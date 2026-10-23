// Keep modules separate, but flatten content scripts because browsers load them as classic scripts.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { stripTypes } from '@entropy/core/strip-types';
import { fileURLToPath } from 'node:url';
import { icon } from './icons.ts';
import { crxIdText, packCrx, publicKeyOf, signingKey, zipDirectory } from './pack.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SRC = path.join(ROOT, 'src');
const VM_SRC = path.resolve(ROOT, '../vm/src');
const DIST = path.join(ROOT, 'dist');
const VENDOR = path.join(DIST, 'vendor');
const VM_OUT = path.join(VENDOR, 'entropy');
const PIXI_OUT = path.join(VENDOR, 'pixi.mjs');
const DEXIE_OUT = path.join(VENDOR, 'dexie.mjs');

const ZIP = path.join(ROOT, 'entropy-extension.zip');
const CHROME_ZIP = path.join(ROOT, 'entropy-extension-chrome.zip');
const CRX = path.join(ROOT, 'entropy-extension.crx');
// The signing key determines the extension ID, so keep it stable.
const CRX_KEY = path.join(ROOT, 'crx-key.pem');

const MODULE_ENTRIES = ['page/main.ts', 'popup/popup.ts'];
const CLASSIC_ENTRIES = ['content.ts'];
const ICON_SIZES = [16, 32, 48, 128];

const RELATIVE_IMPORT = /(['"])(\.\.?\/[^'"]*\.ts)\1/g;
// Match only import specifiers so string values such as a format name stay untouched.
const PIXI_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*)(['"])pixi\.js\2/g;
const DEXIE_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*)(['"])dexie\2/g;
const IMPORT_STATEMENT = /^import\s[\s\S]*?from\s*['"][^'"]*['"];?[^\S\n]*$/gm;
const BARE_IMPORT = /^import\s*['"][^'"]*['"];?[^\S\n]*$/gm;
const EXPORT_KEYWORD = /^export\s+(?=(?:const|let|var|function|class|async)\b)/gm;
const LEFTOVER_MODULE = /^\s*(?:import|export)\b/m;

const read = (file: string) => stripTypes(fs.readFileSync(file, 'utf-8'));

function outputFor(file: string): string {
  const roots = [
    { src: SRC, out: DIST },
    { src: VM_SRC, out: VM_OUT },
  ];
  for (const root of roots) {
    const inside = path.relative(root.src, file);
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
      return path.join(root.out, inside).replace(/\.ts$/, '.js');
    }
  }
  throw new Error(`확장에 포함할 수 없는 모듈입니다: ${file}`);
}

function link(from: string, to: string): string {
  const relative = path.relative(path.dirname(from), to).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function importsOf(file: string): string[] {
  const text = read(file);
  const found: string[] = [];
  for (const [, , specifier] of text.matchAll(RELATIVE_IMPORT)) {
    found.push(path.resolve(path.dirname(file), specifier!));
  }
  return found;
}

function emitModule(file: string): string[] {
  const out = outputFor(file);
  const found: string[] = [];
  const code = read(file)
    .replace(RELATIVE_IMPORT, (_match, quote: string, specifier: string) => {
      const target = path.resolve(path.dirname(file), specifier);
      found.push(target);
      return `${quote}${link(out, outputFor(target))}${quote}`;
    })
    .replace(PIXI_IMPORT, (_match, lead: string, quote: string) => `${lead}${quote}${link(out, PIXI_OUT)}${quote}`)
    .replace(DEXIE_IMPORT, (_match, lead: string, quote: string) => `${lead}${quote}${link(out, DEXIE_OUT)}${quote}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  return found;
}

function emitModules(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    queue.push(...emitModule(file));
  }
  return seen;
}

// Emit dependencies first so flattened scripts declare names before using them.
function inOrder(file: string, seen: Set<string>, out: string[]): void {
  if (seen.has(file)) {
    return;
  }
  seen.add(file);
  for (const dependency of importsOf(file)) {
    inOrder(dependency, seen, out);
  }
  out.push(file);
}

// Parse the flattened script to catch remaining imports and duplicate declarations.
function emitClassic(entry: string): number {
  const files: string[] = [];
  inOrder(entry, new Set(), files);
  const body = files
    .map((file) =>
      read(file)
        .replace(IMPORT_STATEMENT, '')
        .replace(BARE_IMPORT, '')
        .replace(EXPORT_KEYWORD, ''),
    )
    .join('\n');
  const code = `(() => {\n${body}\n})();\n`;
  const leftover = LEFTOVER_MODULE.exec(code);
  if (leftover) {
    throw new Error(`${path.relative(SRC, entry)}: 모듈 문법이 남았습니다 — ${leftover[0].trim()}`);
  }
  try {
    new Function(code);
  } catch (error) {
    throw new Error(
      `${path.relative(SRC, entry)}: 클래식 스크립트로 읽히지 않습니다 — ${(error as Error).message}`,
    );
  }
  const out = outputFor(entry);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  return files.length;
}

function checkLinks(): void {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const full = path.join(dir, item.name);
      return item.isDirectory() ? walk(full) : [full];
    });
  for (const file of walk(DIST)) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) {
      continue;
    }
    const source = fs.readFileSync(file, 'utf-8');
    for (const [, , specifier] of source.matchAll(/(['"])(\.\.?\/[^'"]*\.m?js)\1/g)) {
      const target = path.resolve(path.dirname(file), specifier!);
      if (!fs.existsSync(target)) {
        throw new Error(`${path.relative(DIST, file)} 가 없는 파일을 가리킵니다: ${specifier}`);
      }
    }
  }
}

// Missing manifest files can prevent installation or silently disable extension features.
function checkManifest(): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf-8'));
  const named: string[] = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    ...(manifest.content_scripts ?? []).flatMap((script: { js?: string[] }) => script.js ?? []),
    ...(manifest.background?.scripts ?? []),
    manifest.background?.service_worker,
  ].filter((item): item is string => typeof item === 'string');
  for (const file of named) {
    if (!fs.existsSync(path.join(DIST, file))) {
      throw new Error(`manifest.json 이 없는 파일을 가리킵니다: ${file}`);
    }
  }
  if (manifest.default_locale && !fs.existsSync(path.join(DIST, '_locales', manifest.default_locale))) {
    throw new Error(`manifest.json 의 default_locale 에 맞는 _locales 폴더가 없습니다`);
  }
  for (const group of manifest.web_accessible_resources ?? []) {
    for (const pattern of group.resources ?? []) {
      const prefix = pattern.split('*')[0];
      const at = path.join(DIST, prefix);
      const exists = fs.existsSync(at) || fs.existsSync(path.dirname(at));
      if (!exists) {
        throw new Error(`web_accessible_resources 가 없는 경로를 가리킵니다: ${pattern}`);
      }
    }
  }
}

function packageDir(from: string, name: string): string {
  const require = createRequire(from);
  let dir = path.dirname(require.resolve(name));
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) {
      throw new Error(`${name} 을(를) 찾지 못했습니다`);
    }
    dir = up;
  }
  return dir;
}

// Drop source map comments because package maps are not shipped with the extension.
function copyVendor(from: string, name: string, inside: string, out: string): void {
  const source = path.join(packageDir(from, name), inside);
  const code = fs.readFileSync(source, 'utf-8')
    .replace(/\n?\/\/# sourceMappingURL=.*$/, '\n')
    // Rewrite bare library imports because the browser cannot resolve package names here.
    .replace(DEXIE_IMPORT, (_match, lead: string, quote: string) => `${lead}${quote}${link(out, DEXIE_OUT)}${quote}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
}

const rel = (file: string) => path.relative(process.cwd(), file);

// Remove Firefox-only manifest keys from Chrome builds.
function writeManifest(target: 'chrome' | 'firefox' | 'shared'): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf-8'));
  if (target === 'chrome') {
    delete manifest.browser_specific_settings;
    // Chrome uses a service worker; Firefox uses an event page.
    manifest.background = { service_worker: 'background.js' };
  } else if (target === 'firefox') {
    delete manifest.background.service_worker;
  }
  fs.writeFileSync(path.join(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function copy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function writeIcons(): void {
  const dir = path.join(DIST, 'icons');
  fs.mkdirSync(dir, { recursive: true });
  for (const size of ICON_SIZES) {
    fs.writeFileSync(path.join(dir, `icon-${size}.png`), icon(size));
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
const modules = emitModules(MODULE_ENTRIES.map((entry) => path.join(SRC, entry)));
let flattened = 0;
for (const entry of CLASSIC_ENTRIES) {
  flattened += emitClassic(path.join(SRC, entry));
}
execFileSync(process.execPath, ['build', path.join(SRC, 'background.ts'), '--target=browser',
  '--format=iife', '--minify', `--outfile=${path.join(DIST, 'background.js')}`]);
execFileSync(process.execPath, ['build', path.join(packageDir(path.join(ROOT, '../vm/package.json'), 'pixi.js'),
  'dist/pixi.mjs'), '--target=browser', '--format=esm', '--minify', `--outfile=${PIXI_OUT}`]);
copyVendor(
  path.join(ROOT, '../vm/package.json'),
  'dexie',
  'dist/modern/dexie.min.mjs',
  DEXIE_OUT,
);
copy(path.join(SRC, 'player.css'), path.join(DIST, 'player.css'));
copy(path.join(SRC, 'popup', 'popup.html'), path.join(DIST, 'popup', 'popup.html'));
copy(path.join(SRC, 'popup', 'popup.css'), path.join(DIST, 'popup', 'popup.css'));
// Ship the licenses with the build: AGPL for Entropy, MIT for the parts from Tess.
for (const file of ['LICENSE', 'LICENSE-TESS']) copy(path.resolve(ROOT, '../..', file), path.join(DIST, file));
writeIcons();
checkLinks();

// Pack each browser's manifest before writing the next one over it.
writeManifest('firefox');
checkManifest();
zipDirectory(DIST, ZIP);
writeManifest('chrome');
checkManifest();
zipDirectory(DIST, CHROME_ZIP);
// Unpacked loading uses either browser's supported background environment.
writeManifest('shared');
checkManifest();

const lines = [
  `확장을 만들었습니다: ${rel(DIST)} (모듈 ${modules.size}개 · 내용 스크립트 ${flattened}개)`,
  `파이어폭스용 묶음: ${rel(ZIP)}`,
  `크롬용 묶음: ${rel(CHROME_ZIP)} (웹스토어에 올리는 것은 이 zip 입니다)`,
];
if (process.argv.includes('--crx')) {
  const fresh = !fs.existsSync(CRX_KEY);
  const key = signingKey(CRX_KEY);
  fs.writeFileSync(CRX, packCrx(fs.readFileSync(CHROME_ZIP), key));
  lines.push(`크롬 crx: ${rel(CRX)} · 확장 id ${crxIdText(publicKeyOf(key))}`);
  lines.push(
    fresh
      ? `서명 키를 새로 만들었습니다: ${rel(CRX_KEY)} — 확장 id 가 이 키에서 나오므로 잃어버리면 안 됩니다.`
      : `서명 키: ${rel(CRX_KEY)}`,
  );
}
console.log(lines.join('\n'));
