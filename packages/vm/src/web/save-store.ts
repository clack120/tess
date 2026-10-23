// Keep each work's saves in one IndexedDB record; they belong to this browser and viewer.
import { Dexie, type Table } from 'dexie';
import type { SaveHost, StoredValue } from '../runtime/save.ts';

const DATABASE = 'entropy-store';

interface Saved {
  // Prefer the playentry ID; otherwise use the project's name.
  work: string;
  values: Record<string, StoredValue>;
}

class SaveDatabase extends Dexie {
  works!: Table<Saved, string>;

  constructor() {
    super(DATABASE);
    this.version(1).stores({ works: 'work' });
  }
}

let database: SaveDatabase | null = null;

// Return null when IndexedDB is unavailable so can_save reports no storage.
export function dexieSaveStore(work: string): SaveHost | null {
  if (typeof indexedDB === 'undefined') {
    return null;
  }
  try {
    database ??= new SaveDatabase();
  } catch (error) {
    console.warn('[entropy] 저장소를 열지 못해 저장 기능을 끕니다', error);
    return null;
  }
  const open = database;
  return {
    async read() {
      const row = await open.works.get(work);
      return row?.values ?? {};
    },
    async write(values) {
      await open.works.put({ work, values });
    },
  };
}
