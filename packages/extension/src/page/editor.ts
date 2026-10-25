import type { EntropyHandle } from '../../../vm/src/web/boot.ts';
import type { CloudClient } from './cloud.ts';
import { withAssetUrls, type EntryWork } from './entry-project.ts';
import { signedInUser } from './signed-in.ts';
import { compactLargeProject, PROJECT_JSON_LIMIT } from './project-compact.ts';
import { improveSoundLoading } from './editor-sounds.ts';
import { beginLiveEditing, type LiveEditing } from './editor-live.ts';
import { beginActorEditing, type ActorEditing } from './editor-actors.ts';

interface Editor {
  type: string;
  isLoadProject?: boolean;
  engine: Record<string, any>;
  tickTime: number;
  playground?: Record<string, any>;
  soundQueue?: { getItem(id: string): { src?: unknown } | undefined; getResult(id: string): unknown };
  creationChangedEvent?: { attach(owner: unknown, fn: () => void): { destroy(): void } };
  exportProject(): EntryWork | false;
  getMainWS(): any;
  scene: { selectedScene?: { id: string }; getSceneById?(id: string): unknown; selectScene?(scene: unknown): void };
}
interface Prepared {
  audioContext?: AudioContext;
  root: HTMLElement;
  status: HTMLElement;
  controller: AbortController;
  handle?: EntropyHandle;
  cloud?: CloudClient;
  cloudSource?: string;
  source: string;
  requested: string;
  requestedWork: EntryWork | null;
  promise: Promise<void>;
  busy: boolean;
  svg: boolean;
  escape: boolean;
  cleanup(): void;
}
interface EditorSnapshot {
  source: string;
  work: EntryWork;
}

let settings = { enabled: false, svg: true, cache: false, escape: true };
let attached: Editor | null = null;
let attachedEngine: Record<string, any> | null = null;
let restore: (() => void) | null = null;
let prepared: Prepared | null = null;
interface RunningEditor { live?: LiveEditing | null; actors?: ActorEditing; cleanup(): void }
let active: RunningEditor | null = null;
let stopping: { entry: Editor; live?: LiveEditing | null; promise: Promise<unknown> } | null = null;
let dirty = true;
let editRevision = 0;
let cachedExport: { entry: Editor; revision: number; work: EntryWork } | null = null;
let exportingEntry: Editor | null = null;
let wrappedExport: Editor['exportProject'] | null = null;
let restoreExport: (() => void) | null = null;
let soundEditor: unknown = null;
let restoreSound: (() => void) | null = null;
const incompatible = new WeakSet<Editor>();

function traceEditor(phase: string): void {
  if (document.documentElement) document.documentElement.dataset.entropyEditorPhase = phase;
  try {
    const key = 'entropy-editor-trace';
    const previous = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    const trace = Array.isArray(previous) ? previous.slice(-23) : [];
    trace.push({ time: Date.now(), phase });
    sessionStorage.setItem(key, JSON.stringify(trace));
  } catch {}
}
traceEditor('loaded');

function observeExport(entry: Editor | undefined): void {
  if (exportingEntry === entry && entry?.type === 'workspace' && entry.exportProject === wrappedExport) return;
  restoreExport?.(); restoreExport = null; exportingEntry = null; wrappedExport = null;
  if (entry?.type !== 'workspace' || typeof entry.exportProject !== 'function') return;
  const original = entry.exportProject;
  const compactionCache = new Map();
  const observed = function(this: Editor, ...args: unknown[]) {
    if (active?.live && attached === entry) return active.live.work;
    if (stopping?.entry === entry && stopping.live) return stopping.live.work;
    let work = Reflect.apply(original, this, args) as EntryWork | false;
    if (work) {
      try {
        const result = compactLargeProject(work, PROJECT_JSON_LIMIT, compactionCache);
        work = result.project;
        if (result.beforeBytes > PROJECT_JSON_LIMIT) {
          const message = `[Entropy] 저장 JSON 축약: ${result.beforeBytes.toLocaleString()} → ${result.afterBytes.toLocaleString()} bytes`;
          if (result.afterBytes > PROJECT_JSON_LIMIT) console.warn(`${message} (16,700,000 bytes 한도 초과)`);
          else console.info(message);
        }
      } catch (error) {
        // Preserve native saving if a future Entry format cannot be compacted,
        // but leave enough evidence to diagnose an over-limit save failure.
        console.warn('[Entropy] 저장 JSON을 축약하지 못해 원본을 사용합니다', error);
      }
      cachedExport = { entry, revision: editRevision, work };
    }
    return work;
  };
  try { entry.exportProject = observed; } catch { return; }
  if (entry.exportProject !== observed) return;
  exportingEntry = entry;
  wrappedExport = observed;
  restoreExport = () => {
    try { if (entry.exportProject === observed) entry.exportProject = original; } catch {}
    if (cachedExport?.entry === entry) cachedExport = null;
  };
}

function tryCleanup(action: () => void): boolean {
  try { action(); return true; }
  catch (error) { console.warn('[entropy] 에디터 정리 중 오류가 발생했습니다', error); return false; }
}

function restoreActors(current: RunningEditor | null): void {
  const actors = current?.actors;
  if (current) current.actors = undefined;
  tryCleanup(() => actors?.restore());
}

function finish(): () => void {
  traceEditor('stopping');
  const old = active;
  active = null;
  restoreActors(old);
  const stopped = tryCleanup(() => prepared?.handle?.stop());
  if (prepared) {
    prepared.root.hidden = true;
    prepared.root.tabIndex = -1;
    prepared.root.setAttribute('aria-hidden', 'true');
  }
  if (prepared?.busy || !stopped) discard();
  // Restore native code only after toggleStop has restored Entry's edit state.
  return () => {
    tryCleanup(() => old?.cleanup());
    if (old?.live?.applied && prepared) { prepared.source = ''; prepared.requested = ''; }
    if (old?.live) cachedExport = null;
  };
}

function discard(): void {
  const old = prepared;
  prepared = null;
  tryCleanup(() => old?.controller.abort());
  tryCleanup(() => old?.handle?.dispose());
  tryCleanup(() => { if (old?.audioContext && !old.handle) void old.audioContext.close().catch(() => undefined); });
  tryCleanup(() => old?.cloud?.dispose());
  tryCleanup(() => old?.cleanup());
  tryCleanup(() => old?.root.remove());
  if (old) traceEditor('disposed');
}

// Block and comment coordinates in saved scripts only place them on the board; the runner never reads them.
const BOARD_POSITION = /(?<!\\)"x":-?[\d.eE+-]+,"y":-?[\d.eE+-]+/g;

function withoutBoardPositions(script: unknown): unknown {
  return typeof script === 'string' ? script.replace(BOARD_POSITION, '"x":0,"y":0') : script;
}

function snapshot(entry: Editor): EditorSnapshot | null {
  // Entry's own autosave exports the complete project shortly after the same
  // change event. Reuse that result instead of exporting a large work twice.
  let work = cachedExport?.entry === entry && cachedExport.revision === editRevision
    ? cachedExport.work
    : null;
  if (!work) {
    entry.getMainWS()?.syncCode();
    work = entry.exportProject() || null;
  }
  if (!work) return null;
  // Layout-only changes do not invalidate a compiled work or decoded assets.
  const objects = work.objects?.map(object => ({ ...object, script: withoutBoardPositions(object.script) }));
  const functions = work.functions?.map(fn => ({ ...fn, content: withoutBoardPositions(fn.content) }));
  return { source: JSON.stringify({ objects, scenes: work.scenes, variables: work.variables,
    messages: work.messages, functions, tables: work.tables, speed: work.speed }), work };
}

function schedule(): void {
  dirty = true;
  // Entry already owns the editor's decoded media. Do not create another
  // renderer or decode a second copy of every asset while the user is editing.
}

function createPrepared(canvas: HTMLCanvasElement, entry: Editor): Prepared {
  let audioContext: AudioContext | undefined;
  const root = document.createElement('div');
  root.className = 'entropy-player entropy-editor-player';
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute('aria-label', 'Entropy 실행 화면');
  root.setAttribute('aria-hidden', 'true');
  Object.assign(root.style, { position: 'absolute', minHeight: '0', zIndex: '2' });
  const status = document.createElement('div');
  status.className = 'entropy-status';
  status.setAttribute('role', 'status');
  Object.assign(status.style, { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', zIndex: '3' });
  root.append(status);
  const fallbackMouseInput = document.querySelector<HTMLInputElement>('.entryMouseViewWorkspace_w > input');
  const mousePosition = () => {
    if (!active || prepared?.root !== root || !prepared.handle || attached !== entry || (window as any).Entry !== entry) return;
    const input = entry.engine.mouseViewInput ?? fallbackMouseInput;
    if (!input) return;
    const vm = prepared.handle.vm;
    const value = `X : ${vm.mouseX.toFixed(1)}, Y : ${vm.mouseY.toFixed(1)}`;
    if (input.value !== value) input.value = value;
    (entry.engine.mouseView ?? input.parentElement)?.classList.remove('entryHide');
  };
  const hideMousePosition = () => {
    if (active && prepared?.root === root) {
      (entry.engine.mouseView ?? fallbackMouseInput?.parentElement)?.classList.add('entryHide');
    }
  };
  // The VM stage updates its coordinates before this bubbling listener runs.
  // Do not run the native interpreter just to update its existing readout.
  root.addEventListener('pointermove', mousePosition);
  root.addEventListener('pointerleave', hideMousePosition);
  const parents = new Map<HTMLElement, string>();
  let size = '';
  const layout = () => {
    const parent = canvas.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === 'static' && !parents.has(parent)) {
      parents.set(parent, parent.style.position);
      parent.style.position = 'relative';
    }
    const moved = root.parentElement !== parent;
    if (moved) parent.append(root);
    const next = `${canvas.offsetLeft},${canvas.offsetTop},${canvas.clientWidth},${canvas.clientHeight}`;
    if (!moved && size === next) return;
    size = next;
    Object.assign(root.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`,
      width: `${canvas.clientWidth}px`, height: `${canvas.clientHeight}px` });
    if (!root.hidden) prepared?.handle?.relayout();
  };
  const observer = new ResizeObserver(layout);
  observer.observe(canvas);
  layout();
  const timer = setInterval(() => {
    if (!canvas.isConnected) { if (active) void attached?.engine.toggleStop(); discard(); return; }
    if (active && prepared?.handle?.vm.state === 'stop' && !prepared.busy) void attached?.engine.toggleStop();
    if (active) {
      layout();
      try { active.actors?.sync(); }
      catch (error) {
        restoreActors(active);
        console.warn('[entropy] 오브젝트 속성 표시를 연결하지 못했습니다', error);
      }
    }
  }, 100);
  try { if (typeof AudioContext === 'function') audioContext = new AudioContext(); } catch {}
  return { root, status, audioContext, controller: new AbortController(), source: '', requested: '', requestedWork: null,
    promise: Promise.resolve(),
    busy: false, svg: settings.svg, escape: settings.escape,
    cleanup() {
      observer.disconnect(); clearInterval(timer);
      root.removeEventListener('pointermove', mousePosition);
      root.removeEventListener('pointerleave', hideMousePosition);
      for (const [parent, position] of parents) parent.style.position = position;
    } };
}

async function prepare(entry: Editor, snapshot: EditorSnapshot): Promise<void> {
  if (prepared && (prepared.svg !== settings.svg || prepared.escape !== settings.escape)) discard();
  const canvas = document.getElementById('entryCanvas');
  if (!(canvas instanceof HTMLCanvasElement)) return Promise.reject(new Error('엔트리 실행 화면을 찾지 못했습니다'));
  const current = prepared ?? (prepared = createPrepared(canvas, entry));
  dirty = false;
  current.requestedWork = snapshot.work;
  if (current.requested === snapshot.source) return current.promise;
  current.requested = snapshot.source;
  if (current.busy) return current.promise;
  current.busy = true;
  traceEditor('preparing');
  current.status.hidden = false;
  current.status.textContent = '실행기를 준비하는 중';
  // Serialize updates in one renderer/context; unchanged assets stay in RAM and GPU memory.
  current.promise = current.promise.catch(() => {}).then(async () => {
    do {
      const source = current.requested;
      const exported = current.requestedWork;
      if (prepared !== current) return;
      if (!exported) return;
      if (current.source === source && current.handle) break;
      const [{ boot }, { ensureStageStyle }, { bridgeSaveStore }, { CloudClient }] = await Promise.all([
        import('../../../vm/src/web/boot.ts'), import('./player.ts'), import('./save-bridge.ts'), import('./cloud.ts'),
      ]);
      traceEditor('modules-ready');
      if (prepared !== current) return;
      ensureStageStyle();
      const work = withAssetUrls(exported);
      const id = /^\/ws\/([^/?#]+)/.exec(location.pathname)?.[1] ?? 'new';
      const ids = new Map<string, string>(), mongo = new Map<string, string>();
      const cloudVariables: unknown[] = [];
      for (const variable of work.variables ?? []) {
        if (variable.isCloud || variable.isRealTime) {
          ids.set(String(variable.id), String(variable.id)); mongo.set(String(variable.id), String(variable._id));
          cloudVariables.push([variable.id, variable._id, variable.variableType,
            variable.isCloud === true, variable.isRealTime === true]);
        }
      }
      const cloudSource = JSON.stringify([id, cloudVariables]);
      if (!current.cloud || current.cloudSource !== cloudSource) {
        current.cloud?.dispose();
        current.cloud = new CloudClient(id, document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '',
          work.variables ?? [], ids, ids, mongo);
        current.cloudSource = cloudSource;
        traceEditor('cloud');
        await current.cloud.connect();
      }
      if (prepared !== current) return;
      if (current.handle) await current.handle.reload(work);
      else {
        traceEditor('booting');
        const handle = await boot({ signal: current.controller.signal, project: work,
          scene: entry.scene.selectedScene?.id,
          liveEditing: true,
          preloadAssets: false,
          audioContext: current.audioContext,
          container: current.root, autoStart: false, keyTarget: current.root, boost: true,
          svg: current.svg, get cacheAssets() { return settings.cache; }, grabEscape: current.escape,
          store: { read: key => current.cloud?.read(key), write: (key, value) => current.cloud?.write(key, value) },
          saveStore: bridgeSaveStore(id, document.title), user: signedInUser(),
          tableColumnName: (window as any).Lang?.DataAnalytics?.new_attribute,
          readAudioBuffer(sound) {
            const queue = entry.soundQueue;
            const src = queue?.getItem(sound.id)?.src;
            if (typeof src !== 'string' || new URL(src, location.href).href !== new URL(sound.fileurl, location.href).href) return;
            const buffer = queue?.getResult(sound.id) as AudioBuffer | undefined;
            return buffer && typeof buffer.getChannelData === 'function' && buffer.duration > 0 ? buffer : undefined;
          },
          onProgress(done, all) {
            if (done === 0) traceEditor('assets');
            current.status.textContent = all ? `읽어들이는 중: ${((done / all) * 100).toFixed(2)}%` : '읽어들이는 중';
          },
        });
        if (prepared !== current) { handle.dispose(); return; }
        current.handle = handle;
        handle.vm.onSceneChange = id => {
          if (!active || prepared !== current || attached !== entry || (window as any).Entry !== entry || entry.scene.selectedScene?.id === id) return;
          try {
            const scene = entry.scene.getSceneById?.(id);
            if (scene) entry.scene.selectScene?.(scene);
          } catch (error) {
            handle.vm.onSceneChange = null;
            console.warn('[entropy] 장면 선택을 연결하지 못했습니다', error);
          }
        };
        handle.vm.onError = error => {
          console.error('[entropy] 에디터 실행 오류', error);
          void entry.engine.toggleStop();
          (window as any).Entry.toast?.alert('실행 오류', error.message);
        };
      }
      current.cloud.setChangeListener(() => current.handle?.vm.readStore());
      current.source = source;
      current.status.hidden = true;
      traceEditor('ready');
    } while (prepared === current && current.source !== current.requested);
  }).catch(error => {
    current.requested = '';
    current.requestedWork = null;
    traceEditor('prepare-error');
    throw error;
  }).finally(() => {
    current.busy = false;
    if (dirty && prepared === current && !active) schedule();
  });
  return current.promise;
}

// Browsing uses Entry's existing board/scroller; no code edits are applied to a running snapshot.
function browse(entry: Editor): () => void {
  const workspace = entry.getMainWS();
  const playground = entry.playground;
  if (!workspace?.board || !playground?.view_ || typeof playground.getViewMode !== 'function') return () => {};
  const boards = [...new Set([workspace.board, workspace.overlayBoard, workspace.blockMenu].filter(Boolean))];
  const saved = boards.map(board => [board, board.readOnly] as const);
  for (const board of boards) board.readOnly = true;
  const sync = () => playground.view_.classList.toggle('entropy-editor-browsing', playground.getViewMode() === 'code');
  sync();
  const timer = setInterval(sync, 250);
  return () => {
    clearInterval(timer);
    playground.view_.classList.remove('entropy-editor-browsing');
    for (const [board, readOnly] of saved) board.readOnly = readOnly;
  };
}

function attach(entry: Editor): void {
  cachedExport = null; // Edits made while the VM was disabled did not advance editRevision.
  const engine = entry.engine;
  const originals = new Map<string, { original: (...args: any[]) => any; replacement: (...args: any[]) => any }>();
  const patch = (name: string, replacement: (...args: any[]) => any) => {
    originals.set(name, { original: engine[name], replacement });
    if (!Reflect.set(engine, name, replacement) || engine[name] !== replacement) throw new Error(`Entry.${name} 연결을 지원하지 않습니다`);
  };
  const originalRun = engine.toggleRun, originalStop = engine.toggleStop, originalPause = engine.togglePause;
  const restartTicker = () => {
    if (!engine.ticker || !(entry.tickTime > 0) || typeof engine.update !== 'function') return;
    const previous = engine.ticker;
    const next = setInterval(engine.update, entry.tickTime);
    if (!Reflect.set(engine, 'ticker', next)) { clearInterval(next); throw new Error('Entry ticker 연결을 지원하지 않습니다'); }
    clearInterval(previous);
  };
  let changed: { destroy(): void } | undefined;
  let tickerChanged = false;
  const unpatch = () => {
    try { changed?.destroy(); }
    finally {
      changed = undefined;
      for (const [name, { original, replacement }] of originals) {
        if (engine[name] === replacement) Reflect.set(engine, name, original);
      }
      if (cachedExport?.entry === entry) cachedExport = null;
      if (tickerChanged) { tickerChanged = false; restartTicker(); }
    }
  };
  const disable = (error: unknown) => {
    incompatible.add(entry);
    try { unpatch(); }
    finally {
      if (attached === entry) { restore = null; attached = null; attachedEngine = null; }
      traceEditor('incompatible');
      console.warn('[entropy] 에디터 연결을 해제했습니다. 원본 실행기를 사용합니다.', error);
    }
  };
  try {
    for (const name of ['update', 'computeFunction', 'raiseEvent', 'raiseKeyEvent', 'raiseEventOnEntity']) {
      const original = engine[name];
      patch(name, function(this: unknown, ...args: any[]) { if (!active) return original.apply(this, args); });
    }
    patch('toggleRun', function(...args: any[]) {
      if (stopping) return;
      if (active) { if (engine.state === 'pause') engine.togglePause(); return; }
      if (!settings.enabled || engine.state !== 'stop') return originalRun.apply(engine, args);
      traceEditor('run-requested');
      let currentSnapshot: EditorSnapshot;
      let canvas: HTMLCanvasElement;
      try {
        prepared?.handle?.audio.unlock();
        const element = document.getElementById('entryCanvas');
        if (!(element instanceof HTMLCanvasElement)) throw new Error('엔트리 실행 화면을 찾지 못했습니다');
        canvas = element;
        const exported = snapshot(entry);
        if (!exported) throw new Error('엔트리 작품을 읽지 못했습니다');
        currentSnapshot = exported;
      } catch (error) {
        disable(error); discard();
        return originalRun.apply(engine, args);
      }
      const visibility = canvas.style.visibility;
      const current: RunningEditor = {
        cleanup() { canvas.style.visibility = visibility; unbrowse(); },
      };
      let unbrowse = () => {};
      active = current;
      try { originalRun.apply(engine, args); } catch (error) { finish()(); throw error; }
      try { current.live = beginLiveEditing(entry, currentSnapshot.work, () => prepared?.handle?.vm, traceEditor); }
      catch (error) { console.warn('[entropy] 실행 중 편집을 준비하지 못해 탐색만 허용합니다', error); }
      if (current.live) unbrowse = () => current.live?.restore();
      else {
        try { unbrowse = browse(entry); }
        catch (error) { console.warn('[entropy] 블록 탐색을 연결하지 못했습니다', error); }
      }
      const scene = entry.scene.selectedScene?.id;
      const ready = prepare(entry, currentSnapshot);
      void prepared?.audioContext?.resume().catch(() => undefined);
      if (prepared) {
        prepared.root.hidden = false; prepared.root.tabIndex = 0; prepared.root.removeAttribute('aria-hidden');
        canvas.style.visibility = 'hidden';
      }
      void ready.then(() => {
        if (active !== current || !prepared?.handle) return;
        const handle = prepared.handle;
        handle.vm.setStartScene(scene);
        const unknown = [...handle.vm.unknownBlocks.keys()].filter(type => !type.startsWith('variable:'));
        if (unknown.length) (window as any).Entry.toast?.alert('실행기 안내',
          `이 실행기가 아직 모르는 블록이 ${unknown.length}종 있습니다: ${unknown.slice(0, 6).join(', ')}`);
        handle.relayout(); handle.start();
        try { current.actors = beginActorEditing(entry, handle); }
        catch (error) { console.warn('[entropy] 오브젝트 속성 편집을 연결하지 못했습니다', error); }
        traceEditor('running');
        if (engine.state === 'pause') handle.pause();
      }).catch(error => {
        if (active === current) {
          const failed = prepared;
          const message = error instanceof Error ? error.message : String(error);
          traceEditor('run-error');
          console.warn('[entropy] 실행기를 준비하지 못했습니다', error);
          void engine.toggleStop().finally(() => { disable(error); if (prepared === failed) discard(); })
            .catch((error: unknown) => console.warn('[entropy] 에디터 정지를 마치지 못했습니다', error));
          (entry as any).toast?.alert('실행기를 준비하지 못했습니다', `${message}\n다시 시작하면 원본 실행기를 사용합니다.`);
        }
      });
    });
    patch('toggleStop', function(...args: any[]) {
      if (stopping) return stopping.promise;
      // Native stop can await editor work. Keep saving on the original snapshot
      // and prevent reentry until its temporary code and wrappers are restored.
      const pending = { entry, live: active?.live, promise: Promise.resolve() as Promise<unknown> };
      stopping = pending;
      pending.promise = (async () => {
        let cleanup = () => {};
        try { cleanup = finish(); return await originalStop.apply(engine, args); }
        finally {
          try { cleanup(); schedule(); }
          finally { if (stopping === pending) stopping = null; }
        }
      })();
      return pending.promise;
    });
    patch('togglePause', function(...args: any[]) {
      const result = originalPause.apply(engine, args);
      if (active && prepared?.handle) {
        if (engine.state === 'pause') prepared.handle.pause();
        else prepared.handle.start();
      }
      return result;
    });
    changed = entry.creationChangedEvent?.attach(null, () => {
      editRevision += 1;
      schedule();
    });
    restartTicker(); tickerChanged = true;
    restore = unpatch;
    attached = entry; attachedEngine = engine;
    traceEditor('attached');
    if (engine.state === 'run' || engine.state === 'pause') void engine.toggleStop();
    schedule();
  } catch (error) { disable(error); }
}

function reconcile(): void {
  const entry = (window as Window & { Entry?: Editor }).Entry;
  observeExport(entry); // Save compaction also works with the VM toggle disabled.
  const sound = entry?.type === 'workspace' && settings.enabled ? entry.playground?.soundEditor : null;
  if (soundEditor !== sound) {
    restoreSound?.(); restoreSound = null; soundEditor = null;
    if (sound) {
      restoreSound = improveSoundLoading(entry?.playground, (window as any).EntrySoundEditor);
      if (restoreSound) soundEditor = sound;
    }
  }
  if (attached && (!settings.enabled || attached !== entry || attachedEngine !== entry?.engine || entry?.type !== 'workspace')) {
    if (stopping) return;
    if (active) {
      void attachedEngine?.toggleStop().finally(reconcile);
      return;
    }
    restore?.(); discard(); restore = null; attached = null; attachedEngine = null;
  }
  if (!attached && settings.enabled && entry?.type === 'workspace' && !incompatible.has(entry) && entry.engine?.runButton &&
    typeof entry.getMainWS === 'function' && entry.scene &&
    exportingEntry === entry && entry.exportProject === wrappedExport && typeof entry.creationChangedEvent?.attach === 'function' &&
    entry.isLoadProject !== false && typeof entry.exportProject === 'function' &&
    ['toggleRun', 'toggleStop', 'togglePause', 'update', 'computeFunction', 'raiseEvent', 'raiseKeyEvent', 'raiseEventOnEntity']
      .every(name => typeof entry.engine[name] === 'function')) attach(entry);
}
window.addEventListener('message', event => {
  if (event.source !== window || event.data?.__entropy !== 'editor-settings') return;
  settings = { enabled: event.data.enabled === true, svg: event.data.svg !== false,
    cache: event.data.cache === true, escape: event.data.escape !== false };
  reconcile();
  if (attached && !active && prepared && (prepared.svg !== settings.svg || prepared.escape !== settings.escape)) schedule();
});
// Entry initializes asynchronously and may be replaced during navigation.
window.setInterval(reconcile, 250);
