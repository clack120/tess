/** Block stacks in Entry projects may be JSON text or already-parsed arrays. */
export function parseEntryBlockData<T = unknown>(value: unknown): T[][] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new TypeError('Entry 블록 데이터는 배열 또는 JSON 배열 문자열이어야 합니다.');
  }
  return parsed as T[][];
}
