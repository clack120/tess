import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@entropy/compiler';
import { Vm } from '@entropy/vm';

const work = (fn: string) => `var out = 0
${fn}
scene "s":
  object "o":
    when start do
      out = f(3)
    end
  end
end`;

function run(source: string) {
  const result = compileProject(source);
  assert.deepEqual(result.errors, []);
  const vm = new Vm({ renderer: null, audio: null, kernel: false });
  vm.load(result.project! as never);
  vm.start();
  for (let tick = 0; tick < 30; tick++) vm.tick();
  assert.deepEqual(vm.errors, []);
  return vm.variables.find(variable => variable.name === 'out')!.getValue();
}

test('duplicate globals, object declarations and parameters are errors', () => {
  for (const source of [
    'var score = 0\nvar score = 1',
    'var score = 0\nlist score = []',
    'scene "s":\n  object "o":\n    var score = 0\n    var score = 1\n  end\nend',
    'function f(a, a) do\n  return a\nend',
    work('function f(n) do\n  var a = 0\n  var a = 1\n  return a\nend'),
  ]) {
    const result = compileProject(source);
    assert.equal(result.ok, false, source);
    assert.ok(result.errors.some(item => /중복|이미 선언/.test(item.message)), source);
  }
});

test('nested function locals shadow outer locals and parameters without changing them', () => {
  assert.equal(Number(run(work(`function f(n) do
  var value = 1
  if n > 0:
    var value = value + 1
    var n = 9
    value += n
  end
  return value + n
end`))), 4);
});

test('separate branches and repeated block entries get independent local bindings', () => {
  assert.equal(Number(run(work(`function f(n) do
  var total = 0
  repeat n:
    var value = 1
    if total == 0:
      var value = 2
      total += value
    else:
      var value = 3
      total += value
    end
    total += value
  end
  return total
end`))), 11);
});

test('block locals cannot be read after the block ends', () => {
  const result = compileProject(work(`function f(n) do
  if n > 0:
    var hidden = 2
  end
  return hidden
end`));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.message.includes("'hidden'")));
});

test('recursive calls preserve each local and its shadowed inner binding', () => {
  assert.equal(Number(run(work(`function f(n) do
  var value = n
  if n > 0:
    var value = f(n - 1)
    out += value
  end
  return value
end`))), 3);
});
