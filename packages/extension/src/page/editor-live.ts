import type { EntryWork } from './entry-project.ts';
import type { Vm } from '../../../vm/src/runtime/engine.ts';
import { loadYield } from '../../../vm/src/web/load-yield.ts';

export interface LiveEditing {
  work: EntryWork;
  applied: boolean;
  restore(): void;
}

// Edit copies of the native code models. Their original blocks and undo history
// remain intact, and autosave continues to receive the pre-run project.
export function beginLiveEditing(entry: any, work: EntryWork, runtime: () => Vm | undefined,
  trace: (phase: string) => void = () => {}): LiveEditing | null {
  const workspace = entry.getMainWS();
  const playground = entry.playground;
  if (entry.readOnly || !workspace?.board || !playground?.view_ || typeof entry.Code !== 'function' ||
    typeof playground.injectCode !== 'function' || typeof workspace.changeBoardCode !== 'function') return null;
  const saved = new Map<any, { field: string; original: any; copy: any; options?: Record<string, unknown> }>();
  const functions = entry.variableContainer?.functions_;
  const originalFunctions = functions ? { ...functions } : null;
  const functionEditor = entry.Func;
  const editingBefore = functionEditor?.isEdit;
  const history = entry.stateManager;
  const undo = history?.undoStack_?.slice(), redo = history?.redoStack_?.slice();
  const boards = [...new Set([workspace.board, workspace.overlayBoard, workspace.blockMenu].filter(Boolean))] as any[];
  const readOnly = boards.map(board => [board, board.readOnly] as const);
  // Native addRef/removeRef repaint the entire variable list for every block.
  // Keep reference registration intact, but paint once after synchronous bulk work.
  const batchReferences = <T>(action: () => T, refresh = (update: () => void) => update()): T => {
    const container = entry.variableContainer;
    const update = container?.updateList;
    if (typeof update !== 'function') return action();
    let requested = false;
    const defer = () => { requested = true; };
    if (!Reflect.set(container, 'updateList', defer) || container.updateList !== defer) return action();
    try { return action(); }
    finally {
      if (container.updateList === defer) container.updateList = update;
      if (requested) refresh(() => update.call(container));
    }
  };
  const copy = (owner: any, field: string) => batchReferences(() => {
    if (saved.has(owner)) return saved.get(owner)!.copy;
    const original = owner?.[field];
    if (typeof original?.toJSON !== 'function') return original;
    // Entry refuses Code.load while running. Construction is synchronous; keep
    // the native interpreter paused only for this call, then restore its state.
    const state = entry.engine.state;
    let cloned;
    try {
      entry.engine.state = 'pause';
      cloned = new entry.Code(original.toJSON(), original.object);
    } finally { entry.engine.state = state; }
    const options = field === 'content' ? { type: owner.type, useLocalVariables: owner.useLocalVariables,
      localVariables: owner.localVariables?.map((variable: any) => ({ ...variable })) } : undefined;
    saved.set(owner, { field, original, copy: cloned, options });
    owner[field] = cloned;
    return cloned;
  });
  const injectCode = playground.injectCode;
  const inject = function(this: any, ...args: any[]) {
    if (this.object) copy(this.object, 'script');
    return injectCode.apply(this, args);
  };
  const overlayCode = workspace.changeOverlayBoardCode;
  const initEdit = functionEditor?.initEditView;
  const edit = function(this: any, code: any, ...args: any[]) {
    const fn = Object.values(functions ?? {}).find((candidate: any) => candidate.content === code) as any;
    return initEdit.call(this, fn ? copy(fn, 'content') : code, ...args);
  };
  const panel = document.createElement('div');
  panel.className = 'entropy-editor-live';
  const label = document.createElement('span');
  label.textContent = '임시 편집 · 정지하면 원래 블록으로 돌아갑니다.';
  const apply = document.createElement('button');
  apply.className = 'entropy-editor-apply';
  apply.type = 'button'; apply.textContent = '실행에 적용';
  apply.title = '수정한 블록을 실행 중인 작품에 적용합니다.';
  panel.append(label, apply);
  const host = [playground.boardView_, playground.codeView_, workspace.board.wrapper, playground.view_]
    .find(node => node?.namespaceURI === 'http://www.w3.org/1999/xhtml') ?? playground.view_;
  const session: LiveEditing = { work, applied: false, restore };
  const signature = (code: any, type: unknown) => {
    const header = code.toJSON().find((stack: any[]) => /^function_create(?:_value)?$/.test(stack[0]?.type))?.[0];
    return JSON.stringify([type, header?.params?.[0]], (_key, item) => item && typeof item.type === 'string'
      ? { id: item.id, type: item.type, params: item.params ?? [] } : item);
  };
  const changedSignature = (fn: any) => {
    const before = saved.get(fn);
    return before?.field === 'content' && signature(before.original, before.options?.type) !== signature(fn.content, fn.type);
  };
  const guards: Array<() => void> = [];
  const replace = (owner: any, name: string, replacement: any) => {
    const original = owner[name];
    guards.push(() => { if (owner[name] === replacement) Reflect.set(owner, name, original); });
    if (!Reflect.set(owner, name, replacement) || owner[name] !== replacement) {
      throw new Error(`Entry.${name} 연결을 지원하지 않습니다`);
    }
  };
  const guard = (owner: any, name: string, blocked: (...args: any[]) => boolean) => {
    const original = owner?.[name];
    if (typeof original !== 'function') return;
    const wrapped = function(this: any, ...args: any[]) {
      if ((entry.engine.state === 'run' || entry.engine.state === 'pause') && blocked(...args)) {
        label.textContent = '함수 추가·삭제·이름·매개변수 변경은 정지 후 편집해주세요.';
        return;
      }
      return original.apply(this, args);
    };
    replace(owner, name, wrapped);
  };
  let updating: AbortController | null = null;
  const togglePause = entry.engine.togglePause;
  const pause = function(this: any, ...args: any[]) {
    if (!updating) return togglePause.apply(this, args);
  };
  apply.onclick = async () => {
    if (updating) return;
    const vm = runtime();
    if (!vm || vm.state === 'stop') { label.textContent = '실행기를 준비하는 중입니다. 준비 후 적용해주세요.'; return; }
    const controller = new AbortController();
    updating = controller;
    const resume = entry.engine.state === 'run';
    apply.disabled = true;
    label.textContent = '갱신 중입니다…';
    trace('updating');
    const editable = boards.map(board => [board, board.readOnly] as const);
    try {
      if (resume) { vm.pause(false); togglePause.call(entry.engine); }
      for (const [board] of editable) board.readOnly = true;
      // Paint the paused state before serializing or compiling a large work.
      await new Promise<void>(resolve => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
        else setTimeout(resolve, 0);
      });
      controller.signal.throwIfAborted();
      const yieldToPage = loadYield();
      if (Object.keys(functions ?? {}).some(id => !originalFunctions?.[id]) ||
        Object.keys(originalFunctions ?? {}).some(id => !functions[id])) {
        throw new Error('함수 추가·삭제는 정지 후 편집해주세요.');
      }
      if (Object.values(functions ?? {}).some(changedSignature)) throw new Error('함수 이름·매개변수 변경은 정지 후 편집해주세요.');
      const objects = [];
      for (const [object, value] of saved) {
        if (value.field !== 'script') continue;
        objects.push({ id: object.id, script: object.script.stringify() });
        await yieldToPage(); controller.signal.throwIfAborted();
      }
      const patchedFunctions = [];
      for (const raw of work.functions) {
        const native = functions?.[String(raw.id)];
        patchedFunctions.push(native && saved.has(native) ? { ...raw, content: native.content.stringify() } : raw);
        const pause = yieldToPage(); if (pause) await pause;
        controller.signal.throwIfAborted();
      }
      trace('compiling');
      await vm.patchCodeAsync({ objects, functions: patchedFunctions }, controller.signal);
      session.applied = true;
      label.textContent = '적용됨 · 정지하면 변경을 버립니다.';
      trace('updated');
    } catch (error) {
      trace(controller.signal.aborted ? 'update-cancelled' : 'update-error');
      if (!controller.signal.aborted) label.textContent = `적용하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      updating = null;
      if (!restored) {
        for (const [board, previous] of editable) board.readOnly = previous;
        apply.disabled = false;
        if (resume && entry.engine.state === 'pause' && vm.state === 'pause') togglePause.call(entry.engine);
      }
    }
  };
  const viewMode = playground.changeViewMode;
  const curtain = playground.curtainView_ ?? document.getElementById('entryCurtain');
  const curtainDisplay = curtain?.style.getPropertyValue('display') ?? '';
  const curtainPriority = curtain?.style.getPropertyPriority('display') ?? '';
  const restoreCurtain = () => {
    if (!curtain) return;
    if (curtainDisplay) curtain.style.setProperty('display', curtainDisplay, curtainPriority);
    else curtain.style.removeProperty('display');
  };
  const sync = () => {
    const code = playground.getViewMode?.() === 'code';
    playground.view_.classList.toggle('entropy-editor-editing', code);
    panel.hidden = !code;
    if (code) curtain?.style.setProperty('display', 'none', 'important');
    else restoreCurtain();
  };
  const changeView = function(this: any, ...args: any[]) { const result = viewMode.apply(this, args); sync(); return result; };
  const variableView = playground.toggleOnVariableView;
  const showVariables = function(this: any, ...args: any[]) { const result = variableView.apply(this, args); sync(); return result; };
  let restored = false;
  try {
    // Install as one transaction: any changed native API must leave no live
    // wrappers, permissions or controls behind when browsing takes over.
    for (const board of boards) {
      if (!Reflect.set(board, 'readOnly', false) || board.readOnly !== false) throw new Error('Entry board 연결을 지원하지 않습니다');
    }
    replace(playground, 'injectCode', inject);
    if (typeof initEdit === 'function') replace(functionEditor, 'initEditView', edit);
    host.append(panel);
    // Native function deletion/signature changes rewrite call blocks throughout
    // the project, including unopened originals. Keep those operations out of a run.
    for (const name of ['createFunction', 'removeFunction', 'appendFunctions']) guard(entry.variableContainer, name, () => true);
    guard(functionEditor, 'changeType', () => true);
    guard(functionEditor, 'generateWsBlock', fn => changedSignature(fn?.content ? fn : functionEditor.targetFunc));
    if (typeof togglePause === 'function') replace(entry.engine, 'togglePause', pause);
    if (typeof viewMode === 'function') replace(playground, 'changeViewMode', changeView);
    if (typeof variableView === 'function') replace(playground, 'toggleOnVariableView', showVariables);
    if (editingBefore && functionEditor.targetFunc) {
      overlayCode.call(workspace, copy(functionEditor.targetFunc, 'content'));
    }
    inject.call(playground); sync();
  } catch (error) { restore(); throw error; }
  function restore(): void {
    if (restored) return;
    restored = true;
    updating?.abort();
    let failure: unknown;
    const restoreView = (action: () => void) => { try { action(); } catch (error) { failure ??= error; } };
    batchReferences(() => {
      for (const restoreGuard of guards) restoreView(restoreGuard);
      if (!editingBefore && functionEditor?.isEdit) restoreView(() => functionEditor.endEdit('cancelEdit'));
      if (originalFunctions) {
        for (const id of Object.keys(functions)) delete functions[id];
        Object.assign(functions, originalFunctions);
      }
      for (const [owner, value] of saved) {
        owner[value.field] = value.original;
        if (value.options) {
          Object.assign(owner, value.options);
          restoreView(() => functionEditor?._generateFunctionSchema?.(owner.id, owner.type));
          restoreView(() => functionEditor?.generateWsBlock?.(owner));
        }
      }
      if (undo) history.undoStack_ = undo;
      if (redo) history.redoStack_ = redo;
      for (const [board, previous] of readOnly) restoreView(() => { if (board.readOnly !== previous) board.readOnly = previous; });
      playground.view_.classList.remove('entropy-editor-editing');
      restoreCurtain();
      panel.remove();
      if (playground.object) restoreView(() => injectCode.call(playground));
      const overlayBoard = workspace.overlayBoard;
      const shown = [...saved.values()].find(value => value.copy === overlayBoard?.code);
      if (shown) restoreView(() => overlayCode.call(workspace, shown.original));
      for (const value of saved.values()) restoreView(() => value.copy.destroy?.());
      saved.clear();
    }, restoreView);
    if (failure) console.warn('[entropy] 블록 원본은 복원했지만 편집 화면 일부를 갱신하지 못했습니다', failure);
  }
  return session;
}
