import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypes } from '@tess/core/strip-types';
import { JSDOM } from 'jsdom';

function setup(t: any, phase: 'init' | 'save' | 'assets') {
  const dom = new JSDOM('<!doctype html><main></main>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  let finish: () => void = () => {};
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const calls = { destroyed: 0, stopped: 0, closed: 0, preloaded: 0, afterLoad: 0 };
  class Renderer {
    overlayView = { bind() {} };
    static costumeCount() { return 1; }
    async init() { if (phase === 'init') await blocked; }
    async preload() { calls.preloaded++; if (phase === 'assets') await blocked; }
    destroy() { calls.destroyed++; }
    flush() { calls.afterLoad++; }
  }
  const context = vm.createContext({ document: dom.window.document, window: dom.window,
    navigator: { userAgent: '', maxTouchPoints: 0 }, AbortController, PixiRenderer: Renderer,
    WebAudioEngine: class { async preload() {} close() { calls.closed++; } }, EntryTtsEngine: class {}, EntryTranslator: class {},
    Vm: class { targets = []; currentSceneId = ''; save = { host: null, async load() { if (phase === 'save') await blocked; } };
      load() {} stop() { calls.stopped++; } },
  });
  const source = stripTypes(fs.readFileSync(new URL('../packages/tessvm/src/web/boot.ts', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${source}\nthis.boot=boot`, context);
  const start = (signal: AbortSignal) => context.boot({ signal, project: {}, store: null, saveStore: null });
  return { start, finish, calls, document: dom.window.document };
}

for (const phase of ['init', 'save', 'assets'] as const) {
  test(`aborting boot during ${phase} releases resources without installing input or exposing a stale VM`, async t => {
    const { start, finish, calls, document } = setup(t, phase);
    const controller = new AbortController();
    const job = start(controller.signal);
    const rejected = assert.rejects(job, (error: any) => error.name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    if (phase !== 'init') {
      await rejected;
      assert.equal(document.querySelector('.tessvm-stage'), null, 'asset/save stalls cannot keep the canvas alive');
    }
    finish(); await rejected;
    assert.equal(calls.destroyed, 1); assert.equal(calls.afterLoad, 0);
    assert.equal(calls.closed, phase === 'init' ? 0 : 1);
    assert.equal(calls.stopped, phase === 'init' ? 0 : 1);
    assert.equal(document.querySelector('.tessvm-stage'), null);
    controller.abort(); assert.equal(calls.destroyed, 1);
  });
}
