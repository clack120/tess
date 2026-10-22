import fs from 'node:fs';
import path from 'node:path';
import { stripTypes } from '@tess/core/strip-types';
import { fileURLToPath } from 'node:url';
import { ENTRY_FONT_STYLES, withServedAssets } from '@tess/player';
import type { AssetFile, EntryProject } from '@tess/compiler';
import { ASK_FIELD_STYLE } from '../web/ask-style.ts';
import { CHART_WINDOW_STYLE } from '../web/chart-view.ts';
import { EXTRAS_DIALOG_STYLE } from '../web/extras.ts';
import { zipFiles, type ZipFile } from './zip.ts';
import { DEFAULT_STAGE_HEIGHT, DEFAULT_STAGE_WIDTH } from '../runtime/model.ts';

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));
const PIXI_FILE = fileURLToPath(new URL('../../node_modules/pixi.js/dist/pixi.mjs', import.meta.url));
const DEXIE_FILE = fileURLToPath(new URL('../../node_modules/dexie/dist/modern/dexie.mjs', import.meta.url));

const VM_PREFIX = 'vm/';

const BARE_PREFIX = 'tessvm/';

const MEDIA: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
};

export interface ExportOptions {
  project: EntryProject;
  assets: AssetFile[];
  name: string;
  quality?: number;
  fps?: number;
  stageWidth?: number;
  stageHeight?: number;
  autoStart?: boolean;
  boost?: boolean;
  svg?: boolean;
  kernel?: boolean;
}

export interface ExportResult {
  data: Buffer;
  modules: number;
  assets: number;
  kernel: boolean;
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;

// Strip module types the same way as the run server.
function collectModules(entries: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const queue = [...entries];
  while (queue.length) {
    const relative = queue.pop()!;
    if (found.has(relative)) {
      continue;
    }
    const file = path.join(SRC_DIR, relative);
    if (!file.startsWith(SRC_DIR) || !fs.existsSync(file)) {
      throw new Error(`실행기 모듈을 찾지 못했습니다: ${relative}`);
    }
    const source = fs.readFileSync(file, 'utf-8');
    const code = relative.endsWith('.ts')
      ? stripTypes(source)
      : source;
    found.set(relative, code);
    for (const specifier of relativeSpecifiers(code)) {
      queue.push(resolveFrom(relative, specifier));
    }
  }
  return found;
}

function* relativeSpecifiers(code: string): Generator<string> {
  for (const match of code.matchAll(SPECIFIER)) {
    if (match[3]!.startsWith('.')) {
      yield match[3]!;
    }
  }
}

function resolveFrom(relative: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
}

function rewriteSpecifiers(
  relative: string,
  code: string,
  name: (target: string, specifier: string) => string,
): string {
  return code.replace(SPECIFIER, (whole, head: string, quote: string, specifier: string) =>
    specifier.startsWith('.')
      ? `${head}${quote}${name(resolveFrom(relative, specifier), specifier)}${quote}`
      : whole);
}

// Emit .js because browsers reject the content type static servers assign to .ts.
const asJs = (name: string) => name.replace(/\.ts$/, '.js');

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body {
  background: #000; color: #e8eaed;
  font: 13px/1.5 system-ui, -apple-system, 'Segoe UI', 'Noto Sans KR', sans-serif;
}
#stage { position: relative; width: 100%; height: 100%; }
.tessvm-stage { position: relative; width: 100%; height: 100%; display: grid; place-items: center; }
.tessvm-stage canvas { display: block; }
.tessvm-frame { position: relative; }
#tessvm-cover {
  position: absolute; inset: 0; z-index: 2; display: grid; place-items: center;
  background: #00000059;
}
#tessvm-start {
  width: 88px; height: 88px; padding: 0; border: 0; border-radius: 50%;
  background: #fff; color: #4f80ff; cursor: pointer; display: grid; place-items: center;
  box-shadow: 0 6px 24px #0007; transition: transform .12s ease-out;
}
#tessvm-start:hover { transform: scale(1.06); }
#tessvm-start svg { width: 40px; height: 40px; margin-left: 5px; fill: currentColor; }
#tessvm-error {
  position: absolute; inset: auto 12px 12px 12px; z-index: 3; padding: 10px 12px;
  border-radius: 8px; background: #46161a; border: 1px solid #7d2b31; display: none;
  white-space: pre-wrap; max-height: 40vh; overflow: auto; font-family: ui-monospace, monospace;
}
${ASK_FIELD_STYLE}
${CHART_WINDOW_STYLE}
${EXTRAS_DIALOG_STYLE}
`;

const BODY = `<div id="stage">
  <div id="tessvm-cover">
    <button id="tessvm-start" type="button" title="시작하기" aria-label="시작하기">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 3.1 12.9 8l-8.3 4.9Z"/></svg>
    </button>
  </div>
</div>
<div id="tessvm-error"></div>`;

function bootModule(
  links: { boot: string; project: string; prelude?: string },
  config: unknown,
): string {
  return `
import { boot } from ${links.boot};
${links.prelude ?? ''}

const config = ${literal(config)};
const errorBox = document.getElementById('tessvm-error');
function showError(message) {
  errorBox.style.display = 'block';
  errorBox.textContent = message;
}
window.addEventListener('error', (event) => {
  if (/^ResizeObserver loop/.test(String(event.message))) return;
  showError(String(event.message));
});
window.addEventListener('unhandledrejection', (event) => showError(String(event.reason)));

try {
  const project = ${links.project};
  const cover = document.getElementById('tessvm-cover');
  const handle = await boot({
    project,
    container: document.getElementById('stage'),
    quality: config.quality,
    fps: config.fps ?? undefined,
    showStats: false,
    autoStart: config.autoStart,
    boost: config.boost,
    svg: config.svg,
    stageWidth: config.stageWidth,
    stageHeight: config.stageHeight,
    kernel: config.kernel,
  });
  window.tessvm = handle;
  // Wait for the viewer to start, matching Entry.
  document.getElementById('tessvm-start').onclick = () => handle.start();
  setInterval(() => { cover.hidden = handle.vm.state !== 'stop'; }, 100);
  cover.hidden = config.autoStart;
} catch (error) {
  showError(String(error && error.stack ? error.stack : error));
}
`;
}

function page(title: string, head: string, tail: string): string {
  const fonts = ENTRY_FONT_STYLES.map((url) => `<link rel="stylesheet" href="${url}">`).join('\n');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${fonts}
<style>${STYLE}</style>
${head}
</head>
<body>
${BODY}
${tail}
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

// Escape script terminators because HTML escaping cannot protect a JavaScript literal.
function literal(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

interface Asset {
  /** The address the work itself uses. */
  target: string;
  data: Buffer;
  type: string;
}

interface Built {
  modules: Map<string, string>;
  assets: Asset[];
  config: Record<string, unknown>;
}

function build(options: ExportOptions): Built {
  const assets: Asset[] = [];
  const seen = new Set<string>();
  for (const asset of options.assets) {
    if (seen.has(asset.target) || !fs.existsSync(asset.source)) {
      continue;
    }
    seen.add(asset.target);
    assets.push({
      target: asset.target,
      data: fs.readFileSync(asset.source),
      type: MEDIA[path.extname(asset.target).toLowerCase()] ?? 'application/octet-stream',
    });
  }
  return {
    modules: collectModules(['web/boot.ts']),
    assets,
    config: {
      quality: options.quality ?? 1,
      fps: options.fps ?? null,
      autoStart: options.autoStart ?? false,
      boost: options.boost ?? true,
      svg: options.svg ?? true,
      stageWidth: options.stageWidth ?? DEFAULT_STAGE_WIDTH,
      stageHeight: options.stageHeight ?? DEFAULT_STAGE_HEIGHT,
      kernel: options.kernel !== false,
    },
  };
}

export function exportZip(options: ExportOptions): ExportResult {
  const built = build(options);
  const rewrites = new Map(built.assets.map((asset) => [asset.target, `assets/${asset.target}`]));
  const project = withServedAssets(options.project, rewrites);
  const config = built.config;
  const files: ZipFile[] = [
    {
      name: 'index.html',
      data: page(
        options.name,
        `<script type="importmap">${literal({
          imports: { 'pixi.js': './vm/pixi.mjs', dexie: './vm/dexie.mjs' },
        })}</script>`,
        `<script type="module">${bootModule(
          {
            boot: literal(`./${VM_PREFIX}web/boot.js`),
            project: `await (await fetch('./project.json')).json()`,
          },
          config,
        )}</script>`,
      ),
    },
    { name: 'project.json', data: JSON.stringify(project) },
    { name: `${VM_PREFIX}pixi.mjs`, data: fs.readFileSync(PIXI_FILE) },
    { name: `${VM_PREFIX}dexie.mjs`, data: fs.readFileSync(DEXIE_FILE) },
  ];
  for (const [relative, code] of built.modules) {
    files.push({
      name: `${VM_PREFIX}${asJs(relative)}`,
      data: rewriteSpecifiers(relative, code, (_target, specifier) => asJs(specifier)),
    });
  }
  for (const asset of built.assets) {
    files.push({ name: `assets/${asset.target}`, data: asset.data });
  }
  return {
    data: zipFiles(files),
    modules: built.modules.size + 2,
    assets: built.assets.length,
    kernel: options.kernel !== false,
  };
}

// Map modules to blob URLs, but keep asset URLs intact so costume type detection still works.
export function exportHtml(options: ExportOptions): ExportResult {
  const built = build(options);
  const sources: Record<string, string> = {};
  for (const [relative, code] of built.modules) {
    sources[`${BARE_PREFIX}${relative}`] = rewriteSpecifiers(
      relative,
      code,
      (target) => `${BARE_PREFIX}${target}`,
    );
  }
  sources['pixi.js'] = fs.readFileSync(PIXI_FILE, 'utf-8');
  sources.dexie = fs.readFileSync(DEXIE_FILE, 'utf-8');

  const files: Record<string, [string, string]> = {};
  for (const asset of built.assets) {
    files[asset.target] = [asset.type, asset.data.toString('base64')];
  }
  const config = built.config;
  const runner = bootModule(
    {
      boot: literal(`${BARE_PREFIX}web/boot.ts`),
      project: 'window.__tessProject',
      // Read textures on this thread because workers cannot access the page's in-memory assets.
      prelude: `import { loadTextures } from 'pixi.js';\nloadTextures.config.preferWorkers = false;`,
    },
    config,
  );

  const bootstrap = `
const SOURCES = ${literal(sources)};
const FILES = ${literal(files)};
const PROJECT = ${literal(JSON.stringify(options.project))};
const RUNNER = ${literal(runner)};

// Match asset paths by suffix so both relative and browser-resolved absolute URLs reach memory files.
const bytesOf = (base64) => {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) out[at] = raw.charCodeAt(at);
  return out;
};
const byTail = new Map();
for (const name of Object.keys(FILES)) {
  const tail = name.split('/').pop();
  if (!byTail.has(tail)) byTail.set(tail, []);
  byTail.get(tail).push(name);
}
const lookup = (url) => {
  const clean = String(url).split(/[?#]/)[0];
  if (FILES[clean]) return clean;
  const names = byTail.get(clean.split('/').pop()) || [];
  return names.find((name) => clean.endsWith(name)) || null;
};
const served = fetch;
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input && input.url;
  const name = url && lookup(url);
  if (!name) return served.call(this, input, init);
  const [type, base64] = FILES[name];
  return Promise.resolve(new Response(bytesOf(base64), { headers: { 'content-type': type } }));
};

const blobUrl = (text, type) => URL.createObjectURL(new Blob([text], { type }));
const imports = {};
for (const name of Object.keys(SOURCES)) imports[name] = blobUrl(SOURCES[name], 'text/javascript');
const map = document.createElement('script');
map.type = 'importmap';
map.textContent = JSON.stringify({ imports: imports });
document.head.appendChild(map);

window.__tessProject = JSON.parse(PROJECT);
const script = document.createElement('script');
script.type = 'module';
script.src = blobUrl(RUNNER, 'text/javascript');
document.body.appendChild(script);
`;
  const html = page(options.name, '', `<script>${bootstrap}</script>`);
  return {
    data: Buffer.from(html, 'utf-8'),
    modules: Object.keys(sources).length,
    assets: built.assets.length,
    kernel: options.kernel !== false,
  };
}
