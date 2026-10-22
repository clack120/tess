import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@tess/vm';
import type { RawBlock } from '../packages/tessvm/src/compile/codegen.ts';

function tableVm(rows: unknown[][]) {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], variables: [], functions: [], messages: [], objects: [],
    tables: [{ id: 't', name: 'table', fields: ['X', 'Y'], data: rows }],
  } as never);
  return vm;
}

test('table statistics include median and use sample standard deviation', () => {
  const vm = tableVm([2, 4, 4, 4, 5, 5, 7, 9].map(value => [value, 0]));
  for (const [calc, expected] of [['SUM', 40], ['AVG', 5], ['MAX', 9], ['MIN', 2], ['MEDIAN', 4.5], ['STDEV', Math.sqrt(32 / 7)]] as const) {
    assert.equal(vm.ops.tableCalc(0, 'A', calc), expected, calc);
  }
  assert.equal(tableVm([[7, 0], [1, 0], [3, 0]]).ops.tableCalc(0, 1, 'MEDIAN'), 3);
  assert.equal(tableVm([[5, 0]]).ops.tableCalc(0, 1, 'MEDIAN'), 5);
  assert.ok(Number.isNaN(tableVm([[5, 0]]).ops.tableCalc(0, 1, 'STDEV')));
  assert.equal(tableVm([]).ops.tableCalc(0, 1, 'STDEV'), 0);
  assert.equal(tableVm([]).ops.tableCalc(0, 1, 'MEDIAN'), 0);
  assert.ok(Object.is(tableVm([[-0, 0]]).ops.tableCalc(0, 1, 'SUM'), -0));
  assert.deepEqual(vm.tables[0]!.rows.map(row => row[0]), [2, 4, 4, 4, 5, 5, 7, 9]);
});

test('table values use Entry numeric conversion on load, edits, and reset', () => {
  const raw = [' +1 ', '0x10', '0b10', '0o10', '1e2', '.5', '', 'bad', 'Infinity', NaN];
  const vm = tableVm(raw.map(value => [value, 0]));
  const table = vm.tables[0]!;
  assert.deepEqual(table.rows.map(row => row[0]), [1, 16, 2, 8, 100, '.5', '', 'bad', 'Infinity', NaN]);
  assert.deepEqual(table.column(1), [1, 16, 2, 8, 100, 0, 0, 0, 0, NaN]);
  assert.ok(Number.isNaN(vm.ops.tableCalc(0, 1, 'SUM')));
  table.replaceValue(1, 1, ' +2 ');
  assert.equal(table.getValue(1, 1), 2);
  table.reset();
  assert.equal(table.getValue(1, 1), 1);
  assert.equal(raw[0], ' +1 ');
});

test('table correlation keeps Entry rounding, text results, invalid values, and zero cases', () => {
  for (const [rows, expected] of [
    [[[1, 2], [2, 3], [3, 5]], '0.98'],
    [[[1, 5], [2, 3], [3, 2]], '-0.98'],
    [[[1, 1], [2, 2], [3, 3]], '1.00'],
    [[[1, 3], [1, 2], [1, 1]], 0],
    [[[1, 'bad'], [2, 2], [3, 3]], 'NaN'],
    [[[1, ''], [2, 2], [3, 3]], '0.98'],
    [[['.5', 1], [1, 2], [2, 4]], '1.00'],
    [[[1000000000001, 1000000000002], [1000000000002, 1000000000003], [1000000000003, 1000000000005]], 0],
    [[[1, 2]], 0], [[], 0],
  ] as const) {
    assert.equal(tableVm(rows as unknown as unknown[][]).ops.tableCoefficient(0, 'A', 'B'), expected);
  }
});

test('correlation reporters convert their text result in numeric input slots', () => {
  for (const kernel of [false, true]) {
    const reporter: RawBlock = { id: 'correlation', type: 'get_coefficient', params: ['t', 1, 2] };
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load({ scenes: [{ id: 's', name: 's' }], functions: [], messages: [],
      variables: [{ id: 'out', name: 'out', value: 0 }],
      tables: [{ id: 't', name: 'table', fields: ['X', 'Y'], data: [[1, 2], [2, 3], [3, 5]] }],
      objects: [{ id: 'actor', name: 'actor', scene: 's', entity: {}, script: [[
        { id: 'hat', type: 'when_run_button_click', params: [] },
        { id: 'save', type: 'set_variable', params: ['out', reporter] },
        { id: 'move', type: 'locate_x', params: [reporter] },
      ]] }],
    } as never);
    vm.start(); vm.tick();
    assert.deepEqual(vm.errors, []);
    assert.equal(vm.variables[0]!.value, '0.98');
    assert.equal(vm.targets[0]!.entity.x, 0.98);
  }
});
