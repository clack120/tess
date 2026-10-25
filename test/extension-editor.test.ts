import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { stripTypes } from '@entropy/core/strip-types';
import { compactLargeProject, PROJECT_JSON_LIMIT } from '../packages/extension/src/page/project-compact.ts';
import { beginLiveEditing } from '../packages/extension/src/page/editor-live.ts';

const test = 'Bun' in globalThis ? nodeTest.skip : nodeTest;

async function setup(t: any, delay = false) {
  const dom = new JSDOM('<!doctype html><div style="position:relative"><canvas id="entryCanvas"></canvas></div>',
    { url: 'https://playentry.org/ws/work', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  t.after(() => w.close());
  let nativeTicks = 0, starts = 0, stops = 0, exports = 0;
  let cloudClients = 0, cloudConnects = 0, cloudDisposals = 0;
  let audioResumes = 0, audioCloses = 0;
  w.AudioContext = class {
    async resume() { audioResumes++; }
    async close() { audioCloses++; }
  };
  const changeListeners = new Set<() => void>();
  const scenes = [{ id: 'first' }, { id: 'second' }];
  let startScene = scenes[1]!;
  const work = { objects: [{ sprite: { pictures: [{ fileurl: 'original' }] } }], variables: [{ id: 'score', value: 9 }], scenes: [] };
  const boots: any[] = [], handles: any[] = [], reloads: any[] = [];
  let release!: () => void;
  const gate = delay ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const engine = {
    state: 'stop', runButton: {},
    toggleRun() { starts++; startScene = w.Entry.scene.selectedScene; this.state = 'run'; this.raiseEvent(); },
    async toggleStop() { stops++; this.state = 'stop'; w.Entry.scene.selectedScene = startScene; },
    togglePause() { this.state = this.state === 'pause' ? 'run' : 'pause'; },
    computeFunction() { nativeTicks++; }, raiseEvent() { nativeTicks++; },
    update() { this.computeFunction(); },
    raiseKeyEvent() { nativeTicks++; }, raiseEventOnEntity() { nativeTicks++; },
  };
  const originalRun = engine.toggleRun, originalTick = engine.computeFunction;
  w.Entry = { type: 'workspace', engine, exportProject: () => { exports++; return work; },
    creationChangedEvent: { attach(_owner: unknown, listener: () => void) {
      changeListeners.add(listener); return { destroy() { changeListeners.delete(listener); } };
    } }, scene: { selectedScene: scenes[1], getSceneById: (id: string) => scenes.find(scene => scene.id === id),
      selectScene(scene: typeof scenes[number]) { this.selectedScene = scene; } },
    getMainWS: () => ({ syncCode() {} }) };
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.withAssetUrls = (project: any) => ({ ...project, objects: project.objects.map((object: any) => ({
    ...object, sprite: { ...object.sprite, pictures: object.sprite.pictures.map((picture: any) => (
      { ...picture, fileurl: 'normalized' })) },
  })) });
  w.signedInUser = () => null;
  w.compactLargeProject = compactLargeProject;
  w.PROJECT_JSON_LIMIT = PROJECT_JSON_LIMIT;
  w.beginLiveEditing = beginLiveEditing;
  w.beginActorEditing = () => undefined;
  w.loadModule = async (specifier: string) => {
    if (specifier.endsWith('boot.ts')) return { boot: async (options: any) => {
      boots.push(options); await gate;
      const handle = { disposed: false, audio: { unlock() {} }, vm: { state: 'stop', scene: '', unknownBlocks: new Map(), readStore() {},
        setStartScene(scene: string) { this.scene = scene; } },
        start() { this.vm.state = 'run'; }, pause() { this.vm.state = 'pause'; },
        stop() { this.vm.state = 'stop'; },
        async reload(project: any) { reloads.push(project); },
        dispose() { this.disposed = true; }, relayout() {} };
      handles.push(handle); return handle;
    } };
    if (specifier.endsWith('player.ts')) return { ensureStageStyle() {} };
    if (specifier.endsWith('save-bridge.ts')) return { bridgeSaveStore() { return {}; } };
    return { CloudClient: class {
      constructor() { cloudClients++; }
      async connect() { cloudConnects++; }
      dispose() { cloudDisposals++; }
      setChangeListener() {}
    } };
  };
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/page/editor.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/\bimport\(/g, 'loadModule(');
  w.eval(source);
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const configure = (enabled: boolean, cache = true) => w.dispatchEvent(new w.MessageEvent('message',
    { source: w, data: { __entropy: 'editor-settings', enabled, cache, svg: true, escape: true } }));
  configure(true); await settle();
  return { w, engine, work, boots, handles, reloads, settle, configure, release, originalRun, originalTick,
    change: () => { for (const listener of changeListeners) listener(); },
    counts: () => ({ nativeTicks, starts, stops, exports, cloudClients, cloudConnects, cloudDisposals, audioResumes, audioCloses }) };
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

test('runtime scene changes follow the native editor focus and stop restores the starting scene', async t => {
  const s = await setup(t);
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.boots[0].scene, 'second', 'only the selected scene needs its first costumes loaded');
  const vm = s.handles[0].vm;
  vm.onSceneChange('first'); assert.equal(s.w.Entry.scene.selectedScene.id, 'first');
  vm.onSceneChange('missing'); assert.equal(s.w.Entry.scene.selectedScene.id, 'first');
  const original = s.w.Entry;
  s.w.Entry = { ...original, scene: { selectedScene: { id: 'unrelated' } } };
  vm.onSceneChange('second'); assert.equal(original.scene.selectedScene.id, 'first', 'a previous project cannot select a scene in its replacement');
  s.w.Entry = original;
  await s.engine.toggleStop(); assert.equal(s.w.Entry.scene.selectedScene.id, 'second');
  vm.onSceneChange('first'); assert.equal(s.w.Entry.scene.selectedScene.id, 'second', 'late notifications cannot move a stopped editor');
});

test('temporary actor controls attach after VM start and detach before native stop or disabling the runner', async t => {
  const s = await setup(t);
  const events: string[] = [];
  s.w.beginActorEditing = (_entry: any, handle: any) => {
    assert.equal(handle.vm.state, 'run'); events.push('attach');
    return { sync() {}, restore() {
      assert.notEqual(handle.vm.state, 'stop');
      assert.notEqual(s.engine.state, 'stop'); events.push('restore');
    } };
  };
  s.engine.toggleRun(); await s.settle();
  await s.engine.toggleStop();
  s.engine.toggleRun(); await s.settle();
  s.configure(false); await s.settle();
  assert.deepEqual(events, ['attach', 'restore', 'attach', 'restore']);
});

test('the native mouse readout follows VM coordinates with one decimal while running and paused', async t => {
  const s = await setup(t);
  const view = s.w.document.createElement('div'); view.className = 'entryMouseViewWorkspace_w entryHide';
  const input = s.w.document.createElement('input'); view.append(input); s.w.document.body.append(view);
  Object.assign(s.engine, { mouseView: view, mouseViewInput: input });
  s.engine.toggleRun(); await s.settle();
  const root = s.w.document.querySelector('.entropy-editor-player');
  const stage = s.w.document.createElement('div'); root.append(stage);
  const vm = s.handles[0].vm;
  stage.addEventListener('pointermove', () => { vm.mouseX = -12.345; vm.mouseY = 0; });
  stage.dispatchEvent(new s.w.Event('pointermove', { bubbles: true }));
  assert.equal(input.value, 'X : -12.3, Y : 0.0');
  assert.equal(vm.mouseX, -12.345, 'formatting never rounds the runtime sensor value');
  assert.equal(view.classList.contains('entryHide'), false);
  s.engine.togglePause(); vm.mouseX = 2.36; vm.mouseY = -8.76;
  root.dispatchEvent(new s.w.Event('pointermove'));
  assert.equal(input.value, 'X : 2.4, Y : -8.8');
  root.dispatchEvent(new s.w.Event('pointerleave')); assert.equal(view.classList.contains('entryHide'), true);
  assert.equal(s.counts().nativeTicks, 0);
  await s.engine.toggleStop(); input.value = 'native';
  root.dispatchEvent(new s.w.Event('pointermove')); assert.equal(input.value, 'native');
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

test('a cold run unlocks audio in the click handler and stopping aborts unfinished preparation', async t => {
  const s = await setup(t, true);
  s.engine.toggleRun();
  assert.equal(s.counts().audioResumes, 1, 'resume is called before asynchronous module loading');
  await s.settle();
  await s.engine.toggleStop();
  assert.equal(s.boots[0].signal.aborted, true);
  assert.equal(s.counts().audioCloses, 1);
  assert.equal(s.w.document.querySelector('.entropy-editor-player'), null);
  s.release(); await s.settle();
  assert.equal(s.handles[0].disposed, true);
  assert.equal(s.handles[0].vm.state, 'stop');
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

test('native decoded audio is reused only when the queued file URL still matches the project', async t => {
  const s = await setup(t);
  s.engine.toggleRun(); await s.settle();
  let src = '/old.wav';
  const buffer = { duration: 1, getChannelData() { return new Float32Array(1); } };
  s.w.Entry.soundQueue = { getItem: () => ({ src }), getResult: () => buffer };
  const read = s.boots[0].readAudioBuffer;
  assert.equal(read({ id: 'tone', fileurl: 'https://playentry.org/new.wav' }), undefined);
  src = '/new.wav';
  assert.equal(read({ id: 'tone', fileurl: 'https://playentry.org/new.wav' }), buffer);
  s.w.Entry.soundQueue.getResult = () => undefined;
  assert.equal(read({ id: 'tone', fileurl: 'https://playentry.org/new.wav' }), undefined);
});

test('editing does not create a second media library before running, and disabling releases the player', async t => {
  const s = await setup(t);
  await new Promise(resolve => setTimeout(resolve, 650)); await s.settle();
  assert.equal(s.boots.length, 0);
  assert.equal(s.counts().starts, 0);
  assert.equal(s.counts().exports, 0);
  assert.equal(s.w.document.querySelector('.entropy-editor-player'), null);
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.boots.length, 1);
  assert.equal(s.boots[0].preloadAssets, false);
  assert.equal(s.boots[0].liveEditing, true);
  assert.equal(s.handles[0].vm.state, 'run');
  await s.engine.toggleStop();
  assert.equal(s.handles[0].disposed, false);
  s.configure(false); await s.settle();
  assert.equal(s.handles[0].disposed, true);
  assert.equal(s.w.document.querySelector('.entropy-editor-player'), null);
});

test('editor reuses Entry autosave export instead of exporting a large changed work twice', async t => {
  const s = await setup(t);
  s.engine.toggleRun(); await s.settle(); await s.engine.toggleStop();
  assert.equal(s.counts().exports, 1);

  s.work.variables[0].value = 10;
  s.change();
  s.w.Entry.exportProject(); // Entry site's debounced autosave export.
  assert.equal(s.counts().exports, 2);
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.counts().exports, 2, 'Entropy preparation reuses the autosave result');
  assert.equal(s.reloads.length, 1);
});

test('large editor exports compact with the VM disabled and leave the editable data untouched', async t => {
  const s = await setup(t);
  s.configure(false); await s.settle();
  const blocks = [[{ id: 'hat', type: 'when_run_button_click', x: 17, y: 29, params: [], statements: [],
    movable: null, deletable: 1, emphasized: false, readOnly: null, copyable: true, assemble: true, extensions: [] }]];
  (s.work.objects[0] as any).script = JSON.stringify(blocks);
  const before = JSON.stringify(s.work);
  s.w.compactLargeProject = (work: unknown) => compactLargeProject(work, 1);
  const exported = s.w.Entry.exportProject();
  assert.notStrictEqual(exported, s.work);
  assert.deepEqual(JSON.parse(exported.objects[0].script), [[{ id: 'hat', type: 'when_run_button_click', x: 17, y: 29 }]]);
  assert.equal(JSON.stringify(s.work), before);
  assert.deepEqual(exported.variables, s.work.variables);
  s.w.Entry.type = 'minimize'; s.configure(false);
  assert.strictEqual(s.w.Entry.exportProject(), s.work, 'leaving the editor restores its original export');
});

test('editor reattaches export handling when Entry replaces the method in place', async t => {
  const s = await setup(t);
  s.configure(false); await s.settle();
  let calls = 0;
  const replacement = () => { calls++; return s.work; };
  s.w.Entry.exportProject = replacement;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.notStrictEqual(s.w.Entry.exportProject, replacement);
  assert.strictEqual(s.w.Entry.exportProject(), s.work);
  assert.equal(calls, 1);
  s.w.Entry.type = 'minimize';
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.strictEqual(s.w.Entry.exportProject, replacement, 'the newest native method is restored');
});

test('ordinary editor changes keep the same cloud connection', async t => {
  const s = await setup(t);
  Object.assign(s.work.variables[0], { _id: 'mongo-score', isCloud: true, variableType: 'variable' });
  s.engine.toggleRun(); await s.settle(); await s.engine.toggleStop();
  assert.deepEqual(s.counts(), { nativeTicks: 0, starts: 1, stops: 1, exports: 1,
    cloudClients: 1, cloudConnects: 1, cloudDisposals: 0, audioResumes: 1, audioCloses: 0 });

  (s.work.objects[0] as any).entity = { x: 1 };
  s.change();
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.reloads.length, 1);
  assert.equal(s.counts().cloudClients, 1);
  assert.equal(s.counts().cloudConnects, 1);
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

test('an incompatible engine rolls back partial patches and leaves every native method callable', async t => {
  const s = await setup(t);
  s.configure(false); await s.settle();
  const original = { ...s.engine };
  Object.defineProperty(s.engine, 'togglePause', { writable: false });
  s.configure(true); await s.settle();
  for (const key of Object.keys(original) as Array<keyof typeof original>) assert.equal(s.engine[key], original[key]);
  assert.equal(s.w.document.documentElement.dataset.entropyEditorPhase, 'incompatible');
  s.configure(true); s.engine.toggleRun(); s.engine.update();
  assert.equal(s.counts().nativeTicks, 2); assert.equal(s.boots.length, 0);
});

test('a changed native event API cannot leave the engine half attached', async t => {
  const s = await setup(t);
  s.configure(false); await s.settle();
  s.w.Entry.creationChangedEvent.attach = () => { throw new Error('changed Entry event API'); };
  s.configure(true); await s.settle();
  assert.equal(s.engine.toggleRun, s.originalRun); assert.equal(s.engine.computeFunction, s.originalTick);
  s.engine.toggleRun(); assert.equal(s.engine.state, 'run'); assert.equal(s.boots.length, 0);
});

test('a read-only native ticker stays running if attaching its replacement is rejected', async t => {
  const s = await setup(t);
  s.configure(false); await s.settle();
  let ticks = 0;
  const ticker = s.w.setInterval(() => { ticks++; }, 10);
  t.after(() => s.w.clearInterval(ticker));
  s.w.Entry.tickTime = 10;
  Object.defineProperty(s.engine, 'ticker', { value: ticker, writable: false });
  s.configure(true); await s.settle();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok(ticks > 0); assert.equal(s.engine.toggleRun, s.originalRun);
  assert.equal(s.engine.computeFunction, s.originalTick);
});

test('if project export cannot be wrapped, live copies cannot reach native saving', async t => {
  const s = await setup(t);
  s.configure(false); await s.settle();
  const entry = { ...s.w.Entry };
  Object.defineProperty(entry, 'exportProject', { writable: false });
  s.w.Entry = entry; s.configure(true); await s.settle();
  assert.equal(s.engine.toggleRun, s.originalRun);
  s.engine.toggleRun(); assert.equal(s.boots.length, 0); assert.equal(s.counts().nativeTicks, 1);
});

test('a changed export format falls back to native execution before creating live copies', async t => {
  const s = await setup(t);
  (s.work as any).objects = {};
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.engine.toggleRun, s.originalRun); assert.equal(s.engine.state, 'run');
  assert.equal(s.counts().nativeTicks, 1); assert.equal(s.boots.length, 0);
  assert.equal(s.w.document.querySelector('.entropy-editor-live'), null);
});

test('preparation failures before a handle exists stop cleanly and permit the next native run', async t => {
  const s = await setup(t);
  s.w.ResizeObserver = class { constructor() { throw new Error('cannot observe stage'); } };
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.engine.state, 'stop'); assert.equal(s.engine.toggleRun, s.originalRun);
  assert.equal(s.w.document.getElementById('entryCanvas').style.visibility, '');
  assert.equal(s.boots.length, 0);
  s.engine.toggleRun(); assert.equal(s.counts().nativeTicks, 1);
});

test('a rejected VM module load restores native buttons, canvas and temporary editing state', async t => {
  const s = await setup(t);
  s.w.loadModule = async () => { throw new Error('missing module'); };
  s.engine.toggleRun(); await s.settle();
  assert.equal(s.engine.state, 'stop'); assert.equal(s.engine.toggleRun, s.originalRun);
  assert.equal(s.w.document.getElementById('entryCanvas').style.visibility, '');
  assert.equal(s.w.document.querySelector('.entropy-editor-player'), null);
  s.engine.toggleRun(); assert.equal(s.counts().nativeTicks, 1);
});

test('optional actor and scene integration failures leave the replacement VM running', async t => {
  const s = await setup(t);
  s.w.beginActorEditing = () => { throw new Error('changed actor controls'); };
  s.engine.toggleRun(); await s.settle();
  const vm = s.handles[0].vm;
  assert.equal(vm.state, 'run');
  s.w.Entry.scene.selectScene = () => { throw new Error('changed scene API'); };
  assert.doesNotThrow(() => vm.onSceneChange('first'));
  assert.equal(vm.state, 'run'); assert.equal(vm.onSceneChange, null);
  await s.engine.toggleStop(); assert.equal(s.engine.state, 'stop');
});

test('detach preserves native methods that Entry replaced after the extension attached', async t => {
  const s = await setup(t);
  const newPause = () => {};
  s.engine.togglePause = newPause;
  s.configure(false); await s.settle();
  assert.equal(s.engine.togglePause, newPause); assert.equal(s.engine.toggleRun, s.originalRun);
});
