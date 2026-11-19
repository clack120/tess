// The save manager recognizes @-prefixed globals and intercepts its named save functions.

export const STORE_PREFIX = '@';
export const STORE_SAVE_FUNCTION = '@저장';
export const STORE_SAVE_ASYNC_FUNCTION = '@비동기저장';
// The extension sets this flag to 1; it is zero or missing otherwise.
export const STORE_FLAG_VARIABLE = '@확장프로그램';
export const STORE_FLAG_ON = 1;

export function isStoreFlag(name: unknown): boolean {
  return typeof name === 'string' && name.replace(/\s+/g, '') === STORE_FLAG_VARIABLE;
}

export function isStoreName(name: unknown): boolean {
  return typeof name === 'string' && name.trim().startsWith(STORE_PREFIX) && !isStoreFlag(name);
}

export function saveFunctionKind(name: unknown): 'wait' | 'async' | undefined {
  if (typeof name !== 'string') return undefined;
  const clean = name.trim().replace(/\s*\([^)]*\)\s*$/, '').replace(/^@\s+/, '@');
  return clean === STORE_SAVE_FUNCTION ? 'wait' : clean === STORE_SAVE_ASYNC_FUNCTION ? 'async' : undefined;
}
