import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, Vm } from '@tess/vm';
import type { RawBlock } from '../packages/tessvm/src/compile/codegen.ts';

const initial = () => Table.from({ id: 't', name: 'table', fields: ['X', 'Y'], data: [[1, 2], [3, 4]] });

test('table row edits include the field-name row and fill new data with zero', () => {
  const appended = initial();
  appended.appendRow();
  assert.deepEqual(appended.rows, [[1, 2], [3, 4], [0, 0]]);
  for (const [index, fields, rows] of [
    [0, [0, 0], [['X', 'Y'], [1, 2], [3, 4]]],
    [1, ['X', 'Y'], [[0, 0], [1, 2], [3, 4]]],
    [2, ['X', 'Y'], [[1, 2], [0, 0], [3, 4]]],
    [-1, ['X', 'Y'], [[0, 0], [1, 2], [3, 4]]],
    [100, ['X', 'Y'], [[1, 2], [3, 4], [0, 0]]],
  ] as const) {
    const table = initial();
    table.insertRow(index);
    assert.deepEqual(table.fields, fields);
    assert.deepEqual(table.rows, rows);
  }
  for (const [index, fields, rows] of [
    [0, [1, 2], [[3, 4]]], [1, ['X', 'Y'], [[3, 4]]], [2, ['X', 'Y'], [[1, 2]]],
    [-1, ['X', 'Y'], [[1, 2], [3, 4]]], [100, ['X', 'Y'], [[1, 2], [3, 4]]],
  ] as const) {
    const table = initial();
    table.deleteRow(index);
    assert.deepEqual(table.fields, fields);
    assert.deepEqual(table.rows, rows);
  }
});

test('numeric field names retain their values and reset after row edits', () => {
  const table = Table.from({ id: 't', fields: [0, 2], data: [[3, 4]] });
  assert.equal(table.getValue(0, 1), 0);
  table.insertRow(0);
  assert.deepEqual(table.rows, [[0, 2], [3, 4]]);
  table.deleteRow(0);
  table.replaceValue(0, 1, 99);
  table.reset();
  assert.deepEqual(table.fields, [0, 2]);
  assert.deepEqual(table.rows, [[3, 4]]);
});

test('raw row-edit blocks use Entry row numbers and retain promoted field values', async () => {
  for (const kernel of [false, true]) {
    const block = (type: string, params: unknown[] = []): RawBlock => ({ id: type, type, params });
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load({ scenes: [{ id: 's', name: 's' }], messages: [], functions: [],
      variables: [{ id: 'out', name: 'out', value: 0 }],
      tables: [{ id: 't', name: 'table', fields: ['X', 'Y'], data: [[1, 2], [3, 4]] }],
      objects: [{ id: 'actor', name: 'actor', scene: 's', entity: {}, script: [[
        block('when_run_button_click'), block('insert_row_to_table', ['t', 2, 'ROW']),
        block('delete_row_from_table', ['t', 1, 'ROW']),
        block('set_variable', ['out', block('get_value_from_table', ['t', 1, 1])]),
      ]] }],
    } as never);
    vm.start();
    for (let i = 0; i < 5; i++) { vm.tick(); await Promise.resolve(); }
    assert.deepEqual(vm.errors, []);
    assert.deepEqual(vm.tables[0]!.fields, [0, 0]);
    assert.deepEqual(vm.tables[0]!.rows, [[1, 2], [3, 4]]);
    assert.equal(vm.variables[0]!.value, 0);
    vm.stop(); vm.start();
    assert.deepEqual(vm.tables[0]!.fields, ['X', 'Y']);
  }
});

test('column edits fill zero, preserve splice positions, and choose Entry names', () => {
  const table = initial();
  table.appendCol();
  assert.deepEqual(table.fields, ['X', 'Y', '새로운 열']);
  assert.deepEqual(table.rows, [[1, 2, 0], [3, 4, 0]]);
  table.insertCol(2);
  assert.deepEqual(table.fields, ['X', '새로운 열1', 'Y', '새로운 열']);
  assert.deepEqual(table.rows, [[1, 0, 2, 0], [3, 0, 4, 0]]);
  table.deleteCol(-1);
  assert.deepEqual(table.fields, ['X', '새로운 열1', '새로운 열']);
  table.deleteCol(0);
  assert.equal(table.fields.length, 3);
  const gaps = Table.from({ fields: ['새로운 열', '새로운 열3', 1], data: [[1, 2, 3]] });
  gaps.appendCol();
  assert.equal(gaps.fields[3], '새로운 열4');
  const lines = Table.from({ fields: ['새로운 열1\n', '새로운 열2\n', `새로운 열${'9'.repeat(10000)}X`] });
  lines.appendCol();
  assert.equal(lines.fields[3], '새로운 열');
});

test('invalid column insertion reports the original table and allowed range without mutating', () => {
  for (const index of [0, -1, 4, Infinity]) {
    const table = initial();
    assert.throws(() => table.insertCol(index), /열 삽입 위치.*1.*3/);
    assert.deepEqual(table.fields, ['X', 'Y']);
    assert.deepEqual(table.rows, [[1, 2], [3, 4]]);
    assert.equal(table.revision, 0);
  }
});

test('column edits update live chart references and reset restores the saved chart', () => {
  const source = { fields: ['X', 'Y'], data: [[1, 2]], chart: [
    { type: 'bar', title: 'chart', xIndex: 0, yIndex: 1, categoryIndexes: [0, 1] },
  ] };
  const table = Table.from(source);
  table.insertCol(1);
  assert.deepEqual(table.charts[0], { ...source.chart[0], yIndex: 2, categoryIndexes: [0, 2] });
  table.deleteCol(1);
  assert.deepEqual(table.charts[0], source.chart[0]);
  table.deleteCol(1);
  assert.deepEqual(table.charts[0], { ...source.chart[0], yIndex: -1, categoryIndexes: [] });
  table.reset();
  assert.deepEqual(table.charts, source.chart);
  assert.deepEqual(table.fields, source.fields);
  table.charts.at(0)!.categoryIndexes.push(99);
  table.reset();
  assert.deepEqual(table.charts, source.chart);
});

test('the VM uses the host Entry column label and its largest existing suffix', () => {
  const vm = new Vm({ renderer: null, audio: null, tableColumnName: 'New column' });
  vm.load({ scenes: [], objects: [], variables: [], functions: [], messages: [],
    tables: [{ id: 't', fields: ['New column', 'New column3', 'New column001'], data: [[1, 2, 3]] }],
  } as never);
  vm.ops.tableAppend(0, 'COL').next();
  vm.ops.tableInsert(0, 1, 'COL').next();
  assert.deepEqual(vm.tables[0]!.fields, ['New column5', 'New column', 'New column3', 'New column001', 'New column4']);
  assert.deepEqual(vm.tables[0]!.rows, [[0, 1, 2, 3, 0]]);
});

test('invalid column insertion rejects asynchronously with its original block and inputs', async () => {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], variables: [{ id: 'after', name: 'after', value: 0 }], functions: [], messages: [],
    tables: [{ id: 't', name: 'table', fields: ['X'], data: [[1]] }],
    objects: [{ id: 'actor', name: 'actor', scene: 's', entity: {}, script: [[
      { id: 'hat', type: 'when_run_button_click' },
      { id: 'invalid-insert', type: 'insert_row_to_table', params: ['t', 0, 'COL'] },
      { id: 'after', type: 'set_variable', params: ['after', 1] },
    ]] }],
  } as never);
  vm.onError = () => vm.stop();
  vm.start(); vm.tick();
  assert.equal(vm.errors.length, 0);
  for (let i = 0; i < 3; i++) { await Promise.resolve(); vm.tick(); }
  assert.equal(vm.errors[0]!.blockId, 'invalid-insert');
  assert.equal(vm.errors[0]!.inputs!.position!.type, 'number');
  assert.equal((vm.errors[0]!.inputs!.position as { value: number }).value, 0);
  assert.equal(vm.variables[0]!.value, 0);
});
