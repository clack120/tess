// Handle clipboard and pointer requests inside viewer gestures so browser permissions remain valid.
import { stage } from '../runtime/model.ts';
import type { PixiRenderer } from '../render/renderer.ts';
import type { Vm } from '../runtime/engine.ts';

const COPY_INTERVAL = 1000;
const NOTICE_TIME = 1800;
const DETAIL_LIMIT = 20_000;
// Normalize wheel units from pixels, lines, or pages.
const WHEEL_UNITS = [100, 3, 1];
const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export const EXTRAS_DIALOG_STYLE = `
/* Keep permission dialogs in ordinary pixels so embedded stages cannot shrink their controls. */
.tessvm-ask-permission {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  padding: 16px;
  box-sizing: border-box;
  background: rgba(23, 26, 33, 0.45);
  backdrop-filter: blur(3px);
  font-family: 'Nanum Gothic', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: normal;
  animation: tessvm-permit-in 0.14s ease-out;
}

.tessvm-ask-permission[hidden] { display: none !important; }

@keyframes tessvm-permit-in { from { opacity: 0; } to { opacity: 1; } }

.tessvm-ask-permission .tessvm-permit-card {
  width: min(100%, 400px);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 22px 22px 18px;
  box-sizing: border-box;
  background: #fff;
  color: #2c313d;
  border: 0;
  border-radius: 16px;
  box-shadow: 0 18px 40px rgba(16, 19, 26, 0.28);
  animation: tessvm-permit-rise 0.16s cubic-bezier(0.2, 0.8, 0.3, 1);
}

@keyframes tessvm-permit-rise {
  from { transform: translateY(12px) scale(0.98); }
  to { transform: none; }
}

.tessvm-ask-permission h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.35;
  color: inherit;
}

.tessvm-ask-permission p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: #5a616e;
  white-space: pre-line;
}

.tessvm-ask-permission details {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #e4e6eb;
  border-radius: 10px;
  overflow: hidden;
}

.tessvm-ask-permission summary {
  flex: none;
  padding: 8px 12px;
  font-size: 12.5px;
  line-height: 1.5;
  color: #5a616e;
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.tessvm-ask-permission summary::-webkit-details-marker { display: none; }
.tessvm-ask-permission summary::before { content: '▸ '; }
.tessvm-ask-permission details[open] summary::before { content: '▾ '; }
.tessvm-ask-permission summary:hover { background: #f5f6f8; }

.tessvm-ask-permission pre {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 130px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  overscroll-behavior: contain;
  border-top: 1px solid #e4e6eb;
  background: #f7f8fa;
  color: #2c313d;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tessvm-ask-permission .tessvm-permit-buttons {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}

.tessvm-ask-permission .tessvm-permit-keep {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: 12.5px;
  line-height: 1.4;
  color: #5a616e;
  cursor: pointer;
  user-select: none;
}

.tessvm-ask-permission .tessvm-permit-keep[hidden] { display: none !important; }

.tessvm-ask-permission .tessvm-permit-keep input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: #4f80ff;
  cursor: pointer;
}

.tessvm-ask-permission button {
  min-width: 78px;
  min-height: 38px;
  margin: 0;
  padding: 9px 16px;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.4;
  border: 0;
  border-radius: 9px;
  cursor: pointer;
  transition: background-color 0.12s ease-out;
}

.tessvm-ask-permission .tessvm-permit-deny { background: #eef0f3; color: #5a616e; }
.tessvm-ask-permission .tessvm-permit-deny:hover { background: #e2e5ea; }
.tessvm-ask-permission .tessvm-permit-allow { background: #4f80ff; color: #fff; }
.tessvm-ask-permission .tessvm-permit-allow:hover { background: #3c6df2; }
.tessvm-ask-permission button:focus-visible {
  outline: 2px solid #1b4bd8;
  outline-offset: 2px;
}

.tessvm-notice {
  position: absolute;
  left: 50%;
  top: 12px;
  z-index: 4;
  max-width: calc(100% - 24px);
  padding: 8px 14px;
  box-sizing: border-box;
  background: rgba(23, 26, 33, 0.86);
  color: #fff;
  border-radius: 999px;
  font-family: 'Nanum Gothic', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  transform: translateX(-50%);
  animation: tessvm-notice-fade ${NOTICE_TIME}ms ease-out forwards;
}

.tessvm-notice[hidden] { display: none !important; }

@keyframes tessvm-notice-fade {
  from { opacity: 0; transform: translate(-50%, -8px); }
  10%, 75% { opacity: 1; transform: translate(-50%, 0); }
  to { opacity: 0; transform: translate(-50%, 0); }
}
`;

interface Request {
  title: string;
  body: string;
  /** Shown folded away, in a box of its own. Left out, there is no box. */
  detail?: string;
  confirm: string;
  /** Label for the box that keeps the answer. Left out, there is no box. */
  remember?: string;
  /** Run inside the click on the button, so the browser still counts it. */
  answer(allowed: boolean, remember: boolean): void;
}

interface Dialog {
  /** False when one already stands — the answer is never asked for twice at once. */
  ask(request: Request): boolean;
  readonly open: boolean;
  dispose(): void;
}

function makeDialog(parent: HTMLElement): Dialog {
  const root = document.createElement('div');
  root.className = 'tessvm-ask-permission';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');

  const card = document.createElement('div');
  card.className = 'tessvm-permit-card';
  const heading = document.createElement('h2');
  const body = document.createElement('p');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '내용 보기';
  const content = document.createElement('pre');
  details.append(summary, content);
  const buttons = document.createElement('div');
  buttons.className = 'tessvm-permit-buttons';
  const keep = document.createElement('label');
  keep.className = 'tessvm-permit-keep';
  const keepBox = document.createElement('input');
  keepBox.type = 'checkbox';
  const keepText = document.createElement('span');
  keep.append(keepBox, keepText);
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'tessvm-permit-deny';
  deny.textContent = '취소';
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'tessvm-permit-allow';
  card.append(heading, body, details, buttons);
  buttons.append(keep, deny, allow);
  root.appendChild(card);
  parent.appendChild(root);

  let pending: Request | null = null;

  const close = (allowed: boolean) => {
    const request = pending;
    pending = null;
    root.hidden = true;
    content.textContent = '';
    request?.answer(allowed, keepBox.checked);
  };
  allow.addEventListener('click', () => close(true));
  deny.addEventListener('click', () => close(false));
  // Keep dialog keys from reaching work scripts.
  card.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      close(false);
    }
  });

  return {
    get open() {
      return pending !== null;
    },
    ask(request) {
      if (pending) {
        return false;
      }
      pending = request;
      heading.textContent = request.title;
      body.textContent = request.body;
      allow.textContent = request.confirm;
      const remember = request.remember ?? '';
      keep.hidden = remember === '';
      keepText.textContent = remember;
      keepBox.checked = false;
      const detail = request.detail ?? '';
      details.hidden = detail === '';
      details.open = false;
      // Copy the full text but truncate its preview so large variables cannot overwhelm the dialog.
      content.textContent =
        detail.length > DETAIL_LIMIT
          ? `${detail.slice(0, DETAIL_LIMIT)}\n… ${detail.length - DETAIL_LIMIT}자 더`
          : detail;
      root.hidden = false;
      allow.focus({ preventScroll: true });
      return true;
    },
    dispose() {
      pending = null;
      root.remove();
    },
  };
}

interface Notice {
  /** Shows the line and starts its fade over again. */
  show(text: string): void;
  dispose(): void;
}

function makeNotice(parent: HTMLElement): Notice {
  const root = document.createElement('div');
  root.className = 'tessvm-notice';
  root.hidden = true;
  root.setAttribute('role', 'status');
  parent.appendChild(root);

  let timer = 0;

  return {
    show(text) {
      root.textContent = text;
      // Hide first to restart the fade when a notice is already visible.
      root.hidden = true;
      void root.offsetWidth;
      root.hidden = false;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        root.hidden = true;
      }, NOTICE_TIME);
    },
    dispose() {
      clearTimeout(timer);
      root.remove();
    },
  };
}

export interface ExtrasBinding {
  /** Cursor the work asked for, `''` when it has asked for none. */
  cursor(): string;
  dispose(): void;
}

export function bindExtras(
  vm: Vm,
  renderer: PixiRenderer,
  frame: HTMLElement,
  view: HTMLElement,
  cleanups: Array<() => void>,
): ExtrasBinding {
  const extras = vm.extras;
  const dialog = makeDialog(frame);
  const notice = makeNotice(frame);
  const on = <T extends EventTarget>(
    target: T,
    type: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  let wanted = '';
  // Keep cursor-hiding consent for the life of the page.
  let hideAllowed: boolean | null = null;
  let lockAllowed = false;
  let copyAlways: boolean | null = null;
  let lockAlways: boolean | null = null;
  let lastCopy = 0;

  // Browser clipboard writes must run inside a viewer gesture.
  const write = (text: string): Promise<void> =>
    navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'));

  const askCopy = (text: string) =>
    dialog.ask({
      title: '클립보드 복사',
      body: '작품이 클립보드에 내용을 복사하려고 합니다.',
      detail: text,
      confirm: '복사',
      remember: '다시 묻지 않기',
      answer: (allowed, remember) => {
        if (remember) {
          copyAlways = allowed;
        }
        if (allowed) {
          void write(text).catch(() => undefined);
        }
      },
    });

  extras.host = {
    copy(text) {
      const now = performance.now();
      if (text === '' || copyAlways === false || now - lastCopy < COPY_INTERVAL) {
        return;
      }
      lastCopy = now;
      if (copyAlways) {
        // Try immediately after consent; ask again only if the browser rejects the gesture context.
        void write(text).then(
          () => notice.show('작품이 클립보드에 복사했습니다.'),
          () => askCopy(text),
        );
        return;
      }
      if (!dialog.open) {
        askCopy(text);
      }
    },

    cursor(value) {
      if (value !== 'none') {
        wanted = value;
        return;
      }
      if (hideAllowed !== null) {
        wanted = hideAllowed ? 'none' : '';
        return;
      }
      dialog.ask({
        title: '마우스 포인터 감추기',
        body: '작품이 무대 위에서 마우스 포인터를 감추려고 합니다.\n포인터는 무대 밖으로 나가면 다시 보입니다.',
        confirm: '감추기',
        answer: (allowed) => {
          hideAllowed = allowed;
          wanted = allowed ? 'none' : '';
        },
      });
    },

    lock(on) {
      if (!on) {
        if (document.pointerLockElement === view) {
          document.exitPointerLock();
        }
        return;
      }
      if (document.pointerLockElement === view) {
        return;
      }
      if (lockAllowed || lockAlways) {
        request();
        return;
      }
      if (lockAlways === false) {
        extras.lockChanged(false);
        return;
      }
      // Keep an existing question open rather than replacing it on each frame.
      dialog.ask({
        title: '마우스 잠금',
        body: '작품이 마우스 포인터를 무대 안에 가두려고 합니다.\nEsc 키를 누르면 언제든 빠져나올 수 있습니다.',
        confirm: '허용',
        remember: '다시 묻지 않기',
        answer: (allowed, remember) => {
          if (remember) {
            lockAlways = allowed;
          }
          lockAllowed = allowed;
          if (allowed) {
            request();
          } else {
            extras.lockChanged(false);
          }
        },
      });
    },

    release() {
      wanted = '';
      lockAllowed = false;
      if (document.pointerLockElement === view) {
        document.exitPointerLock();
      }
    },
  };

  // Report a refused pointer lock as unlocked state rather than a script error.
  const request = () => {
    const result = view.requestPointerLock() as unknown as Promise<void> | undefined;
    void result?.catch?.(() => extras.lockChanged(false));
  };

  // Text controls keep their own paste events.
  const field = (node: Element | null): boolean =>
    node !== null &&
    (FIELD_TAGS.has(node.tagName) || (node as HTMLElement).isContentEditable === true);

  // Listen on the window but leave text-field pastes to the page's controls.
  const ours = (target: EventTarget | null): boolean => {
    if (target instanceof Node && view.contains(target)) {
      return true;
    }
    const active = document.activeElement;
    return !active || view.contains(active) || !field(active);
  };

  const intoAnswer = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('.tessvm-ask') !== null;

  // Paste is a viewer action; capture it without throttling or waiting for a permission dialog.
  on(
    window,
    'paste',
    (raw) => {
      const event = raw as ClipboardEvent;
      if (!extras.uses.clipboard || vm.state !== 'run' || !ours(event.target)) {
        return;
      }
      const text = event.clipboardData?.getData('text/plain');
      if (text) {
        extras.pasted(text);
        // Show a stage-paste notice because no input field displays the pasted text there.
        if (!intoAnswer(event.target)) {
          notice.show('작품이 클립보드를 읽었습니다.');
        }
      }
    },
    { capture: true },
  );

  on(
    view,
    'wheel',
    (raw) => {
      if (!extras.uses.scroll || vm.state !== 'run') {
        return;
      }
      const event = raw as WheelEvent;
      const unit = WHEEL_UNITS[event.deltaMode] ?? WHEEL_UNITS[0]!;
      // Flip wheel y because stage y increases upward.
      extras.scrolled(event.deltaX / unit, -event.deltaY / unit);
      // Prevent page scrolling when the work reads the wheel.
      event.preventDefault();
    },
    { passive: false },
  );

  on(document, 'pointerlockchange', () => {
    extras.lockChanged(document.pointerLockElement === view);
  });
  on(document, 'pointerlockerror', () => extras.lockChanged(false));
  on(document, 'mousemove', (raw) => {
    if (document.pointerLockElement !== view) {
      return;
    }
    const event = raw as MouseEvent;
    const rect = renderer.canvasRect();
    // Convert CSS movement pixels to stage units and flip y.
    const perX = rect.width ? stage.width / rect.width : 1;
    const perY = rect.height ? stage.height / rect.height : 1;
    extras.moved(event.movementX * perX, -event.movementY * perY);
  });

  return {
    cursor: () => wanted,
    dispose: () => {
      extras.host = null;
      dialog.dispose();
      notice.dispose();
    },
  };
}
