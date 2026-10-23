// Swap a property for one test. node:test's mock is missing in bun, and deno exposes some globals as getters only.
export function stub<T extends object, K extends keyof T>(t: { after(fn: () => void): void }, target: T, key: K, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: own?.enumerable ?? true });
  t.after(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete target[key];
  });
}
