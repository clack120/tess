import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypes } from '@entropy/core/strip-types';

test('slow cache censuses never overlap and one final report includes changes made during the scan', async () => {
  let changed!: () => void;
  const timers: Array<() => void> = [], scans: Array<(size: unknown) => void> = [], messages: unknown[] = [];
  const context = vm.createContext({
    onAssetCacheChange(fn: () => void) { changed = fn; }, clearAssetCache() {},
    setTimeout(fn: () => void) { timers.push(fn); return timers.length; },
    assetCacheSize: () => new Promise(resolve => scans.push(resolve)),
    window: { postMessage: (message: unknown) => messages.push(message) }, location: { origin: 'https://playentry.org' },
  });
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/page/cache.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  changed(); timers.shift()!();
  for (let i = 0; i < 20; i++) changed();
  assert.equal(timers.length, 0); assert.equal(scans.length, 1);
  scans[0]!({ count: 1, bytes: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 0, 'the old snapshot is not published as current');
  assert.equal(timers.length, 1); timers.shift()!();
  scans[1]!({ count: 21, bytes: 21 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1); assert.equal(timers.length, 0);
});

function setup() {
  const changes: boolean[] = [], deleted: number[] = [], revoked: string[] = [];
  const pending: Array<{ url: string; signal: AbortSignal; resolve(value: Response): void; reject(error: unknown): void }> = [];
  const listeners: Array<(event: unknown) => void> = [];
  class Image extends EventTarget {
    value = '';
    get src() { return this.value; }
    set src(value: string) { this.value = value; }
  }
  class Xhr extends EventTarget {
    readyState = 0; responseType = ''; timeout = 0; target = ''; sent = 0;
    get responseURL() { return this.target; }
    open(_method: string, url: string) { this.target = url; this.readyState = 1; }
    send() { this.sent++; this.readyState = 4; }
    abort() { this.readyState = 0; }
  }
  class BlobUrl extends URL {
    static next = 0;
    static createObjectURL() { return `blob:probe/${++this.next}`; }
    static revokeObjectURL(url: string) { revoked.push(url); }
  }
  const window = { addEventListener: (_type: string, fn: typeof listeners[number]) => { listeners.push(fn); } };
  const context = vm.createContext({ HTMLImageElement: Image, XMLHttpRequest: Xhr, URL: BlobUrl, AbortController,
    DOMException, ProgressEvent: Event, setTimeout, clearTimeout, performance,
    location: { origin: 'https://playentry.org', href: 'https://playentry.org/iframe/project' },
    document: { querySelector: () => null }, window,
    setAssetCache: (on: boolean) => changes.push(on), applyCacheClear: async (stamp: number) => { deleted.push(stamp); },
    fetchAsset: (url: string, signal: AbortSignal) => new Promise<Response>((resolve, reject) => pending.push({ url, signal, resolve, reject })),
  });
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/page/native-cache.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  const configure = (on: boolean) => listeners.forEach(fn => fn({ source: window, data: { __entropy: 'native-cache', on, clear: 123 } }));
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { Image, Xhr, pending, changes, deleted, revoked, configure, settle };
}
const image = 'https://playentry.org/uploads/aa/bb/image/aabbpicture.png';
const sound = 'https://playentry.org/uploads/aa/bb/aabbsound.mp3';

test('native cache only intercepts uploaded assets and a later image wins over a delayed load', async () => {
  const s = setup(); s.configure(true);
  const img = new s.Image();
  img.src = image;
  assert.equal(img.src, image);
  img.src = image.replace('picture', 'second');
  assert.equal(s.pending[0]!.signal.aborted, true);
  s.pending[0]!.resolve(new Response('old')); await s.settle();
  assert.equal(img.value, '');
  s.pending[1]!.resolve(new Response('new')); await s.settle();
  assert.match(img.value, /^blob:/);
  img.dispatchEvent(new Event('load'));
  assert.equal(s.revoked.length, 1);
  for (const url of ['/api/private.png', 'https://foreign.test/uploads/aa/bb/image/aabb.png', 'data:image/png,x']) {
    img.src = url; assert.equal(img.value, url);
  }
  assert.equal(s.pending.length, 2);
  s.configure(false); img.src = image;
  assert.equal(img.value, image);
  assert.equal(s.pending.length, 2);
});

test('native XHR preserves original URLs and cancellation never starts a late request', async () => {
  const s = setup(); s.configure(true);
  const req = new s.Xhr(); req.open('GET', sound); req.responseType = 'arraybuffer'; req.send();
  assert.throws(() => req.send(), { name: 'InvalidStateError' });
  let aborted = 0; req.addEventListener('abort', () => { aborted++; });
  req.abort(); s.pending[0]!.resolve(new Response('audio')); await s.settle();
  assert.equal(req.sent, 0); assert.equal(aborted, 1);
  req.open('GET', sound); req.send(); s.pending[1]!.resolve(new Response('audio')); await s.settle();
  assert.equal(req.sent, 1); assert.equal(req.responseType, 'arraybuffer');
  assert.equal(req.responseURL, sound);
  req.dispatchEvent(new Event('loadend')); assert.equal(s.revoked.length, 1);
  req.open('POST', sound); req.send(); assert.equal(s.pending.length, 2);
  req.open('GET', '/graphql/query'); req.send(); assert.equal(s.pending.length, 2);
  s.configure(false); req.open('GET', sound); req.send(); assert.equal(s.pending.length, 2);
});

test('native XHR timeout includes waiting for a cached response', async () => {
  const s = setup(); s.configure(true);
  const req = new s.Xhr(); req.open('GET', sound); req.timeout = 1;
  let timedOut = 0; req.addEventListener('timeout', () => { timedOut++; });
  req.send(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(timedOut, 1);
  assert.equal(s.pending[0]!.signal.aborted, true);
  s.pending[0]!.resolve(new Response('audio')); await s.settle();
  assert.equal(req.sent, 0);
});

test('a deletion requested while pages are closed is applied once when an Entry page opens', async () => {
  const stored = new Map<string, string>();
  let deleted = 0;
  const context = vm.createContext({
    localStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) },
    onAssetCacheChange() {}, setTimeout() { return 1; },
    clearAssetCache: async () => { deleted++; },
  });
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/page/cache.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  await vm.runInContext('applyCacheClear(123)', context);
  assert.equal(deleted, 1);
  await vm.runInContext('applyCacheClear(123)', context);
  assert.equal(deleted, 1, 'reloading does not delete files saved since the last deletion');
  await vm.runInContext('applyCacheClear(456)', context);
  assert.equal(deleted, 2);
  await vm.runInContext('applyCacheClear(456, true)', context);
  assert.equal(deleted, 3, 'live frames also invalidate their own pending writes');
});

test('the native frame uses the shared cache preference at startup and on live changes', async () => {
  let changed!: (changes: Record<string, unknown>, area: string) => void;
  let finishSettings!: (settings: unknown) => void;
  const settings = new Promise(resolve => { finishSettings = resolve; });
  const scripts: Array<{ dataset: Record<string, string>; onload(): void }> = [];
  const messages: Array<{ on: boolean }> = [];
  const context = vm.createContext({
    CACHE_KEY: 'assetCache', CACHE_CLEAR_KEY: 'assetCacheClear', CACHE_SIZE_KEY: 'assetCacheSize',
    api: { storage: { onChanged: { addListener: (fn: typeof changed) => { changed = fn; } } },
      runtime: { getURL: (path: string) => path } },
    readSettings: () => settings,
    document: { createElement: () => ({ dataset: {} }), head: { append: (script: typeof scripts[number]) => { scripts.push(script); } } },
    window: { addEventListener() {}, postMessage: (message: typeof messages[number]) => { messages.push(message); } },
    location: { origin: 'https://playentry.org' },
  });
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/native-content.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  changed({ assetCache: { newValue: true } }, 'local');
  finishSettings({ cache: false, cacheClear: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scripts[0]!.dataset.entropyNativeCache, '1');
  scripts[0]!.onload();
  assert.equal(messages.at(-1)!.on, true);
  changed({ assetCache: { newValue: false } }, 'local');
  assert.equal(messages.at(-1)!.on, false);
});

test('workspace bridges live runner settings and saves without echoing its own replies', async () => {
  let changed!: (changes: Record<string, unknown>, area: string) => void;
  let receive!: (event: any) => void;
  let finishSettings!: (settings: unknown) => void;
  const scripts: any[] = [], messages: any[] = [], saves: any[] = [];
  const window = { addEventListener: (_type: string, fn: typeof receive) => { receive = fn; },
    postMessage: (message: unknown) => { messages.push(message); } };
  const context = vm.createContext({
    CACHE_KEY: 'assetCache', CACHE_CLEAR_KEY: 'assetCacheClear', CACHE_SIZE_KEY: 'assetCacheSize',
    ENABLED_KEY: 'enabled', SVG_KEY: 'svg', ESCAPE_KEY: 'grabEscape',
    api: { storage: { onChanged: { addListener: (fn: typeof changed) => { changed = fn; } } },
      runtime: { getURL: (path: string) => path, sendMessage: async (message: unknown) => { saves.push(message); return { ok: true }; } } },
    readSettings: () => new Promise(resolve => { finishSettings = resolve; }),
    document: { createElement: () => ({ dataset: {} }), head: { append: (...items: any[]) => { scripts.push(...items); } } },
    window, location: { origin: 'https://playentry.org', pathname: '/ws/work' },
  });
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/native-content.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  changed({ enabled: { newValue: false }, assetCache: { newValue: true } }, 'local');
  finishSettings({ enabled: true, svg: true, escape: true, cache: false, cacheClear: 0 });
  await new Promise(resolve => setImmediate(resolve));
  const editor = scripts.find(script => script.src === 'page/editor.js');
  assert.ok(editor);
  assert.ok(scripts.some(script => script.href === 'player.css'));
  editor.onload();
  assert.equal(messages.at(-1).__entropy, 'editor-settings');
  assert.equal(messages.at(-1).enabled, false, 'late initial settings cannot re-enable the runner');
  assert.equal(messages.at(-1).cache, true);
  changed({ enabled: { newValue: true }, svg: { newValue: false } }, 'local');
  assert.equal(messages.at(-1).enabled, true);
  assert.equal(messages.at(-1).svg, false);
  receive({ source: window, data: { __entropy: 'store-get', id: 5 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves.length, 1);
  assert.equal(messages.at(-1).__entropy, 'store-answer');
  receive({ source: window, data: messages.at(-1) });
  assert.equal(saves.length, 1);
});
