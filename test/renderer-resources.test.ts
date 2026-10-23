import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypes } from '@entropy/core/strip-types';

function setup() {
  const cache = new Map<string, any>(), aliases = new Set<string>(), unloads: string[] = [];
  const pending: Array<() => void> = [];
  let held = false, holdUnload = false;
  const unloadsPending: Array<() => void> = [];
  const assets = {
    resolver: { removeAlias: (src: string) => aliases.delete(src) },
    async load({ src }: { src: string }) {
      aliases.add(src);
      if (held) await new Promise<void>(resolve => pending.push(resolve));
      if (!cache.has(src)) cache.set(src, { source: { resource: {} }, width: 10, height: 10, destroyed: false });
      return cache.get(src);
    },
    async unload(src: string) {
      unloads.push(src);
      if (holdUnload) await new Promise<void>(resolve => unloadsPending.push(resolve));
      const texture = cache.get(src); if (texture) texture.destroyed = true;
      cache.delete(src);
    },
  };
  class Container { children: unknown[] = []; destroy() {} }
  const context = vm.createContext({ URL, AbortController, document: { baseURI: 'https://example.test/' },
    Application: class { renderer = { resolution: 1 }; destroy() {} }, Container, TextStyle: class {}, Texture: { EMPTY: {} }, Assets: assets,
    Color: class { alpha = 1; toNumber() { return 0; } }, svgSharpness: () => 2,
    stage: { scale: 1, worldWidth: 640, worldHeight: 360 }, MAX_SHARPNESS: 6,
  });
  const source = stripTypes(fs.readFileSync(new URL('../packages/vm/src/render/renderer.ts', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${source}\nthis.Engine=PixiRenderer;this.colors=colorCache;this.color=usableColor;`, context);
  const create = () => { const engine = new context.Engine(); engine.ready = true; return engine; };
  const picture = (id = 'p', fileurl = '/picture.png') => ({ id, fileurl, imageType: 'png', dimension: { width: 10, height: 10 } });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { create, picture, cache, aliases, unloads, pending, context, settle, unloadsPending,
    hold: () => { held = true; }, holdUnload: () => { holdUnload = true; } };
}

test('raster textures survive other runners and leave the shared cache when the last runner closes', async () => {
  const { create, picture, cache, aliases, unloads, settle } = setup();
  for (let i = 0; i < 40; i++) {
    const first = create(), second = create();
    await Promise.all([first.loadPicture(picture()), second.loadPicture(picture('other', 'https://example.test/picture.png'))]);
    assert.equal(cache.size, 1);
    const texture = cache.values().next().value;
    first.destroy(); await settle(); assert.equal(texture.destroyed, false);
    second.destroy(); await settle(); assert.equal(texture.destroyed, true);
    assert.equal(cache.size, 0); assert.equal(aliases.size, 0);
  }
  assert.equal(unloads.length, 40);
});

test('a late costume load cannot repopulate a destroyed renderer or retain its global texture', async () => {
  const { create, picture, cache, aliases, pending, hold, settle } = setup();
  hold(); const renderer = create(); const job = renderer.loadPicture(picture());
  await settle(); assert.equal(pending.length, 1); renderer.destroy(); pending[0]!(); await job; await settle();
  assert.equal(renderer.textures.size, 0); assert.equal(renderer.images.size, 0);
  assert.equal(cache.size, 0); assert.equal(aliases.size, 0);
});

test('a new runner waits for old unloads of the same URL before acquiring a replacement texture', async () => {
  const { create, picture, cache, unloadsPending, holdUnload, settle } = setup();
  const first = create(); await first.loadPicture(picture());
  const old = cache.values().next().value;
  holdUnload(); first.destroy(); await settle();
  const second = create(); const job = second.loadPicture(picture()); await settle();
  assert.equal(second.textures.size, 0);
  unloadsPending[0]!(); await job;
  assert.notEqual(cache.values().next().value, old);
  assert.equal(second.textures.get('p').destroyed, false);
  second.destroy(); await settle(); unloadsPending[1]!(); await settle(); assert.equal(cache.size, 0);
});

test('dynamic pen colors have a bounded cache and reset drops queued entity references', () => {
  const { context, create } = setup();
  for (let i = 0; i < 10000; i++) context.color(String(i));
  assert.equal(context.colors.size, 1024);
  const renderer = create(); renderer.penDirty.add({}); renderer.reset();
  assert.equal(renderer.penDirty.size, 0); renderer.destroy();
});

test('reset releases owned Graphics contexts along with their containing entity tree', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../packages/vm/package.json', import.meta.url));
  const { Container, Graphics } = await import(require.resolve('pixi.js'));
  const { PixiRenderer } = await import('../packages/vm/src/render/renderer.ts');
  const renderer = new PixiRenderer();
  const root = new Container(), graphic = new Graphics();
  const context = graphic.context;
  root.addChild(graphic);
  (renderer as any).views.set({}, { root, stamps: [] });
  renderer.reset();
  assert.equal(graphic.destroyed, true); assert.equal(context.destroyed, true);
});
