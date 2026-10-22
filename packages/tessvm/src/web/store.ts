// Outside Entry, persist shared values locally because no shared server is available.
import type { VariableStore } from '../runtime/engine.ts';

const PREFIX = 'tessvm:vars';

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
      } catch {
        return undefined;
      }
    },
    write(id, value) {
      try {
        backing.setItem(keyOf(id), JSON.stringify(value));
      } catch {
        // Keep running with in-memory values when storage is full or refused.
      }
    },
  };
}
