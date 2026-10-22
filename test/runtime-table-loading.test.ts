import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, Vm } from '@tess/vm';

function tableVm(data: unknown[]) {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], objects: [], variables: [], functions: [], messages: [],
    tables: [{ id: 't', fields: ['A', 'B'], data }],
  } as never);
  return vm;
}

test('table loading reads data and ignores a stale or orphaned origin', () => {
  for (const data of [undefined, [], [['7']]]) {
    const table = Table.from({ fields: ['A'], data, origin: [[99]] });
    assert.deepEqual(table.rows, data?.length ? [[7]] : []);
    table.reset();
    assert.deepEqual(table.rows, data?.length ? [[7]] : []);
  }
});

test('array rows are padded or truncated while keyed rows keep their loaded length', () => {
  const data = [['1'], ['2', '3', '4'], [], { key: 'r', value: ['5', '6', '7'] }];
  const vm = tableVm(data);
  const table = vm.tables[0]!;
  const loaded = [[1, 0], [2, 3], [0, 0], [5, 6, 7]];
  assert.deepEqual(table.rows, loaded);
  vm.start();
  assert.deepEqual(table.rows, loaded);
  vm.pause(); vm.start();
  assert.deepEqual(table.rows, loaded);
  vm.stop();
  const stopped = [[1, 0], [2, 3], [0, 0], [5, 6]];
  assert.deepEqual(table.rows, stopped);
  vm.start();
  assert.deepEqual(table.rows, stopped);
  assert.deepEqual(data, [['1'], ['2', '3', '4'], [], { key: 'r', value: ['5', '6', '7'] }]);
});

test('reset restores independent nested cell values before converting and sizing the rows', () => {
  const vm = tableVm([{ key: 'r', value: [['1', { x: 2 }], '3', '4'] }]);
  const table = vm.tables[0]!;
  vm.start();
  (table.rows[0]![0] as unknown[]).push(8);
  ((table.rows[0]![0] as unknown[])[1] as { x: number }).x = 8;
  vm.stop();
  assert.deepEqual(table.rows, [[[1, { x: 2 }], 3]]);
  (table.rows[0]![0] as unknown[]).push(9);
  table.reset();
  assert.deepEqual(table.rows, [[[1, { x: 2 }], 3]]);
});

test('raw table reads and writes use padded cells and retain keyed overflow until stop', () => {
  for (const kernel of [false, true]) {
    const block = (type: string, params: unknown[] = []) => ({ type, params });
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load({ scenes: [{ id: 's', name: 's' }], functions: [], messages: [],
      variables: ['padded', 'overflow', 'keyed'].map(id => ({ id, name: id, value: -1 })),
      tables: [{ id: 't', fields: ['A', 'B'], data: [[1], [2, 3, 4], { key: 'r', value: [5, 6, 7] }] }],
      objects: [{ id: 'actor', name: 'actor', scene: 's', entity: {}, script: [[
        block('when_run_button_click'),
        ...[['padded', 'B2'], ['overflow', 'C3'], ['keyed', 'C4']].map(([id, cell]) =>
          block('set_variable', [id, block('get_value_from_cell', ['t', cell])])),
        block('set_value_from_cell', ['t', 'B2', 9]),
      ]] }],
    } as never);
    vm.start(); vm.tick();
    assert.deepEqual(vm.errors, []);
    assert.deepEqual(vm.variables.map(variable => variable.value), [0, null, 7]);
    assert.deepEqual(vm.tables[0]!.rows, [[1, 9], [2, 3], [5, 6, 7]]);
    vm.stop(); vm.start(); vm.tick();
    assert.deepEqual(vm.variables.map(variable => variable.value), [0, null, null]);
  }
});
