// The popup and worker share extension storage; page-origin storage is inaccessible to them.
import { Dexie, type Table } from 'dexie';

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


// Files keep the dexie-export-import v1 layout so saves exported by earlier versions still import.
const NUMBER_TYPES: Record<string, number> = { nan: NaN, infinity: Infinity, negativeInfinity: -Infinity };
const escapeKey = (key: string) => key.replace(/~/g, '~0').replace(/\./g, '~1');
const unescapeKey = (key: string) => key.replace(/~1/g, '.').replace(/~0/g, '~');

// JSON cannot hold NaN or Infinity, so record them by key path as the original exporter did.
function encodeRow(row: SavedWork): Record<string, unknown> {
  const types: Record<string, string> = {};
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      types[path] = Number.isNaN(value) ? 'nan' : value > 0 ? 'infinity' : 'negativeInfinity';
      return String(value);
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}.${index}`));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, `${path}.${escapeKey(key)}`)]));
    }
    return value;
  };
  const values = walk(row.values, 'values');
  return { ...row, values, ...(Object.keys(types).length ? { $types: types } : {}) };
}

function decodeRow(raw: unknown): SavedWork {
  const row = raw as SavedWork & { $types?: Record<string, string> };
  if (!row || typeof row.work !== 'string') throw new Error('저장 파일의 작품 항목이 올바르지 않습니다.');
  const { $types: types, ...plain } = row;
  for (const [path, type] of Object.entries(types ?? {})) {
    if (type === 'arrayNonindexKeys') continue;
    if (!(type in NUMBER_TYPES)) throw new Error(`저장 파일에 읽을 수 없는 값이 있습니다: ${type}`);
    const keys = path.split('.').map(unescapeKey);
    const last = keys.pop()!;
    let parent: any = plain;
    for (const key of keys) parent = parent?.[key];
    if (parent && typeof parent === 'object') parent[last] = NUMBER_TYPES[type];
  }
  return plain as SavedWork;
}

export async function exportAll(): Promise<Blob> {
  const db = open();
  const rows = await db.works.toArray();
  const file = {
    formatName: 'dexie',
    formatVersion: 1,
    data: {
      databaseName: DATABASE,
      databaseVersion: db.verno,
      tables: [{ name: 'works', schema: 'work', rowCount: rows.length }],
      data: [{ tableName: 'works', inbound: true, rows: rows.map(encodeRow) }],
    },
  };
  return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
}

export function exportName(now = new Date()): string {
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  return `tessvm-save-${stamp}.json`;
}

// Merge matching works, preserve absent ones, and reject exports from other databases.
export async function importAll(file: Blob): Promise<number> {
  let parsed: any;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('tessvm 이 내보낸 파일이 아닙니다.');
  }
  // Earlier extension builds rewrote the format name along with their dexie import path.
  const format = /^(?:\.\/)?dexie(?:\.mjs)?$/.test(String(parsed?.formatName));
  if (!format || parsed.formatVersion !== 1 || parsed.data?.databaseName !== DATABASE) {
    throw new Error('tessvm 이 내보낸 파일이 아닙니다.');
  }
  const table = (parsed.data.data as Array<{ tableName?: string; rows?: unknown[] }> | undefined)
    ?.find((item) => item.tableName === 'works');
  const rows = (table?.rows ?? []).map(decodeRow);
  await open().works.bulkPut(rows);
  return rows.length;
}
