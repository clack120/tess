// The save manager recognizes @-prefixed globals and intercepts its named save functions.

export const STORE_PREFIX = '@';
export const STORE_SAVE_FUNCTION = '@저장';
export const STORE_SAVE_ASYNC_FUNCTION = '@비동기저장';
// The extension sets this flag to 1; it is zero or missing otherwise.
export const STORE_FLAG_VARIABLE = '@확장프로그램';
export const STORE_FLAG_ON = 1;

export function isStoreName(name: string): boolean {
  return name.startsWith(STORE_PREFIX) && name !== STORE_FLAG_VARIABLE;
}
