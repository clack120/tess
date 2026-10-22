import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@tess/compiler';
import { decompileProject } from '@tess/decompiler';
import { Vm } from '@tess/vm';

function build(source: string) {
  const result = compileProject(source);
  assert.deepEqual(result.errors, []);
  return result.project!;
}

function run(source: string, roundtrip = false) {
  let project = build(source);
  if (roundtrip) project = build(decompileProject(project as never, [], { inline: true }).source);
  const vm = new Vm({ renderer: null, audio: null, kernel: false });
  vm.load(project as never);
  vm.start();
  for (let tick = 0; tick < 60; tick++) vm.tick();
  assert.deepEqual(vm.errors, []);
  return Object.fromEntries(vm.variables.map(variable => [variable.name, variable.getValue()]));
}

const work = (declarations: string, body: string) => `${declarations}
object "o":
  when start do
    ${body.split('\n').join('\n    ')}
  end
end`;

test('early return leaves nested loops and the caller continues, also after a round trip', () => {
  const source = work(`var out = 0
var after = 0
function f(n) do
  repeat 10:
    if n > 0:
      return n + 1
    end
    after += 100
  end
  return 99
end`, 'out = f(3)\nafter += 1');
  for (const roundtrip of [false, true]) {
    const result = run(source, roundtrip);
    assert.equal(Number(result.out), 4);
    assert.equal(Number(result.after), 1);
  }
});

test('recursive early returns preserve values and do not re-evaluate the return expression', () => {
  const result = run(work(`var out = 0
var calls = 0
function factorial(n) do
  calls += 1
  if n < 2:
    return 1
  end
  return n * factorial(n - 1)
end`, 'out = factorial(5)'));
  assert.equal(Number(result.out), 120);
  assert.equal(Number(result.calls), 5);
});

test('early returns preserve empty strings, booleans and numeric-looking strings', () => {
  for (const [expression, expected] of [['""', ''], ['false', false], ['true', true], ['"001"', '001'], ['0', '0']] as const) {
    const result = run(work(`var out = 9
function f(n) do
  if n > 0:
    return ${expression}
  end
  return 9
end`, 'out = f(1)'));
    assert.equal(result.out, expected);
  }
});

test('a call that reaches the end returns 0 rather than a previous call result', () => {
  const result = run(work(`var out = 9
var first = 0
function f(n) do
  if n > 0:
    return n
  end
end`, 'first = f(7)\nout = f(0)'));
  assert.equal(Number(result.first), 7);
  assert.equal(Number(result.out), 0);
});

test('interleaved calls return their own values after yielding', () => {
  const source = `var first = 0
var second = 0
function f(n) do
  repeat n:
    wait 0
  end
  if n > 0:
    return n
  end
  return 0
end
object "o":
  when start do
    first = f(2)
  end
  when start do
    second = f(5)
  end
end`;
  const result = run(source);
  assert.equal(Number(result.first), 2);
  assert.equal(Number(result.second), 5);
});

test('bare return exits normal functions without swallowing the next line', () => {
  const result = run(work(`var out = 0
function f(n) do
  if n > 0:
    return
    out = 99
  end
  out = 88
end`, 'f(3)\nout += 1'));
  assert.equal(Number(result.out), 1);
});

test('bare return in a value function returns zero', () => {
  const result = run(work(`var out = 9
function f(n) do
  if n > 0:
    return
  end
  return 5
end`, 'out = f(1)'));
  assert.equal(Number(result.out), 0);
});
