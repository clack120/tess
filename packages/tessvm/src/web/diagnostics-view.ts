import { formatVmError } from '../runtime/diagnostics.ts';
import type { RuntimeDiagnostics } from './diagnostics.ts';

const STYLE = `
.tessvm-diagnostics { box-sizing: border-box; width: min(760px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); padding: 0; border: 1px solid #c8cdd5; border-radius: 8px; background: #fff; color: #20242b; color-scheme: light; font: 14px/1.5 system-ui, sans-serif; text-align: left; }
.tessvm-diagnostics:not([open]) { display: none; }
.tessvm-diagnostics::backdrop { background: #11182766; }
.tessvm-diagnostics header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; padding: 12px 16px; border-bottom: 1px solid #dce0e6; background: #fff; color: #20242b; }
.tessvm-diagnostics h2 { flex: 1; margin: 0; font: 600 17px/1.4 system-ui, sans-serif; }
.tessvm-diagnostics button { padding: 6px 10px; border: 1px solid #c8cdd5; border-radius: 4px; background: #fff; color: #20242b; font: inherit; cursor: pointer; }
.tessvm-diagnostics button:hover { background: #f0f3f7; }
.tessvm-diagnostics button:focus-visible { outline: 2px solid #2359b4; outline-offset: 2px; }
.tessvm-diagnostics .diagnostic-body { padding: 12px 16px 16px; }
.tessvm-diagnostics p { margin: 0 0 10px; }
.tessvm-diagnostics pre { margin: 8px 0 16px; padding: 10px; overflow: auto; max-height: 220px; border: 1px solid #dce0e6; background: #f7f8fa; color: inherit; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.tessvm-diagnostics h3 { margin: 16px 0 6px; font: 600 14px/1.4 system-ui, sans-serif; }
.tessvm-diagnostics .diagnostic-note { color: #555e6b; font-size: 12px; }
.tessvm-diagnostics summary { cursor: pointer; }
`;

export function mountDiagnostics(parent: HTMLElement, diagnostics: RuntimeDiagnostics, restoreFocus: () => void) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  parent.appendChild(style);
  const dialog = document.createElement('dialog');
  dialog.className = 'tessvm-diagnostics';
  dialog.setAttribute('aria-label', '현재 실행 상태');
  parent.appendChild(dialog);
  const header = document.createElement('header');
  dialog.appendChild(header);
  const title = document.createElement('h2');
  title.textContent = '현재 실행 상태';
  header.appendChild(title);
  const button = (label: string, run: () => void) => {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.onclick = run;
    header.appendChild(node);
    return node;
  };
  const body = document.createElement('div');
  body.className = 'diagnostic-body';
  dialog.appendChild(body);
  const text = (tag: 'p' | 'h3' | 'pre', value: string, className = '') => {
    const node = document.createElement(tag);
    node.textContent = value; node.className = className; body.appendChild(node);
    return node;
  };
  const status = text('p', '');
  const counts = text('p', '');
  const activity = text('p', '');
  const heap = text('p', '');
  const input = text('p', '');
  const note = text('p', '매초 갱신합니다. 진단 파일에는 최근 처리량, 변수·리스트 미리보기와 최근 오류 직전 상태가 들어갑니다.', 'diagnostic-note');
  const focusDetails = document.createElement('details');
  const focusSummary = document.createElement('summary'); focusSummary.textContent = '최근 포커스 이동';
  const focusLog = document.createElement('pre');
  focusDetails.append(focusSummary, focusLog); body.appendChild(focusDetails);
  text('h3', '실행 스레드');
  const threads = text('pre', '');
  text('h3', '최근 오류');
  const error = text('pre', '');
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'JavaScript 스택';
  const stack = document.createElement('pre');
  details.append(summary, stack); body.appendChild(details);
  let timer = 0;
  let focusAtOpen = '';
  const mib = (bytes: number) => (bytes / 1048576).toFixed(1);

  const refresh = () => {
    const report = diagnostics.snapshot();
    const current = report.current;
    const state = { run: '실행 중', pause: '일시정지', stop: '정지' }[current.state];
    status.textContent = `${state} · 장면 ${current.scene.name} · ${current.frame}틱 · 실행 시간 ${(current.clock / 1000).toFixed(2)}초 · 설정 ${current.frameRate}Hz`;
    counts.textContent = `오브젝트 ${current.counts.objects} · 복제본 ${current.counts.clones} · 스레드 ${current.counts.threads} · 기본 리스트 항목 ${current.counts.listItems}`;
    const recent = report.activity.slice(-10);
    const elapsed = recent.reduce((sum, item) => sum + item.elapsedMs, 0) / 1000;
    const calls = recent.reduce((sum, item) => sum + item.callbacks, 0);
    const total = (key: 'ticks' | 'kernelRuns' | 'kernelFallbacks' | 'workMs') => recent.reduce((sum, item) => sum + item[key], 0);
    activity.textContent = elapsed > 0 && calls > 0
      ? `최근 ${elapsed.toFixed(1)}초: ${(total('ticks') / elapsed).toFixed(1)}틱/초 · 커널 ${(total('kernelRuns') / elapsed).toFixed(1)}회/초 · 커널 되돌림 ${total('kernelFallbacks')}회\nVM·화면 처리 평균 ${(total('workMs') / calls).toFixed(2)}ms · 최대 ${Math.max(...recent.map((item) => item.maxWorkMs)).toFixed(2)}ms`
      : '최근 처리량 측정 중…';
    activity.style.whiteSpace = 'pre-line';
    heap.textContent = report.heap
      ? `페이지 전체 JS 힙(브라우저 추정): 사용 ${mib(report.heap.used)}MiB / 확보 ${mib(report.heap.allocated)}MiB · 한도 ${mib(report.heap.limit)}MiB · GPU 메모리 제외`
      : 'JS 힙: 이 브라우저가 수치를 제공하지 않습니다.';
    const point = current.input;
    input.textContent = `열기 전 포커스 ${focusAtOpen} · 창 ${report.page.focused ? '활성' : '비활성'} · 누른 키 ${point.keys.join(', ') || '없음'} · 마우스 (${point.mouseX.toFixed(1)}, ${point.mouseY.toFixed(1)}) ${point.mouseDown ? '누름' : '놓음'}`;
    focusLog.textContent = report.focusEvents.map((item) => `${(item.at / 1000).toFixed(2)}초 · ${item.type} · ${item.element ?? '없음'} · 창 ${item.focused ? '활성' : '비활성'}`).join('\n') || '기록된 포커스 이동이 없습니다.';
    const names = new Map(current.entities.map((entity) => [entity.targetId, entity.name]));
    threads.textContent = current.threads.length ? current.threads.map((thread) =>
      `${names.get(thread.targetId) ?? thread.targetId} · ${thread.event}${thread.eventFilter ? ` (${thread.eventFilter})` : ''} · 블록 ${thread.eventBlockId} · 함수 깊이 ${thread.depth}${thread.done ? ' · 종료' : ''}`,
    ).join('\n') : '실행 중인 스레드가 없습니다.';
    error.textContent = report.failure ? formatVmError(report.failure.error) : '기록된 오류가 없습니다.';
    details.hidden = !report.failure?.error.stack;
    stack.textContent = report.failure?.error.stack ?? '';
  };
  const download = () => {
    const report = diagnostics.snapshot();
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `tessvm-diagnostics-${report.capturedAt.replace(/[:.]/g, '-')}.json`;
    dialog.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (dialog.open) note.textContent = '진단 파일 저장을 요청했습니다. 미리보기에서 생략한 길이와 개수는 파일에 표시됩니다.';
  };
  button('진단 저장', download);
  const close = button('닫기', () => dialog.close());
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  dialog.addEventListener('pointerdown', (event) => event.stopPropagation());
  dialog.addEventListener('contextmenu', (event) => event.stopPropagation());
  dialog.addEventListener('close', () => { clearInterval(timer); timer = 0; restoreFocus(); });
  return {
    open() {
      if (dialog.open) return;
      const active = document.activeElement;
      focusAtOpen = active ? `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''}` : '없음';
      refresh(); dialog.showModal(); close.focus();
      timer = window.setInterval(refresh, 1000);
    },
    download,
    dispose() {
      clearInterval(timer);
      if (dialog.open) dialog.close();
      dialog.remove(); style.remove();
    },
  };
}
