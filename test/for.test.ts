import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, verifyEntryProject } from '@tess/compiler';
import { decompileProject } from '@tess/decompiler';
import { Vm } from '@tess/vm';

function run(body: string, declarations = '', roundtrip = false) {
  const build = (source: string) => {
    const result = compileProject(source);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(verifyEntryProject(result.project!), []);
    return result.project!;
  };
  let project = build(`var out = 0\n${declarations}\nobject "o":\n  when start do\n${body.split('\n').map(line => `    ${line}`).join('\n')}\n  end\nend`);
  if (roundtrip) project = build(decompileProject(project as never, [], { inline: true }).source);
  const vm = new Vm({ renderer: null, audio: null, kernel: false });
  vm.load(project as never); vm.start();
  for (let i = 0; i < 200; i++) vm.tick();
  assert.deepEqual(vm.errors, []);
  assert.deepEqual([...vm.unknownBlocks], []);
  return Object.fromEntries(vm.variables.filter(v => v.objectId === null).map(v => [v.name, v.getValue()]));
}

test('for ranges include both endpoints and support negative and fractional steps', () => {
  for (const [range, expected] of [['1 to 5', 15], ['5 to 1 step -2', 9], ['1 to 2 step 0.5', 4.5], ['5 to 1', 0], ['1 to 1', 1]] as const) {
    assert.equal(Number(run(`for i from ${range}:\n  out += i\nend`).out), expected);
  }
});

test('continue and skip advance only their own for loop counter', () => {
  for (const flow of ['continue', 'skip']) {
    const result = run(`for i from 1 to 5:
  if i == 3:
    ${flow}
  end
  repeat 2:
    continue
  end
  out += i
end`);
    assert.equal(Number(result.out), 12);
  }
});

test('break leaves a for loop and nested for counters shadow without leaking', () => {
  const result = run(`for i from 1 to 5:
  for i from 1 to 2:
    out += i
  end
  if i == 3:
    break
  end
end
out += i`, 'var i = 100');
  assert.equal(Number(result.out), 109);
  assert.equal(Number(result.i), 100);
});

test('range endpoints are evaluated once in source order', () => {
  const result = run('for i from next() to next():\n  out += i\nend', `var calls = 0
function next() do
  calls += 1
  return calls
end`);
  assert.equal(Number(result.out), 3);
  assert.equal(Number(result.calls), 2);
});

test('function for locals survive recursion and round-trip conversion', () => {
  const declarations = `function f(n) do
  var total = 0
  for i from 1 to n:
    if n > 1:
      total += f(n - 1)
    else:
      total += i
    end
  end
  return total
end`;
  for (const roundtrip of [false, true]) assert.equal(Number(run('out = f(4)', declarations, roundtrip).out), 24);
});

test('event declarations can shadow a counter without resetting its iteration', () => {
  for (const roundtrip of [false, true]) {
    const result = run('for i from 1 to 2:\n  var i = i + 10\n  out += i\nend', '', roundtrip);
    assert.equal(Number(result.out), 23);
  }
});

test('zero steps fail compilation and the counter is invisible after the loop', () => {
  const zero = compileProject('object "o":\n  when start do\n    for i from 1 to 2 step 0:\n    end\n  end\nend');
  assert.equal(zero.ok, false);
  assert.match(zero.errors[0]!.message, /step.*0/);
  const leaked = compileProject('function f() do\n  for i from 1 to 2:\n  end\n  return i\nend');
  assert.equal(leaked.ok, false);
  assert.ok(leaked.errors.some(error => error.message.includes("'i'")));
});
