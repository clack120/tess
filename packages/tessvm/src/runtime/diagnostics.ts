import type { VmError } from './engine.ts';

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

/** Capture only on failure, without retaining large strings or invoking user code. */
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

/** Resolve an engine stack location to a block without instrumenting executed blocks. */
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
