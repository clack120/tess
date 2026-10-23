import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypes } from '@tess/core/strip-types';

// Written by dexie-export-import 4.4.1 from the shipped extension, whose build renamed the format.
const LEGACY: any = {"formatName": "./dexie.mjs", "formatVersion": 1, "data": {"databaseName": "tessvm-store", "databaseVersion": 1, "tables": [{"name": "works", "schema": "work", "rowCount": 2}], "data": [{"tableName": "works", "inbound": true, "rows": [{"work": "w1", "title": "제목", "values": {"a": 1, "x.y~z": "NaN", "inf": "Infinity", "neg": "-Infinity", "s": "t", "list": [{"data": "NaN"}, {"data": "q"}]}, "updated": 5, "$types": {"values.x~1y~0z": "nan", "values.inf": "infinity", "values.neg": "negativeInfinity", "values.list": "arrayNonindexKeys", "values.list.0.data": "nan"}}, {"work": "w2", "title": "", "values": {}, "updated": 0}]}]}};

function load(rows: any[] = []) {
  const table = new Map<string, any>(rows.map((row) => [row.work, row]));
  // Like Dexie, attach tables when the schema is declared in the subclass constructor.
  class Dexie {
    verno = 1;
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

test('files exported by the previous library import with NaN and Infinity restored', async () => {
  const { api, table } = load([{ work: 'w2', title: 'old', values: { kept: 1 }, updated: 1 }, { work: 'w9', title: '', values: {}, updated: 0 }]);
  assert.equal(await api.importAll(blob(LEGACY)), 2);
  const w1 = table.get('w1');
  assert.equal(w1.title, '제목');
  assert.ok(Number.isNaN(w1.values['x.y~z']));
  assert.equal(w1.values.inf, Infinity);
  assert.equal(w1.values.neg, -Infinity);
  assert.ok(Number.isNaN(w1.values.list[0].data));
  assert.equal(w1.values.list[1].data, 'q');
  assert.equal('$types' in w1, false);
  assert.deepEqual(table.get('w2').values, {}, 'matching works are overwritten');
  assert.ok(table.has('w9'), 'absent works are kept');
});

test('exports keep the v1 layout and round-trip special numbers', async () => {
  const values = { 'a.b': NaN, n: 2, list: [{ data: -Infinity }] };
  const { api } = load([{ work: 'w', title: 't', values, updated: 3 }]);
  const text = await (await api.exportAll()).text();
  const file = JSON.parse(text);
  assert.equal(file.formatName, 'dexie');
  assert.deepEqual(file.data.tables, [{ name: 'works', schema: 'work', rowCount: 1 }]);
  assert.deepEqual(file.data.data[0].rows[0].$types, { 'values.a~1b': 'nan', 'values.list.0.data': 'negativeInfinity' });
  const other = load();
  assert.equal(await other.api.importAll(blob(text)), 1);
  const back = other.table.get('w');
  assert.ok(Number.isNaN(back.values['a.b']));
  assert.equal(back.values.list[0].data, -Infinity);
});

test('other files are refused', async () => {
  const { api } = load();
  for (const bad of ['not json', { formatName: 'dexie', formatVersion: 1, data: { databaseName: 'other' } }, {}]) {
    await assert.rejects(api.importAll(blob(bad)), /tessvm 이 내보낸 파일이 아닙니다/);
  }
  const strange = structuredClone(LEGACY);
  strange.data.data[0].rows[0].$types = { 'values.a': 'date' };
  await assert.rejects(api.importAll(blob(strange)), /읽을 수 없는 값/);
});
