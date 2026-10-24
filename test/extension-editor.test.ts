import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { stripTypes } from '@entropy/core/strip-types';

const test = 'Bun' in globalThis ? nodeTest.skip : nodeTest;

async function setup(t: any, delay = false) {
  const dom = new JSDOM('<!doctype html><div style="position:relative"><canvas id="entryCanvas"></canvas></div>',
    { url: 'https://playentry.org/ws/work', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  t.after(() => w.close());
  let nativeTicks = 0, starts = 0, stops = 0;
  const work = { objects: [{ sprite: { pictures: [{ fileurl: 'original' }] } }], variables: [{ id: 'score', value: 9 }], scenes: [] };
  const boots: any[] = [], handles: any[] = [], reloads: any[] = [];
  let release!: () => void;
  const gate = delay ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const engine = {
    state: 'stop', runButton: {},
    toggleRun() { starts++; this.state = 'run'; this.raiseEvent(); },
    async toggleStop() { stops++; this.state = 'stop'; },
    togglePause() { this.state = this.state === 'pause' ? 'run' : 'pause'; },
    computeFunction() { nativeTicks++; }, raiseEvent() { nativeTicks++; },
    update() { this.computeFunction(); },
    raiseKeyEvent() { nativeTicks++; }, raiseEventOnEntity() { nativeTicks++; },
  };
  const originalRun = engine.toggleRun, originalTick = engine.computeFunction;
  w.Entry = { type: 'workspace', engine, exportProject: () => work, scene: { selectedScene: { id: 'second' } },
    getMainWS: () => ({ syncCode() {} }) };
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.withAssetUrls = (project: any) => { project.objects[0].sprite.pictures[0].fileurl = 'normalized'; return project; };
  w.signedInUser = () => null;
  w.loadModule = async (specifier: string) => {
    if (specifier.endsWith('boot.ts')) return { boot: async (options: any) => {
      boots.push(options); await gate;
      const handle = { disposed: false, vm: { state: 'stop', scene: '', unknownBlocks: new Map(), readStore() {},
        setStartScene(scene: string) { this.scene = scene; } },
        start() { this.vm.state = 'run'; }, pause() { this.vm.state = 'pause'; },
        stop() { this.vm.state = 'stop'; },
        async reload(project: any) { reloads.push(project); },
        dispose() { this.disposed = true; }, relayout() {} };
      handles.push(handle); return handle;
    } };
    if (specifier.endsWith('player.ts')) return { ensureStageStyle() {} };
    if (specifier.endsWith('save-bridge.ts')) return { bridgeSaveStore() { return {}; } };
    return { CloudClient: class { async connect() {} dispose() {} setChangeListener() {} } };
  };
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/page/editor.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/\bimport\(/g, 'loadModule(');
  w.eval(source);
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const configure = (enabled: boolean, cache = true) => w.dispatchEvent(new w.MessageEvent('message',
    { source: w, data: { __entropy: 'editor-settings', enabled, cache, svg: true, escape: true } }));
  configure(true); await settle();
  return { w, engine, work, boots, handles, reloads, settle, configure, release, originalRun, originalTick,
    counts: () => ({ nativeTicks, starts, stops }) };
}

test('editor runs current unsaved data and selected scene once, then restores native editing and execution', async t => {
  const s = await setup(t);
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.boots.length, 1);
  assert.equal(s.boots[0].project.variables[0].value, 9);
  assert.equal(s.handles[0].vm.scene, 'second');
  assert.equal(s.work.objects[0].sprite.pictures[0].fileurl, 'original', 'the editor model is never normalized in place');
  s.engine.update(); s.engine.computeFunction(); s.engine.raiseKeyEvent(); s.engine.raiseEventOnEntity();
  assert.equal(s.counts().nativeTicks, 0, 'native blocks do not run alongside Entropy');
  s.engine.toggleRun(); assert.equal(s.boots.length, 1);
  s.engine.togglePause(); assert.equal(s.handles[0].vm.state, 'pause');
  s.engine.toggleRun(); assert.equal(s.handles[0].vm.state, 'run');
  s.configure(true, false); await s.settle();
  assert.equal(s.boots[0].cacheAssets, false);
  assert.equal(s.handles[0].disposed, false, 'cache toggles keep the session');
  await s.engine.toggleStop();
  assert.equal(s.w.document.querySelector('.entropy-editor-player').hidden, true);
  assert.equal(s.w.document.getElementById('entryCanvas').style.visibility, '');
  s.work.variables[0].value = 27;
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.reloads[0].variables[0].value, 27, 'each run exports fresh edits');
  assert.equal(s.boots.length, 1, 'edits reuse the renderer and decoded assets');
  s.configure(false); await s.settle();
  assert.equal(s.handles[0].disposed, true);
  assert.equal(s.engine.toggleRun, s.originalRun);
  assert.equal(s.engine.computeFunction, s.originalTick);
  s.engine.toggleRun(); s.engine.computeFunction();
  assert.equal(s.counts().nativeTicks, 2);
});

test('stopping or disabling during editor asset loading cannot start a late player', async t => {
  const s = await setup(t, true);
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.boots.length, 1);
  s.configure(false); await s.settle();
  assert.equal(s.boots[0].signal.aborted, true);
  s.release(); await s.settle();
  assert.equal(s.handles[0].disposed, true);
  assert.equal(s.handles[0].vm.state, 'stop');
  assert.equal(s.w.document.querySelector('.entropy-editor-player'), null);
});

test('enabling Entropy stops a running native editor before the next run', async t => {
  const s = await setup(t);
  s.configure(false); await s.settle();
  s.engine.toggleRun();
  assert.equal(s.engine.state, 'run');
  s.configure(true); await s.settle();
  assert.equal(s.engine.state, 'stop');
  assert.equal(s.counts().stops, 1);
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.handles[0].vm.state, 'run');
  assert.equal(s.counts().nativeTicks, 1);
});

test('enabling preloads once and disabling releases the prepared player without a run', async t => {
  const s = await setup(t);
  await new Promise(resolve => setTimeout(resolve, 650)); await s.settle();
  assert.equal(s.boots.length, 1);
  assert.equal(s.counts().starts, 0);
  assert.equal(s.handles[0].vm.state, 'stop');
  assert.equal(s.w.document.querySelector('.entropy-editor-player').hidden, true);
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.boots.length, 1);
  assert.equal(s.handles[0].vm.state, 'run');
  await s.engine.toggleStop();
  assert.equal(s.handles[0].disposed, false);
  s.configure(false); await s.settle();
  assert.equal(s.handles[0].disposed, true);
  assert.equal(s.w.document.querySelector('.entropy-editor-player'), null);
});

test('moving blocks on the board keeps the prepared runner, while code edits reload it', async t => {
  const s = await setup(t);
  const object = s.work.objects[0] as any;
  object.entity = { x: 10, y: 20 };
  object.script = '[[{"id":"a","x":5,"y":6,"type":"when_run_button_click","params":["\\"x\\":1,\\"y\\":2"]}]]';
  s.engine.toggleRun(); await s.settle(); await s.engine.toggleStop();
  object.script = object.script.replace('"x":5,"y":6', '"x":-40.5,"y":1e3');
  s.engine.toggleRun(); await s.settle(); await s.engine.toggleStop();
  assert.equal(s.reloads.length, 0, 'board coordinates are not part of the runnable work');
  object.entity.x = 11;
  s.engine.toggleRun(); await s.settle(); await s.engine.toggleStop();
  assert.equal(s.reloads.length, 1, 'object positions still matter');
  assert.equal(s.reloads[0].objects[0].entity.x, 11);
  assert.match(s.reloads[0].objects[0].script, /\\"x\\":1,\\"y\\":2/, 'text that looks like a position is kept');
  object.script = object.script.replace('when_run_button_click', 'when_some_key_pressed');
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.reloads.length, 2);
});
