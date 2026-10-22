import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@tess/vm';
import { columnIndex } from '../packages/tessvm/src/runtime/table.ts';
import { RuntimeBlockError } from '../packages/tessvm/src/runtime/diagnostics.ts';

function tableVm() {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [], objects: [], variables: [], functions: [], messages: [],
    tables: [{ id: 't', fields: Array.from({ length: 28 }, (_, i) => `field${i + 1}`),
      data: Array.from({ length: 3 }, (_, i) => Array.from({ length: 28 }, (_, j) => (j + 1) ** (i + 1))) }],
  } as never);
  return vm;
}

test('table column names retain Entry array and non-text handling', () => {
  for (const [input, expected] of [
    ['AB', 28], ['ab', 28], ['1e1', 10], [true, 0], [false, 0], [null, 0], [undefined, 0],
    [[], 0], [['AB'], 1], [['BB'], 2], [['A', 'B'], 0], [[''], NaN], [new String('AB'), 28],
  ] as const) assert.equal(columnIndex(input), expected);
  const vm = tableVm();
  assert.equal(vm.ops.tableValue(0, 2, ['AB']), 1);
  assert.equal(vm.ops.tableLastValue(0, ['BB']), 8);
  assert.equal(vm.ops.tableCalc(0, ['AB'], 'SUM'), 3);
  assert.equal(vm.ops.tableCoefficient(0, ['AB'], 2), 0);
  assert.equal(vm.ops.tableCoefficient(0, 2, ['AB']), 0);
  assert.equal(vm.ops.tableLookup(0, ['AB'], 1, 2), 2);
  assert.equal(vm.ops.tableLookup(0, 2, 2, ['AB']), 1);
  vm.ops.tableSet(0, 2, ['AB'], 99);
  assert.equal(vm.tables[0]!.getValue(1, 1), 99);
  assert.equal(vm.tables[0]!.getValue(1, 28), 28);
});

test('invalid column items fail in every table operation with their input context', () => {
  const vm = tableVm();
  for (const col of [[null], [[]], [['A']]]) {
    assert.throws(() => columnIndex(col), TypeError);
    for (const [type, input, call] of [
      ['set_value_from_table', 'column', () => vm.ops.tableSet(0, 2, col, 99)],
      ['get_value_from_table', 'column', () => vm.ops.tableValue(0, 2, col)],
      ['get_value_from_last_row', 'column', () => vm.ops.tableLastValue(0, col)],
      ['calc_values_from_table', 'column', () => vm.ops.tableCalc(0, col, 'SUM')],
      ['get_coefficient', 'x', () => vm.ops.tableCoefficient(0, col, 2)],
      ['get_coefficient', 'y', () => vm.ops.tableCoefficient(0, 2, col)],
      ['get_value_v_lookup', 'column', () => vm.ops.tableLookup(0, col, 1, 2)],
      ['get_value_v_lookup', 'returnColumn', () => vm.ops.tableLookup(0, 1, 1, col)],
    ] as const) {
      assert.throws(call, error => {
        assert.ok(error instanceof RuntimeBlockError);
        assert.equal(error.blockType, type);
        assert.deepEqual(error.inputs.table, { type: 'string', value: 't', length: 1, truncated: false });
        assert.equal(error.inputs[input]!.type, 'object');
        assert.match(error.message, /열.*A.*1/);
        return true;
      });
    }
    assert.equal(vm.tables[0]!.getValue(1, 1), 1);
  }
});

test('raw table reporters preserve array columns and identify the failing parent', () => {
  for (const kernel of [false, true]) for (const invalid of [false, true]) {
    const child = { id: 'column-value', type: 'get_value_from_cell', params: ['source', 'A2'] };
    const parent = { id: 'read-column', type: 'get_value_from_table', params: ['t', 2, child] };
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load({ scenes: [{ id: 's', name: 's' }], functions: [], messages: [],
      variables: [{ id: 'out', name: 'out', value: -1 }, { id: 'after', name: 'after', value: 0 }],
      tables: [{ id: 't', fields: ['A', 'B'], data: [[11, 22]] },
        { id: 'source', fields: ['column'], data: [[invalid ? [['A']] : ['AB']]] }],
      objects: [{ id: 'actor', name: 'actor', scene: 's', entity: {}, script: [[
        { id: 'hat', type: 'when_run_button_click' },
        { id: 'save', type: 'set_variable', params: ['out', parent] },
        { id: 'after', type: 'set_variable', params: ['after', 1] },
      ]] }],
    } as never);
    vm.onError = () => vm.stop();
    vm.start(); vm.tick();
    assert.deepEqual(vm.variables.map(variable => variable.value), invalid ? [-1, 0] : [11, 1]);
    if (invalid) {
      const error = vm.errors[0]!;
      assert.equal(error.blockId, 'read-column');
      assert.equal(error.blockType, 'get_value_from_table');
      assert.equal(error.inputs!.column!.type, 'object');
      assert.ok(error.stack); assert.ok(error.snapshot);
      assert.equal(vm.state, 'stop');
    } else assert.deepEqual(vm.errors, []);
  }
});
