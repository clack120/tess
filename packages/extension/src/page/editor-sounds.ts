import { fetchAsset } from '../../../vm/src/web/fetch-retry.ts';
import { loadYield } from '../../../vm/src/web/load-yield.ts';

// Keep Entry's selection, save confirmation and waveform editor. Only replace
// the selected file's blocking download with a cancellable, panel-local load.
export function improveSoundLoading(playground: any, api: any): (() => void) | null {
  const editor = playground?.soundEditor;
  const view = playground?.soundView_ as HTMLElement | undefined;
  if (!view || typeof editor?.updateSound !== 'function' || typeof editor.getEntryAudioBuffer !== 'function' ||
    typeof api?.loadSound !== 'function' || typeof api.clearSound !== 'function') return null;
  const original = editor.updateSound;
  const originalHide = editor.hide;
  const status = document.createElement('div');
  status.className = 'entropy-editor-sound-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  const position = view.style.position;
  let context: AudioContext | null = null;
  let pending: AbortController | null = null;
  let disposed = false;
  let listVersion = 0;
  const listStatus = status.cloneNode() as HTMLElement;
  const originalInject = playground.injectSound;
  const inject = function(this: any, ...args: any[]) {
    const object = this.object;
    const sounds = object?.sounds;
    const version = ++listVersion;
    listStatus.hidden = true;
    if (!Array.isArray(sounds) || sounds.length < 200) return originalInject.apply(this, args);
    listStatus.textContent = '소리 목록을 준비하는 중…'; listStatus.hidden = false;
    const current = () => !disposed && version === listVersion && playground.object === object && object.sounds === sounds;
    void (async () => {
      const yieldToPage = loadYield();
      for (const sound of sounds) {
        if (!current()) return;
        if (!sound.view?.soundLengthView) playground.generateSoundElement(sound);
        const pause = yieldToPage();
        if (pause) await pause;
      }
      if (current()) originalInject.apply(this, args);
    })().catch(error => {
      if (current()) console.warn('[entropy] 소리 목록을 준비하지 못했습니다', error);
    }).finally(() => { if (version === listVersion) listStatus.hidden = true; });
  };
  const chunkedList = typeof originalInject === 'function' && typeof playground.generateSoundElement === 'function';
  const cancel = () => {
    const request = pending;
    pending = null;
    if (request) { editor.sound = null; request.abort(); }
    status.hidden = true;
  };
  const update = async function(this: any, sound: any, object: any): Promise<void> {
    cancel();
    if (disposed || !sound?.path || playground.object?.id !== object?.id) return;
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(new Error('소리를 읽는 시간이 초과되었습니다.')), 20_000);
    this.sound = sound;
    this.object = object;
    status.textContent = '소리를 읽는 중…';
    status.hidden = false;
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      api.clearSound();
      const buffer = await Promise.race([aborted, (async () => {
        const cached = this.getEntryAudioBuffer(sound.id);
        if (cached) return cached;
        context ??= new AudioContext();
        const response = await fetchAsset(sound.path, controller.signal);
        const bytes = await response.arrayBuffer();
        controller.signal.throwIfAborted();
        return context.decodeAudioData(bytes);
      })()]);
      if (pending !== controller || controller.signal.aborted || playground.object?.id !== object.id) return;
      await Promise.race([aborted, Promise.resolve(api.loadSound(buffer))]);
      if (pending === controller) status.hidden = true;
    } catch (error) {
      if (pending !== controller || disposed || playground.object?.id !== object.id) return;
      this.sound = null; // Entry permits selecting the same sound again after a failure.
      status.textContent = '소리를 읽지 못했습니다. ';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '다시 시도';
      retry.onclick = () => { void update.call(this, sound, object); };
      status.append(retry);
      console.warn('[entropy] 편집할 소리를 읽지 못했습니다', sound.name, error);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', rejectAbort);
      if (pending === controller) {
        pending = null;
        if (playground.object?.id !== object.id) { this.sound = null; status.hidden = true; }
      }
    }
  };
  const hide = function(this: any, ...args: any[]) {
    listVersion++; listStatus.hidden = true;
    cancel();
    return originalHide?.apply(this, args);
  };
  const restore = () => {
    if (disposed) return;
    disposed = true;
    cancel();
    if (editor.updateSound === update) editor.updateSound = original;
    if (editor.hide === hide) editor.hide = originalHide;
    if (playground.injectSound === inject) playground.injectSound = originalInject;
    status.remove();
    listStatus.remove();
    view.style.position = position;
    void context?.close().catch(() => undefined);
  };
  try {
    // Do not leave a partial sound override behind if Entry changes a method
    // to a read-only property. This optional integration must not block run.
    for (const [owner, name, replacement] of [
      [editor, 'updateSound', update], [editor, 'hide', hide],
      ...(chunkedList ? [[playground, 'injectSound', inject]] : []),
    ] as const) {
      if (!Reflect.set(owner, name, replacement) || owner[name] !== replacement) {
        throw new Error(`Entry.${name} 연결을 지원하지 않습니다`);
      }
    }
    if (getComputedStyle(view).position === 'static') view.style.position = 'relative';
    view.append(status, listStatus);
  } catch { restore(); return null; }
  return restore;
}
