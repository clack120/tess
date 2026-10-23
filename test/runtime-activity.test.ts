import test from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './stub.ts';
import { Vm } from '@entropy/vm';
import { RuntimeDiagnostics } from '../packages/vm/src/web/diagnostics.ts';

test('activity separates catch-up ticks from draws and does not count paused callbacks as frames', t => {
  stub(t, globalThis, 'document', { activeElement: null, hidden: false, hasFocus: () => true });
  const renderer = { renderCount: 0, addEntity() {}, removeEntity() {}, flush() { this.renderCount++; } };
  const vm = new Vm({ fps: 50, renderer });
  vm.load({ scenes: [{ id: 's', name: 's' }], objects: [], variables: [], functions: [], messages: [] });
  vm.start(); vm.advance(0); vm.startTimer();
  const diagnostics = new RuntimeDiagnostics(vm, 0);
  for (let now = 50; now <= 1000; now += 50) {
    vm.advance(now);
    diagnostics.record(now, 2);
  }
  const active = diagnostics.snapshot().activity;
  assert.equal(active.reduce((sum, item) => sum + item.ticks, 0), 50);
  assert.equal(active.reduce((sum, item) => sum + item.renders, 0), 20);
  vm.advance(2000);
  const stalled = diagnostics.record(2000, 8)!;
  assert.equal(stalled.elapsedMs, 1000);
  assert.equal(stalled.ticks, 4);
  assert.equal(stalled.renders, 1);
  assert.equal(vm.timerValue(), 2);
  vm.pause(); vm.advance(2500);
  const paused = diagnostics.record(2500, 0)!;
  assert.equal(paused.callbacks, 1);
  assert.equal(paused.ticks, 0);
  assert.equal(paused.renders, 0);
  renderer.flush();
  const redraw = diagnostics.record(3000, 1)!;
  assert.equal(redraw.ticks, 0);
  assert.equal(redraw.renders, 1, 'a paused manual redraw is still an actual draw');
});

test('recent activity counts actual ticks, bounds history and retains partial failure intervals', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { activeElement: { tagName: 'DIV', id: 'stage' }, hidden: false, hasFocus: () => true } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  stub(t, console, 'error', () => {});
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 'scene' }], objects: [], variables: [], functions: [], messages: [] } as never);
  vm.start();
  const diagnostics = new RuntimeDiagnostics(vm, 0);
  vm.frame = 1; diagnostics.record(250, 2);
  vm.frame = 3; diagnostics.record(500, 20);
  const report = diagnostics.snapshot();
  assert.deepEqual(report.activity, [{ at: 500, elapsedMs: 500, callbacks: 2, ticks: 3, renders: 0,
    workMs: 22, maxWorkMs: 20, kernelRuns: 0, kernelFallbacks: 0 }]);
  assert.equal(report.page.activeElement, 'div#stage');
  for (let index = 0; index < 20; index++) diagnostics.recordFocus(index % 2 ? 'focus' : 'blur');
  assert.equal(diagnostics.snapshot().focusEvents.length, 16);
  assert.equal(diagnostics.snapshot().focusEvents.at(-1)!.element, 'div#stage');
  vm.frame = 0; // Restarting must not create negative throughput.
  diagnostics.record(600, 5);
  vm.fail(new Error('failed in next interval'));
  vm.reset();
  diagnostics.record(750, 9);
  const failed = diagnostics.snapshot().failure!;
  assert.equal(failed.error.message, 'failed in next interval');
  assert.deepEqual(failed.activity.at(-1), { at: 750, elapsedMs: 250, callbacks: 2, ticks: 0, renders: 0,
    workMs: 14, maxWorkMs: 9, kernelRuns: 0, kernelFallbacks: 0 });
  for (let index = 2; index < 70; index++) diagnostics.record(index * 500, 1);
  assert.equal(diagnostics.snapshot().activity.length, 60);
  assert.deepEqual(diagnostics.snapshot().failure, failed, 'idle history must not overwrite the failure context');
  assert.doesNotThrow(() => JSON.stringify(diagnostics.snapshot()));
});
