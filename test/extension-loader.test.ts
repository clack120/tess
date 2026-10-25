import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { stripTypes } from '@entropy/core/strip-types';

const test = 'Bun' in globalThis ? nodeTest.skip : nodeTest;
async function setup(t: any, failSettings = false, early = false) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { url: 'https://playentry.org/ws/work', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window as any;
  const messages: any[] = [];
  w.api = { runtime: { getURL: (file: string) => '/extension/' + file },
    storage: { onChanged: { addListener() {} }, local: { async set() {} } } };
  w.readSettings = async () => {
    if (failSettings) throw new Error('storage unavailable');
    return { enabled: true, svg: true, escape: false, cache: true, cacheClear: 0 };
  };
  w.postMessage = (data: any) => messages.push(data);
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/native-content.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  if (early) w.document.documentElement.remove();
  w.eval(`(() => { const CACHE_KEY='assetCache', CACHE_CLEAR_KEY='assetCacheClear', CACHE_SIZE_KEY='assetCacheSize', ENABLED_KEY='enabled', SVG_KEY='svg', ESCAPE_KEY='grabEscape'; ${source} })()`);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return { w, messages, settle, runner: () => w.document.querySelector('script[src="/extension/page/editor.js"]') };
}

test('editor loader waits for the document root and sends settings only after the page module loads', async t => {
  const s = await setup(t, false, true);
  assert.equal(s.runner(), null);
  s.w.document.append(s.w.document.createElement('html')); await s.settle();
  assert.ok(s.runner()); assert.equal(s.messages.length, 0);
  assert.equal(s.w.document.documentElement.dataset.entropyEditorLoader, 'loading');
  s.runner().dispatchEvent(new s.w.Event('load'));
  assert.equal(s.w.document.documentElement.dataset.entropyEditorLoader, 'ready');
  assert.equal(s.messages[0].__entropy, 'editor-settings'); assert.equal(s.messages[0].cache, true);
});

test('storage failure does not silently prevent editor injection, and module failure is identifiable', async t => {
  const s = await setup(t, true);
  assert.ok(s.runner());
  s.runner().dispatchEvent(new s.w.Event('error'));
  assert.equal(s.w.document.documentElement.dataset.entropyEditorLoader, 'error');
  assert.equal(s.messages.length, 0);
  s.runner().dispatchEvent(new s.w.Event('load'));
  assert.equal(s.messages[0].enabled, true);
});
