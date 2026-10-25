import { createLocalArchive } from './local-archive.ts';
import type { EntryWork } from './entry-project.ts';
import { LOCAL_DOWNLOAD_STYLE } from './local-download-style.ts';

// Entry puts its action ID on dropdown rows. Scope interception to the native
// header so it is independent of translation and cannot match project text.
export function isLocalDownload(target: Element): boolean {
  return target.closest('#common_srch [value="exportProjectData"]') !== null;
}

export function installLocalDownload(readProject: (signal: AbortSignal, progress: (done: number, total: number) => void) => EntryWork | false | Promise<EntryWork | false>, enabled: () => boolean): () => void {
  let running: AbortController | null = null;
  let panel: HTMLDivElement | null = null;
  let backdrop: HTMLDivElement | null = null;
  let previousFocus: HTMLElement | null = null;
  const close = () => {
    backdrop?.remove(); backdrop = null; panel = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const start = async () => {
    if (running) { panel?.focus(); return; }
    close();
    const controller = new AbortController(); running = controller;
    previousFocus = document.activeElement as HTMLElement | null;
    backdrop = document.createElement('div'); backdrop.className = 'entropy-local-download-backdrop';
    const style = document.createElement('style'); style.textContent = LOCAL_DOWNLOAD_STYLE;
    panel = document.createElement('div'); panel.className = 'entropy-local-download';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'entropy-local-download-title'); panel.tabIndex = -1;
    const title = document.createElement('h2'); title.className = 'entropy-local-title';
    title.id = 'entropy-local-download-title'; title.textContent = '내 컴퓨터에 저장';
    const caption = document.createElement('p'); caption.className = 'entropy-local-caption';
    caption.textContent = '작품 코드와 이미지·소리를 하나의 .ent 파일로 저장합니다.';
    const status = document.createElement('p'); status.className = 'entropy-local-status'; status.setAttribute('role', 'status');
    status.textContent = '작품 정보를 준비하는 중입니다.';
    const progress = document.createElement('progress'); progress.setAttribute('aria-label', '저장 진행률');
    const detail = document.createElement('p'); detail.className = 'entropy-local-error'; detail.hidden = true;
    const hint = document.createElement('p'); hint.className = 'entropy-local-hint'; hint.hidden = true;
    const actions = document.createElement('div'); actions.className = 'entropy-local-actions';
    const cancel = document.createElement('button'); cancel.className = 'entropy-local-button'; cancel.type = 'button'; cancel.textContent = '저장 취소';
    cancel.onclick = () => { if (running === controller) controller.abort(); else close(); };
    actions.append(cancel); panel.append(title, caption, status, progress, detail, hint, actions);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.click(); }
      if (event.key === 'Tab') {
        const buttons = [...actions.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const target = event.shiftKey ? buttons.at(-1) : buttons[0];
        if (document.activeElement === panel || document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1))) {
          event.preventDefault(); target?.focus();
        }
      }
    });
    backdrop.append(style, panel); (document.body ?? document.documentElement).append(backdrop); panel.focus();
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      controller.signal.throwIfAborted();
      let preparedAt = 0;
      const exported = await readProject(controller.signal, (done, total) => {
        const now = performance.now(); if (done !== total && now - preparedAt < 100) return; preparedAt = now;
        status.textContent = `작품 정보 준비 중 · ${done.toLocaleString()} / ${total.toLocaleString()}`;
        progress.max = Math.max(1, total); progress.value = done;
      });
      controller.signal.throwIfAborted();
      if (!exported) throw new Error('저장할 작품을 읽지 못했습니다.');
      const name = document.querySelector<HTMLInputElement>('#common_srch input[maxlength="30"]')?.value || exported.name || '작품';
      const parent = (window as any).Entry?.projectId;
      const project = { ...exported, name,
        ...(typeof parent === 'string' ? { parent: exported.parent ?? parent } : {}),
        isPracticalCourse: new URLSearchParams(location.search).get('type') === 'practical_course' };
      status.textContent = '작품 파일을 만드는 중입니다.'; progress.removeAttribute('value');
      let reported = 0;
      const blob = await createLocalArchive(project, controller.signal, (done, total) => {
        const now = performance.now();
        if (done !== total && now - reported < 100) return;
        reported = now;
        progress.max = Math.max(1, total); progress.value = done;
        status.textContent = done === total ? '파일을 마무리하는 중입니다.' : `미디어 파일 준비 중 · ${done.toLocaleString()} / ${total.toLocaleString()}`;
      });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.download = (String(project.name || '작품').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.ent$/i, '') || '작품') + '.ent';
      link.href = url; link.hidden = true;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      close();
    } catch (error) {
      if (controller.signal.aborted) close();
      else {
        status.textContent = '저장을 완료하지 못했습니다.'; status.setAttribute('role', 'alert');
        progress.hidden = true;
        detail.textContent = error instanceof Error ? error.message : String(error); detail.hidden = false;
        hint.textContent = '아래 버튼으로 다시 시도하거나 창을 닫을 수 있습니다.'; hint.hidden = false;
        cancel.textContent = '닫기';
        const retry = document.createElement('button'); retry.className = 'entropy-local-button entropy-local-primary';
        retry.type = 'button'; retry.textContent = '다시 시도';
        retry.onclick = () => { close(); void start(); }; actions.append(retry); retry.focus();
      }
    } finally { if (running === controller) running = null; }
  };
  const click = (event: MouseEvent) => {
    if (!enabled() || !(event.target instanceof Element) || !isLocalDownload(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const save = [...document.querySelectorAll('#common_srch button')].find(button =>
      [...button.querySelectorAll('span')].some(span => span.textContent?.trim() === 'save')) as HTMLButtonElement | undefined;
    save?.click(); // Close the native dropdown without selecting its server action.
    void start();
  };
  const abort = () => { running?.abort(); close(); };
  document.addEventListener('click', click, true);
  window.addEventListener('pagehide', abort);
  return () => { abort(); document.removeEventListener('click', click, true); window.removeEventListener('pagehide', abort); };
}
