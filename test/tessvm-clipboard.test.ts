import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypes } from '@tess/core/strip-types';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const stubRenderer = () => ({ canvasRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) });

function mountExtras(t: any) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="player" tabindex="0"><button id="start"></button>'
      + '<div id="view"><div id="frame"><canvas id="canvas"></canvas>'
      + '<form class="tessvm-ask"><input id="answer" type="text"></form>'
      + '</div></div></div><textarea id="comment"></textarea></body>',
    { pretendToBeVisual: true },
  );
  t.after(() => dom.window.close());

  // Capture timers so notice expiry can be tested without waiting.
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  dom.window.setTimeout = ((run: () => void) => {
    timers.set(nextTimer, run);
    return nextTimer++;
  }) as never;

  const source = stripTypes(fs.readFileSync(path.join(root, 'packages/tessvm/src/web/extras.ts'), 'utf-8'));
  // Control the clock to test the one-second copy interval.
  let clock = 100_000;
  const copied: string[] = [];
  const sandbox: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    clearTimeout: (id: number) => timers.delete(id),
    performance: { now: () => clock },
    // Capture writes because jsdom has no clipboard.
    navigator: {
      clipboard: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    },
    Node: dom.window.Node,
    Element: dom.window.Element,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${source.replace(/^import[^;]*;$/gm, '').replace(/^export /gm, '')}\nthis.bind = bindExtras;`,
    sandbox,
  );

  const pasted: string[] = [];
  const machine = {
    state: 'run',
    extras: {
      host: null as unknown,
      uses: { clipboard: true, cursor: false, mouseLock: false, scroll: false },
      pasted: (text: string) => pasted.push(text),
      lockChanged: () => undefined,
      moved: () => undefined,
      scrolled: () => undefined,
    },
  };
  const document_ = dom.window.document;
  const view = document_.getElementById('view')!;
  const frame = document_.getElementById('frame')!;
  // Stub pointer lock because jsdom does not implement it.
  const locks: number[] = [];
  (view as any).requestPointerLock = () => {
    locks.push(1);
    return undefined;
  };
  const cleanups: Array<() => void> = [];
  const binding = (sandbox.bind as any)(machine, stubRenderer(), frame, view, cleanups);

  const dialog = () => frame.querySelector('.tessvm-ask-permission') as HTMLElement;
  return {
    machine,
    pasted,
    copied,
    locks,
    binding,
    cleanups,
    host: () => machine.extras.host as any,
    advance: (ms: number) => {
      clock += ms;
    },
    dialog,
    dialogOpen: () => dialog().hidden === false,
    answer(confirm: boolean, keep = false) {
      const box = dialog().querySelector('.tessvm-permit-keep input') as HTMLInputElement;
      box.checked = keep;
      const button = dialog().querySelector(
        confirm ? '.tessvm-permit-allow' : '.tessvm-permit-deny',
      ) as HTMLElement;
      button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    },
    notice: () => frame.querySelector('.tessvm-notice') as HTMLElement | null,
    focus(on: string) {
      (document_.getElementById(on) as HTMLElement).focus();
    },
    paste(on: string, text: string) {
      const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: () => text },
      });
      document_.getElementById(on)!.dispatchEvent(event);
    },
    runTimers() {
      const waiting = [...timers.values()];
      timers.clear();
      waiting.forEach((run) => run());
    },
  };
}

test('무대에 붙여넣으면 클립보드를 읽었다는 알림이 떴다가 사라진다', (t) => {
  const page = mountExtras(t);
  page.paste('canvas', '붙여넣기');

  assert.deepEqual(page.pasted, ['붙여넣기'], '값은 작품으로 들어갑니다');
  const notice = page.notice()!;
  assert.ok(notice, '알림 자리가 있습니다');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent ?? '', /클립보드/);

  page.runTimers();
  assert.equal(notice.hidden, true, '스스로 사라집니다');
});

test('대답 입력칸에 붙여넣으면 알림은 뜨지 않는다', (t) => {
  const page = mountExtras(t);
  page.paste('answer', '대답');

  assert.deepEqual(page.pasted, ['대답'], '값은 그대로 작품으로 들어갑니다');
  assert.equal(page.notice()?.hidden, true, '칸에 글이 보이므로 알릴 것이 없습니다');
});

test('작품이 도는 중이 아니거나 페이지의 다른 칸에 붙여넣으면 아무 일도 없다', (t) => {
  const page = mountExtras(t);
  page.focus('comment');
  page.paste('comment', '댓글');
  assert.deepEqual(page.pasted, []);
  assert.equal(page.notice()?.hidden, true);

  page.machine.state = 'stop';
  page.paste('canvas', '멈춘 사이');
  assert.deepEqual(page.pasted, [], '멈춘 작품은 클립보드를 읽지 않습니다');
  assert.equal(page.notice()?.hidden, true);
});

// Button focus should not steal pastes from the work because the button is not a text input.
test('무대 밖 단추에 포커스가 있어도 붙여넣기는 작품으로 간다', (t) => {
  const page = mountExtras(t);
  page.focus('start');
  page.paste('start', '시작 단추를 누른 뒤');
  assert.deepEqual(page.pasted, ['시작 단추를 누른 뒤']);

  page.focus('player');
  page.paste('player', '무대를 누른 뒤');
  assert.deepEqual(page.pasted.length, 2);
});

test('붙여넣기에는 간격도 한도도 없다', (t) => {
  const page = mountExtras(t);
  for (let i = 0; i < 5; i += 1) {
    page.paste('canvas', `${i}`);
  }
  assert.deepEqual(page.pasted, ['0', '1', '2', '3', '4']);

  page.host().copy('복사할 글');
  assert.equal(page.dialogOpen(), true);
  page.paste('canvas', '창이 서 있는 동안');
  assert.equal(page.pasted.at(-1), '창이 서 있는 동안');
});

test('복사는 다시 묻지 않기를 켜면 그다음부터 묻지 않고 복사한다', async (t) => {
  const page = mountExtras(t);
  page.host().copy('첫 번째');
  assert.equal(page.dialogOpen(), true);
  page.answer(true, true);
  assert.deepEqual(page.copied, ['첫 번째']);

  page.advance(2000);
  page.host().copy('두 번째');
  assert.equal(page.dialogOpen(), false, '두 번째는 묻지 않습니다');
  await Promise.resolve();
  assert.deepEqual(page.copied, ['첫 번째', '두 번째']);
  assert.match(page.notice()?.textContent ?? '', /복사/, '대신 복사했다고 알립니다');
});

test('복사를 다시 묻지 않기로 거절하면 그다음부터 묻지도 복사하지도 않는다', (t) => {
  const page = mountExtras(t);
  page.host().copy('첫 번째');
  page.answer(false, true);
  assert.deepEqual(page.copied, []);

  page.advance(2000);
  page.host().copy('두 번째');
  assert.equal(page.dialogOpen(), false);
  assert.deepEqual(page.copied, []);
});

test('마우스 잠금도 다시 묻지 않기를 켜면 다음 실행부터 바로 가져간다', (t) => {
  const page = mountExtras(t);
  page.host().lock(true);
  assert.equal(page.dialogOpen(), true);
  page.answer(true, true);
  assert.equal(page.locks.length, 1);

  // Reset per-run consent on stop but retain answers remembered for this page.
  page.host().release();
  page.host().lock(true);
  assert.equal(page.dialogOpen(), false, '다시 묻지 않습니다');
  assert.equal(page.locks.length, 2);
});
