import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { stripTypes } from '@entropy/core/strip-types';
import { Vm } from '@entropy/vm';

function setup(t: any) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window as any;
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 'scene', name: 'scene' }], variables: [], messages: [], functions: [], objects: ['first', 'second'].map(id => ({
    id, name: id, scene: 'scene', rotateMethod: 'free', script: '[]',
    entity: { x: 5, y: 10, width: 20, height: 20, scaleX: 2, scaleY: 2, direction: 90, rotation: 30 },
  })) });
  vm.start();
  let nativeChanges = 0, flushes = 0;
  const makeObject = (id: string) => {
    const field = () => {
      const input = w.document.createElement('input');
      input.disabled = true;
      input.onblur = () => { nativeChanges++; };
      w.document.body.append(input);
      return input;
    };
    const button = () => {
      const node = w.document.createElement('span');
      node.onclick = () => { nativeChanges++; };
      w.document.body.append(node); return node;
    };
    const object = { id, locked: false, getLock() { return this.locked; },
      coordinateView_: { xInput_: field(), yInput_: field(), sizeInput_: field() },
      directionInput_: field(), rotateInput_: field(), rotateWrapper_: w.document.createElement('span'),
      rotateModeAView_: button(), rotateModeBView_: button(), rotateModeCView_: button(),
      updateCoordinateView() {
        this.coordinateView_.xInput_.value = '5'; this.coordinateView_.yInput_.value = '10';
        this.coordinateView_.sizeInput_.value = '40';
      },
      updateRotateMethodView() {
        this.directionInput_.value = '90'; this.rotateInput_.value = '30';
        this.rotateModeAView_.classList.add('selected'); this.rotateModeBView_.classList.remove('selected');
        this.rotateModeCView_.classList.remove('selected'); this.rotateWrapper_.classList.remove('entryRemove');
      } };
    return object;
  };
  const first = makeObject('first'), second = makeObject('second');
  const entry = { playground: { object: first }, readOnly: false, objectEditable: true };
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/page/editor-actors.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  w.eval(source + '\nwindow.begin = beginActorEditing;');
  const handle = { vm, renderer: { flush() { flushes++; } } };
  const live = w.begin(entry, handle);
  t.after(() => live.restore());
  const edit = (input: any, value: string, key?: string) => {
    input.focus(); input.value = value;
    if (key) input.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    else input.blur();
  };
  return { w, vm, entry, handle, first, second, live, edit, entity: vm.targets[0]!.entity,
    counts: () => ({ nativeChanges, flushes }) };
}

test('native actor inputs edit live position, size and angles without native commands or rounding runtime values', t => {
  const s = setup(t);
  s.edit(s.first.coordinateView_.xInput_, '31.125', 'Enter');
  s.edit(s.first.coordinateView_.yInput_, '-12.875');
  s.edit(s.first.coordinateView_.sizeInput_, '80');
  s.edit(s.first.directionInput_, '401°');
  s.edit(s.first.rotateInput_, '-15');
  assert.equal(s.entity.x, 31.125); assert.equal(s.entity.y, -12.875);
  assert.equal(s.entity.getSize(), 80); assert.equal(s.entity.direction, 41); assert.equal(s.entity.rotation, 345);
  assert.equal(s.first.coordinateView_.xInput_.value, '31.1');
  assert.deepEqual(s.counts(), { nativeChanges: 0, flushes: 5 });
});

test('live readouts preserve in-progress typing, reject invalid input and let Escape discard an edit', t => {
  const s = setup(t), input = s.first.coordinateView_.xInput_;
  s.entity.setX(21.234); s.live.sync(); assert.equal(input.value, '21.2');
  input.focus(); input.value = '-'; s.entity.setX(44); s.live.sync(); assert.equal(input.value, '-');
  input.blur(); assert.equal(s.entity.x, 44); assert.equal(input.value, '44.0');
  for (const value of ['', 'Infinity', 'NaN']) { s.edit(input, value); assert.equal(s.entity.x, 44); }
  s.edit(input, '100', 'Escape'); assert.equal(s.entity.x, 44);
  input.focus(); s.entity.setX(55); input.blur(); assert.equal(s.entity.x, 55, 'focusing alone must not overwrite motion');
  assert.equal(s.counts().nativeChanges, 0);
  s.entity.width = s.entity.height = 0;
  s.edit(s.first.coordinateView_.sizeInput_, '80');
  assert.equal(s.entity.scaleX, 2, 'an unloaded or empty costume must not introduce infinite scale');
});

test('rotation buttons apply while running and paused, invalidate clones and restore original controls on stop', t => {
  const s = setup(t), target = s.vm.targets[0]!;
  const clone = target.addClone(s.entity); clone.rotation = 50; const version = clone.version;
  s.first.rotateModeBView_.click();
  assert.equal(target.rotateMethod, 'vertical'); assert.equal(s.entity.rotation, 0); assert.equal(clone.rotation, 0);
  assert.ok(clone.version > version); assert.equal(s.first.rotateModeBView_.classList.contains('selected'), true);
  assert.equal(s.first.rotateWrapper_.classList.contains('entryRemove'), true);
  s.edit(s.first.directionInput_, '270'); assert.equal(s.entity.flip, true); assert.equal(s.entity.scaleX, -2);
  s.vm.pause(false); s.first.rotateModeCView_.click(); assert.equal(target.rotateMethod, 'none');
  s.live.restore(); s.vm.stop(); s.vm.reset();
  assert.equal(target.rotateMethod, 'free'); assert.equal(s.entity.x, 5); assert.equal(s.entity.direction, 90);
  assert.equal(s.first.rotateModeAView_.classList.contains('selected'), true);
  assert.equal(s.first.coordinateView_.xInput_.disabled, true, 'native stop will re-enable the restored controls');
  s.first.rotateModeBView_.click(); assert.equal(s.counts().nativeChanges, 1, 'native listeners work after cleanup');
});

test('switching actors edits the selected target; locks and read-only workspaces keep their restrictions', t => {
  const s = setup(t);
  s.entry.playground.object = s.second; s.live.sync();
  s.edit(s.second.coordinateView_.xInput_, '70');
  assert.equal(s.vm.targets[1]!.entity.x, 70); assert.equal(s.entity.x, 5);
  s.second.locked = true; s.live.sync(); assert.equal(s.second.coordinateView_.xInput_.disabled, true);
  s.second.rotateModeBView_.click(); assert.equal(s.vm.targets[1]!.rotateMethod, 'free');
  s.live.restore(); s.entry.readOnly = true;
  assert.equal(s.w.begin(s.entry, s.handle), undefined);
  s.entry.readOnly = false; s.entry.objectEditable = false;
  assert.equal(s.w.begin(s.entry, s.handle), undefined);
});

test('stopping with a focused edit does not schedule a native blur command or retain temporary values', t => {
  const s = setup(t), input = s.first.coordinateView_.xInput_;
  input.focus(); input.value = '200'; s.live.restore(); s.live.restore();
  assert.equal(s.entity.x, 5); assert.equal(input.value, '5'); assert.equal(s.counts().nativeChanges, 0);
  s.live.sync(); assert.equal(input.disabled, true);
});

test('partially initialized actor controls restore listeners if a changed native view rejects synchronization', t => {
  const s = setup(t); s.live.restore();
  s.first.rotateWrapper_.classList.toggle = () => { throw new Error('changed native view'); };
  assert.throws(() => s.w.begin(s.entry, s.handle), /changed native view/);
  const input = s.first.coordinateView_.xInput_;
  assert.equal(input.disabled, true);
  input.disabled = false; input.focus(); input.blur();
  assert.equal(s.counts().nativeChanges, 1, 'no temporary blur handler remains');
});
