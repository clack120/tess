import { Vm, type EntryProjectLike, type EntryUser, type VariableStore } from '../runtime/engine.ts';
import { PixiRenderer } from '../render/renderer.ts';
import { EntryTtsEngine, WebAudioEngine } from '../audio/sound.ts';
import { EntryTranslator } from './translate.ts';
import { mountChartWindow } from './chart-view.ts';
import { LIST_MIN_SIZE } from '../render/overlay.ts';
import { setStageSize, stage, type Entity } from '../runtime/model.ts';
import { localVariableStore } from './store.ts';
import { dexieSaveStore } from './save-store.ts';
import type { SaveHost } from '../runtime/save.ts';
import { bindExtras } from './extras.ts';
import { RuntimeDiagnostics } from './diagnostics.ts';
import { setAssetCache } from './fetch-retry.ts';
import { mountDiagnostics } from './diagnostics-view.ts';

export interface BootOptions {
  signal?: AbortSignal;
  projectUrl?: string;
  project?: EntryProjectLike;
  container?: HTMLElement;
  // Default to waiting for the viewer to start the work.
  autoStart?: boolean;
  // Leave unset to start on the first scene; editors may select another by ID or name.
  scene?: string;
  quality?: number;
  // Leave unset to use the project's speed.
  fps?: number;
  showStats?: boolean;
  boost?: boolean;
  stageWidth?: number;
  stageHeight?: number;
  // A focusable target keeps work keys separate from surrounding page inputs.
  keyTarget?: HTMLElement;
  svg?: boolean;
  // Claim Escape like other work keys and lock it during element fullscreen where supported (default true).
  grabEscape?: boolean;
  // Keep downloaded costumes and sounds in Cache Storage and reuse them without revalidation.
  cacheAssets?: boolean;
  // Without a viewer, both identity blocks return a space.
  user?: EntryUser | null;
  tableColumnName?: string;
  kernel?: boolean;
  onProgress?(loaded: number, total: number): void;
  // Omitted uses browser storage; null keeps shared values in VM memory only.
  store?: VariableStore | null;
  // Omitted uses IndexedDB; null disables saving and clears can_save.
  saveStore?: SaveHost | null;
  // Wait for all assets by default; disabling this allows loading during the run.
  waitForAssets?: boolean;
}

export interface EntropyHandle {
  vm: Vm;
  renderer: PixiRenderer;
  audio: WebAudioEngine;
  stage: typeof stage;
  // Keep initial environment settings for the debug panel's restore action.
  defaultBoost: boolean;
  defaultTouch: boolean;
  defaultDeviceType: 'desktop' | 'tablet' | 'mobile';
  defaultUser: EntryUser | null;
  start(): void;
  stop(): void;
  pause(): void;
  inspect(): void;
  downloadDiagnostics(): void;
  relayout(): void;
  setStageSize(width: number, height: number): void;
  dispose(): void;
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17,
  ControlRight: 17, AltLeft: 18, AltRight: 18, CapsLock: 20, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38,
  ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53,
  Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
  KeyA: 65, KeyB: 66, KeyC: 67, KeyD: 68, KeyE: 69, KeyF: 70, KeyG: 71, KeyH: 72,
  KeyI: 73, KeyJ: 74, KeyK: 75, KeyL: 76, KeyM: 77, KeyN: 78, KeyO: 79, KeyP: 80,
  KeyQ: 81, KeyR: 82, KeyS: 83, KeyT: 84, KeyU: 85, KeyV: 86, KeyW: 87, KeyX: 88,
  KeyY: 89, KeyZ: 90,
  Numpad0: 96, Numpad1: 97, Numpad2: 98, Numpad3: 99, Numpad4: 100, Numpad5: 101,
  Numpad6: 102, Numpad7: 103, Numpad8: 104, Numpad9: 105,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191,
  Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
};

function keyCodeOf(event: KeyboardEvent): number {
  const code = KEY_CODES[event.code] ?? event.keyCode ?? 0;
  // Entry's input map excludes function keys; preserve their browser actions.
  return code >= 112 && code <= 123 ? 0 : code;
}

// Use a worker timer because hidden-page timers can be heavily throttled.
const TICKER_WORKER = `let id = 0;
onmessage = (e) => {
  clearInterval(id);
  id = e.data > 0 ? setInterval(() => postMessage(0), e.data) : 0;
};`;

// Use animation frames while visible and a worker timer while hidden; the engine catches up by clock.
function startFrameDriver(step: (now: number) => void): () => void {
  const INTERVAL = 1000 / 60;
  let raf = 0;
  let timer = 0;
  let worker: Worker | null = null;

  const tick = () => step(performance.now());
  const loop = () => {
    raf = requestAnimationFrame(loop);
    tick();
  };

  const makeWorker = () => {
    try {
      const url = URL.createObjectURL(new Blob([TICKER_WORKER], { type: 'text/javascript' }));
      const made = new Worker(url);
      URL.revokeObjectURL(url);
      made.onmessage = tick;
      return made;
    } catch (error) {
      // Fall back to a plain timer when CSP or browser settings block blob workers.
      return null;
    }
  };

  const startBackground = () => {
    if (worker || timer) {
      return;
    }
    worker = makeWorker();
    if (worker) {
      worker.postMessage(INTERVAL);
    } else {
      timer = window.setInterval(tick, INTERVAL);
    }
  };

  const stopBackground = () => {
    worker?.terminate();
    worker = null;
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  };

  const follow = () => {
    if (document.hidden) {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      startBackground();
      return;
    }
    stopBackground();
    if (!raf) {
      raf = requestAnimationFrame(loop);
    }
  };

  document.addEventListener('visibilitychange', follow);
  follow();

  return () => {
    document.removeEventListener('visibilitychange', follow);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    stopBackground();
  };
}

function storeKey(project: EntryProjectLike): string {
  const raw = (project as { id?: unknown; name?: unknown }).id ?? (project as { name?: unknown }).name;
  return String(raw ?? 'project').slice(0, 120);
}

export async function boot(options: BootOptions = {}): Promise<EntropyHandle> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const wait = async <T>(job: Promise<T>): Promise<T> => {
    if (!signal) return job;
    signal.throwIfAborted();
    let abort: () => void = () => {};
    try {
      return await Promise.race([job, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  };
  const container = options.container ?? document.body;
  const project =
    options.project ??
    ((await (await fetch(options.projectUrl ?? '/project.json', { signal })).json()) as EntryProjectLike);
  signal?.throwIfAborted();

  if (options.stageWidth && options.stageHeight) {
    setStageSize(options.stageWidth, options.stageHeight);
  }

  const view = document.createElement('div');
  view.className = 'entropy-stage';
  container.appendChild(view);
  const frame = document.createElement('div');
  frame.className = 'entropy-frame';
  view.appendChild(frame);

  setAssetCache(options.cacheAssets ?? false);
  // Forward boost changes because they also affect renderer behavior.
  const boost = options.boost ?? true;
  const renderer = new PixiRenderer({
    parent: frame,
    quality: options.quality ?? 1,
    svg: options.svg ?? true,
    boost,
  });
  try { await renderer.init(); }
  catch (error) { renderer.destroy(); view.remove(); throw error; }

  const cleanups: Array<() => void> = [];
  let disposed = false;
  let handle: EntropyHandle | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    for (const undo of cleanups.splice(0).reverse()) undo();
    renderer.destroy();
    view.remove();
    const exposed = window as unknown as { entropy?: EntropyHandle };
    if (handle && exposed.entropy === handle) delete exposed.entropy;
  };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    signal?.throwIfAborted();

    const audio = new WebAudioEngine();
    cleanups.push(() => audio.close());
    const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const deviceType = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
    const vm = new Vm({
      renderer,
      audio,
      speech: new EntryTtsEngine(),
      translator: new EntryTranslator(),
      fps: options.fps,
      boost,
      touch,
      deviceType,
      user: options.user,
      tableColumnName: options.tableColumnName,
      store: options.store === null ? null : (options.store ?? localVariableStore(storeKey(project))),
      kernel: options.kernel !== false,
    });
    cleanups.push(() => vm.stop());

    vm.load(project);
    if (options.scene) vm.setStartScene(options.scene);
    // Restore saved values before the work starts on every run.
    vm.save.host = options.saveStore === null ? null : (options.saveStore ?? dexieSaveStore(storeKey(project)));
    await wait(vm.save.load());
    renderer.overlayView?.bind({
      variables: vm.variables,
      ownerName: (objectId) => vm.targetOf(objectId)?.name ?? null,
      ownerScene: (objectId) => vm.targetOf(objectId)?.sceneId ?? null,
      answer: () => vm.answer,
      answerVisible: () => vm.answerVisible,
      timer: () => vm.timerValue(),
      timerVisible: () => vm.timerVisible,
      scene: () => vm.currentSceneId,
    });
    // Wait for assets by default; opting out allows missing costumes and late sound loads during execution.
    const sounds = vm.targets.flatMap((target) => target.sounds);
    const waitForAssets = options.waitForAssets ?? true;
    const total = PixiRenderer.costumeCount(vm.targets) + sounds.length;
    let loaded = 0;
    let failed = 0;
    const arrived = (ok: boolean) => {
      loaded += 1;
      if (!ok) failed += 1;
      options.onProgress?.(loaded, total);
      if (loaded === total && failed) console.warn(`[entropy] 모양·소리 ${failed}개를 받지 못했습니다`);
    };
    options.onProgress?.(0, total);
    // Start both preloads regardless of whether the caller waits for them.
    const costumes = renderer
      .preload(vm.targets, vm.currentSceneId, arrived)
      .catch((error) => console.warn('[entropy] 모양을 미리 받지 못했습니다', error));
    const files = audio.preload(sounds, 6, arrived).catch((error) => console.warn('[entropy] 소리를 미리 받지 못했습니다', error));
    if (waitForAssets) {
      await wait(Promise.all([costumes, files]));
    }
    // Paint the idle stage, then remeasure text after web fonts finish loading.
    renderer.flush();
    void renderer.waitForFonts();

    const question = makeQuestionField(frame, (value) => {
      vm.pendingAnswer = value;
    }, () => (options.keyTarget ?? view).focus({ preventScroll: true }));
    const originalShow = renderer.showQuestion.bind(renderer);
    renderer.showQuestion = (text: string) => {
      originalShow(text);
      question.show();
    };
    const originalHide = renderer.hideQuestion.bind(renderer);
    renderer.hideQuestion = () => {
      originalHide();
      question.hide();
    };

    // Charts use HTML windows; ordinary tables stay on the canvas.
    const chartWindow = mountChartWindow(frame, () => vm.openTable(null));
    cleanups.push(() => chartWindow.dispose());
    const originalTable = renderer.showTable.bind(renderer);
    renderer.showTable = (table, chart = null) => {
      originalTable(table, chart);
      if (table && chart !== null && table.charts?.[chart]) {
        chartWindow.show(table, chart);
      } else {
        chartWindow.hide();
      }
    };

    const extras = bindExtras(vm, renderer, frame, view, cleanups);
    cleanups.push(() => extras.dispose());
    const syncCursor = bindInput(
      vm,
      renderer,
      view,
      options.keyTarget ?? window,
      cleanups,
      extras.cursor,
      options.grabEscape ?? true,
    );

    // Skip unchanged sizes and defer layout writes to avoid a ResizeObserver feedback loop.
    let lastWidth = 0;
    let lastHeight = 0;
    const layout = (force: boolean) => {
      const width = view.clientWidth || stage.worldWidth;
      const height = view.clientHeight || stage.worldHeight;
      if (!force && width === lastWidth && height === lastHeight) {
        return;
      }
      lastWidth = width;
      lastHeight = height;
      const fitted = renderer.layout(width, height);
      if (fitted) {
        frame.style.setProperty('--entropy-stage-width', `${fitted.width}px`);
      }
    };
    const resize = () => layout(true);
    let queued = 0;
    cleanups.push(() => { if (queued) cancelAnimationFrame(queued); });
    const layoutSoon = () => {
      if (queued) {
        return;
      }
      queued = requestAnimationFrame(() => {
        queued = 0;
        layout(false);
      });
    };
    resize();
    window.addEventListener('resize', resize);
    cleanups.push(() => window.removeEventListener('resize', resize));
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(layoutSoon);
      observer.observe(view);
      cleanups.push(() => observer.disconnect());
    }

    const stats = options.showStats ? makeStats(frame) : null;
    const diagnostics = new RuntimeDiagnostics(vm);
    for (const type of ['focus', 'blur', 'focusin']) {
      const listener = () => diagnostics.recordFocus(type);
      window.addEventListener(type, listener);
      cleanups.push(() => window.removeEventListener(type, listener));
    }
    const diagnosticView = mountDiagnostics(container, diagnostics, () => {
      (options.keyTarget ?? view).focus({ preventScroll: true });
    });
    cleanups.push(() => diagnosticView.dispose());
    let last = performance.now();
    let frames = 0;
    let accumulated = 0;

    const step = (now: number) => {
      // Stop and report uncaught frame failures instead of leaving a frozen canvas with a live driver.
      const began = performance.now();
      try {
        vm.advance(now);
      } catch (error) {
        vm.fail(error);
      }
      diagnostics.record(now, performance.now() - began);
      syncCursor();
      chartWindow.sync();
      if (stats) {
        frames += 1;
        accumulated += now - last;
        last = now;
        if (accumulated >= 500) {
          stats.textContent =
            `${Math.round((frames * 1000) / accumulated)} fps · ${vm.frame} tick` +
            ` · ${vm.frameRate}Hz · ${stage.width}×${stage.height}`;
          frames = 0;
          accumulated = 0;
        }
      }
    };
    const stopFrames = startFrameDriver(step);
    cleanups.push(stopFrames);

    handle = {
      vm,
      renderer,
      audio,
      stage,
      defaultBoost: boost,
      defaultTouch: touch,
      defaultDeviceType: deviceType,
      defaultUser: vm.user,
      start: () => {
        // Focus the player before it starts so keyboard input can reach the work.
        (options.keyTarget ?? view).focus?.({ preventScroll: true });
        vm.start();
      },
      stop: () => {
        vm.stop();
        vm.reset();
        renderer.flush();
      },
      pause: () => vm.pause(),
      inspect: () => diagnosticView.open(),
      downloadDiagnostics: () => diagnosticView.download(),
      relayout: resize,
      setStageSize(width: number, height: number) {
        setStageSize(width, height);
        renderer.applyStageSize();
        for (const target of vm.targets) {
          target.forEachEntity((entity) => {
            entity.touch();
          });
        }
        resize();
        renderer.flush();
      },
      dispose,
    };

    if (options.autoStart) {
      vm.start();
    }
    (window as unknown as { entropy: EntropyHandle }).entropy = handle;
    return handle;
  } catch (error) {
    dispose();
    throw error;
  }
}

const MODIFIER_KEY_CODES = new Set([16, 17, 18]);
const ESCAPE = 27;

const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A']);

// Capture work keys only while running and focused; leave text controls to their own key handlers.
function worksKey(vm: Vm, event: KeyboardEvent, code: number, grabEscape: boolean): boolean {
  // Stopped or paused works keep browser actions; Escape reaches the browser too unless it is grabbed.
  if (code === 0 || (code === ESCAPE && !grabEscape) || vm.state !== 'run') {
    return false;
  }
  // Keep browser shortcuts unless the running work reacts to their key.
  if ((event.ctrlKey || event.altKey || event.metaKey) && !MODIFIER_KEY_CODES.has(code) &&
    vm.usedKeys !== null && !vm.usedKeys.has(code)) {
    return false;
  }
  const target = event.target as HTMLElement | null;
  return !target?.isContentEditable && !CONTROL_TAGS.has(target?.tagName ?? '');
}

// Refresh focus and cursor each frame because the stage can move under a stationary pointer.
function bindInput(
  vm: Vm,
  renderer: PixiRenderer,
  view: HTMLElement,
  keyTarget: HTMLElement | Window,
  cleanups: Array<() => void>,
  // Explicit work cursor requests take precedence over the automatic cursor.
  workCursor: () => string,
  grabEscape: boolean,
): () => void {
  const on = <T extends EventTarget>(target: T, type: string, handler: EventListener, capture = false) => {
    target.addEventListener(type, handler, capture);
    cleanups.push(() => target.removeEventListener(type, handler, capture));
  };
  const toStage = (clientX: number, clientY: number) => {
    const rect = renderer.canvasRect();
    return {
      x: stage.width * ((clientX - rect.left) / rect.width - 0.5),
      y: -stage.height * ((clientY - rect.top) / rect.height - 0.5),
    };
  };

  const claim = (event: KeyboardEvent, code: number) => {
    if (worksKey(vm, event, code, grabEscape)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  on(keyTarget, 'keydown', (raw) => {
    const event = raw as KeyboardEvent;
    const code = keyCodeOf(event);
    if (!code) return;
    vm.pressedKeys.add(code);
    // Forward repeated keydowns too because Entry runs key scripts at the browser's repeat rate.
    vm.fireEvent('keyPress', String(code));
    claim(event, code);
  });
  on(keyTarget, 'keyup', (raw) => {
    const event = raw as KeyboardEvent;
    const code = keyCodeOf(event);
    if (!code) return;
    vm.pressedKeys.delete(code);
    claim(event, code);
  });
  let syncFocus = () => {};
  // Key releases can arrive after focus moves; keep keydown scoped to the player.
  if (keyTarget !== window) {
    on(window, 'keyup', (raw) => vm.pressedKeys.delete(keyCodeOf(raw as KeyboardEvent)), true);
    const player = keyTarget as HTMLElement;
    let playerFocused = document.activeElement === player;
    let restoreFocus = false;
    const fullscreen = () => {
      const full = document.fullscreenElement;
      return full === player || !!full && player.contains(full);
    };
    syncFocus = () => {
      const full = fullscreen();
      if ((!full && !restoreFocus) || !player.isConnected || document.hidden || !document.hasFocus()) return;
      const active = document.activeElement;
      if (full) {
        if (player.contains(active) || active?.closest('dialog[open]')) return;
      } else if (vm.state !== 'run' || active && active !== document.body &&
        active !== document.documentElement && active !== player) return;
      // Retain focus retries because browser activation may finish after its focus event.
      if (active !== player) {
        player.focus({ preventScroll: true });
      }
      if (document.activeElement === player) restoreFocus = false;
    };
    on(window, 'focusin', () => {
      const active = document.activeElement;
      playerFocused = active === player;
      if (!fullscreen() && document.hasFocus() && active && active !== document.body &&
        active !== document.documentElement && !playerFocused) restoreFocus = false;
      syncFocus();
    });
    on(window, 'blur', () => { restoreFocus ||= playerFocused || document.activeElement === player; });
    on(window, 'focus', syncFocus);
    on(document, 'visibilitychange', syncFocus);
    on(document, 'fullscreenchange', syncFocus);
    // Element fullscreen exits on Escape before pages see it; Chromium's Keyboard Lock keeps it (hold to exit).
    const keyboard = (globalThis.navigator as Navigator & { keyboard?: { lock?(keys: string[]): Promise<void>; unlock?(): void } } | undefined)?.keyboard;
    if (grabEscape && keyboard?.lock) {
      const lockEscape = () => {
        if (fullscreen()) keyboard.lock!(['Escape']).catch((error) => console.warn('[entropy] 전체화면에서 Esc 를 잡지 못했습니다', error));
        else keyboard.unlock?.();
      };
      on(document, 'fullscreenchange', lockEscape);
      lockEscape();
      cleanups.push(() => keyboard.unlock?.());
    } else if (grabEscape) {
      // Firefox has no Keyboard Lock and Brave removes it, so say why Escape still leaves fullscreen.
      let told = false;
      on(document, 'fullscreenchange', () => {
        if (told || !fullscreen()) return;
        told = true;
        console.warn('[entropy] 이 브라우저는 Keyboard Lock 을 지원하지 않아 전체화면에서 Esc 를 잡을 수 없습니다');
      });
    }
  }
  // Clear pressed keys on blur because the window may never receive their releases.
  on(window, 'blur', () => vm.pressedKeys.clear());

  const move = (clientX: number, clientY: number) => {
    const point = toStage(clientX, clientY);
    vm.mouseX = point.x;
    vm.mouseY = point.y;
    vm.pointerSeen = true;
  };

  let hovering = false;
  on(view, 'pointerenter', () => {
    hovering = true;
  });
  on(view, 'pointerleave', () => {
    hovering = false;
    renderer.setCursor(workCursor());
  });

  // Monitor dragging consumes its press instead of sending it to work scripts.
  type Dragged = Parameters<NonNullable<typeof renderer.overlayView>['scrollTo']>[0];
  let dragging:
    | { variable: Dragged; fromRow: number; fromY: number; rowsPerPixel: number }
    | null = null;
  let sliding: Dragged | null = null;
  let resizing: { variable: Dragged; fromX: number; fromY: number } | null = null;

  // Prevent surrounding draggable links and images from stealing the stage pointer.
  on(window, 'dragstart', (event) => {
    if (vm.mouseDown || vm.clickedEntityId || dragging || sliding || resizing) event.preventDefault();
  }, true);

  on(view, 'pointermove', (raw) => {
    const event = raw as PointerEvent;
    move(event.clientX, event.clientY);
  });
  on(window, 'pointermove', (raw) => {
    const event = raw as PointerEvent;
    // Keep tracking held drags outside the embedded canvas.
    if (vm.mouseDown || vm.clickedEntityId) move(event.clientX, event.clientY);
    if (resizing) {
      const point = toStage(event.clientX, event.clientY);
      const box = resizing.variable as unknown as { width: number; height: number };
      box.width = Math.max(LIST_MIN_SIZE, point.x - resizing.fromX);
      box.height = Math.max(LIST_MIN_SIZE, -point.y - resizing.fromY);
      renderer.flush();
      return;
    }
    if (sliding) {
      renderer.overlayView?.dragSlider(sliding, toStage(event.clientX, event.clientY).x);
      renderer.flush();
      return;
    }
    if (!dragging) {
      return;
    }
    const point = toStage(event.clientX, event.clientY);
    // Overlay y increases downward; stage y increases upward.
    const rows = (-point.y - dragging.fromY) * dragging.rowsPerPixel;
    renderer.overlayView?.scrollTo(dragging.variable, dragging.fromRow + rows);
    renderer.flush();
  });
  on(view, 'pointerdown', (raw) => {
    const event = raw as PointerEvent;
    if ((event.target as Element | null)?.closest?.('input, textarea, select, button, form, [contenteditable="true"]')) return;
    event.preventDefault();
    if (keyTarget !== window) (keyTarget as HTMLElement).focus({ preventScroll: true });
    move(event.clientX, event.clientY);
    // Slider track presses set the knob and do not reach work scripts.
    const slider = renderer.overlayView?.sliderAt(vm.mouseX, -vm.mouseY);
    if (slider && vm.state === 'run') {
      sliding = slider;
      renderer.overlayView?.dragSlider(slider, vm.mouseX);
      renderer.flush();
      event.preventDefault();
      return;
    }
    // Table windows consume presses like Entry's modal, including on their close button.
    const onTable = renderer.overlayView?.tableAt(vm.mouseX, -vm.mouseY);
    if (onTable) {
      if (onTable === 'close') {
        vm.openTable(null);
        renderer.flush();
      }
      event.preventDefault();
      return;
    }
    const handle = renderer.overlayView?.listHandleAt(vm.mouseX, -vm.mouseY);
    if (handle) {
      resizing = {
        variable: handle as never,
        fromX: vm.mouseX - (handle.width || 100),
        fromY: -vm.mouseY - (handle.height || 120),
      };
      event.preventDefault();
      return;
    }
    // List box presses begin scrolling and do not reach work scripts.
    const list = renderer.overlayView?.listAt(vm.mouseX, -vm.mouseY);
    if (list) {
      dragging = {
        variable: list.variable,
        fromRow: renderer.overlayView!.scrollOf(list.variable),
        fromY: -vm.mouseY,
        rowsPerPixel: list.rowsPerPixel,
      };
      event.preventDefault();
      return;
    }
    vm.mouseDown = true;
    vm.fireEvent('mouse_clicked');
    const hit = pick(vm);
    if (hit) {
      vm.clickedEntityId = hit.id;
      vm.fireEventOn('when_object_click', hit);
    }
  });
  const up = (event?: Event) => {
    if (resizing) {
      resizing = null;
      return;
    }
    if (sliding) {
      sliding = null;
      return;
    }
    if (dragging) {
      dragging = null;
      return;
    }
    // Clear stage presses on outside release, but ignore releases that started elsewhere.
    if (!vm.mouseDown && !vm.clickedEntityId) {
      return;
    }
    if (event?.type === 'pointerup') {
      const pointer = event as PointerEvent;
      move(pointer.clientX, pointer.clientY);
    }
    vm.mouseDown = false;
    vm.fireEvent('mouse_click_cancled');
    const clicked = vm.clickedEntityId;
    vm.clickedEntityId = null;
    if (clicked) {
      const entity = vm.targets
        .flatMap((target) => [target.entity, ...target.clones])
        .find((candidate) => candidate.id === clicked);
      if (entity) {
        vm.fireEventOn('when_object_click_canceled', entity);
      }
    }
  };
  on(window, 'pointerup', up);
  on(window, 'pointercancel', up);
  on(window, 'blur', () => up());

  let forced = '';
  return () => {
    syncFocus();
    const asked = workCursor();
    if (asked) {
      forced = asked;
      renderer.setCursor(asked);
      return;
    }
    // Restore the automatic cursor when the work clears its request, even outside the stage.
    if (forced) {
      forced = '';
      renderer.setCursor('');
    }
    if (!hovering) {
      return;
    }
    renderer.setCursor(
      vm.clickableAt(
        vm.mouseX * stage.scale + stage.worldWidth / 2,
        -vm.mouseY * stage.scale + stage.worldHeight / 2,
      )
        ? 'pointer'
        : '',
    );
  };
}

function pick(vm: Vm): Entity | null {
  return vm.entityAtPoint(
    vm.mouseX * stage.scale + stage.worldWidth / 2,
    -vm.mouseY * stage.scale + stage.worldHeight / 2,
  );
}

function makeQuestionField(view: HTMLElement, submit: (value: string) => void, refocus: () => void) {
  const wrap = document.createElement('form');
  wrap.className = 'entropy-ask';
  wrap.hidden = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  const button = document.createElement('button');
  button.type = 'submit';
  button.title = '확인';
  button.setAttribute('aria-label', '확인');
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.237 8.354a1 1 0 0 1 1.526 ' +
    '1.292l-5.5 6.5a1 1 0 0 1-1.47.061l-3.5-3.5a1 1 0 0 1 1.414-1.414l2.732 2.731 4.798-5.67z"/></svg>';
  wrap.append(input, button);
  wrap.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(input.value);
    input.value = '';
  });
  view.appendChild(wrap);
  return {
    show() {
      wrap.hidden = false;
      input.focus({ preventScroll: true });
    },
    hide() {
      // Return typing focus to the work; a plain blur would leave keys on the page body.
      const typing = document.activeElement === input;
      wrap.hidden = true;
      if (typing) refocus();
      else input.blur();
    },
  };
}

function makeStats(view: HTMLElement): HTMLElement {
  const element = document.createElement('div');
  element.className = 'entropy-stats';
  view.appendChild(element);
  return element;
}

