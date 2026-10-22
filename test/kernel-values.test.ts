import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@tess/compiler';
import { Vm } from '@tess/vm';

function pair(source: string): [Vm, Vm] {
  const compiled = compileProject(source, { path: 'values.tess' });
  assert.deepEqual(compiled.errors, []);
  assert.ok(compiled.project);
  return [false, true].map((kernel) => {
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(structuredClone(compiled.project) as never); vm.start();
    return vm;
  }) as [Vm, Vm];
}

const values = (vm: Vm) => vm.variables.map((item) =>
  ({ name: item.name, value: item.isList ? item.array.map((cell) => cell.data) : item.value }));
const value = (vm: Vm, name: string) => vm.variables.find((item) => item.name === name)!.value;
function advance(vms: [Vm, Vm], requireKernel = true) {
  for (const vm of vms) vm.tick();
  assert.deepEqual(values(vms[1]), values(vms[0]));
  assert.deepEqual(vms[1].errors, []);
  if (requireKernel) assert.ok(vms[1].kernel!.stats.runs > 0, 'the kernel must execute this case');
}

test('kernel arguments, locals, nested calls and returns preserve numeric-looking text', () => {
  for (const input of ['123', '000123', '1.200', '0.100', '1e2']) {
    const vms = pair(`var output = 0
function inner(value) do
  var local = value
  return local
end
function outer(value) do
  return inner(value)
end
object "actor":
  when start do
    output = outer(${JSON.stringify(input)})
  end
end`);
    advance(vms);
    assert.equal(value(vms[1], 'output'), input);
  }
});

test('judgement and boolean-value function results keep their types through nested arithmetic', () => {
  for (const [expression, expected] of [
    ['check(2)', true], ['check(0)', false], ['check(2) * 5', 0],
    ['check(2) + 5', 6], ['check(0) == 0', false], ['check(0) != 0', false],
    ['boolean_value(check(0))', 'FALSE'],
  ] as const) {
    const vms = pair(`var output = 0
function check(value) do
  return value > 0
end
function outer() do
  return ${expression}
end
object "actor":
  when start do
    output = outer()
  end
end`);
    advance(vms);
    assert.equal(value(vms[1], 'output'), expected, expression);
  }
});

test('kernel scalar and list copies retain numeric strings as strings', () => {
  const vms = pair(`var output = 0
var other = 0
list items = [1, "2", "1e+21"]
function copy(value) do
  items[1] = value
  other = items[2]
  return items[1]
end
object "actor":
  when start do
    output = copy("123")
  end
end`);
  advance(vms);
  assert.equal(value(vms[1], 'output'), '123');
  assert.equal(value(vms[1], 'other'), '2');
  assert.deepEqual(vms[1].variables.find((item) => item.name === 'items')!.array.map((cell) => cell.data), ['123', '2', '1e+21']);
});

test('an unrepresentable list store falls back without prefix writes or stale cached data', () => {
  const vms = pair(`var output = 0
var counter = 0
var input = "0.100"
list items = [1, 2]
function write(value) do
  counter += 1
  items[1] = 7
  items[2] = value
  return items[2]
end
object "actor":
  when start do
    forever do
      output = write(input)
    end
  end
end`);
  advance(vms, false);
  assert.equal(value(vms[1], 'counter'), '1');
  assert.equal(value(vms[1], 'output'), '0.100');
  assert.ok(vms[1].kernel!.stats.fallbacks > 0);
  for (const vm of vms) {
    vm.variables.find((item) => item.name === 'input')!.setValue('2');
    const list = vm.variables.find((item) => item.name === 'items')!;
    list.array[1]!.data = 2; list.touch();
  }
  advance(vms);
  assert.equal(value(vms[1], 'counter'), '2');
  assert.equal(value(vms[1], 'output'), '2');
});

test('raw string zero and numeric zero differ in Entry and/or even inside kernels', () => {
  for (const [initial, expected] of [['0', true], [0, false]] as const) {
    const vms = pair(`var input = ${JSON.stringify(initial)}
var output = 0
function check() do
  return input and true
end
object "actor":
  when start do
    output = check()
  end
end`);
    advance(vms);
    assert.equal(value(vms[1], 'output'), expected);
  }
});

test('literal increments preserve Entry normalization and stored decimal places', () => {
  for (const [current, increment, expected] of [
    [0, '-1.20', '-1.2'], [0, '1.200', '1.2'], [0, '0.100', '0.100'],
    [0, '01.200', '1.200'], [0, '1.2e3', '1200'], [0, '01.2e3', '1200.000'],
    ['0.000', '1.200', '1.200'], ['1.200', '-1.20', '0.000'],
    [0, '1.2e-10', '0.00000'], ['0.00000', 1, '1.00000'], ['1e+21', 1, '1e+21'],
  ] as const) {
    const vms = pair(`var total = ${JSON.stringify(current)}
var output = 0
function change() do
  total += ${JSON.stringify(increment)}
  return total
end
object "actor":
  when start do
    output = change()
  end
end`);
    advance(vms);
    assert.equal(value(vms[1], 'output'), expected, `${current} += ${increment}`);
  }
});

test('NaN and negative zero made inside a kernel are coerced only at numeric slots', () => {
  for (const expression of ['0 / 0', '0 * -1']) {
    const vms = pair(`var x = 0
var sum = 0
var output = 0
function make() do
  x = ${expression}
  sum = x + 1
  return x
end
object "actor":
  when start do
    output = make()
  end
end`);
    advance(vms);
    assert.equal(value(vms[1], 'sum'), 1);
    if (expression === '0 / 0') assert.ok(Number.isNaN(value(vms[1], 'output')));
    else assert.ok(Object.is(value(vms[1], 'output'), -0));
  }
});

test('constant-return calls still run once and list indices run before their stored value', () => {
  const vms = pair(`var counter = 0
var output = 0
list items = [0]
function next() do
  counter += 1
  return 123
end
function write() do
  output = next()
  items[1] = next()
  return output
end
object "actor":
  when start do
    output = write()
  end
end`);
  advance(vms);
  assert.equal(value(vms[1], 'counter'), '2');
  assert.equal(value(vms[1], 'output'), '123');
  assert.deepEqual(vms[1].variables.find((item) => item.name === 'items')!.array.map((cell) => cell.data), ['123']);

  const indexed = pair(`var input = 1
var counter = 0
var output = 0
list items = [0]
function index() do
  input = "0.100"
  counter += 1
  return 1
end
function write() do
  items[index()] = input
  return 0
end
object "actor":
  when start do
    output = write()
  end
end`);
  advance(indexed, false);
  assert.equal(value(indexed[1], 'counter'), '1');
  assert.deepEqual(indexed[1].variables.find((item) => item.name === 'items')!.array.map((cell) => cell.data), ['0.100']);
});
