// Serve original asset URLs and readable aliases; rewrite only unambiguous paths.
import path from 'node:path';
import type { AssetFile, EntryProject } from '@tess/compiler';

export interface AssetRoutes {
  files: Map<string, string>;
  rewrites: Map<string, string>;
}

const RESERVED = new Set([
  '/', '/index.html', '/project.json', '/sourcemap.json', '/debug-ui.js',
  '/__reload', '/__log',
]);

const RESERVED_PREFIXES = ['/lib/', '/arrow/', '/temp/', '/api/'];

function publicPath(source: string, assetDirs: string[]): string | null {
  for (const dir of assetDirs) {
    const relative = path.relative(dir, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    return `/${relative.split(path.sep).join('/')}`;
  }
  return null;
}

const isReserved = (url: string, taken: Set<string>) => RESERVED.has(url)
  || taken.has(url)
  || RESERVED_PREFIXES.some((prefix) => url.startsWith(prefix));

export function assetRoutes(
  assets: AssetFile[],
  assetDirs: string[] = [],
  taken: string[] = [],
): AssetRoutes {
  const reserved = new Set(taken);
  const files = new Map<string, string>();
  for (const { source, target } of assets) files.set(`/${target}`, source);

  // Do not assign an alias when different folders claim the same name.
  const claims = new Map<string, Set<string>>();
  for (const { source } of assets) {
    const url = publicPath(source, assetDirs);
    if (!url || isReserved(url, reserved)) continue;
    if (!claims.has(url)) claims.set(url, new Set());
    claims.get(url)!.add(source);
  }

  const rewrites = new Map<string, string>();
  for (const { source, target } of assets) {
    const url = publicPath(source, assetDirs);
    if (!url || claims.get(url)?.size !== 1) continue;
    files.set(url, source);
    rewrites.set(target, url);
  }
  return { files, rewrites };
}

export function withServedAssets(project: EntryProject, rewrites: Map<string, string>): EntryProject {
  if (rewrites.size === 0) return project;
  return rewriteUrls(project, rewrites) as EntryProject;
}

// Keep pngurl alongside fileurl because it points to the saved raster copy.
const URL_KEYS = new Set(['fileurl', 'pngurl']);

function rewriteUrls(value: unknown, rewrites: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteUrls(item, rewrites));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = URL_KEYS.has(key) && typeof item === 'string' && rewrites.has(item)
      ? rewrites.get(item)
      : rewriteUrls(item, rewrites);
  }
  return out;
}
