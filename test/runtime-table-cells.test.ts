import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, Vm } from '@entropy/vm';

function tableVm(value: unknown, header = false) {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [], objects: [], variables: [], functions: [], messages: [],
    tables: [{ id: 't', name: 'table', fields: header ? [value, 'Y'] : ['X', 'Y'], data: [[header ? 123 : value, 'needle']] }],
  } as never);
  return vm;
}

const cases: Array<[unknown, boolean, unknown]> = [
  [0, true, 0], [-0, true, -0], [null, true, null],
  [false, false, null], ['', false, null], [undefined, false, null], [NaN, false, null],
  [true, true, true], ['false', true, 'false'], [[], true, []], [[0], true, [0]],
];

test('table reporters retain Entry cell existence rules without changing raw stored values', () => {
  for (const [value, exists, expected] of cases) for (const header of [false, true]) {
    const vm = tableVm(value, header);
    const row = header ? 1 : 2;
    const table = vm.tables[0]!;
    assert.deepEqual(table.getValue(row - 1, 1), value);
    assert.equal(table.isExist(row - 1, 1), exists);
    assert.deepEqual(vm.ops.tableValue(0, row, 1), expected);
    assert.deepEqual(vm.ops.tableCellValue(0, `A${row}`), expected);
    if (!header) assert.deepEqual(vm.ops.tableLastValue(0, 1), expected);
    assert.deepEqual(vm.ops.tableLookup(0, 2, header ? 'Y' : 'needle', 1), expected);
  }
  const missing = tableVm(0).tables[0]!;
  assert.equal(missing.getValue(2, 1), undefined);
  assert.equal(missing.isExist(2, 1), false);
});

test('table write blocks change null and zero cells while leaving false and empty cells alone', () => {
  for (const [value, exists] of cases) for (const header of [false, true]) for (const cell of [false, true]) {
    const vm = tableVm(value, header);
    const row = header ? 1 : 2;
    if (cell) vm.ops.tableSetCell(0, `A${row}`, 'changed');
    else vm.ops.tableSet(0, row, 1, 'changed');
    assert.deepEqual(vm.tables[0]!.getValue(row - 1, 1), exists ? 'changed' : value);
  }
  const vm = tableVm(0);
  vm.ops.tableSet(0, 3, 1, 'changed');
  vm.ops.tableSetCell(0, 'A3', 'changed');
  assert.deepEqual(vm.tables[0]!.rows, [[0, 'needle']]);
});

test('lookup compares raw cells and filters only the first matching return cell', () => {
  const vm = tableVm(false);
  vm.tables[0] = new Table('t', 'table', ['key', 'value'], [[false, 'first'], [0, 'second'], ['', 'third']]);
  assert.equal(vm.ops.tableLookup(0, 1, false, 2), 'first');
  vm.tables[0] = new Table('t', 'table', ['key', 'value'], [['wanted', false], ['wanted', 99]]);
  assert.equal(vm.ops.tableLookup(0, 1, 'wanted', 2), null);
  vm.tables[0] = new Table('t', 'table', ['wanted', 0], [['wanted', 99]]);
  assert.equal(vm.ops.tableLookup(0, 1, 'wanted', 2), 0);
});

test('raw cell read, write, and lookup blocks preserve falsy values with either kernel setting', () => {
  for (const kernel of [false, true]) {
    let next = 0;
    const block = (type: string, params: unknown[] = []) => ({ id: `b-${next++}`, type, params });
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load({ scenes: [{ id: 's', name: 's' }], functions: [], messages: [],
      variables: ['read', 'lookup', 'last'].map(id => ({ id, name: id, value: -1 })),
      tables: [{ id: 't', name: 'table', fields: ['X', 'Y'], data: [[false, 'needle'], [null, 'other'], [0, 'last']] }],
      objects: [{ id: 'actor', name: 'actor', scene: 's', entity: {}, script: [[
        block('when_run_button_click'),
        block('set_variable', ['read', block('get_value_from_cell', ['t', 'A2'])]),
        block('set_value_from_table', ['t', 2, 1, 'skipped']),
        block('set_value_from_cell', ['t', 'A3', 'changed']),
        block('set_variable', ['lookup', block('get_value_v_lookup', ['t', 2, 'needle', 1])]),
        block('set_variable', ['last', block('get_value_from_last_row', ['t', 1])]),
      ]] }],
    } as never);
    vm.start(); vm.tick();
    assert.deepEqual(vm.errors, []);
    assert.deepEqual(vm.variables.map(variable => variable.value), [null, null, 0]);
    assert.deepEqual(vm.tables[0]!.rows, [[false, 'needle'], ['changed', 'other'], [0, 'last']]);
  }
});
