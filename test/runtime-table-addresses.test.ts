import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm, cellToRowCol } from '@entropy/vm';
import { RuntimeBlockError } from '../packages/vm/src/runtime/diagnostics.ts';

function tableVm() {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [], objects: [], variables: [], messages: [], functions: [],
    tables: [{ id: 't', name: 'table', fields: ['X', 'Y'], data: [[1, 2], [3, 4]] }],
  } as never);
  return vm;
}

test('table addresses retain Entry prefix parsing without trimming', () => {
  for (const [cell, col, row] of [
    ['A1', 1, 0], ['A2text', 1, 1], ['AA2.5', 27, 1], ['A 2', 1, 1],
    ['A1e2', 1, 0], [' A2', 0, NaN], ['A-2', 7, 1], ['A0', 1, -1], ['', 0, NaN],
  ] as const) assert.deepEqual(cellToRowCol(cell), { col, row }, cell);
  const vm = tableVm();
  assert.equal(vm.ops.tableCellValue(0, 'a2text'), 1);
  assert.equal(vm.ops.tableCellValue(0, ' A2'), null);
  assert.equal(vm.ops.tableCellValue(0, 'A1e2'), 'X');
  vm.ops.tableSetCell(0, 'a2text', 9);
  assert.equal(vm.tables[0]!.getValue(1, 1), 9);
});

test('truthy non-text addresses fail with context while falsy inputs become empty addresses', () => {
  const vm = tableVm();
  for (const cell of [0, -0, false, null, undefined, NaN, '']) {
    assert.equal(vm.ops.tableCellValue(0, cell), null);
    vm.ops.tableSetCell(0, cell, 99);
  }
  assert.deepEqual(vm.tables[0]!.rows, [[1, 2], [3, 4]]);
  for (const cell of [1, true, {}, [], ['A2']]) for (const read of [false, true]) {
    assert.throws(() => read ? vm.ops.tableCellValue(0, cell) : vm.ops.tableSetCell(0, cell, 9), error => {
      assert.ok(error instanceof RuntimeBlockError);
      assert.equal(error.blockType, read ? 'get_value_from_cell' : 'set_value_from_cell');
      assert.ok(error.inputs.cell);
      assert.match(error.message, /셀 주소.*A2/);
      return true;
    });
  }
  assert.equal(vm.ops.tableCellValue(0, new String('A2')), 1);
});

test('bad cell addresses stop raw blocks at the parent and retain the failing input', () => {
  for (const kernel of [false, true]) for (const read of [false, true]) {
    const vm = new Vm({ renderer: null, audio: null, kernel });
    const operation = { id: 'bad-address', type: read ? 'get_value_from_cell' : 'set_value_from_cell', params: ['t', 7, 99] };
    vm.load({ scenes: [{ id: 's', name: 's' }], functions: [], messages: [],
      variables: [{ id: 'after', name: 'after', value: 0 }],
      tables: [{ id: 't', name: 'table', fields: ['X'], data: [[1]] }],
      objects: [{ id: 'actor', name: 'actor', scene: 's', entity: {}, script: [[
        { id: 'hat', type: 'when_run_button_click' },
        read ? { id: 'save', type: 'set_variable', params: ['after', operation] } : operation,
        { id: 'after', type: 'set_variable', params: ['after', 1] },
      ]] }],
    } as never);
    vm.onError = () => vm.stop();
    vm.start(); vm.tick();
    const error = vm.errors[0]!;
    assert.equal(error.blockId, 'bad-address');
    assert.equal(error.blockType, operation.type);
    assert.deepEqual(error.inputs!.cell, { type: 'number', value: 7 });
    assert.ok(error.stack); assert.ok(error.snapshot);
    assert.equal(vm.variables[0]!.value, 0);
    assert.equal(vm.state, 'stop');
  }
});
