import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';
import type { RawBlock, FunctionEntry } from '../packages/vm/src/compile/codegen.ts';

let nextId = 0;
const block = (type: string, params: unknown[] = []): RawBlock => ({ id: `block-${nextId++}`, type, params });
const missingReads: Array<[string, unknown[]]> = [
  ['get_table_count', ['ROW']], ['get_value_from_table', [2, 1]],
  ['get_value_from_last_row', [1]], ['get_value_from_cell', ['A2']],
  ['calc_values_from_table', [1, 'SUM']], ['get_coefficient', [1, 2]],
  ['get_value_v_lookup', [1, 'wanted', 2]],
];
const missingWrites: Array<[string, unknown[]]> = [
  ['append_row_to_table', ['ROW']], ['insert_row_to_table', [1, 'ROW']],
  ['delete_row_from_table', [1, 'ROW']], ['set_value_from_table', [2, 1, 'new']],
  ['set_value_from_cell', ['A2', 'new']],
];

function load(operation: RawBlock, kernel = false, functions: FunctionEntry[] = []) {
  const vm = new Vm({ renderer: null, audio: null, kernel });
  vm.load({ scenes: [{ id: 's', name: 'scene' }], functions, messages: [],
    variables: ['out', 'after', 'argument'].map(id => ({ id, name: id, value: 0 })),
    tables: [{ id: 't', name: 'table', fields: ['X', 'Y'], data: [[1, 2]] }],
    objects: [{ id: 'actor', name: 'actor', scene: 's', entity: {}, script: [[
      block('when_run_button_click'), operation, block('set_variable', ['after', 1]),
    ]] }],
  } as never);
  vm.onError = () => vm.stop();
  vm.start();
  return vm;
}

async function finish(vm: Vm) {
  for (let i = 0; i < 5; i++) { vm.tick(); await Promise.resolve(); }
}

test('missing tables stop reads and edits with the original ID, block, and inputs', async () => {
  for (const kernel of [false, true]) for (const missingId of ['missing-table', '0', '__proto__']) for (const [type, params] of [...missingReads, ...missingWrites]) {
    const operation = block(type, [missingId, ...params]);
    const statement = missingReads.some(([name]) => name === type) ? block('set_variable', ['out', operation]) : operation;
    const vm = load(statement, kernel);
    vm.tick();
    assert.equal(vm.errors.length, ['append_row_to_table', 'insert_row_to_table'].includes(type) ? 0 : 1);
    await finish(vm);
    assert.equal(vm.errors.length, 1, `${type} / kernel=${kernel}`);
    const error = vm.errors[0]!;
    assert.equal(error.blockId, operation.id);
    assert.equal(error.blockType, type);
    assert.match(error.message, /표를 찾을 수 없습니다/);
    assert.equal(error.inputs!.table!.type, 'string');
    assert.equal((error.inputs!.table as { value: string }).value, missingId);
    assert.ok(error.stack); assert.ok(error.snapshot);
    assert.equal(error.context!.targetName, 'actor');
    assert.equal(vm.variables[1]!.value, 0);
    assert.equal(vm.state, 'stop');
    assert.deepEqual(vm.tables[0]!.rows, [[1, 2]]);
  }
});

test('table inputs finish before a missing-table error points at the parent block', async () => {
  const input = block('func_argument');
  const operation = block('get_value_from_table', ['missing-table', input, 1]);
  const fn: FunctionEntry = { id: 'argument', type: 'value', localVariables: [], content: [[
    block('function_create_value', [block('function_field_label', ['argument']), null, null, 2]),
    block('set_variable', ['argument', 1]),
  ]] };
  const vm = load(block('set_variable', ['out', operation]), false, [fn]);
  await finish(vm);
  assert.equal(vm.variables[2]!.value, 1);
  assert.equal(vm.errors[0]!.blockId, operation.id);
  assert.equal(vm.errors[0]!.inputs!.row!.type, 'number');
  assert.equal((vm.errors[0]!.inputs!.row as { value: number }).value, 2);
});

test('table append and insert mutate immediately and await before following blocks', async () => {
  for (const kernel of [false, true]) for (const [type, params] of missingWrites.slice(0, 2)) {
    const vm = load(block(type, ['t', ...params]), kernel);
    vm.tick();
    assert.equal(vm.tables[0]!.rows.length, 2);
    assert.equal(vm.variables[1]!.value, 0);
    await finish(vm);
    assert.equal(vm.variables[1]!.value, 1);
    assert.deepEqual(vm.errors, []);
  }
});

test('opening a missing table or chart keeps Entry nonfatal behavior', async () => {
  for (const type of ['open_table', 'open_table_wait', 'open_table_chart']) {
    const vm = load(block(type, ['missing-table', 1]));
    await finish(vm);
    assert.equal(vm.variables[1]!.value, 1);
    assert.deepEqual(vm.errors, []);
  }
});
