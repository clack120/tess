import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@entropy/compiler';
import { decompileProject } from '@entropy/decompiler';
import { Vm } from '@entropy/vm';

test('strings, call results, parenthesized values and list items support chained indexing', () => {
  const source = `var literal = 0
var called = 0
var grouped = 0
var chained = 0
list items = ["abc"]
function text() do
  return "xyz"
end
object "o":
  when start do
    literal = "abc"[2]
    called = text()[3]
    grouped = (join("a", "b"))[2]
    chained = items[1][2][1]
  end
end`;
  const build = (source: string) => {
    const result = compileProject(source);
    assert.deepEqual(result.errors, []);
    return result.project!;
  };
  const project = build(source);
  for (const p of [project, build(decompileProject(project as never, [], { inline: true }).source)]) {
    const vm = new Vm({ renderer: null, audio: null, kernel: false });
    vm.load(p as never); vm.start(); vm.tick();
    assert.deepEqual(vm.errors, []);
    for (const [name, expected] of [['literal', 'b'], ['called', 'z'], ['grouped', 'b'], ['chained', 'b']]) {
      assert.equal(vm.variables.find(variable => variable.name === name)!.getValue(), expected);
    }
  }
});
