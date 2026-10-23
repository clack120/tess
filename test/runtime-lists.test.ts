import test from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './stub.ts';
import { compileProject } from '@tess/compiler';
import { Vm } from '@tess/vm';
import { RuntimeBlockError } from '../packages/tessvm/src/runtime/diagnostics.ts';
import { Codegen } from '../packages/tessvm/src/compile/codegen.ts';

const entity = { localVars: null } as never;
function listVm(values: unknown[] = ['A', 'B', 'C']) {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], objects: [], functions: [], messages: [],
    variables: [{ id: 'items', name: 'items', variableType: 'list', array: values.map((data) => ({ data })) }] } as never);
  return vm;
}

test('list reads retain Entry numeric syntax and stop at invalid or missing items', () => {
  const vm = listVm();
  assert.throws(() => vm.ops.listValue(entity, -1, 1), /리스트를 찾을 수 없습니다/);
  for (const index of [0, -1, 1.5, 4, NaN, Infinity, -Infinity, '+1', ' 1 ', '.5', true, false, null, undefined, {}, ['1']]) {
    assert.throws(() => vm.ops.listValue(entity, 0, index), (error) => {
      assert.ok(error instanceof RuntimeBlockError);
      assert.equal(error.blockType, 'value_of_index_from_list');
      assert.deepEqual(error.inputs.length, { type: 'number', value: 3 });
      return true;
    }, String(index));
  }
  for (const [index, expected] of [[1, 'A'], ['1', 'A'], ['1e0', 'A'], ['FIRST', 'A'], ['LAST', 'C']] as const) {
    assert.equal(vm.ops.listValue(entity, 0, index), expected);
  }
  for (const index of [1, 'FIRST', 'LAST', 'RANDOM']) {
    assert.throws(() => listVm([]).ops.listValue(entity, 0, index), RuntimeBlockError);
  }
});

test('a random list index is resolved once', (t) => {
  let calls = 0;
  stub(t, Math, 'random', () => (calls += 1, 0.5));
  assert.equal(listVm().ops.listValue(entity, 0, 'RANDOM'), 'B');
  assert.equal(calls, 1);
});

test('list removal and insertion preserve Entry splice rules for zero, negatives and fractions', () => {
  const values = (vm: Vm) => vm.variables[0]!.array.map((item) => item.data);
  for (const [index, expected] of [
    [0, ['A', 'B']], [-1, ['A', 'C']], [-10, ['B', 'C']],
    [1.5, ['B', 'C']], [NaN, ['B', 'C']], [-Infinity, ['B', 'C']], ['1e0', ['B', 'C']],
  ] as const) {
    const vm = listVm(); vm.ops.listRemove(entity, 0, index);
    assert.deepEqual(values(vm), expected, `remove ${index}`);
  }
  for (const [index, expected] of [
    [-1, ['A', 'X', 'B', 'C']], [-10, ['X', 'A', 'B', 'C']],
    [0.5, ['X', 'A', 'B', 'C']], [1.5, ['X', 'A', 'B', 'C']],
    [NaN, ['X', 'A', 'B', 'C']], [-Infinity, ['X', 'A', 'B', 'C']], [4, ['A', 'B', 'C', 'X']],
  ] as const) {
    const vm = listVm(); vm.ops.listInsert(entity, 0, index, 'X');
    assert.deepEqual(values(vm), expected, `insert ${index}`);
  }
});

test('invalid list mutations report their index and value without changing the list', () => {
  const operations = [
    ['remove_value_from_list', (vm: Vm, index: unknown) => vm.ops.listRemove(entity, 0, index), [4]],
    ['insert_value_to_list', (vm: Vm, index: unknown) => vm.ops.listInsert(entity, 0, index, 'X'), [0, 5]],
    ['change_value_list_index', (vm: Vm, index: unknown) => vm.ops.listReplace(entity, 0, index, 'X'), [0, -1, 1.5, 4, NaN, -Infinity]],
  ] as const;
  for (const [type, run, invalid] of operations) {
    for (const index of [...invalid, '+1', ' 1 ', '.5', 'FIRST', 'LAST', 'RANDOM', true, false, null, undefined, {}, Infinity]) {
      const vm = listVm();
      assert.throws(() => run(vm, index), (error) => {
        assert.ok(error instanceof RuntimeBlockError);
        assert.equal(error.blockType, type);
        assert.deepEqual(error.inputs.length, { type: 'number', value: 3 });
        if (type !== 'remove_value_from_list') assert.deepEqual(error.inputs.value,
          { type: 'string', value: 'X', length: 1, truncated: false });
        return true;
      }, `${type}, ${index}`);
      assert.deepEqual(vm.variables[0]!.array.map((item) => item.data), ['A', 'B', 'C']);
    }
  }
});

test('only list membership treats an unknown list as absent', () => {
  const vm = listVm();
  assert.equal(vm.ops.listIncludes(entity, -1, 'X'), false);
  for (const run of [
    () => vm.ops.listLength(entity, -1), () => vm.ops.listAppend(entity, -1, 'X'),
    () => vm.ops.listRemove(entity, -1, 1), () => vm.ops.listInsert(entity, -1, 1, 'X'),
    () => vm.ops.listReplace(entity, -1, 1, 'X'),
  ]) assert.throws(run, RuntimeBlockError);
});

test('list insertion evaluates data before its index, including across a yielded frame', () => {
  for (const wait of ['', 'wait 0']) for (const kernel of [false, true]) {
    const compiled = compileProject(`var order = ""
var after = 0
list items = ["A", "B"]
function data() do
  order = order + "D"
  ${wait}
  return "X"
end
function position() do
  order = order + "I"
  return 1
end
object "actor":
  when start do
    in items insert data() at position()
    in items insert data() at position()
    after = 1
  end
end`);
    assert.deepEqual(compiled.errors, []);
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(compiled.project as never); vm.start();
    for (let frame = 0; frame < 10; frame++) vm.tick();
    assert.deepEqual(vm.errors, []);
    assert.equal(vm.variables.find((item) => item.name === 'order')!.value, 'DIDI');
    assert.equal(vm.variables.find((item) => item.name === 'after')!.value, '1');
    assert.deepEqual(vm.variables.find((item) => item.name === 'items')!.array.map((item) => item.data), ['X', 'X', 'A', 'B']);
  }
});

test('failed insertion inputs retain the correct evaluation order and error context', () => {
  for (const failure of ['data', 'index']) for (const kernel of [false, true]) {
    const compiled = compileProject(`var calls = 0
var after = 0
list items = ["A", "B"]
function data() do
  return ${failure === 'data' ? '"ABC"[4]' : '"X"'}
end
function position() do
  calls += 1
  return 4
end
object "actor":
  when start do
    in items insert data() at position()
    after = 1
  end
end`);
    assert.deepEqual(compiled.errors, []);
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(compiled.project as never); vm.onError = () => vm.stop(); vm.start(); vm.tick();
    assert.equal(vm.errors.length, 1);
    assert.equal(vm.errors[0]!.blockType, failure === 'data' ? 'char_at' : 'insert_value_to_list');
    assert.deepEqual(vm.errors[0]!.inputs!.index, failure === 'data' ? { type: 'number', value: 4 }
      : { type: 'string', value: '4', length: 1, truncated: false });
    if (failure === 'index') assert.deepEqual(vm.errors[0]!.inputs!.value,
      { type: 'string', value: 'X', length: 1, truncated: false });
    assert.ok(vm.errors[0]!.stack); assert.ok(vm.errors[0]!.snapshot);
    assert.equal(vm.variables.find((item) => item.name === 'calls')!.value, failure === 'data' ? 0 : '1');
    assert.equal(vm.variables.find((item) => item.name === 'after')!.value, 0);
    assert.deepEqual(vm.variables.find((item) => item.name === 'items')!.array.map((item) => item.data), ['A', 'B']);
  }
});

test('invalid kernel list stores retain evaluated data and discard speculative prefix writes', () => {
  for (const index of [0, -1, 1.5, 3]) for (const kernel of [false, true]) {
    const compiled = compileProject(`var index = ${index}
var calls = 0
var after = 0
var output = 99
list items = [10, 20]
function data() do
  calls += 1
  return 7
end
function write() do
  calls += 1
  items[1] = 15
  items[index] = data()
  return 0
end
object "actor":
  when start do
    output = write()
    after = 1
  end
end`);
    assert.deepEqual(compiled.errors, []);
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(compiled.project as never); vm.onError = () => vm.stop(); vm.start(); vm.tick();
    assert.equal(vm.errors.length, 1, `${index}, kernel=${kernel}`);
    const error = vm.errors[0]!;
    assert.equal(error.blockType, 'change_value_list_index');
    assert.deepEqual(error.inputs!.index, { type: 'number', value: index });
    assert.deepEqual(error.inputs!.value, { type: 'string', value: '7', length: 1, truncated: false });
    assert.equal(vm.variables.find((item) => item.name === 'calls')!.value, '2');
    assert.equal(vm.variables.find((item) => item.name === 'after')!.value, 0);
    assert.equal(vm.variables.find((item) => item.name === 'output')!.value, 99);
    assert.deepEqual(vm.variables.find((item) => item.name === 'items')!.array.map((item) => item.data), ['15', 20]);
    if (kernel) assert.ok(vm.kernel!.stats.fallbacks > 0);
  }
});

test('invalid kernel list reads fall back to a detailed error without repeating prefix calls', () => {
  for (const index of [0, -1, 1.5, 3]) for (const kernel of [false, true]) {
    const compiled = compileProject(`var index = ${index}
var calls = 0
var output = 99
var after = 0
list items = [10, 20]
function position() do
  calls += 1
  return index
end
function read() do
  calls += 1
  return items[position()]
end
object "actor":
  when start do
    output = read()
    after = 1
  end
end`);
    assert.deepEqual(compiled.errors, []);
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(compiled.project as never); vm.onError = () => vm.stop(); vm.start(); vm.tick();
    assert.equal(vm.errors.length, 1, `${index}, kernel=${kernel}`);
    const error = vm.errors[0]!;
    assert.equal(error.blockType, 'value_of_index_from_list');
    assert.deepEqual(error.inputs!.index, { type: 'number', value: index });
    assert.deepEqual(error.inputs!.length, { type: 'number', value: 2 });
    assert.ok(error.blockId); assert.ok(error.stack); assert.ok(error.snapshot);
    const value = (name: string) => vm.variables.find((item) => item.name === name)!.value;
    assert.equal(value('calls'), '2'); assert.equal(value('output'), 99); assert.equal(value('after'), 0);
    if (kernel) assert.ok(vm.kernel!.stats.fallbacks > 0);
  }
});

test('kernels cannot convert nonnumeric literal or judgement list indices into valid positions', () => {
  for (const index of ['true', '"+1"', '" 1 "']) {
    const compiled = compileProject(`var output = 99
list items = [10, 20]
function read() do
  return items[${index}]
end
object "actor":
  when start do
    output = read()
  end
end`);
    assert.deepEqual(compiled.errors, []);
    const vm = new Vm({ renderer: null, audio: null, kernel: true });
    vm.load(compiled.project as never); vm.start(); vm.tick();
    assert.equal(vm.errors.length, 1, index);
    assert.equal(vm.errors[0]!.blockType, 'value_of_index_from_list');
  }
});

test('typed numbers and shared lists compile to direct reads without changing results', () => {
  const num = (value: string) => ({ type: 'number', params: [value] });
  const item = (list: string, index: string) => ({ type: 'value_of_index_from_list', params: [null, list, null, num(index)] });
  const plus = (left: unknown, right: unknown) => ({ type: 'calc_basic', params: [left, 'PLUS', right] });
  const set = (id: string, value: unknown) => ({ type: 'set_variable', params: [id, value] });
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({
    scenes: [{ id: 's', name: 's' }], functions: [], messages: [],
    variables: [
      { id: 'shared', name: 'shared', variableType: 'list', array: [{ data: 'A' }, { data: 'B' }, { data: 'C' }] },
      { id: 'own', name: 'own', variableType: 'list', object: 'o', array: [{ data: 'x' }, { data: 'y' }] },
      { id: 'joined', name: 'joined', variableType: 'variable', value: 0 },
      { id: 'sum', name: 'sum', variableType: 'variable', value: 0 },
      { id: 'kept', name: 'kept', variableType: 'variable', value: 0 },
      { id: 'local', name: 'local', variableType: 'variable', value: 0 },
    ],
    objects: [{
      id: 'o', name: 'o', scene: 's', objectType: 'sprite', entity: { x: 0, y: 0 }, sprite: { pictures: [], sounds: [] },
      script: JSON.stringify([[{ type: 'when_run_button_click' },
        { type: 'change_value_list_index', params: ['shared', num('2'), { type: 'text', params: ['Z'] }] },
        set('joined', plus(item('shared', '2'), num('1'))),
        set('sum', plus(num('1'), num('2'))),
        set('kept', plus(num('007'), { type: 'text', params: ['a'] })),
        set('local', item('own', '2'))]]),
    }],
  } as never);
  const source = new Codegen((vm as never as { compileInput: never }).compileInput).compile().source;
  assert.match(source, /O\.listSet\(V\[0\], 2, "Z"\)/);
  assert.match(source, /O\.listItem\(V\[0\], 2\)/);
  assert.match(source, /C\.calcPlus\(1, 2\)/);
  assert.match(source, /C\.calcPlus\("007", "a"\)/, 'text that does not read back unchanged stays text');
  assert.match(source, /O\.listValue\(e, 1, 2\)/, 'object lists still resolve per entity');
  vm.start();
  vm.tick();
  assert.deepEqual(vm.errors, []);
  const value = (name: string) => vm.variables.find((variable) => variable.name === name)!.getValue();
  assert.deepEqual([value('joined'), value('sum'), value('kept'), value('local')], ['Z1', 3, '7a', 'y']);
});
