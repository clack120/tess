import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vm } from '@tess/vm';
import { mountInspector } from '../packages/extension/src/page/inspector.ts';

function setup(t: any) {
  const dom = new JSDOM('<!doctype html><div class="css-hxgsd9 e1edvhig3"><p>keep</p></div><div id="player"><div class="tessvm-stage"><canvas></canvas></div></div>', { pretendToBeVisual: true });
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
    vm, stage: { worldWidth: 640, worldHeight: 360 },
    renderer: { setInspection: (...args: [unknown, boolean?]) => calls.push(args), flush() {},
      canvasRect: () => ({ left: 20, top: 30, width: 320, height: 180 }) },
    inspect: () => inspected++, downloadDiagnostics: () => downloaded++,
  } as never);
  t.after(() => { inspector.dispose(); window.close(); for (const [key, value] of previous) scope[key] = value; });
  return { window, vm, inspector, timers, calls, visibility: (visible: boolean) => visibility!([{ isIntersecting: visible }]),
    inspected: () => inspected, downloaded: () => downloaded,
    panel: window.document.querySelector<HTMLElement>('.tessvm-inspector')! };
}

test('Entry inspector preserves its host and virtualizes live clones without idle polling', t => {
  const { window, vm, inspector, timers, panel, calls } = setup(t);
  assert.equal(panel.parentElement!.className, 'css-hxgsd9 e1edvhig3');
  assert.equal(panel.parentElement!.firstElementChild, panel);
  assert.equal(panel.hidden, true);
  assert.equal(panel.parentElement!.querySelector(':scope > p')!.textContent, 'keep');
  assert.equal(timers.size, 0);
  inspector.open();
  assert.equal(panel.hidden, false);
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
  inspector.toggle();
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.at(-1), [null, false]);
});

test('Entry inspector stays disabled through fullscreen until toggled and sleeps when disabled', t => {
  const { window, inspector, panel, timers, calls } = setup(t);
  const player = window.document.getElementById('player')!;
  Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, value: player });
  window.document.dispatchEvent(new window.Event('fullscreenchange'));
  assert.equal(panel.hidden, true); assert.equal(inspector.enabled, false); assert.equal(timers.size, 0);
  inspector.toggle();
  assert.equal(panel.hidden, false); assert.equal(inspector.enabled, true); assert.equal(timers.size, 1);
  inspector.toggle();
  assert.equal(panel.hidden, true); assert.equal(inspector.enabled, false); assert.equal(timers.size, 0);
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

function pointer(window: any, target: EventTarget, type: string, x: number, y: number) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
  return event;
}

test('canvas inspection selects and reveals a virtualized clone without sending its press to the work', t => {
  const { window, vm, inspector, panel, calls } = setup(t);
  inspector.open();
  const clone = vm.targets[0]!.clones[1999]!;
  let presses = 0, releases = 0;
  const canvas = window.document.querySelector('canvas')!;
  canvas.addEventListener('pointerdown', () => presses++);
  canvas.addEventListener('pointerup', () => releases++);
  const points: number[][] = [];
  t.mock.method(vm, 'entityAtPoint', (x: number, y: number) => { points.push([x, y]); return clone; });
  const pick = Array.from(panel.querySelectorAll('button')).find(node => node.textContent === '화면에서 선택')!;
  pick.click();
  pointer(window, canvas, 'pointermove', 100, 75);
  assert.equal(calls.at(-1)![0], clone);
  pointer(window, canvas, 'pointerdown', 100, 75);
  pointer(window, canvas, 'pointerup', 100, 75);
  assert.deepEqual(points, [[160, 90], [160, 90]]);
  assert.equal(presses, 0); assert.equal(releases, 0);
  assert.equal(pick.getAttribute('aria-pressed'), 'false');
  const row = panel.querySelector<HTMLButtonElement>('.ti-clone-space [aria-pressed=true]')!;
  assert.match(row.textContent!, /클론 2000/);
  assert.equal(window.document.activeElement, row);
  assert.ok(panel.querySelectorAll('.ti-clone-space button').length <= 12);
  assert.equal(calls.at(-1)![0], clone);
  pointer(window, canvas, 'pointerdown', 100, 75);
  pointer(window, canvas, 'pointerup', 100, 75);
  assert.equal(presses, 1); assert.equal(releases, 1);
  pick.click();
  const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false);
  assert.equal(pick.getAttribute('aria-pressed'), 'false');
  pick.click(); inspector.toggle();
  assert.equal(pick.getAttribute('aria-pressed'), 'false');
  pointer(window, canvas, 'pointerdown', 100, 75);
  assert.equal(presses, 2);
});

test('the inspector can undock by dragging, stay onscreen, return to its host, and close', t => {
  const { window, inspector, panel, timers } = setup(t);
  inspector.open();
  Object.defineProperties(panel, { offsetWidth: { value: 320 }, offsetHeight: { value: 200 } });
  panel.getBoundingClientRect = () => ({ left: 100, top: 100, width: 320, height: 200 }) as DOMRect;
  const header = panel.querySelector<HTMLElement>('.ti-head')!;
  pointer(window, header, 'pointerdown', 110, 110);
  pointer(window, window.document, 'pointermove', 150, 140);
  assert.equal(panel.parentElement, window.document.body);
  assert.equal(panel.style.left, '140px'); assert.equal(panel.style.top, '130px');
  pointer(window, window.document, 'pointermove', 10000, 10000);
  assert.equal(panel.style.left, '696px'); assert.equal(panel.style.top, '560px');
  pointer(window, window.document, 'pointerup', 10000, 10000);
  pointer(window, window.document, 'pointermove', 0, 0);
  assert.equal(panel.style.left, '696px');
  panel.querySelector<HTMLButtonElement>('[aria-label="원래 위치로"]')!.click();
  assert.equal(panel.parentElement!.className, 'css-hxgsd9 e1edvhig3');
  assert.equal(panel.parentElement!.firstElementChild, panel);
  assert.equal(panel.style.left, '');
  panel.querySelector<HTMLButtonElement>('[aria-label="디버그 끄기"]')!.click();
  assert.equal(inspector.enabled, false); assert.equal(panel.hidden, true); assert.equal(timers.size, 0);
});
