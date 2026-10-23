import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, verifyEntryProject } from '@entropy/compiler';
import { decompileProject } from '@entropy/decompiler';
import { Vm } from '@entropy/vm';

function build(source: string) {
  const result = compileProject(source);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(verifyEntryProject(result.project!), []);
  return result.project!;
}

function execute(project: ReturnType<typeof build>, kernel: boolean) {
  const vm = new Vm({ renderer: null, audio: null, kernel });
  vm.load(project as never); vm.start();
  for (let tick = 0; tick < 5000; tick++) vm.tick();
  assert.deepEqual(vm.errors, []);
  assert.deepEqual([...vm.unknownBlocks], []);
  return Object.fromEntries(vm.variables.map(variable => [variable.name, variable.getValue()]));
}

test('string helpers preserve whitespace, empty values and partial padding through native blocks and round trips', () => {
  const whitespace = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  const cases: Array<[string, string]> = [];
  const literal = (value: string) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  for (const value of ['', '0', '001', '한글', ' a b ', whitespace, `${whitespace}x${whitespace}`]) {
    cases.push([`trim(${literal(value)})`, value.trim()],
      [`trim_start(${literal(value)})`, value.trimStart()],
      [`trim_end(${literal(value)})`, value.trimEnd()]);
    for (const count of [0, 1, 2, 5, 8, 17]) {
      cases.push([`repeat_text(${literal(value)}, ${count})`, value.repeat(count)]);
      for (const fill of ['', '0', 'ab', '🙂']) {
        cases.push([`pad_start(${literal(value)}, ${count}, ${literal(fill)})`, value.padStart(count, fill)],
          [`pad_end(${literal(value)}, ${count}, ${literal(fill)})`, value.padEnd(count, fill)]);
      }
    }
  }
  cases.push(['pad_start("x", 3)', '  x'], ['pad_end("x", 3)', 'x  '],
    ['repeat_text("ab", -1)', ''], ['repeat_text("ab", 2.8)', 'abab'],
    ['pad_start("x", -1, "ab")', 'x'], ['pad_end("x", 4.9, "ab")', 'xaba'],
    ['trim(false)', 'false'], ['repeat_text(false, 2)', 'falsefalse'], ['pad_start(false, 7, 0)', '00false']);
  const source = `${cases.map((_, i) => `var result_${i} = "pending"`).join('\n')}
object "o":
  when start do
    ${cases.map(([expression], i) => `result_${i} = ${expression}`).join('\n    ')}
  end
end`;
  const project = build(source);
  assert.equal(project.functions.length, 6, 'one cached native function per helper');
  const roundtrip = build(decompileProject(project as never, [], { inline: true }).source);
  for (const p of [project, roundtrip]) for (const kernel of [false, true]) {
    const result = execute(p, kernel);
    cases.forEach(([expression, expected], i) => assert.equal(result[`result_${i}`], expected, expression));
  }
});

test('string helper calls evaluate arguments once in order and isolate interleaved working state', () => {
  const project = build(`var calls = 0
var first = "pending"
var second = "pending"
var third = "pending"
function next() do
  calls += 1
  return calls
end
object "o":
  when start do
    first = pad_start(next(), next(), next())
    third = repeat_text("xy", 257)
  end
  when start do
    second = pad_start("a", 70, "bc")
  end
end`);
  for (const kernel of [false, true]) {
    const result = execute(project, kernel);
    assert.equal(Number(result.calls), 3);
    assert.equal(result.first, '31');
    assert.equal(result.second, 'a'.padStart(70, 'bc'));
    assert.equal(result.third, 'xy'.repeat(257));
  }
});

test('string helpers report incorrect argument counts at compile time', () => {
  for (const expression of ['trim()', 'trim_start(1, 2)', 'trim_end()', 'repeat_text(1)',
    'pad_start(1)', 'pad_end(1, 2, 3, 4)']) {
    const result = compileProject(`object "o":\n  when start do\n    say ${expression}\n  end\nend`);
    assert.equal(result.ok, false, expression);
    assert.ok(result.errors.some(error => error.message.includes('인자')), expression);
  }
});
