import type { Vm } from '../runtime/engine.ts';
import { snapshotVm } from '../runtime/diagnostics.ts';

interface Activity {
  at: number;
  elapsedMs: number;
  callbacks: number;
  ticks: number;
  workMs: number;
  maxWorkMs: number;
  kernelRuns: number;
  kernelFallbacks: number;
}

function focusedElement(): string | null {
  const active = document.activeElement;
  return active ? `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''}${active.classList?.length ? `.${[...active.classList].slice(0, 2).join('.')}` : ''}` : null;
}

// Use half-second buckets without work proportional to block count.
export class RuntimeDiagnostics {
  private readonly vm: Vm;
  private since: number;
  private frame: number;
  private runs: number;
  private fallbacks: number;
  private pending = { callbacks: 0, ticks: 0, workMs: 0, maxWorkMs: 0, kernelRuns: 0, kernelFallbacks: 0 };
  private readonly history: Activity[] = [];
  private readonly focusEvents: Array<{ at: number; type: string; element: string | null; focused: boolean }> = [];
  private failure: { error: NonNullable<Vm['lastError']>; activity: Activity[] } | null = null;

  constructor(vm: Vm, now = performance.now()) {
    this.vm = vm;
    this.since = now;
    this.frame = vm.frame;
    this.runs = vm.kernel?.stats.runs ?? 0;
    this.fallbacks = vm.kernel?.stats.fallbacks ?? 0;
  }

  record(now: number, workMs: number): void {
    const runs = this.vm.kernel?.stats.runs ?? 0;
    const fallbacks = this.vm.kernel?.stats.fallbacks ?? 0;
    this.pending.callbacks++;
    this.pending.ticks += Math.max(0, this.vm.frame - this.frame);
    this.pending.kernelRuns += Math.max(0, runs - this.runs);
    this.pending.kernelFallbacks += Math.max(0, fallbacks - this.fallbacks);
    this.pending.workMs += workMs;
    this.pending.maxWorkMs = Math.max(this.pending.maxWorkMs, workMs);
    this.frame = this.vm.frame;
    this.runs = runs;
    this.fallbacks = fallbacks;
    if (now - this.since >= 500) {
      this.history.push({ at: now, elapsedMs: now - this.since, ...this.pending });
      if (this.history.length > 60) this.history.shift();
      this.since = now;
      this.pending = { callbacks: 0, ticks: 0, workMs: 0, maxWorkMs: 0, kernelRuns: 0, kernelFallbacks: 0 };
    }
    this.keepFailure(now);
  }

  recordFocus(type: string): void {
    this.focusEvents.push({ at: performance.now(), type, element: focusedElement(), focused: document.hasFocus() });
    if (this.focusEvents.length > 16) this.focusEvents.shift();
  }

  private keepFailure(now = performance.now()): void {
    const error = this.vm.lastError;
    if (error && error !== this.failure?.error) {
      const activity = this.history.slice();
      if (this.pending.callbacks) activity.push({ at: now, elapsedMs: Math.max(0, now - this.since), ...this.pending });
      this.failure = { error, activity };
    }
  }

  snapshot() {
    this.keepFailure();
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return {
      format: 'entropy-diagnostics', version: 1, capturedAt: new Date().toISOString(),
      current: snapshotVm(this.vm), activity: this.history.slice(), failure: this.failure,
      heap: memory ? { used: memory.usedJSHeapSize, allocated: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit } : null,
      focusEvents: this.focusEvents.slice(),
      page: { visible: !document.hidden, focused: document.hasFocus(),
        activeElement: focusedElement() },
    };
  }
}

export type DiagnosticReport = ReturnType<RuntimeDiagnostics['snapshot']>;
