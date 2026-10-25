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
    loadYield: () => () => undefined,
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

test('project edits keep unchanged textures and release only replaced or removed costumes', async () => {
  const { create, picture, cache, unloads, settle } = setup();
  const renderer = create();
  renderer.setSvgBudget = () => {};
  const first = picture('first', '/first.png'), second = picture('second', '/second.png');
  await renderer.preload([{ pictures: [first, second] }]);
  const kept = renderer.textures.get('first'), replaced = renderer.textures.get('second');
  await renderer.preload([{ pictures: [first, { ...second, fileurl: '/new.png' }] }]);
  await settle();
  assert.equal(renderer.textures.get('first'), kept);
  assert.notEqual(renderer.textures.get('second'), replaced);
  assert.equal(replaced.destroyed, true);
  assert.deepEqual(unloads, ['https://example.test/second.png']);
  await renderer.preload([{ pictures: [first] }]); await settle();
  assert.equal(renderer.textures.size, 1);
  assert.equal(renderer.images.size, 1);
  assert.equal(renderer.pictures.size, 1);
  assert.equal(cache.size, 1);
  renderer.destroy(); await settle(); assert.equal(cache.size, 0);
});

test('entering an unloaded scene refreshes static costumes and never stretches a stale costume while loading', async () => {
  const s = setup(), renderer = s.create();
  renderer.options.lazyAssets = true;
  renderer.app.renderer.render = () => {};
  renderer.applyEffects = () => {};
  const first = s.picture('first'), second = s.picture('second', '/second.png');
  const entity = { target: { sceneId: 'second' }, picture: first, visible: true, dirty: true,
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, effect: { alpha: 1 }, width: 10, height: 10, regX: 0, regY: 0 };
  const sprite: any = { texture: {}, visible: true };
  const view = { root: { position: { set() {} }, scale: { set() {} }, pivot: { set() {} }, destroy() {} }, sprite, stamps: [] };
  renderer.views.set(entity, view);
  renderer.sceneLayers.set('first', { visible: true, destroy() {} });
  renderer.sceneLayers.set('second', { visible: false, destroy() {} });
  renderer.flush(); assert.equal(entity.dirty, false); assert.equal(renderer.textures.size, 0);
  renderer.setScene('second'); assert.equal(entity.dirty, true);
  renderer.flush(); await s.settle(); renderer.flush();
  const kept = sprite.texture;
  assert.equal(kept, renderer.textures.get('first')); assert.equal(sprite.visible, true);
  s.hold(); entity.picture = second; entity.width = 300; entity.dirty = true;
  renderer.flush(); await s.settle(); assert.equal(sprite.visible, false);
  entity.picture = first; entity.width = 10; entity.dirty = true;
  renderer.flush(); assert.equal(sprite.visible, true); assert.equal(sprite.texture, kept);
  s.pending[0]!(); await s.settle();
  entity.picture = second; entity.width = 300; entity.dirty = true; renderer.flush();
  assert.equal(sprite.visible, true); assert.equal(sprite.texture, renderer.textures.get('second'));
  assert.equal(sprite.width, 300, 'the requested width is applied to the loaded costume');
  renderer.destroy(); await s.settle();
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

test('the renderer counts completed draws rather than idle or failed flushes', async () => {
  const { PixiRenderer } = await import('../packages/vm/src/render/renderer.ts');
  const renderer = new PixiRenderer();
  renderer.flush();
  assert.equal(renderer.renderCount, 0);
  (renderer as any).ready = true;
  (renderer.app as any).renderer = { render() {} };
  renderer.flush(); renderer.flush();
  assert.equal(renderer.renderCount, 2);
  (renderer.app as any).renderer.render = () => { throw new Error('draw failed'); };
  assert.throws(() => renderer.flush(), /draw failed/);
  assert.equal(renderer.renderCount, 2);
});
