import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { stripTypes } from '@entropy/core/strip-types';

function setup(t: any) {
  const dom = new JSDOM('<div id="view"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window as any;
  let added = (_code: any) => {}, removed = (_code: any) => {};
  class Code {
    data: any;
    destroyed = false;
    object?: any;
    constructor(data: any, object?: any) { this.data = structuredClone(data); this.object = object; added(this); }
    toJSON() { return structuredClone(this.data); }
    stringify() { return JSON.stringify(this.data); }
    destroy() { this.destroyed = true; removed(this); }
  }
  const block = (id: string) => [[{ id, type: 'when_run_button_click', params: [] }]];
  const first = { id: 'first', script: new Code(block('hat-first')) };
  const second = { id: 'second', script: new Code(block('hat-second')) };
  const fn = { id: 'fn', type: 'normal', content: new Code([[{ id: 'function', type: 'function_create',
    params: [{ id: 'label', type: 'function_field_label', params: ['fn', null] }], statements: [[]] }]]) };
  const original = { first: first.script, second: second.script, fn: fn.content };
  const board = { readOnly: true, code: first.script };
  const overlayBoard = { readOnly: false, code: fn.content };
  const workspace = { board, overlayBoard, blockMenu: { readOnly: false },
    changeBoardCode(code: any) { board.code = code; },
    changeOverlayBoardCode(code: any) { overlayBoard.code = code; } };
  const playground = { object: first, view_: w.document.getElementById('view'), mode: 'code',
    tabViewElements: Object.fromEntries(['picture', 'sound', 'text'].map(mode => {
      const tab = w.document.createElement('li'); tab.textContent = mode;
      w.document.getElementById('view').append(tab); return [mode, tab];
    })),
    injectCode() { workspace.changeBoardCode(this.object.script); },
    getViewMode() { return this.mode; }, changeViewMode(mode: string) { this.mode = mode; } };
  const undo = { before: true }, redo = { after: true };
  let schemaUpdates = 0;
  const entry = { Code, readOnly: false, getMainWS: () => workspace, playground, engine: { state: 'run', togglePause() { this.state = this.state === 'run' ? 'pause' : 'run'; vm.state = this.state; } },
    Func: { isEdit: false, initEditView(code: any) { this.isEdit = true; workspace.changeOverlayBoardCode(code); },
      endEdit() { this.isEdit = false; }, generateWsBlock(_fn: any) { schemaUpdates++; } },
    variableContainer: { functions_: { fn }, removeFunction({ id }: { id: string }) {
      second.script.data[0][0].params.push('removed call'); delete (this.functions_ as any)[id];
    } }, stateManager: { undoStack_: [undo], redoStack_: [redo] } };
  const work = { objects: [], functions: [{ id: 'fn', content: original.fn.stringify() }] };
  const patches: any[] = [];
  const vm = { state: 'pause', pause(_finish: boolean) { this.state = 'pause'; }, async patchCodeAsync(value: any) { patches.push(value); return 0; } };
  let referenceRenders = 0;
  const references = new Set([original.first, original.second, original.fn]);
  const renderReferences = () => { referenceRenders++; };
  Object.assign(entry.variableContainer, { updateList: renderReferences });
  added = code => { references.add(code); for (let i = 0; i < 5; i++) (entry.variableContainer as any).updateList(); };
  removed = code => { references.delete(code); for (let i = 0; i < 5; i++) (entry.variableContainer as any).updateList(); };
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/page/editor-live.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  w.loadYield = () => () => undefined;
  w.eval(source + '\nwindow.begin = beginLiveEditing;');
  const live = w.begin(entry, work, () => vm);
  t.after(() => live.restore());
  return { w, entry, playground, board, workspace, overlayBoard, first, second, fn, original, undo, redo, live, patches, work, vm,
    references, renderReferences, referenceRenders: () => referenceRenders,
    schemaUpdates: () => schemaUpdates,
    apply: () => w.document.querySelector('.entropy-editor-live button').onclick() };
}

test('running block edits use copies, preserve native history and restore the exact original code on stop', async t => {
  const s = setup(t);
  assert.notEqual(s.first.script, s.original.first);
  assert.equal(s.board.code, s.first.script);
  assert.equal(s.entry.engine.state, 'run'); assert.equal(s.board.readOnly, false);
  s.first.script.data[0][0].params.push('temporary');
  s.entry.stateManager.undoStack_.push({ temporary: true } as never);
  assert.deepEqual(s.original.first.toJSON()[0][0].params, []);
  await s.apply(); assert.equal(s.live.applied, true); assert.equal(s.patches.length, 1);
  assert.equal(JSON.parse(s.patches[0].objects[0].script)[0][0].params[0], 'temporary');
  s.entry.engine.state = 'stop'; s.live.restore();
  assert.equal(s.first.script, s.original.first); assert.equal(s.board.code, s.original.first);
  assert.equal(s.board.readOnly, true);
  assert.deepEqual(s.entry.stateManager.undoStack_, [s.undo]);
  assert.deepEqual(s.entry.stateManager.redoStack_, [s.redo]);
});

test('other objects are copied only when opened, and function body edits are isolated too', async t => {
  const s = setup(t);
  assert.equal(s.second.script, s.original.second);
  s.playground.object = s.second; s.playground.injectCode();
  assert.notEqual(s.second.script, s.original.second);
  s.entry.Func.initEditView(s.fn.content);
  assert.notEqual(s.fn.content, s.original.fn); assert.equal(s.overlayBoard.code, s.fn.content);
  s.fn.content.data[0][0].statements[0].push({ id: 'body', type: 'dialog', params: ['changed'] });
  await s.apply(); assert.equal(JSON.parse(s.patches[0].functions[0].content)[0][0].statements[0][0].params[0], 'changed');
  s.entry.Func.endEdit();
  s.playground.changeViewMode('variable');
  assert.equal(s.w.document.querySelector('.entropy-editor-live').hidden, true);
  s.playground.changeViewMode('code');
  assert.equal(s.w.document.querySelector('.entropy-editor-live').hidden, false);
  s.entry.engine.state = 'stop'; s.live.restore();
  assert.equal(s.second.script, s.original.second); assert.equal(s.fn.content, s.original.fn);
});

test('bulk native code copies and cleanup keep reference tracking but repaint the variable list only once', async t => {
  const s = setup(t);
  assert.equal(s.referenceRenders(), 1);
  assert.equal(s.references.has(s.original.first), true); assert.equal(s.references.has(s.first.script), true);
  s.playground.object = s.second; s.playground.injectCode();
  s.entry.Func.initEditView(s.fn.content);
  assert.equal(s.referenceRenders(), 3);
  assert.equal(s.references.size, 6);
  s.entry.engine.state = 'stop'; s.live.restore();
  assert.equal(s.referenceRenders(), 4, 'all temporary code is destroyed in one repaint batch');
  assert.deepEqual(s.references, new Set([s.original.first, s.original.second, s.original.fn]));
  assert.equal((s.entry.variableContainer as any).updateList, s.renderReferences);
});

test('failed native code construction always restores the reference renderer and native run state', async t => {
  const s = setup(t);
  (s.entry as any).Code = class { constructor() {
    (s.entry.variableContainer as any).updateList();
    throw new Error('native code failed');
  } };
  s.playground.object = s.second;
  assert.throws(() => s.playground.injectCode(), /native code failed/);
  assert.equal((s.entry.variableContainer as any).updateList, s.renderReferences);
  assert.equal(s.entry.engine.state, 'run');
  assert.equal(s.second.script, s.original.second);
});

test('native function removal cannot rewrite call blocks in unopened originals during a run', async t => {
  const s = setup(t);
  s.entry.variableContainer.removeFunction({ id: 'fn' });
  assert.equal(s.entry.variableContainer.functions_.fn, s.fn);
  assert.deepEqual(s.original.second.toJSON()[0][0].params, []);
  s.entry.engine.state = 'stop'; s.live.restore();
  s.entry.variableContainer.removeFunction({ id: 'fn' });
  assert.equal(s.entry.variableContainer.functions_.fn, undefined);
});

test('function signature edits cannot mutate global call schemas or be applied to the live VM', async t => {
  const s = setup(t);
  s.entry.Func.initEditView(s.fn.content);
  s.fn.content.data[0][0].params[0].params[0] = 'renamed';
  s.entry.Func.generateWsBlock(s.fn);
  assert.equal(s.schemaUpdates(), 0);
  await s.apply(); assert.equal(s.patches.length, 0);
  assert.match(s.w.document.querySelector('.entropy-editor-live').textContent, /이름·매개변수/);
  s.entry.engine.state = 'stop'; s.live.restore();
  assert.equal(s.fn.content, s.original.fn);
});

test('native view cleanup errors cannot prevent restoration of the original code and history', async t => {
  const s = setup(t);
  s.entry.Func.isEdit = true;
  s.entry.Func.endEdit = () => { throw new Error('native view changed'); };
  s.first.script.data[0][0].params.push('temporary');
  s.entry.engine.state = 'stop'; s.live.restore();
  assert.equal(s.first.script, s.original.first); assert.equal(s.board.readOnly, true);
  assert.deepEqual(s.entry.stateManager.undoStack_, [s.undo]);
});

test('native read-only workspaces keep their edit restrictions', async t => {
  const s = setup(t); s.live.restore();
  s.entry.readOnly = true;
  assert.equal(s.w.begin(s.entry, s.work, () => s.vm), null);
  assert.equal(s.first.script, s.original.first);
});

test('live editing keeps the native curtain hidden across views and restores it on stop', async t => {
  const s = setup(t); s.live.restore();
  const curtain = s.w.document.createElement('div'); curtain.id = 'entryCurtain';
  curtain.style.setProperty('display', 'block', 'important');
  s.playground.view_.append(curtain);
  const live = s.w.begin(s.entry, s.work, () => s.vm);
  assert.equal(curtain.style.display, 'none');
  s.playground.changeViewMode('variable'); assert.equal(curtain.style.display, 'none');
  assert.equal(s.playground.view_.classList.contains('entropy-editor-editing'), true);
  assert.equal(s.w.document.querySelector('.entropy-editor-live').hidden, true);
  s.playground.changeViewMode('default'); assert.equal(curtain.style.display, 'none');
  s.playground.changeViewMode('sound'); assert.equal(curtain.style.display, 'none');
  s.playground.changeViewMode('code'); assert.equal(curtain.style.display, 'none');
  live.restore(); assert.equal(curtain.style.display, 'block');
  assert.equal(curtain.style.getPropertyPriority('display'), 'important');
});

test('the apply panel stays visible while editing a function from the properties tab', async t => {
  const s = setup(t);
  const panel = s.w.document.querySelector('.entropy-editor-live');
  s.playground.changeViewMode('variable'); assert.equal(panel.hidden, true);
  s.entry.Func.initEditView(s.fn.content); assert.equal(panel.hidden, false);
  s.fn.content.data[0][0].statements[0].push({ id: 'body', type: 'dialog', params: ['function edit'] });
  await s.apply();
  assert.equal(s.live.applied, true);
  assert.equal(JSON.parse(s.patches[0].functions[0].content)[0][0].statements[0][0].params[0], 'function edit');
  s.entry.Func.endEdit(); assert.equal(panel.hidden, true);
  s.playground.changeViewMode('code'); assert.equal(panel.hidden, false);
});

test('unsafe media tabs block mouse, keyboard and programmatic entry until stop and restore their attributes', t => {
  const s = setup(t); s.live.restore();
  let clicks = 0;
  for (const tab of Object.values(s.playground.tabViewElements) as any[]) {
    tab.title = 'original'; tab.setAttribute('aria-disabled', 'false');
    tab.style.setProperty('cursor', 'crosshair', 'important');
    tab.addEventListener('click', () => { clicks++; });
  }
  s.playground.mode = 'sound';
  const live = s.w.begin(s.entry, s.work, () => s.vm);
  assert.equal(s.playground.mode, 'code', 'an already open media editor is left before hiding its curtain');
  for (const [mode, tab] of Object.entries(s.playground.tabViewElements) as any) {
    s.playground.changeViewMode(mode); assert.equal(s.playground.mode, 'code');
    assert.equal(tab.getAttribute('aria-disabled'), 'true');
    assert.equal(tab.style.cursor, 'not-allowed'); assert.match(tab.title, /정지 후/);
    tab.click();
    assert.equal(tab.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })), false);
  }
  assert.equal(clicks, 0);
  s.entry.engine.state = 'stop'; live.restore();
  for (const [mode, tab] of Object.entries(s.playground.tabViewElements) as any) {
    assert.equal(tab.title, 'original'); assert.equal(tab.getAttribute('aria-disabled'), 'false');
    assert.equal(tab.style.cursor, 'crosshair'); assert.equal(tab.style.getPropertyPriority('cursor'), 'important');
    tab.click(); s.playground.changeViewMode(mode); assert.equal(s.playground.mode, mode);
  }
  assert.equal(clicks, 3);
});

test('applying edits pauses first, shows progress, prevents duplicate updates and resumes only a running session', async t => {
  const s = setup(t);
  const applying = s.apply();
  assert.equal(s.entry.engine.state, 'pause');
  assert.equal(s.w.document.querySelector('.entropy-editor-live button').disabled, true);
  assert.match(s.w.document.querySelector('.entropy-editor-live').textContent, /갱신 중/);
  s.entry.engine.togglePause(); assert.equal(s.entry.engine.state, 'pause', 'the player cannot resume halfway through an update');
  await s.apply(); await applying;
  assert.equal(s.patches.length, 1); assert.equal(s.entry.engine.state, 'run');
  s.entry.engine.state = 'pause'; s.vm.state = 'pause';
  await s.apply(); assert.equal(s.entry.engine.state, 'pause');
});

test('stopping during an update aborts it and never resumes or overwrites restored board permissions', async t => {
  const s = setup(t);
  const applying = s.apply();
  s.entry.engine.state = 'stop'; s.vm.state = 'stop'; s.live.restore();
  await applying;
  assert.equal(s.patches.length, 0); assert.equal(s.entry.engine.state, 'stop');
  assert.equal(s.board.readOnly, true); assert.equal(s.first.script, s.original.first);
});

test('function removal is rejected during live editing and stop restores the original function registry', async t => {
  const s = setup(t);
  s.entry.Func.initEditView(s.fn.content);
  delete (s.entry.variableContainer.functions_ as any).fn;
  await s.apply(); assert.equal(s.patches.length, 0);
  assert.match(s.w.document.querySelector('.entropy-editor-live').textContent, /함수 추가·삭제/);
  s.entry.engine.state = 'stop'; s.live.restore();
  assert.equal(s.entry.variableContainer.functions_.fn, s.fn);
  assert.equal(s.fn.content, s.original.fn);
});

for (const [owner, field] of [['Func', 'initEditView'], ['variableContainer', 'removeFunction'], ['engine', 'togglePause']] as const) {
  test(`failed live initialization at ${owner}.${field} rolls back all earlier changes`, t => {
    const s = setup(t); s.live.restore();
    const inject = s.playground.injectCode, pause = s.entry.engine.togglePause;
    const edit = s.entry.Func.initEditView, remove = s.entry.variableContainer.removeFunction;
    Object.defineProperty(s.entry[owner], field, { writable: false });
    assert.throws(() => s.w.begin(s.entry, s.work, () => s.vm));
    assert.equal(s.playground.injectCode, inject); assert.equal(s.entry.engine.togglePause, pause);
    assert.equal(s.entry.Func.initEditView, edit); assert.equal(s.entry.variableContainer.removeFunction, remove);
    assert.equal(s.board.readOnly, true); assert.equal(s.first.script, s.original.first);
    assert.equal(s.w.document.querySelector('.entropy-editor-live'), null);
    assert.deepEqual(s.references, new Set([s.original.first, s.original.second, s.original.fn]));
  });
}

test('a read-only reference renderer does not block restoration of temporary code', t => {
  const s = setup(t);
  Object.defineProperty(s.entry.variableContainer, 'updateList', { writable: false });
  s.live.restore();
  assert.equal(s.first.script, s.original.first); assert.equal(s.board.readOnly, true);
  assert.equal(s.w.document.querySelector('.entropy-editor-live'), null);
  assert.deepEqual(s.references, new Set([s.original.first, s.original.second, s.original.fn]));
});
