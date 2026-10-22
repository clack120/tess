import type { Vm, VmError } from './engine.ts';
import type { Variable } from './model.ts';

export interface BlockSite {
  line: number;
  column: number;
  blockId: string;
  blockType: string;
}

export interface GeneratedTrace {
  sourceId: string;
  sites: BlockSite[];
}

export type RuntimeValue =
  | { type: 'string'; value: string; length: number; truncated: boolean }
  | { type: 'number'; value: number | string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' | 'undefined' | 'object' | 'function' | 'symbol' | 'bigint' };

// Capture only on failure, without retaining large strings or invoking user code.
export function runtimeValue(value: unknown): RuntimeValue {
  if (typeof value === 'string') return { type: 'string', value: value.slice(0, 1024), length: value.length, truncated: value.length > 1024 };
  if (typeof value === 'number') return { type: 'number', value: Number.isFinite(value) ? value : String(value) };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (value === null) return { type: 'null' };
  switch (typeof value) {
    case 'undefined': return { type: 'undefined' };
    case 'function': return { type: 'function' };
    case 'symbol': return { type: 'symbol' };
    case 'bigint': return { type: 'bigint' };
    default: return { type: 'object' };
  }
}

export class RuntimeBlockError extends Error {
  readonly inputs: Record<string, RuntimeValue>;
  readonly blockType: string;
  constructor(message: string, blockType: string, inputs: Record<string, unknown>) {
    super(message);
    this.name = 'EntryRuntimeError';
    this.blockType = blockType;
    this.inputs = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, runtimeValue(value)]));
  }
}

// Keep previews small and detached so inspecting a large work does not copy its heap.
export function snapshotVm(vm: Vm) {
  let budget = 512;
  const variables = (items: readonly (Variable | undefined)[]) => items.filter((item): item is Variable => !!item).slice(0, 200).map((item) => {
    const values = item.isList ? item.array.slice(0, Math.min(20, budget)).map((cell) => runtimeValue(cell.data))
      : budget > 0 ? [runtimeValue(item.value)] : [];
    budget -= values.length;
    return { id: item.id, name: item.name, objectId: item.objectId, isList: item.isList,
      length: item.isList ? item.array.length : 1, values };
  });
  let clones = 0, threads = 0, listItems = 0;
  for (const target of vm.targets) { clones += target.clones.length; threads += target.threads.length; }
  for (const variable of vm.variables) if (variable.isList) listItems += variable.array.length;
  const globalVariables = variables(vm.variables);
  const entities = [];
  const threadPreview = [];
  for (const target of vm.targets) {
    for (const thread of target.threads) {
      threadPreview.push({ targetId: target.id, entityId: thread.entity.id, event: thread.script.event,
        eventFilter: thread.script.filter, eventBlockId: thread.script.blockId, depth: thread.depth, done: thread.done });
      if (threadPreview.length >= 200) break;
    }
    if (threadPreview.length >= 200) break;
  }
  for (const target of vm.targets) {
    for (let index = -1; index < target.clones.length && entities.length < 100; index++) {
      const entity = index < 0 ? target.entity : target.clones[index]!;
      entities.push({ id: entity.id, targetId: target.id, name: target.name, isClone: entity.isClone,
        x: entity.x, y: entity.y, visible: entity.visible, pictureId: entity.picture?.id ?? null,
        text: runtimeValue(entity.text), variables: variables(entity.localVars ?? []) });
    }
    if (entities.length >= 100) break;
  }
  return {
    state: vm.state, frame: vm.frame, clock: vm.clock, frameRate: vm.frameRate,
    scene: { id: vm.currentSceneId, name: vm.sceneOf(vm.currentSceneId)?.name ?? vm.currentSceneId },
    counts: { objects: vm.targets.length, clones, threads, variables: vm.variables.length, listItems },
    input: { keys: [...vm.pressedKeys], mouseX: vm.mouseX, mouseY: vm.mouseY, mouseDown: vm.mouseDown,
      clickedEntityId: vm.clickedEntityId, question: runtimeValue(vm.question), answer: runtimeValue(vm.answer), pendingAnswer: runtimeValue(vm.pendingAnswer) },
    kernel: vm.kernel ? { roots: vm.kernel.roots.size, ...vm.kernel.stats } : null,
    variables: globalVariables, entities, threads: threadPreview,
    limits: { variablesPerOwner: 200, listPreview: 20, values: 512, entities: 100, threads: 200, stringLength: 1024 },
  };
}

export type VmSnapshot = ReturnType<typeof snapshotVm>;

// Resolve stack locations to blocks without instrumenting every executed block.
export function blockOfError(stack: string | undefined, trace: GeneratedTrace | undefined): BlockSite | null {
  if (!stack || !trace) return null;
  const at = stack.indexOf(`${trace.sourceId}:`);
  if (at === -1) return null;
  const match = /^(\d+):(\d+)/.exec(stack.slice(at + trace.sourceId.length + 1));
  if (!match) return null;
  const line = Number(match[1]), column = Number(match[2]);
  let low = 0, high = trace.sites.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const site = trace.sites[mid]!;
    if (site.line < line || (site.line === line && site.column <= column)) low = mid + 1;
    else high = mid;
  }
  return trace.sites[low - 1] ?? null;
}

export function formatVmError(error: VmError): string {
  const lines = [error.message];
  if (error.where) lines.push(error.where);
  if (error.blockId || error.blockType) lines.push(`블록 ${error.blockType ?? '?'} (${error.blockId ?? '?'})`);
  if (error.context) lines.push(`프레임 ${error.context.frame} · 실행 시간 ${error.context.clock.toFixed(2)} ms · 이벤트 ${error.context.event ?? '프레임 처리'}`);
  for (const [name, input] of Object.entries(error.inputs ?? {})) {
    const value = 'value' in input ? JSON.stringify(input.value) : input.type;
    lines.push(`입력 ${name}: ${value}${input.type === 'string' ? ` (글자 수 ${input.length}${input.truncated ? ', 앞부분만 표시' : ''})` : ''}`);
  }
  return lines.join('\n');
}
