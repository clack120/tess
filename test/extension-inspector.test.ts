import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vm } from '@tess/vm';
import { mountInspector } from '../packages/extension/src/page/inspector.ts';

function setup(t: any) {
  const dom = new JSDOM('<!doctype html><div class="css-hxgsd9 e1edvhig3"><p>keep</p></div><div id="player"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  const keys = ['document', 'window', 'Element', 'IntersectionObserver'];
  const scope = globalThis as Record<string, unknown>;
  const previous = keys.map(key => [key, scope[key]] as const);
  let visibility: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
  for (const key of keys) scope[key] = (window as any)[key];
  scope.IntersectionObserver = class {
    constructor(callback: typeof visibility) { visibility = callback; }
    observe() {}
    disconnect() {}
  };
  const timers = new Map<number, () => void>();
  let next = 0;
  window.setInterval = ((callback: () => void) => { timers.set(++next, callback); return next; }) as never;
  window.clearInterval = ((id: number) => { timers.delete(id); }) as never;
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 'scene' }, { id: 'other', name: 'other' }], variables: [], messages: [], functions: [],
    objects: [{ id: 'actor', name: '<actor>', scene: 's', entity: {}, script: [] },
      { id: 'second', name: 'second', scene: 'other', entity: {}, script: [] }],
  } as never);
  vm.start();
  const target = vm.targets[0]!;
  for (let i = 0; i < 2000; i++) target.addClone(target.entity);
  const calls: Array<[unknown, boolean?]> = [];
  let inspected = 0, downloaded = 0;
  const inspector = mountInspector(window.document.getElementById('player')!, {
    vm, renderer: { setInspection: (...args: [unknown, boolean?]) => calls.push(args), flush() {} },
    inspect: () => inspected++, downloadDiagnostics: () => downloaded++,
  } as never);
  t.after(() => { inspector.dispose(); window.close(); for (const [key, value] of previous) scope[key] = value; });
  return { window, vm, inspector, timers, calls, visibility: (visible: boolean) => visibility!([{ isIntersecting: visible }]),
    inspected: () => inspected, downloaded: () => downloaded,
    panel: window.document.querySelector<HTMLDetailsElement>('.tessvm-inspector')! };
}

test('Entry inspector preserves its host and virtualizes live clones without idle polling', t => {
  const { window, vm, inspector, timers, panel, calls } = setup(t);
  assert.equal(panel.parentElement!.className, 'css-hxgsd9 e1edvhig3');
  assert.equal(panel.parentElement!.querySelector('p')!.textContent, 'keep');
  assert.equal(timers.size, 0);
  inspector.open();
  assert.equal(timers.size, 1);
  assert.match(panel.querySelector('.ti-status')!.textContent!, /클론 2000/);
  const branch = panel.querySelector<HTMLDetailsElement>('.ti-target')!;
  branch.open = true; branch.dispatchEvent(new window.Event('toggle'));
  assert.ok(panel.querySelectorAll('.ti-clone-space button').length <= 12);
  assert.equal(panel.querySelectorAll('.ti-entity').length, 14);
  const list = branch.querySelector<HTMLElement>('.ti-clones')!;
  list.scrollTop = 1990 * 28; list.dispatchEvent(new window.Event('scroll'));
  const last = branch.querySelector<HTMLButtonElement>('.ti-clone-space button:last-child')!;
  assert.match(last.textContent!, /클론 2000/);
  last.click();
  assert.equal(calls.at(-1)![0], vm.targets[0]!.clones[1999]);
  vm.targets[0]!.clones[1999].removeClone();
  for (const tick of timers.values()) tick();
  assert.equal(calls.at(-1)![0], null);
  assert.match(panel.querySelector('.ti-status')!.textContent!, /클론 1999/);
  panel.open = false; panel.dispatchEvent(new window.Event('toggle'));
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.at(-1), [null, false]);
});

test('Entry inspector highlights hover, exposes diagnostics and sleeps offscreen or hidden', t => {
  const { window, inspector, timers, panel, calls, visibility, vm, inspected, downloaded } = setup(t);
  inspector.open();
  const row = panel.querySelector<HTMLButtonElement>('.ti-entity')!;
  row.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
  assert.equal(calls.at(-1)![0], vm.targets[0]!.entity);
  panel.querySelector('.ti-tree')!.dispatchEvent(new window.Event('pointerleave'));
  assert.equal(calls.at(-1)![0], null);
  row.click();
  assert.match(panel.querySelector('.ti-info')!.textContent!, /<actor>/);
  assert.equal(panel.querySelector('actor'), null);
  const bounds = panel.querySelector<HTMLInputElement>('input')!;
  bounds.checked = true; bounds.dispatchEvent(new window.Event('change'));
  assert.equal(calls.at(-1)![1], true);
  const tools = panel.querySelectorAll<HTMLButtonElement>('.ti-tools button');
  tools[0]!.click(); tools[1]!.click();
  assert.equal(inspected(), 1); assert.equal(downloaded(), 1);
  visibility(false); assert.equal(timers.size, 0); assert.deepEqual(calls.at(-1), [null, false]);
  visibility(true); assert.equal(timers.size, 1);
  Object.defineProperty(window.document, 'hidden', { configurable: true, value: true });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(timers.size, 0);
  Object.defineProperty(window.document, 'hidden', { configurable: true, value: false });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(timers.size, 1);
  inspector.dispose();
  assert.equal(timers.size, 0); assert.equal(window.document.querySelector('.tessvm-inspector'), null);
});

test('Entry inspector follows fullscreen and falls back when the dock is replaced', t => {
  const { window, inspector, panel, timers } = setup(t);
  const player = window.document.getElementById('player')!;
  inspector.open();
  Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, value: player });
  window.document.dispatchEvent(new window.Event('fullscreenchange'));
  assert.equal(panel.parentElement, player);
  assert.ok(panel.classList.contains('ti-floating'));
  Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, value: null });
  window.document.dispatchEvent(new window.Event('fullscreenchange'));
  assert.equal(panel.parentElement!.className, 'css-hxgsd9 e1edvhig3');
  assert.ok(!panel.classList.contains('ti-floating'));
  panel.parentElement!.remove();
  window.document.dispatchEvent(new window.Event('fullscreenchange'));
  assert.equal(panel.parentElement, player);
  assert.equal(timers.size, 1);
  inspector.dispose(); inspector.dispose();
  assert.equal(timers.size, 0);
});
