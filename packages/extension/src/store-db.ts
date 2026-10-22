// The popup and worker share extension storage; page-origin storage is inaccessible to them.
import { Dexie, type Table } from 'dexie';
import { exportDB, importInto, peakImportFile } from 'dexie-export-import';

const DATABASE = 'tessvm-store';

export type StoredValue = string | number | boolean | Array<{ data: string | number | boolean }>;

export interface SavedWork {
  work: string;
  title: string;
  values: Record<string, StoredValue>;
  // Last write time in milliseconds.
  updated: number;
}

export interface SavedSummary {
  work: string;
  title: string;
  names: number;
  // Approximate size in JSON bytes.
  bytes: number;
  updated: number;
}

class StoreDatabase extends Dexie {
  works!: Table<SavedWork, string>;

  constructor() {
    super(DATABASE);
    this.version(1).stores({ works: 'work' });
  }
}

let database: StoreDatabase | null = null;

function open(): StoreDatabase {
  database ??= new StoreDatabase();
  return database;
}

export async function readWork(work: string): Promise<Record<string, StoredValue>> {
  const row = await open().works.get(work);
  return row?.values ?? {};
}

export async function writeWork(
  work: string,
  title: string,
  values: Record<string, StoredValue>,
): Promise<void> {
  await open().works.put({ work, title, values, updated: Date.now() });
}

export async function listWorks(): Promise<SavedSummary[]> {
  const rows = await open().works.toArray();
  return rows
    .map((row) => ({
      work: row.work,
      title: row.title || row.work,
      names: Object.keys(row.values ?? {}).length,
      bytes: JSON.stringify(row.values ?? {}).length,
      updated: row.updated ?? 0,
    }))
    .sort((a, b) => b.updated - a.updated);
}

export async function removeWork(work: string): Promise<void> {
  await open().works.delete(work);
}

export async function clearWorks(): Promise<void> {
  await open().works.clear();
}


export async function exportAll(): Promise<Blob> {
  return exportDB(open(), { prettyJson: true });
}

export function exportName(now = new Date()): string {
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  return `tessvm-save-${stamp}.json`;
}

// Merge matching works, preserve absent ones, and reject exports from other databases.
export async function importAll(file: Blob): Promise<number> {
  const meta = await peakImportFile(file);
  if (meta.data.databaseName !== DATABASE) {
    throw new Error('tessvm 이 내보낸 파일이 아닙니다.');
  }
  await importInto(open(), file, { overwriteValues: true });
  return meta.data.tables.find((table) => table.name === 'works')?.rowCount ?? 0;
}
