// Cached assets can finish in one microtask chain; leave time for editor input and paint.
export function loadYield(): () => Promise<void> | undefined {
  let deadline = performance.now() + 8;
  return () => {
    if (performance.now() < deadline) return;
    return new Promise<void>(resolve => setTimeout(() => {
      deadline = performance.now() + 8;
      resolve();
    }, 0));
  };
}
