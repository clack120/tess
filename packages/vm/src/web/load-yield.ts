// Cached assets can finish in one microtask chain; leave time for editor input and paint.
// Timers are clamped to 4ms and throttled much harder in background tabs, so yield with a task instead.
export function loadYield(): () => Promise<void> | undefined {
  let deadline = performance.now() + 8;
  return () => {
    if (performance.now() < deadline) return;
    return nextTask().then(() => {
      deadline = performance.now() + 8;
    });
  };
}

const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
let channel: MessageChannel | undefined;
const waiting: Array<() => void> = [];

function nextTask(): Promise<void> {
  if (scheduler?.yield) return scheduler.yield();
  if (typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      waiting.shift()?.();
      if (waiting.length === 0) portRef('unref');
    };
    portRef('unref');
  }
  return new Promise(resolve => {
    if (waiting.length === 0) portRef('ref');
    waiting.push(resolve);
    channel!.port2.postMessage(0);
  });
}

// Keep server-side runtimes alive only while a posted task is pending.
function portRef(method: 'ref' | 'unref'): void {
  (channel?.port1 as unknown as Record<'ref' | 'unref', (() => void) | undefined>)?.[method]?.();
}
