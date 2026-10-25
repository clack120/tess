import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { stripTypes } from '@entropy/core/strip-types';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  assetRoutes,
  debugUiSource,
  findPreactDir,
  withServedAssets,
  DEBUG_UI_PATH,
  PREACT_PATH,
} from '@entropy/player';
import type { AssetFile, EntryProject, SourceMap } from '@entropy/compiler';
import { playerPage } from './page.ts';
import { DEFAULT_STAGE_HEIGHT, DEFAULT_STAGE_WIDTH } from '../runtime/model.ts';

export const DEFAULT_PORT = 2014;

export interface ServeOptions {
  project: EntryProject;
  assets: AssetFile[];
  assetDirs: string[];
  name: string;
  sourceMap?: SourceMap;
  port?: number;
  quality?: number;
  // Leave unset to use the project's speed.
  fps?: number;
  stageWidth?: number;
  stageHeight?: number;
  stats?: boolean;
  reload?: boolean;
  autoStart?: boolean;
  boost?: boolean;
  svg?: boolean;
  kernel?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  runtime: string;
  close(): Promise<void>;
  update(next: {
    project: EntryProject;
    assets: AssetFile[];
    sourceMap?: SourceMap;
  }): void;
}

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));
const PIXI_FILE = fileURLToPath(
  new URL('../../node_modules/pixi.js/dist/pixi.mjs', import.meta.url),
);
const DEXIE_FILE = fileURLToPath(
  new URL('../../node_modules/dexie/dist/modern/dexie.mjs', import.meta.url),
);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

// Check the Host header to prevent DNS rebinding from exposing the local server.
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function isOwnOrigin(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://${request.headers.host}`;
}

// Proxy expansion APIs through the local origin because Entry does not allow browser CORS.
const EXPANSION_PREFIX = '/api/expansionBlock/';
const ENTRY_ORIGIN = 'https://playentry.org';
// Match Entry's API timeout before returning the default answer.
const API_TIMEOUT_MS = 3000;

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// Drop terminal controls but keep tabs and newlines for readable stack traces.
function plainText(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.replace(CONTROL_CHARS, ' ');
}

export async function serveVm(options: ServeOptions): Promise<RunningServer> {
  let routes = assetRoutes(options.assets, options.assetDirs);
  let served = withServedAssets(options.project, routes.rewrites);
  let projectJson = JSON.stringify(served);
  let sourceMapJson = JSON.stringify(options.sourceMap ?? {});
  const preactDir = findPreactDir();
  const listeners = new Set<http.ServerResponse>();

  const server = http.createServer((request, response) => {
    // Reject foreign Host headers before serving project data or VM files.
    if (!isLoopbackHost(request.headers.host)) {
      return send(response, 403, 'text/plain', 'forbidden');
    }
    let url: string;
    try {
      url = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    } catch {
      return send(response, 400, 'text/plain', 'bad request');
    }

    if (url === '/' || url === '/index.html') {
      return send(response, 200, MIME['.html']!, playerPage({
        name: options.name,
        quality: options.quality ?? 1,
        fps: options.fps,
        stats: options.stats ?? true,
        reload: options.reload ?? false,
        autoStart: options.autoStart ?? false,
        boost: options.boost ?? true,
        svg: options.svg ?? true,
        kernel: options.kernel !== false,
        stageWidth: options.stageWidth ?? DEFAULT_STAGE_WIDTH,
        stageHeight: options.stageHeight ?? DEFAULT_STAGE_HEIGHT,
      }));
    }

    if (url === '/project.json') {
      return send(response, 200, MIME['.json']!, projectJson);
    }

    if (url === '/sourcemap.json') {
      return send(response, 200, MIME['.json']!, sourceMapJson);
    }

    if (request.method === 'GET' && url.startsWith(EXPANSION_PREFIX) && !url.includes('..')) {
      return void passToEntry(request, response);
    }

    if (request.method === 'POST' && url === '/__log') {
      // Only the run page may post terminal logs to this endpoint.
      if (!isOwnOrigin(request)) {
        return send(response, 403, 'text/plain', 'forbidden');
      }
      return receiveLog(request, response);
    }

    if (url === DEBUG_UI_PATH) {
      return send(response, 200, MIME['.js']!, debugUiSource());
    }
    if (preactDir && url.startsWith(PREACT_PATH)) {
      const file = path.join(preactDir, url.slice(PREACT_PATH.length));
      if (inside(preactDir, file) && fs.existsSync(file)) {
        return sendFile(response, file, MIME['.mjs']!);
      }
      return send(response, 404, 'text/plain', 'not found');
    }

    if (url === '/__reload') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write('\n');
      listeners.add(response);
      request.on('close', () => listeners.delete(response));
      return undefined;
    }

    if (url === '/vm/pixi.mjs') {
      return sendFile(response, PIXI_FILE, MIME['.mjs']!);
    }

    if (url === '/vm/dexie.mjs') {
      return sendFile(response, DEXIE_FILE, MIME['.mjs']!);
    }

    if (url.startsWith('/vm/')) {
      const relative = url.slice('/vm/'.length);
      const file = path.join(SRC_DIR, relative);
      if (!inside(SRC_DIR, file) || !fs.existsSync(file)) {
        return send(response, 404, 'text/plain', 'not found');
      }
      const source = fs.readFileSync(file, 'utf-8');
      const code = file.endsWith('.ts') ? stripTypes(source) : source;
      return send(response, 200, MIME['.js']!, code);
    }

    const asset = routes.files.get(url);
    if (asset && fs.existsSync(asset)) {
      return sendFile(response, asset, MIME[path.extname(asset).toLowerCase()] ?? 'application/octet-stream');
    }

    return send(response, 404, 'text/plain', 'not found');
  });

  const port = await listen(server, options.port ?? DEFAULT_PORT);
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    runtime: 'entropy (PixiJS)',
    async close() {
      for (const listener of listeners) {
        listener.end();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    update(next) {
      routes = assetRoutes(next.assets, options.assetDirs);
      served = withServedAssets(next.project, routes.rewrites);
      projectJson = JSON.stringify(served);
      sourceMapJson = JSON.stringify(next.sourceMap ?? {});
      for (const listener of listeners) {
        listener.write('data: reload\n\n');
      }
    },
  };
}

async function passToEntry(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  try {
    const answer = await fetch(`${ENTRY_ORIGIN}${request.url ?? ''}`, {
      // Set the work referer because Entry accepts API calls only for its pages.
      headers: { accept: '*/*', referer: `${ENTRY_ORIGIN}/` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const type = answer.headers.get('content-type') ?? 'application/octet-stream';
    send(response, answer.status, type, Buffer.from(await answer.arrayBuffer()));
  } catch {
    // Keep Entry's default answer when offline or past its timeout.
    send(response, 502, MIME['.json']!, '{}');
  }
}

function receiveLog(request: http.IncomingMessage, response: http.ServerResponse): void {
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += chunk;
    if (body.length > 1_000_000) {
      request.destroy();
    }
  });
  request.on('end', () => {
    try {
      const { kind, message, stack, time } = JSON.parse(body);
      const when = new Date(time ?? Date.now()).toLocaleTimeString('ko-KR', { hour12: false });
      console.error(`\n[${when}] ${plainText(kind) || '오류'}: ${plainText(message) || '(메시지 없음)'}`);
      if (stack) {
        console.error(plainText(stack));
      }
    } catch {
      // Keep serving when a log request body cannot be read.
    }
    response.writeHead(204).end();
  });
}

function send(
  response: http.ServerResponse,
  status: number,
  type: string,
  body: string | Uint8Array,
): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function sendFile(response: http.ServerResponse, file: string, type: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // A file can disappear between checking and reading it.
    return send(response, 404, 'text/plain', 'not found');
  }
  response.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(response);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Prefer a stable port so bookmarks keep working.
function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
