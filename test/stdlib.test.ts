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

test('numeric min/max and string prefix/suffix predicates work through Entry blocks and round trips', () => {
  const expressions: Array<[string, string | number | boolean]> = [
    ['min(7, 3)', 3], ['max(-7, -3)', -3], ['min(0, 0)', 0],
    ['min("10", "2")', 2], ['max("10", "2")', 10],
    ['starts_with("foobar", "foo")', true], ['starts_with("foobar", "bar")', false],
    ['ends_with("foobar", "bar")', true], ['ends_with("foobar", "foo")', false],
    ['starts_with("001", "1")', false], ['ends_with("001", "01")', true],
    ['starts_with("", "")', true], ['ends_with("", "")', true],
    ['starts_with("a", "abc")', false], ['ends_with("a", "abc")', false],
    ['starts_with("한글문자", "한글")', true], ['ends_with("한글문자", "문자")', true],
  ];
  const source = `${expressions.map((_, i) => `var result_${i} = 0`).join('\n')}
object "o":
  when start do
    ${expressions.map(([expr], i) => `result_${i} = ${expr}`).join('\n    ')}
  end
end`;
  const project = build(source);
  assert.equal(project.functions.length, 2, 'one cached helper per min/max operation');
  const back = build(decompileProject(project as never, [], { inline: true }).source);
  for (const p of [project, back]) for (const kernel of [false, true]) {
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(p as never); vm.start(); vm.tick();
    assert.deepEqual(vm.errors, []);
    assert.deepEqual([...vm.unknownBlocks], []);
    expressions.forEach(([, expected], i) => {
      const value = vm.variables.find(variable => variable.name === `result_${i}`)!.getValue();
      assert.equal(value, expected, expressions[i]![0]);
    });
  }
});

test('min/max evaluate effectful arguments exactly once and in source order', () => {
  const project = build(`var calls = 0
var out = 0
function next() do
  calls += 1
  return calls
end
object "o":
  when start do
    out = min(next(), next()) + max(next(), next())
  end
end`);
  const vm = new Vm({ renderer: null, audio: null, kernel: false });
  vm.load(project as never); vm.start(); vm.tick();
  assert.deepEqual(vm.errors, []);
  assert.equal(Number(vm.variables.find(variable => variable.name === 'calls')!.getValue()), 4);
  assert.equal(Number(vm.variables.find(variable => variable.name === 'out')!.getValue()), 5);
});

test('new helpers diagnose wrong argument counts', () => {
  for (const expression of ['min(1)', 'max(1, 2, 3)', 'starts_with("a")', 'ends_with("a")']) {
    const result = compileProject(`object "o":\n  when start do\n    say ${expression}\n  end\nend`);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.message.includes('인자가 2개')));
  }
});
