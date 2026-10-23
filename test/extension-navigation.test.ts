import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { stripTypes } from '@tess/core/strip-types';

async function setup(t: any) {
  const dom = new JSDOM('<!doctype html><div id="wrap" style="position:static"><iframe src="/iframe/first"></iframe></div>',
    { url: 'https://example.test/project/first', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const mounted: Array<{ id: string; disposed: boolean; host: HTMLElement }> = [];
  let settings: (changes: Record<string, unknown>, area: string) => void = () => {};
  (w as any).api = { runtime: { getURL: (file: string) => '/extension/' + file },
    storage: { onChanged: { addListener: (listener: typeof settings) => { settings = listener; } } } };
  (w as any).readSettings = async () => ({ enabled: true, svg: true });
  (w as any).mountPlayer = (host: HTMLElement, id: string) => {
    const item = { id, disposed: false, host }; mounted.push(item);
    const root = w.document.createElement('div'); root.className = 'tessvm-player'; host.append(root);
    return { dispose() { assert.equal(item.disposed, false); item.disposed = true; root.remove(); } };
  };
  // Deliver content-to-page messages in order without jsdom's missing event.source.
  w.postMessage = ((data: unknown) => w.queueMicrotask(() => w.dispatchEvent(new w.MessageEvent('message', { data, source: w as never })))) as never;
  const source = (file: string) => stripTypes(fs.readFileSync(new URL('../packages/extension/src/' + file, import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  w.eval(`(() => { ${source('page/main.ts')} })()`);
  w.eval(`(() => { const ENABLED_KEY='enabled', SVG_KEY='svg', CACHE_KEY='assetCache', CACHE_SIZE_KEY='assetCacheSize', ESCAPE_KEY='grabEscape'; ${source('content.ts')} })()`);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  t.after(() => w.close());
  return { w, mounted, settle, settings, frame: w.document.querySelector('iframe')!,
    scan: async () => { w.postMessage({ __tessvm: 'scan' }); await settle(); } };
}

test('removing an Entry iframe removes its sibling host and stops its player before the next work', async t => {
  const { w, frame, mounted, settle } = await setup(t);
  assert.equal(mounted.length, 1);
  frame.remove(); await settle();
  assert.equal(w.document.querySelectorAll('.tessvm-host').length, 0);
  assert.equal(mounted[0]!.disposed, true);
  const next = w.document.createElement('iframe'); next.src = '/iframe/second';
  w.document.getElementById('wrap')!.append(next); await settle();
  assert.deepEqual(mounted.filter(item => !item.disposed).map(item => item.id), ['second']);
  assert.equal(w.document.querySelectorAll('.tessvm-player').length, 1);
});

test('reusing the same iframe for another work replaces its player and restores the latest original URL', async t => {
  const { w, frame, mounted, settle, settings } = await setup(t);
  for (const id of ['second', 'first', 'second']) {
    frame.src = '/iframe/' + id; await settle();
    assert.deepEqual(mounted.filter(item => !item.disposed).map(item => item.id), [id]);
    assert.equal(frame.getAttribute('src'), 'about:blank');
    assert.equal(w.document.querySelectorAll('.tessvm-host').length, 1);
  }
  settings({ enabled: { newValue: false } }, 'local'); await settle();
  assert.equal(frame.getAttribute('src'), '/iframe/second');
  assert.equal(w.document.querySelectorAll('.tessvm-host').length, 0);
  assert.equal(mounted.every(item => item.disposed), true);
  settings({ enabled: { newValue: true } }, 'local'); await settle();
  assert.deepEqual(mounted.filter(item => !item.disposed).map(item => item.id), ['second']);
});

test('detached and reinserted iframes are captured again and unrelated iframe URLs release the player', async t => {
  const { w, frame, mounted, settle } = await setup(t);
  const wrap = frame.parentElement!;
  frame.remove(); await settle(); wrap.append(frame); await settle();
  assert.deepEqual(mounted.filter(item => !item.disposed).map(item => item.id), ['first']);
  frame.src = '/other'; await settle();
  assert.equal(w.document.querySelectorAll('.tessvm-host').length, 0);
  assert.equal(mounted.every(item => item.disposed), true);
  assert.equal(frame.style.visibility, '');
  assert.equal(frame.getAttribute('src'), '/other');
});

test('the page runner replaces a host whose project metadata changes and ignores repeated scans', async t => {
  const { w, frame, mounted, scan } = await setup(t);
  const host = w.document.querySelector<HTMLElement>('.tessvm-host')!;
  host.dataset.tessvmProject = 'other'; await scan();
  assert.equal(mounted[0]!.disposed, true);
  assert.equal(mounted.at(-1)!.id, 'other');
  await scan(); assert.equal(mounted.length, 2);
  frame.remove(); await scan();
  assert.equal(mounted.every(item => item.disposed), true);
});
