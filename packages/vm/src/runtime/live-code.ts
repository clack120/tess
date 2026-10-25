import type { GeneratedTrace } from './diagnostics.ts';
import type { CallFrame, CompiledFunction, Entity, Thread, Yielded } from './model.ts';

export interface LiveContext {
  entity: Entity;
  params?: unknown[];
  locals?: Record<string, unknown>;
}

export interface LiveProgram {
  blocks?: Record<string, (context: LiveContext, thread: Thread) => CallFrame>;
  sequences?: Record<string, string[]>;
  checks?: Record<string, (context: LiveContext, thread: Thread) => CallFrame>;
  blockTypes?: Record<string, string>;
  functions: CompiledFunction[];
}

// Only the editor uses this dispatch path. Compiled blocks keep their current
// waits and local values; the next block is looked up after each completion.
export class LiveCode {
  readonly exit = Symbol('exit executor');
  readonly break = Symbol('break loop');
  readonly continue = Symbol('continue loop');
  functions: CompiledFunction[] = [];
  private blocks: NonNullable<LiveProgram['blocks']> = {};
  private sequences: NonNullable<LiveProgram['sequences']> = {};
  private checks: NonNullable<LiveProgram['checks']> = {};
  private blockTypes: Record<string, string> = {};
  private trace?: GeneratedTrace;

  install(program: LiveProgram, trace: GeneratedTrace): void {
    this.blocks = program.blocks ?? {};
    this.sequences = program.sequences ?? {};
    this.checks = program.checks ?? {};
    this.blockTypes = program.blockTypes ?? {};
    this.functions = program.functions;
    this.trace = trace;
  }

  *check(id: string, context: LiveContext, thread: Thread): Generator<Yielded, unknown, unknown> {
    const body = this.checks[id];
    if (!body) return false;
    const frame = body(context, thread);
    frame.liveTrace = this.trace;
    return yield frame;
  }

  contains(frame: CallFrame): boolean {
    return !frame.liveBlock || (this.blockTypes[frame.liveBlock.id] === frame.liveBlock.type &&
      !!this.sequences[frame.liveBlock.sequence]?.includes(frame.liveBlock.id));
  }

  *sequence(id: string, context: LiveContext, thread: Thread): Generator<Yielded, void, unknown> {
    let order = this.sequences[id] ?? [];
    let index = 0;
    const completed = new Set<string>();
    while (index < order.length) {
      const blockId = order[index]!;
      const type = this.blockTypes[blockId];
      if (!completed.has(blockId)) {
        const body = this.blocks[blockId];
        if (body) {
          const frame = body(context, thread);
          frame.liveBlock = { id: blockId, sequence: id, type };
          frame.liveTrace = this.trace;
          yield frame;
        }
        if (this.blockTypes[blockId] === type) completed.add(blockId);
      }
      const next = this.sequences[id] ?? [];
      if (next === order) { index++; continue; }
      const anchor = next.indexOf(blockId);
      if (anchor !== -1) index = anchor + (completed.has(blockId) ? 1 : 0);
      else {
        // A deleted active block continues after its nearest surviving previous
        // neighbor. Already completed blocks cannot run twice after a move.
        const previous = order.slice(0, index).findLast(item => next.includes(item));
        index = previous === undefined ? 0 : next.indexOf(previous) + 1;
      }
      order = next;
      while (index < order.length && completed.has(order[index]!)) index++;
    }
  }
}
