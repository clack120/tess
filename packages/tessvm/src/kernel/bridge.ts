// Copy kernel inputs, run once, then commit writes or fall back to the original function.
import { BAIL_SLOT, canonical, judged, type KernelPlan, type KernelSlot } from './plan.ts';
import { decimals } from '../runtime/cast.ts';
import { kernelOps, type KernelMarks } from './runtime-js.ts';
import { scalarPlaces } from './values.ts';
import type { Variable } from '../runtime/model.ts';

// Leave room for kernel calls inside Entry's call depth limit.
const CALL_DEPTH_LIMIT = 1000000;

// Measure enough calls to decide whether crossing into the kernel is worthwhile.
const TRIAL_CALLS = 24;
// Accumulate timings because short calls can fall below the page clock's precision.
const TRIAL_MIN_MS = 2;
const TRIAL_MAX_CALLS = 2048;
// Periodically compare copying cost with the original trial.
const WATCH_CALLS = 256;
// Repeated fallbacks make roots rest, up to this limit.
const FAIL_LIMIT = 8;
const REST_FIRST = 16;
const REST_MAX = 4096;
// Retry roots after this many calls to see whether copying became worthwhile.
const RETRY_FIRST = 8192;
const RETRY_MAX = 1 << 20;

type KernelFn = (...args: unknown[]) => unknown;

export interface KernelHandle {
  run(root: number, args: unknown[]): unknown;
  roots: Map<number, { name: string; arity: number }>;
  depth: number;
  // Count executions, fallbacks, copied values, and roots retired for cost or incompatible data.
  readonly stats: { runs: number; fallbacks: number; copied: number; dropped: number };
}

export function attachJsKernel(
  plan: Pick<KernelPlan, 'javascript' | 'slots' | 'roots' | 'access' | 'depth' | 'size'>,
  variables: Variable[],
): KernelHandle | null {
  const cells = new Float64Array(plan.size);
  const marks: KernelMarks = { flags: new Uint8Array(plan.size), strings: new Uint8Array(plan.size), span: new Int32Array([plan.size, -1]) };
  let built: Record<string, unknown>;
  try {
    const factory = new Function('R', plan.javascript) as (ops: unknown) => Record<string, unknown>;
    built = factory(kernelOps(cells, marks));
  } catch {
    return null;
  }
  const entries = new Map<number, KernelFn>();
  for (const [index, root] of plan.roots) {
    const fn = built[root.name];
    if (typeof fn !== 'function') {
      return null;
    }
    entries.set(index, fn as KernelFn);
  }
  return marshal(plan, variables, entries, () => cells, marks);
}

interface Trial {
  calls: number;
  cross: number;
  inside: number;
  cells: number;
  // Ignore the first call's full copy when estimating ongoing costs.
  cold: boolean;
}

interface Root {
  reading: KernelSlot[];
  writing: KernelSlot[];
  trial: Trial | null;
  baseline: number;
  calls: number;
  cells: number;
  fails: number;
  wait: number;
  waitEnds: 'retry' | 'trial';
  rest: number;
  retry: number;
  // Retire roots permanently when their data no longer matches the module.
  stopped: boolean;
}

function newTrial(cold: boolean): Trial {
  return { calls: 0, cross: 0, inside: 0, cells: 0, cold };
}

// Mark changed list items so only actual writes are copied back.
function marshal(
  plan: Pick<KernelPlan, 'slots' | 'roots' | 'access' | 'depth' | 'size'>,
  variables: Variable[],
  entries: Map<number, KernelFn>,
  data: () => Float64Array,
  marks: KernelMarks,
): KernelHandle {
  // Copy only the variables each root's call tree touches.
  const roots = new Map<number, Root>([...plan.access].map(([index, used]) => [index, {
    reading: used.touched.map((at) => plan.slots[at]!),
    writing: used.written.map((at) => plan.slots[at]!),
    trial: newTrial(true),
    baseline: 0,
    calls: 0,
    cells: 0,
    fails: 0,
    wait: 0,
    waitEnds: 'retry',
    rest: REST_FIRST,
    retry: RETRY_FIRST,
    stopped: false,
  }]));
  const stats = { runs: 0, fallbacks: 0, copied: 0, dropped: 0 };
  let moved = 0;
  // Cache by variable, not offset, because empty lists share offsets with later slots.
  const stamp = new Map<number, number>();

  const agree = (slot: KernelSlot, variable: Variable): void => {
    stamp.set(slot.variable, variable.revision);
    variable.synced();
  };

  // Permanently reject changed layouts or unsafe text; skip only the current call for temporary failures.
  function copyIn(slot: KernelSlot, cells: Float64Array): 'ok' | 'skip' | 'stop' {
    const variable = variables[slot.variable];
    if (!variable) {
      return 'stop';
    }
    const seen = stamp.get(slot.variable);
    if (seen === variable.revision) {
      return 'ok';
    }
    if (slot.list) {
      const array = variable.array;
      if (array.length !== slot.length) {
        return 'stop';
      }
      // Copy only items written since the last synchronization.
      const span = seen === undefined ? null : variable.changedSince(seen);
      const from = span ? Math.max(0, span[0]) : 0;
      const to = span ? Math.min(slot.length - 1, span[1]) : slot.length - 1;
      const count = Math.max(0, to - from + 1);
      stats.copied += count;
      moved += count;
      if (slot.judgement) {
        for (let at = from; at <= to; at += 1) {
          const item = array[at]!.data;
          if (!judged(item)) {
            // Let JavaScript fill an initially nonnumeric list before trying the kernel again.
            return 'skip';
          }
          cells[slot.base + at] = item === true ? 1 : 0;
        }
        agree(slot, variable);
        return 'ok';
      }
      for (let at = from; at <= to; at += 1) {
        const item = array[at]!.data;
        if (!canonical(item)) {
          return 'stop';
        }
        cells[slot.base + at] = Number(item);
        marks.strings[slot.base + at] = typeof item === 'string' ? 1 : 0;
      }
      // Count decimal tails once for read-only tables instead of inside their loops.
      if (slot.tails >= 0) {
        for (let at = from; at <= to; at += 1) {
          cells[slot.tails + at] = decimals(cells[slot.base + at]!);
        }
      }
      agree(slot, variable);
      return 'ok';
    }
    stats.copied += 1;
    moved += 1;
    const raw = variable.value;
    const value = Number(raw);
    const places = scalarPlaces(raw);
    if (places === null) {
      return 'skip';
    }
    cells[slot.base] = value;
    // Preserve stored decimal formatting because change_variable reads it on the next update.
    cells[slot.places] = places;
    agree(slot, variable);
    return 'ok';
  }

  const stored = (cell: number): boolean => marks.flags[cell] === 1;

  function copyOut(slot: KernelSlot, cells: Float64Array): void {
    const variable = variables[slot.variable]!;
    if (slot.list) {
      const array = variable.array;
      const from = Math.max(slot.base, marks.span[0]!) - slot.base;
      const to = Math.min(slot.base + slot.length - 1, marks.span[1]!) - slot.base;
      let wrote = false;
      for (let at = from; at <= to; at += 1) {
        if (!stored(slot.base + at)) continue;
        const value = cells[slot.base + at]!;
        array[at] = { data: slot.judgement ? (value !== 0) as never : marks.strings[slot.base + at] ? String(value) : value };
        moved += 1;
        wrote = true;
      }
      if (wrote) variable.touch();
    } else {
      const places = cells[slot.places]!;
      const value = cells[slot.base]!;
      moved += 1;
      // Entry stores toFixed results as text, so counters can hold "1" rather than 1.
      variable.setValue(places >= 0 ? value.toFixed(places) : places === -2 ? String(value) : value);
    }
    // Skip copying unchanged values until an external write occurs.
    agree(slot, variable);
  }

  const clearMarks = (): void => {
    const [low, high] = marks.span;
    if (high! >= low!) marks.flags.fill(0, low, high! + 1);
    marks.span[0] = plan.size;
    marks.span[1] = -1;
  };

  // Repeated kernel failures make a root rest before retrying.
  const fell = (state: Root): null => {
    stats.fallbacks += 1;
    state.fails += 1;
    if (state.fails >= FAIL_LIMIT) {
      state.fails = 0;
      state.wait = state.rest;
      state.waitEnds = 'retry';
      state.rest = Math.min(state.rest * 2, REST_MAX);
    }
    return null;
  };

  return {
    roots: plan.roots,
    depth: plan.depth,
    stats,
    run(root: number, args: unknown[]): unknown {
      const fn = entries.get(root);
      const state = roots.get(root);
      if (!fn || !state || state.stopped) {
        return null;
      }
      if (state.wait > 0) {
        state.wait -= 1;
        if (state.wait === 0 && state.waitEnds === 'trial') {
          state.trial = newTrial(false);
        }
        return null;
      }
      const trial = state.trial;
      const started = trial ? performance.now() : 0;
      const cells = data();
      moved = 0;
      for (const slot of state.reading) {
        const result = copyIn(slot, cells);
        if (result !== 'ok') {
          if (result === 'stop') {
            state.stopped = true;
            stats.dropped += 1;
            stats.fallbacks += 1;
            return null;
          }
          return fell(state);
        }
      }
      cells[BAIL_SLOT] = 0;
      const entered = trial ? performance.now() : 0;
      const result = fn(...args);
      const left = trial ? performance.now() : 0;
      if (cells[BAIL_SLOT] !== 0) {
        clearMarks();
        for (const slot of state.writing) stamp.delete(slot.variable);
        return fell(state);
      }
      const written = data();
      for (const slot of state.writing) {
        copyOut(slot, written);
      }
      clearMarks();
      stats.runs += 1;
      state.fails = 0;
      state.rest = REST_FIRST;
      if (trial) {
        if (trial.cold) {
          trial.cold = false;
        } else {
          trial.calls += 1;
          trial.inside += left - entered;
          trial.cross += entered - started + (performance.now() - left);
          trial.cells += moved;
        }
        const measured = trial.inside + trial.cross;
        if (trial.calls >= TRIAL_CALLS && (measured >= TRIAL_MIN_MS || trial.calls >= TRIAL_MAX_CALLS)) {
          state.trial = null;
          // Reject crossings whose copy cost consumes the kernel's execution savings.
          if (trial.cross > trial.inside) {
            stats.dropped += 1;
            state.wait = state.retry;
            state.waitEnds = 'trial';
            state.retry = Math.min(state.retry * 2, RETRY_MAX);
          } else {
            state.baseline = trial.cells / trial.calls;
            state.calls = 0;
            state.cells = 0;
          }
        }
      } else {
        // Retime accepted roots when external writes increase their copying cost.
        state.calls += 1;
        state.cells += moved;
        if (state.calls >= WATCH_CALLS) {
          if (state.cells / state.calls > Math.max(state.baseline * 4, state.baseline + 64)) {
            state.trial = newTrial(false);
          }
          state.calls = 0;
          state.cells = 0;
        }
      }
      return result;
    },
  };
}

export { CALL_DEPTH_LIMIT };
