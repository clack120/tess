import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { stripTypes } from '@entropy/core/strip-types';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { playerPage, DEBUG_UI_PATH, PREACT_PATH } from './template.ts';
import { assetRoutes, withServedAssets } from './asset-routes.ts';
import { makeEntryBundle } from '@entropy/compiler';
import type { AssetFile, EntryProject, SourceMap } from '@entropy/compiler';

export interface ServeOptions {
  project: EntryProject;
  assets?: AssetFile[];
  assetDirs?: string[];
  name: string;
  port?: number;
  cwd?: string;
  reload?: boolean;
  sourceMap?: SourceMap;
  boost?: boolean;
}

export interface RunningServer {
  url: string;
  runtime: string;
  close(): Promise<void>;
  update(next: {
    project: EntryProject;
    assets?: AssetFile[];
    sourceMap?: SourceMap;
  }): void;
}

// Proxy TTS through the local server because Entry's service does not allow browser CORS.
const TTS_PROXY_PATH = '/api/expansionBlock/tts/read.mp3';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.ent': 'application/octet-stream',
};

// Use unpkg because Entry's package exceeds jsDelivr's package size limit.
const CDN = 'https://unpkg.com/@entrylabs/entry@4.0.22';

const DEBUG_UI_FILE = fileURLToPath(new URL('./debug-ui.ts', import.meta.url));

// Serve the same type-stripped debug UI module to both runtimes.
export function debugUiSource() {
  return stripTypes(fs.readFileSync(DEBUG_UI_FILE, 'utf-8'));
}

export const DEFAULT_PORT = 2013;

// Preact's standalone ESM file needs no additional module routes.
export function findPreactDir() {
  try {
    return path.dirname(fileURLToPath(import.meta.resolve('preact')));
  } catch {
    return null;
  }
}

export function findLocalRuntime(from = process.cwd()) {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@entrylabs', 'entry');
    if (fs.existsSync(path.join(candidate, 'dist', 'entry.min.js'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function serveProject({
  project, assets = [], assetDirs = [], name, port = DEFAULT_PORT, cwd = process.cwd(),
  reload = true, sourceMap = {}, boost = false,
}: ServeOptions): Promise<RunningServer> {
  const localRuntime = findLocalRuntime(cwd);
  const preactDir = findPreactDir();
  const base = localRuntime ? '/lib' : CDN;
  // Serve default images from this origin because Entry does not set crossOrigin for WebGL textures.
  const mediaBase = localRuntime || boost ? '/lib' : CDN;
  const entName = `${safeName(name)}.ent`;

  let currentProject = project;
  let currentAssets = assets;
  let currentSourceMap = sourceMap;
  let assetFiles = new Map<string, string>();
  // Rewrite a copy for serving; build downloaded archives from the original project.
  let servedProject = project;
  // Build the archive only when requested.
  let cachedBundle: Promise<Buffer> | null = null;
  const reloadClients = new Set<http.ServerResponse>();

  const useAssets = (nextProject: EntryProject, nextAssets: AssetFile[]) => {
    const { files, rewrites } = assetRoutes(nextAssets, assetDirs, [`/${entName}`]);
    assetFiles = files;
    servedProject = withServedAssets(nextProject, rewrites);
    cachedBundle = null;
  };
  useAssets(project, assets);

  const renderPage = () => {
    const summary = {
      scenes: currentProject.scenes.length,
      objects: currentProject.objects.length,
      blocks: currentProject.objects.reduce((sum: number, object) => sum + countBlocks(JSON.parse(object.script)), 0),
    };
    return playerPage({ name, base, mediaBase, summary, entName, reload, boost });
  };

  const server = http.createServer((request, response) => {
    const url = decodeURIComponent((request.url ?? '/').split('?')[0]);

    if (reload && url === '/__reload') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(':ok\n\n');
      reloadClients.add(response);
      request.on('close', () => reloadClients.delete(response));
      return;
    }

    if (request.method === 'POST' && url === '/__log') return receiveLog(request, response);
    if (url === TTS_PROXY_PATH) return proxyTts(request, response);

    if (url === '/' || url === '/index.html') return send(response, 200, '.html', renderPage());
    if (url === '/project.json') return send(response, 200, '.json', JSON.stringify(servedProject));
    if (url === '/sourcemap.json') return send(response, 200, '.json', JSON.stringify(currentSourceMap));
    if (url === `/${entName}`) {
      cachedBundle ??= makeEntryBundle(currentProject, currentAssets);
      return cachedBundle.then(
        (bytes: Buffer) => send(response, 200, '.ent', bytes),
        (error: Error) => send(response, 500, '.html', `<h1>작품을 묶지 못했습니다: ${error.message}</h1>`),
      );
    }

    if (assetFiles.has(url)) return sendFile(response, assetFiles.get(url)!);

    if (localRuntime && url.startsWith('/lib/')) {
      const target = path.join(localRuntime, url.slice('/lib/'.length));
      if (target.startsWith(localRuntime) && fs.existsSync(target)) return sendFile(response, target);
    }
    if (!localRuntime && boost && url.startsWith('/lib/')) return proxyRuntimeFile(url, response);

    if (url === DEBUG_UI_PATH) return send(response, 200, '.js', debugUiSource());

    if (preactDir && url.startsWith(PREACT_PATH)) {
      const target = path.join(preactDir, url.slice(PREACT_PATH.length));
      if (target.startsWith(preactDir) && fs.existsSync(target)) return sendFile(response, target);
    }

    return send(response, 404, '.html', '<h1>404</h1>');
  });

  return new Promise<RunningServer>((resolve, reject) => {
    // Prefer a fixed port to preserve debugger state, then fall back to a free port.
    let retried = port === DEFAULT_PORT;
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && retried) {
        retried = false;
        console.error(`포트 ${port} 가 이미 쓰이고 있어 비어 있는 포트로 대신 엽니다.`);
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        runtime: localRuntime ? '설치된 @entrylabs/entry' : `CDN ${CDN.replace(/^https:\/\//, '')}`,
        // Close SSE responses and remaining connections so shutdown cannot hang.
        close: () => {
          for (const client of reloadClients) client.end();
          reloadClients.clear();
          server.closeAllConnections?.();
          return new Promise<void>((done) => { server.close(() => done()); });
        },
        update({ project: nextProject, assets: nextAssets = [], sourceMap: nextSourceMap = {} }) {
          currentProject = nextProject;
          currentAssets = nextAssets;
          currentSourceMap = nextSourceMap;
          useAssets(nextProject, nextAssets);
          for (const client of reloadClients) client.write('event: reload\ndata: ok\n\n');
        },
      });
    });
  });
}

function receiveLog(request: http.IncomingMessage, response: http.ServerResponse) {
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += chunk;
    if (body.length > 1_000_000) request.destroy();
  });
  request.on('end', () => {
    try {
      const { kind, message, stack, time } = JSON.parse(body);
      const when = new Date(time ?? Date.now()).toLocaleTimeString('ko-KR', { hour12: false });
      console.error(`\n[${when}] 엔트리 실행 중 ${kind ?? '오류'}: ${message ?? '(메시지 없음)'}`);
      if (stack) console.error(stack);
    } catch {
      // Keep the server running if a browser log body cannot be read.
    }
    response.writeHead(204).end();
  });
}

async function proxyTts(request: http.IncomingMessage, response: http.ServerResponse) {
  const target = `https://playentry.org${request.url}`;
  try {
    const upstream = await fetch(target);
    if (!upstream.ok || !upstream.body) {
      send(response, upstream.status || 502, '.html', '<h1>tts 요청이 playentry.org 에서 실패했습니다</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg' });
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
  } catch (error) {
    send(response, 502, '.html', `<h1>tts 요청을 playentry.org 로 보내지 못했습니다: ${(error as Error).message}</h1>`);
  }
}

// Proxy images from the same origin so Entry's WebGL textures are not tainted.
async function proxyRuntimeFile(url: string, response: http.ServerResponse) {
  const rest = url.slice('/lib/'.length);
  // Restrict proxy paths to the Entry package.
  if (rest.split('/').includes('..')) return send(response, 404, '.html', '<h1>404</h1>');
  try {
    const upstream = await fetch(`${CDN}/${rest}`);
    if (!upstream.ok) return send(response, upstream.status, '.html', '<h1>404</h1>');
    const body = Buffer.from(await upstream.arrayBuffer());
    return send(response, 200, path.extname(rest).toLowerCase(), body);
  } catch (error) {
    return send(response, 502, '.html', `<h1>실행기 파일을 CDN 에서 받지 못했습니다: ${(error as Error).message}</h1>`);
  }
}

function send(response: http.ServerResponse, status: number, ext: string, body: string | Buffer) {
  response.writeHead(status, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Disable caching so project and debug UI edits appear after reload.
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendFile(response: http.ServerResponse, file: string) {
  try {
    send(response, 200, path.extname(file).toLowerCase(), fs.readFileSync(file));
  } catch {
    send(response, 404, '.html', '<h1>404</h1>');
  }
}

function safeName(name: string) {
  return String(name).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60) || 'project';
}

function countBlocks(node: any): number {
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countBlocks(item), 0);
  if (!node || typeof node !== 'object' || !node.type) return 0;
  return 1 + countBlocks(node.params ?? []) + countBlocks(node.statements ?? []);
}

export { fileURLToPath };
