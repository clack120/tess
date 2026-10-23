// Outside Entry, persist shared values locally because no shared server is available.
import type { VariableStore } from '../runtime/engine.ts';

const PREFIX = 'entropy:vars';

type Stored = string | number | Array<{ data: string | number }>;

// Fall back to VM memory when the browser refuses storage.
export function localVariableStore(projectKey: string): VariableStore | null {
  let backing: Storage;
  try {
    backing = window.localStorage;
    const probe = `${PREFIX}:probe`;
    backing.setItem(probe, '1');
    backing.removeItem(probe);
  } catch {
    return null;
  }
  const keyOf = (id: string) => `${PREFIX}:${projectKey}:${id}`;
  return {
    read(id) {
      try {
        const text = backing.getItem(keyOf(id));
        return text === null ? undefined : (JSON.parse(text) as Stored);
      } catch (error) {
        console.warn('[entropy] 저장된 변수 값을 읽지 못했습니다', id, error);
        return undefined;
      }
    },
    write(id, value) {
      try {
        backing.setItem(keyOf(id), JSON.stringify(value));
      } catch (error) {
        // Keep running with in-memory values when storage is full or refused.
        console.warn('[entropy] 변수 값을 저장하지 못했습니다', id, error);
      }
    },
  };
}
