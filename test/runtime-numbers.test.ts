import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@tess/compiler';
import { Vm, Variable, Table, cast } from '@tess/vm';
import { columnIndex } from '../packages/tessvm/src/runtime/table.ts';

test('numeric text and stored variables follow Entry including exponent edge cases', () => {
  const variable = new Variable('v', 'v', null, 'variable');
  const pattern = /^-?\d+\.?\d*(?:[eE][+-]?\d+)?$/;
  const values: unknown[] = [NaN, Infinity, -Infinity, -0, true, false, null, undefined, {}, [], 1n,
    '', '1\n', '1\r', '1\u2028', '1e309', '1e-999', '1e+2', '-1.E-2', '01e2', '0x10', '.1', ' 1 ', '1.e', '+1'];
  let seed = 1234;
  const alphabet = '0123eE+-. abc\n';
  for (let i = 0; i < 5000; i++) {
    let text = '';
    for (let j = 0; j < i % 12; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    values.push(text);
  }
  for (const value of values) {
    const expected = typeof value === 'number' || typeof value === 'string' && pattern.test(value);
    assert.equal(cast.isNumber(value), expected, String(value));
    variable.setValue(value as never);
    assert.equal(variable.isNumber(), expected, String(value));
  }
});

test('exponent text adds numerically, passes type checks, and selects costume and table positions', () => {
  const compiled = compileProject(`var text = "1e2"
var sum = 0
var delta = 0
var numeric = false
object "actor":
  when start do
    sum = text + 1
    delta += text
    numeric = type(text) == "number"
  end
end`);
  assert.deepEqual(compiled.errors, []);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(compiled.project as never);
  vm.start(); vm.tick();
  const value = (name: string) => vm.variables.find((item) => item.name === name)!.getValue();
  assert.equal(value('sum'), 101);
  assert.equal(value('delta'), '100');
  assert.equal(value('numeric'), true);
  const target = vm.targets[0]!;
  target.pictures = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `picture${i}`,
    fileurl: '', dimension: { width: 1, height: 1 } }));
  assert.equal(target.getPicture('1e1'), target.pictures[9]);
  target.pictures[0]!.name = '1e1';
  assert.equal(target.getPicture('1e1'), target.pictures[0], 'names still take priority over positions');
  assert.equal(columnIndex('1e1'), 10);
  assert.deepEqual(new Table('t', 't', ['v'], [['1e2'], ['-1.2e3'], ['1e-3'], ['.5']]).column(1), [100, -1200, 0.001, 0]);
});

test('changing nonnumeric stored text joins it instead of accepting extra Number syntax', () => {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], objects: [], functions: [], messages: [],
    variables: [{ id: 'v', name: 'v', value: 0 }] } as never);
  const variable = vm.variables[0]!;
  for (const text of ['.5', '+1', ' 1 ', '0x10', 'Infinity', '']) {
    variable.setValue(text);
    vm.ops.changeVariable({ localVars: null } as never, 0, 1);
    assert.equal(variable.getValue(), `${text}1`, text);
  }
});

test('only boolean false is rejected as an increment; zero, true and text keep Entry behavior', () => {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], objects: [], functions: [], messages: [],
    variables: [{ id: 'v', name: 'v', value: '0' }] } as never);
  const entity = { localVars: null } as never;
  assert.throws(() => vm.ops.changeVariable(entity, 0, false), /false/);
  assert.equal(vm.variables[0]!.value, '0');
  for (const [increment, expected] of [[0, '0'], ['0', '0'], [true, '0true'], ['false', '0false'], ['', '0']] as const) {
    vm.variables[0]!.setValue('0');
    vm.ops.changeVariable(entity, 0, increment);
    assert.equal(vm.variables[0]!.value, expected);
  }
});

test('variable increments normalize their value before choosing decimal places as Entry does', () => {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], objects: [], functions: [], messages: [],
    variables: [{ id: 'v', name: 'v', value: 0 }] } as never);
  const variable = vm.variables[0]!;
  for (const [current, increment, expected] of [
    [0, '1.200', '1.2'], [0, '-1.20', '-1.2'], [0, '0.100', '0.100'],
    [0, '01.200', '1.200'], [0, '1.2e3', '1200'], [0, '01.2e3', '1200.000'],
    ['0.000', '1.200', '1.200'], ['1.200', '-1.20', '0.000'],
    [0, '1.2e-10', '0.00000'], ['0.00000', 1, '1.00000'], ['1e+21', 1, '1e+21'],
  ] as const) {
    variable.setValue(current);
    vm.ops.changeVariable({ localVars: null } as never, 0, increment);
    assert.equal(variable.getValue(), expected, `${current} += ${increment}`);
  }
});

test('numeric kernel calls accept finite exponents and leave overflow and underflow faithful', () => {
  for (const [input, expected] of [['1e2', 101], ['-1E-2', 0.99], ['1e21', 1e21], ['1e309', Infinity], ['1e-999', 1]] as const) {
    const compiled = compileProject(`var output = 0
function add_one(value) do
  return value + 1
end
object "actor":
  when start do
    output = add_one(${JSON.stringify(input)})
  end
end`);
    assert.deepEqual(compiled.errors, []);
    for (const kernel of [false, true]) {
      const vm = new Vm({ renderer: null, audio: null, kernel });
      vm.load(compiled.project as never); vm.start(); vm.tick();
      assert.equal(vm.variables.find((item) => item.name === 'output')!.getValue(), expected, `${input}, kernel=${kernel}`);
      assert.deepEqual(vm.errors, []);
      if (kernel && Number.isFinite(Number(input))) assert.ok(vm.kernel!.stats.runs > 0, input);
    }
  }
});
