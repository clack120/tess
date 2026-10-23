import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypes } from '@entropy/core/strip-types';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const stubRenderer = () => ({
  canvasRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
  overlayView: null,
  flush() {},
});

function mountInput(t: any, rect = { left: 0, top: 0, width: 640, height: 360 }, grabEscape = false) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="root" tabindex="0" draggable="true">'
      + '<div id="view"><input id="ask" type="text"></div><button id="stop"></button>'
      + '</div><input id="outside" type="text"><dialog id="dialog"><button id="modal"></button></dialog></body>',
    { pretendToBeVisual: true },
  );
  t.after(() => dom.window.close());

  const source = stripTypes(fs.readFileSync(path.join(root, 'packages/vm/src/web/boot.ts'), 'utf-8'));
  const sandbox: Record<string, unknown> = {
    window: dom.window, document: dom.window.document,
    stage: { width: 480, height: 270, scale: 4 / 3, worldWidth: 640, worldHeight: 360 },
  };
  const locks: string[] = [];
  sandbox.navigator = { keyboard: {
    lock: (keys: string[]) => { locks.push(`lock ${keys.join()}`); return Promise.resolve(); },
    unlock: () => { locks.push('unlock'); },
  } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${source.replace(/^import[^;]*;$/gm, '').replace(/^export /gm, '')}\nthis.bind = bindInput;`,
    sandbox,
  );

  const fired: Array<[string, string | undefined]> = [];
  const stage = {
    state: 'run',
    pressedKeys: new Set<number>(),
    usedKeys: new Set<number>() as Set<number> | null,
    targets: [],
    mouseX: 0,
    mouseY: 0,
    mouseDown: false,
    clickedEntityId: null,
    entityAtPoint: () => null,
    fireEvent: (event: string, filter?: string) => {
      fired.push([event, filter]);
      return [];
    },
    fireEventOn: () => [],
  };
  const document_ = dom.window.document;
  let windowFocused = true;
  let hidden = false;
  let fullscreen: HTMLElement | null = null;
  Object.defineProperties(document_, {
    hasFocus: { value: () => windowFocused },
    hidden: { get: () => hidden },
    fullscreenElement: { get: () => fullscreen },
  });
  const view = document_.getElementById('view')!;
  const player = document_.getElementById('root')!;
  const cleanups: Array<() => void> = [];
  const frame = (sandbox.bind as any)(stage, { ...stubRenderer(), canvasRect: () => rect }, view, player, cleanups, () => '', grabEscape);

  const press = (on: string, init: Record<string, unknown>, type = 'keydown') => {
    let sawIt = false;
    const watch = () => { sawIt = true; };
    document_.addEventListener(type, watch);
    const event = new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    document_.getElementById(on)!.dispatchEvent(event);
    document_.removeEventListener(type, watch);
    return { prevented: event.defaultPrevented, reachedPage: sawIt };
  };
  const pointer = (on: 'view' | 'root' | 'ask' | 'window', type: string, clientX: number, clientY: number) => {
    if (on === 'window' && type === 'blur') windowFocused = false;
    if (on === 'window' && type === 'focus') windowFocused = true;
    const target = on === 'window' ? dom.window : document_.getElementById(on)!;
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
    target.dispatchEvent(event);
    return event;
  };
  return { press, pointer, stage, fired, frame, locks, sandbox, document: document_,
    dispose: () => { for (const undo of cleanups.splice(0).reverse()) undo(); },
    fullscreen: (enabled: boolean) => {
      fullscreen = enabled ? player : null;
      document_.dispatchEvent(new dom.window.Event('fullscreenchange'));
    },
    visible: (enabled: boolean) => {
      hidden = !enabled;
      document_.dispatchEvent(new dom.window.Event('visibilitychange'));
    },
    openDialog: () => document_.getElementById('dialog')!.setAttribute('open', ''),
    focus: (id: string) => (document_.getElementById(id) as HTMLElement).focus(),
    blurFocused: () => (document_.activeElement as HTMLElement).blur(),
    focused: () => document_.activeElement?.id,
  };
}

test('drag coordinates keep following outside a scaled stage until release', (t) => {
  for (const scale of [0.5, 1, 3]) {
    const rect = { left: 100, top: 75, width: 640 * scale, height: 360 * scale };
    const { pointer, stage } = mountInput(t, rect);
    pointer('view', 'pointerdown', rect.left + rect.width / 2, rect.top + rect.height / 2);
    assert.equal(stage.mouseDown, true);
    pointer('window', 'pointermove', rect.left + rect.width * 1.25, rect.top + rect.height);
    assert.equal(stage.mouseX, 360, `scale ${scale}`);
    assert.equal(stage.mouseY, -135, `scale ${scale}`);
    pointer('window', 'pointerup', rect.left + rect.width, rect.top);
    assert.equal(stage.mouseX, 240);
    assert.equal(stage.mouseY, 135);
    assert.equal(stage.mouseDown, false);
    pointer('window', 'pointermove', 0, 0);
    assert.equal(stage.mouseX, 240, 'page movement after release is not a work drag');
  }
});

test('the browser cannot start a native drag while the stage handles a work press', (t) => {
  const { pointer, stage, fired } = mountInput(t);
  const down = pointer('view', 'pointerdown', 320, 180);
  assert.equal(down.defaultPrevented, true, 'prevent native image/link/selection dragging');
  assert.equal(stage.mouseDown, true);
  const native = pointer('root', 'dragstart', 320, 180);
  assert.equal(native.defaultPrevented, true, 'an ancestor marked draggable must not take the gesture');
  assert.ok(fired.some(([event]) => event === 'mouse_clicked'));
  pointer('window', 'pointerup', 330, 190);
  assert.equal(stage.mouseDown, false);
});

test('answer controls keep native focus and selection and do not press the work', (t) => {
  const { pointer, stage, fired } = mountInput(t);
  assert.equal(pointer('ask', 'pointerdown', 320, 180).defaultPrevented, false);
  assert.equal(stage.mouseDown, false);
  assert.equal(fired.length, 0);
  assert.equal(pointer('root', 'dragstart', 320, 180).defaultPrevented, false, 'unrelated page dragging remains native');
});

test('clicking the stage takes keyboard focus back after another page control used it', (t) => {
  const { focus, focused, pointer } = mountInput(t);
  focus('stop');
  assert.equal(focused(), 'stop');
  pointer('view', 'pointerdown', 320, 180);
  assert.equal(focused(), 'root');
});

test('key release outside the focused player cannot leave a work key stuck down', (t) => {
  const { focus, press, stage } = mountInput(t);
  focus('root');
  press('root', { code: 'Enter' });
  assert.equal(stage.pressedKeys.has(13), true);
  focus('outside');
  press('outside', { code: 'Enter' }, 'keyup');
  assert.equal(stage.pressedKeys.has(13), false);
});

test('returning from another window restores a player that owned focus, repeatedly', (t) => {
  const { focus, focused, blurFocused, pointer, press, stage } = mountInput(t);
  focus('root');
  for (let index = 0; index < 2; index++) {
    press('root', { code: 'AltLeft' });
    pointer('window', 'blur', 0, 0);
    blurFocused();
    assert.equal(focused(), '');
    pointer('window', 'focus', 0, 0);
    assert.equal(focused(), 'root');
    assert.equal(stage.pressedKeys.size, 0);
  }
});

test('returning to the window preserves answer fields and unrelated page focus', (t) => {
  const { focus, focused, pointer } = mountInput(t);
  for (const id of ['ask', 'outside', 'stop']) {
    focus(id);
    pointer('window', 'blur', 0, 0);
    pointer('window', 'focus', 0, 0);
    assert.equal(focused(), id);
  }
  focus('root');
  pointer('window', 'blur', 0, 0);
  focus('outside');
  pointer('window', 'focus', 0, 0);
  assert.equal(focused(), 'outside', 'a page moving focus while away must not be overridden');
});

test('fullscreen recovers lost or stolen focus even without a remembered window blur', (t) => {
  const page = mountInput(t);
  page.focus('outside'); page.fullscreen(true);
  assert.equal(page.focused(), 'root');
  page.focus('outside');
  assert.equal(page.focused(), 'root', 'external page focus cannot take keys from a fullscreen work');
  page.blurFocused(); page.frame();
  assert.equal(page.focused(), 'root', 'a missing focus event is recovered on the next frame');
  page.stage.state = 'stop';
  page.blurFocused(); page.frame();
  assert.equal(page.focused(), 'root', 'fullscreen keeps owning focus while stopped too');
});

test('fullscreen retries window and visibility return while preserving player fields and dialogs', (t) => {
  const page = mountInput(t);
  page.fullscreen(true);
  for (let index = 0; index < 2; index++) {
    page.pointer('window', 'blur', 0, 0);
    page.visible(false); page.focus('outside'); page.frame();
    assert.equal(page.focused(), 'outside', 'another app keeps its focus while away');
    page.pointer('window', 'blur', 0, 0);
    page.visible(true); page.frame();
    assert.equal(page.focused(), 'outside');
    page.pointer('window', 'focus', 0, 0);
    assert.equal(page.focused(), 'root');
  }
  for (const control of ['ask', 'stop']) {
    page.focus(control); page.frame();
    page.pointer('window', 'blur', 0, 0); page.pointer('window', 'focus', 0, 0);
    assert.equal(page.focused(), control);
  }
  page.openDialog(); page.focus('modal'); page.frame();
  assert.equal(page.focused(), 'modal', 'an open dialog keeps its keyboard navigation');
  page.fullscreen(false); page.focus('outside'); page.frame();
  assert.equal(page.focused(), 'outside', 'normal page inputs work after leaving fullscreen');
});

test('window focus arriving before document focus recovery can retry on the next frame', (t) => {
  const page = mountInput(t);
  page.focus('root'); page.pointer('window', 'blur', 0, 0);
  page.focus('outside'); page.pointer('window', 'focus', 0, 0);
  assert.equal(page.focused(), 'outside');
  page.blurFocused(); page.frame();
  assert.equal(page.focused(), 'root');
});

test('losing focus clears a held stage press and raises its release', (t) => {
  const { pointer, stage, fired } = mountInput(t);
  pointer('view', 'pointerdown', 320, 180);
  pointer('window', 'blur', 0, 0);
  assert.equal(stage.mouseDown, false);
  assert.ok(fired.some(([event]) => event === 'mouse_click_cancled'));
});

test('작품 안에서 누른 키는 페이지로 가지 않는다', (t) => {
  const { press } = mountInput(t);

  assert.deepEqual(press('root', { code: 'Space' }), { prevented: true, reachedPage: false });
  assert.deepEqual(press('root', { code: 'ArrowDown' }), { prevented: true, reachedPage: false });
  assert.deepEqual(press('root', { code: 'KeyA' }), { prevented: true, reachedPage: false });
  assert.deepEqual(
    press('root', { code: 'Space' }, 'keyup'),
    { prevented: true, reachedPage: false },
  );
});

test('대답 입력칸과 조작줄 단추의 키는 그대로 둔다', (t) => {
  const { press } = mountInput(t);

  for (const on of ['ask', 'stop']) {
    assert.deepEqual(press(on, { code: 'Space' }), { prevented: false, reachedPage: true }, on);
    assert.deepEqual(press(on, { code: 'ArrowLeft' }), { prevented: false, reachedPage: true }, on);
  }
});

test('브라우저 단축키 조합은 그대로 둔다', (t) => {
  const { press } = mountInput(t);

  assert.equal(press('root', { code: 'KeyR', ctrlKey: true }).prevented, false);
  assert.equal(press('root', { code: 'KeyC', metaKey: true }).prevented, false);
  assert.equal(press('root', { code: 'ArrowLeft', altKey: true }).prevented, false);
  // A modifier pressed alone may belong to the work without forming a browser shortcut.
  assert.equal(press('root', { code: 'ControlLeft', ctrlKey: true }).prevented, true);
});

test('function keys keep browser actions and never enter the work, including computed key reads', t => {
  const { press, stage, fired } = mountInput(t);
  for (const keys of [new Set<number>(), new Set(Array.from({ length: 12 }, (_, i) => 112 + i)), null]) {
    stage.usedKeys = keys;
    for (let i = 1; i <= 12; i++) {
      for (const modifiers of [{}, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        for (const type of ['keydown', 'keyup']) {
          assert.deepEqual(press('root', { code: `F${i}`, keyCode: 111 + i, ...modifiers }, type),
            { prevented: false, reachedPage: true }, `F${i} ${type}`);
        }
      }
      assert.deepEqual(press('root', { keyCode: 111 + i }), { prevented: false, reachedPage: true });
    }
  }
  assert.equal(stage.pressedKeys.size, 0);
  assert.deepEqual(fired, []);
});

test('a shortcut on a key the work uses is the work\'s', (t) => {
  const { press, stage } = mountInput(t);
  stage.usedKeys = new Set([189]);
  assert.equal(press('root', { code: 'Minus', ctrlKey: true }).prevented, true);
  assert.equal(press('root', { code: 'Equal', ctrlKey: true }).prevented, false);
  // Computed key reads may request any key.
  stage.usedKeys = null;
  assert.equal(press('root', { code: 'Equal', ctrlKey: true }).prevented, true);
});

test('grabbed Escape stays with a running work and locks during element fullscreen', (t) => {
  const { press, stage, locks, fullscreen, focus, dispose } = mountInput(t, undefined, true);
  assert.deepEqual(press('root', { code: 'Escape' }), { prevented: true, reachedPage: false });
  // Modified Escape follows the shortcut rule: it is the work's only when the work reads Escape.
  assert.equal(press('root', { code: 'Escape', ctrlKey: true }).prevented, false);
  stage.usedKeys = new Set([27]);
  assert.equal(press('root', { code: 'Escape', ctrlKey: true }).prevented, true);
  stage.state = 'pause';
  assert.deepEqual(press('root', { code: 'Escape' }), { prevented: false, reachedPage: true });
  stage.state = 'run';
  focus('ask');
  assert.equal(press('ask', { code: 'Escape' }).prevented, false, 'text fields keep Escape');
  fullscreen(true);
  fullscreen(false);
  dispose();
  assert.deepEqual(locks, ['unlock', 'lock Escape', 'unlock', 'unlock']);
  // Turning the setting off leaves Escape to the browser and page.
  const off = mountInput(t, undefined, false);
  assert.deepEqual(off.press('root', { code: 'Escape' }), { prevented: false, reachedPage: true });
  assert.deepEqual(off.locks, []);
});

test('answering a question gives typing focus back to the player', (t) => {
  const { sandbox, document, focused } = mountInput(t);
  const view = document.getElementById('view')!;
  const player = document.getElementById('root')!;
  const field = (sandbox.makeQuestionField as any)(view, () => {}, () => player.focus());
  field.show();
  assert.equal(document.activeElement?.tagName, 'INPUT');
  field.hide();
  assert.equal(focused(), 'root');
  // A field that lost focus elsewhere does not pull focus back.
  field.show();
  (document.getElementById('outside') as HTMLElement).focus();
  field.hide();
  assert.equal(focused(), 'outside');
});

test('작품이 돌지 않는 동안에는 페이지가 키를 그대로 쓴다', (t) => {
  const { press, stage } = mountInput(t);

  for (const state of ['stop', 'pause']) {
    stage.state = state;
    assert.deepEqual(press('root', { code: 'Space' }), { prevented: false, reachedPage: true }, state);
  }
});

// Forward every repeated keydown because Entry starts a new event for each repeat.
test('키를 누르고 있으면 되풀이되는 keydown 도 그대로 올라간다', (t) => {
  const { press, fired, stage } = mountInput(t);

  press('root', { code: 'ArrowRight' });
  press('root', { code: 'ArrowRight', repeat: true });
  press('root', { code: 'ArrowRight', repeat: true });
  assert.deepEqual(fired, [
    ['keyPress', '39'],
    ['keyPress', '39'],
    ['keyPress', '39'],
  ]);
  assert.deepEqual([...stage.pressedKeys], [39], '눌린 키는 한 번만 담깁니다');

  press('root', { code: 'ArrowRight' }, 'keyup');
  assert.deepEqual([...stage.pressedKeys], []);
  press('root', { code: 'ArrowRight' });
  assert.equal(fired.length, 4);
});
