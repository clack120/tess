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

// Proxy Entry expansion APIs through the local server because they do not allow browser CORS.
const EXPANSION_PROXY_PREFIX = '/api/expansionBlock/';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
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
// Match the installed runtime first; packaged installs without the dev dependency
// fall back to the declared range and finally unpkg's current release.
const PLAYER_PACKAGE = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8',
));
let installedEntryVersion = '';
try {
  installedEntryVersion = JSON.parse(fs.readFileSync(
    fileURLToPath(new URL('../../../node_modules/@entrylabs/entry/package.json', import.meta.url)), 'utf-8',
  )).version;
} catch {}
const ENTRY_VERSION = installedEntryVersion || /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(
  PLAYER_PACKAGE.devDependencies?.['@entrylabs/entry'] ?? '',
)?.[0] || 'latest';
const CDN = `https://unpkg.com/@entrylabs/entry@${ENTRY_VERSION}`;

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
  if (!fs.existsSync(dir)) return null;
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
    if (!isLoopbackHost(request.headers.host)) {
      return send(response, 403, '.txt', 'forbidden');
    }
    let url: string;
    try {
      url = decodeURIComponent((request.url ?? '/').split('?')[0]);
    } catch {
      return send(response, 400, '.txt', 'bad request');
    }

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

    if (request.method === 'POST' && url === '/__log') {
      if (!isOwnOrigin(request)) return send(response, 403, '.txt', 'forbidden');
      return receiveLog(request, response);
    }
    if (request.method === 'GET' && url.startsWith(EXPANSION_PROXY_PREFIX) && !url.includes('..')) {
      return proxyEntryApi(request, response);
    }

    if (url === '/' || url === '/index.html') return send(response, 200, '.html', renderPage());
    if (url === '/project.json') return send(response, 200, '.json', JSON.stringify(servedProject));
    if (url === '/sourcemap.json') return send(response, 200, '.json', JSON.stringify(currentSourceMap));
    if (url === `/${entName}`) {
      cachedBundle ??= makeEntryBundle(currentProject, currentAssets);
      return cachedBundle.then(
        (bytes: Buffer) => send(response, 200, '.ent', bytes),
        (error: Error) => send(response, 500, '.txt', `작품을 묶지 못했습니다: ${error.message}`),
      );
    }

    if (assetFiles.has(url)) return sendFile(response, assetFiles.get(url)!);

    if (localRuntime && url.startsWith('/lib/')) {
      const target = path.join(localRuntime, url.slice('/lib/'.length));
      if (inside(localRuntime, target) && fs.existsSync(target)) return sendFile(response, target);
    }
    if (!localRuntime && boost && url.startsWith('/lib/')) return proxyRuntimeFile(url, response);

    if (url === DEBUG_UI_PATH) return send(response, 200, '.js', debugUiSource());

    if (preactDir && url.startsWith(PREACT_PATH)) {
      const target = path.join(preactDir, url.slice(PREACT_PATH.length));
      if (inside(preactDir, target) && fs.existsSync(target)) return sendFile(response, target);
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
      console.error(`\n[${when}] 엔트리 실행 중 ${plainText(kind) || '오류'}: ${plainText(message) || '(메시지 없음)'}`);
      if (stack) console.error(plainText(stack));
    } catch {
      // Keep the server running if a browser log body cannot be read.
    }
    response.writeHead(204).end();
  });
}

async function proxyEntryApi(request: http.IncomingMessage, response: http.ServerResponse) {
  const target = `https://playentry.org${request.url}`;
  try {
    const upstream = await fetch(target, {
      headers: { accept: '*/*', referer: 'https://playentry.org/' },
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok || !upstream.body) {
      send(response, upstream.status || 502, '.txt', '확장 데이터 요청이 playentry.org 에서 실패했습니다');
      return;
    }
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
  } catch (error) {
    send(response, 502, '.txt', `확장 데이터 요청을 playentry.org 로 보내지 못했습니다: ${(error as Error).message}`);
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
    return send(response, 502, '.txt', `실행기 파일을 CDN 에서 받지 못했습니다: ${(error as Error).message}`);
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
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return send(response, 404, '.html', '<h1>404</h1>');
  }

  response.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function isOwnOrigin(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://${request.headers.host}`;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function plainText(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.replace(CONTROL_CHARS, ' ');
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
