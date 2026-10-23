import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, verifyEntryProject } from '@entropy/compiler';
import { decompileProject } from '@entropy/decompiler';
import { Vm } from '@entropy/vm';

const work = (body: string, declarations = '') => `var out = 0\n${declarations}\nobject "o":\n  when start do\n${body.split('\n').map(line => `    ${line}`).join('\n')}\n  end\nend`;

function run(source: string, roundtrip = false) {
  const build = (source: string) => {
    const result = compileProject(source);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(verifyEntryProject(result.project!), []);
    return result.project!;
  };
  let project = build(source);
  if (roundtrip) project = build(decompileProject(project as never, [], { inline: true }).source);
  const vm = new Vm({ renderer: null, audio: null, kernel: false });
  vm.load(project as never); vm.start();
  for (let tick = 0; tick < 100; tick++) vm.tick();
  assert.deepEqual(vm.errors, []);
  assert.deepEqual([...vm.unknownBlocks], []);
  return Object.fromEntries(vm.variables.map(variable => [variable.name, variable.getValue()]));
}

test('switch evaluates its selector once and executes only the first matching group', () => {
  const source = work(`switch next():
case 0:
  out = 9
case 1, 2:
  out = 5
default:
  out = 8
end`, `var calls = 0
function next() do
  calls += 1
  return calls
end`);
  for (const roundtrip of [false, true]) {
    const result = run(source, roundtrip);
    assert.equal(Number(result.calls), 1);
    assert.equal(Number(result.out), 5);
  }
});

test('empty branches do not fall through and an absent default does nothing', () => {
  for (const source of [
    work('switch 1:\ncase 1:\ncase 2:\n  out = 8\ndefault:\n  out = 9\nend'),
    work('switch 3:\ncase 1:\n  out = 8\nend'),
    work('switch 3:\nend'),
  ]) assert.equal(Number(run(source).out), 0);
});

test('switch uses Entry equality and preserves empty strings and booleans', () => {
  for (const [selector, expected] of [['""', 1], ['false', 2], ['0', 3], ['true', 4], ['"01"', 5]] as const) {
    const source = work(`switch ${selector}:
case "":
  out = 1
case false:
  out = 2
case 0:
  out = 3
case true:
  out = 4
case 1:
  out = 5
default:
  out = 9
end`);
    assert.equal(Number(run(source).out), expected, selector);
  }
});

test('returns and recursive calls inside branches keep the selected branch', () => {
  const source = work('out = f(5)', `function f(n) do
  switch n:
  case 0, 1:
    return 1
  default:
    return n * f(n - 1)
  end
end`);
  for (const roundtrip of [false, true]) assert.equal(Number(run(source, roundtrip).out), 120);
});

test('switch branches preserve surrounding loop continue and break behavior', () => {
  const source = work(`for i from 1 to 5:
  switch i:
  case 2:
    continue
  case 4:
    break
  default:
    out += i
  end
end`);
  assert.equal(Number(run(source).out), 4);
});

test('case locals are independent and event declarations are registered', () => {
  const source = work(`switch 2:
case 1:
  var first = 10
case 2:
  var second = 20
  out = second
end`);
  assert.equal(Number(run(source).out), 20);
  const duplicate = compileProject(work('out = f(2)', `function f(n) do
  switch n:
  case 1:
    var local = 1
    return local
  default:
    var local = 2
    return local
  end
end`));
  assert.deepEqual(duplicate.errors, []);
  assert.equal(Number(run(work('out = f(2)', `function f(n) do
  switch n:
  case 1:
    var local = 1
    return local
  default:
    var local = 2
    return local
  end
end`)).out), 2);
});

test('nonliteral and duplicate labels have targeted diagnostics and previous source locations', () => {
  const invalid = compileProject(work('switch 1:\ncase next():\nend'));
  const error = invalid.errors.find(item => item.code === 'E0003')!;
  assert.match(error.help!, /if\/else/);
  assert.match(error.detail!, /next\(\)/);
  const duplicate = compileProject(work('switch 1:\ncase "01":\ncase 1:\nend'));
  assert.deepEqual(duplicate.errors, []);
  const warning = duplicate.warnings.find(item => item.code === 'W0002')!;
  assert.match(warning.related![0]!.detail!, /case "01"/);
});
