import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypes } from '@tess/core/strip-types';

function load(rows: any[] = []) {
  const table = new Map<string, any>(rows.map((row) => [row.work, row]));
  // Like Dexie, attach tables when the schema is declared in the subclass constructor.
  class Dexie {
    works: unknown;
    version() {
      return { stores: () => { this.works = {
        toArray: async () => [...table.values()].map((row) => structuredClone(row)),
        bulkPut: async (items: any[]) => { for (const item of items) table.set(item.work, structuredClone(item)); },
      }; } };
    }
  }
  const source = stripTypes(fs.readFileSync(new URL('../packages/extension/src/store-db.ts', import.meta.url), 'utf-8'))
    .replace(/^import[^;]*;$/gm, '').replace(/^export /gm, '');
  const sandbox: Record<string, unknown> = { Dexie, Blob, JSON, Object, Number, String, Array, Error };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.api = { exportAll, importAll };`, sandbox);
  return { api: sandbox.api as { exportAll(): Promise<Blob>; importAll(file: Blob): Promise<number> }, table };
}

const blob = (value: unknown) => new Blob([typeof value === 'string' ? value : JSON.stringify(value)]);

test('exports round-trip NaN and Infinity and merge into existing saves', async () => {
  const values = { 'a.b': NaN, n: 2, inf: Infinity, list: [{ data: -Infinity }, { data: 'q' }] };
  const { api } = load([{ work: 'w', title: 't', values, updated: 3 }]);
  const text = await (await api.exportAll()).text();
  assert.equal(JSON.parse(text).format, 'tessvm-saves');
  const other = load([{ work: 'w', title: 'old', values: { kept: 1 }, updated: 1 }, { work: 'w9', title: '', values: {}, updated: 0 }]);
  assert.equal(await other.api.importAll(blob(text)), 1);
  const back = other.table.get('w');
  assert.equal(back.title, 't');
  assert.ok(Number.isNaN(back.values['a.b']));
  assert.equal(back.values.inf, Infinity);
  assert.deepEqual(back.values.list, [{ data: -Infinity }, { data: 'q' }]);
  assert.equal('kept' in back.values, false, 'matching works are overwritten');
  assert.ok(other.table.has('w9'), 'absent works are kept');
});

test('other files are refused', async () => {
  const { api } = load();
  for (const bad of ['not json', { format: 'other', version: 1, works: [] }, { format: 'tessvm-saves', version: 2, works: [] }, {}]) {
    await assert.rejects(api.importAll(blob(bad)), /tessvm 이 내보낸 파일이 아닙니다/);
  }
  await assert.rejects(api.importAll(blob({ format: 'tessvm-saves', version: 1, works: [{ title: 'x' }] })), /작품 항목이 올바르지 않습니다/);
});
