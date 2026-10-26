import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@entropy/compiler';
import { compareEntryProjects, decompileProject, type RawEntity } from '@entropy/decompiler';
import { Vm } from '@entropy/vm';

function compile(source: string) {
  const result = compileProject(source, { path: 'entry.etp' });
  assert.deepEqual(result.errors, []);
  return result.project!;
}

function roundtrip(project: RawEntity) {
  const result = decompileProject(project, [], { inline: true });
  assert.deepEqual(result.warnings, []);
  return compile(result.source);
}

function run(project: RawEntity) {
  const vm = new Vm({ renderer: null, audio: null, kernel: false });
  vm.load(project as never);
  vm.start();
  for (let tick = 0; tick < 10; tick++) vm.tick();
  assert.deepEqual(vm.errors, []);
  return Object.fromEntries(vm.variables.map(variable => [variable.name, variable.getValue()]));
}

test('character reads of arbitrary expressions evaluate a changing index once after roundtrip', () => {
  for (const text of ['"abc"', 'join("a", "bc")', 'words[1]']) {
    const project = compile(`var calls = 0\nvar result = 0\nlist words = ["abc"]
function next_():
  calls += 1
  return calls
end
object "o":
  when start do
    result = ${text}[next_()]
  end
end`);
    const before = run(project), after = run(roundtrip(project));
    assert.equal(Number(after.calls), 1);
    assert.equal(after.result, 'a');
    assert.deepEqual(after, before);
  }
});

test('fraction keeps Entry decimal behavior and evaluates a changing argument once', () => {
  const project = compile(`var calls = 0\nvar result = 0
function next_():
  calls += 1
  return calls / 10
end
object "o":
  when start do
    result = fraction(next_())
  end
end`);
  const rebuilt = roundtrip(project);
  assert.equal(Number(run(rebuilt).calls), 1);
  assert.deepEqual(run(rebuilt), run(project));
  const script = JSON.parse(rebuilt.objects[0]!.script);
  assert.equal(script[0][1].params[1].params[3], 'unnatural');
});

test('primitive Boolean slots preserve their value instead of becoming zero', () => {
  const project = compile('var result = 0\nobject "o":\n when start do\n result = true\n end\nend');
  const script = JSON.parse(project.objects[0]!.script);
  script[0][1].params[1] = true;
  project.objects[0]!.script = JSON.stringify(script);
  assert.equal(run(roundtrip(project)).result, true);
});

test('raw numeric zero stays false in eager logic instead of becoming the text "0"', () => {
  const project = compile('var result = true\nobject "o":\nwhen start do\nresult = 0 and true\nend\nend');
  for (const value of [0, { type: 'number', params: [0] }, { type: 'text', params: [false] }]) {
    const script = JSON.parse(project.objects[0]!.script);
    script[0][1].params[1].params[0] = value;
    project.objects[0]!.script = JSON.stringify(script);
    assert.equal(run(project).result, false);
    assert.equal(run(roundtrip(project)).result, false);
  }
});

test('UTF-8 source files retain lone surrogate data and long non-BMP identifiers', () => {
  const value = '\ud800\udc01\ud800\n\u0000\udfff\u2028';
  const original = compile('var text_ = ""\nobject "o":\nend');
  original.variables[0]!.value = value;
  original.variables[0]!.name = 'a' + '𐐀'.repeat(40);
  const result = decompileProject(original, [], { inline: true });
  const disk = new TextDecoder().decode(new TextEncoder().encode(result.source));
  const rebuilt = compile(disk);
  assert.equal(rebuilt.variables[0]!.value, value);
  assert.equal(rebuilt.variables[0]!.name, original.variables[0]!.name);
});

test('function-local Boolean initializers retain their saved type', () => {
  const original = compile('function f():\n var flag = false\n stop\n return flag\nend');
  assert.equal(original.functions[0]!.localVariables[0]!.value, false);
  assert.equal(roundtrip(original).functions[0]!.localVariables[0]!.value, false);
});

test('Entry character classifiers retain Korean and English behavior through roundtrip', () => {
  const project = compile(`var korean = false\nvar english = false\nvar numeric = false\nvar pipe = false
object "o":
  when start do
    korean = is_korean("한글")
    english = is_english("한글")
    numeric = is_number("1e2")
    pipe = is_korean("|")
  end
end`);
  for (const built of [project, roundtrip(project)]) {
    const values = run(built);
    assert.equal(values.korean, true);
    assert.equal(values.english, false);
    assert.equal(values.numeric, true);
    assert.equal(values.pipe, true, 'Entry includes a literal pipe in its Korean character class');
  }
  const wrong = compileProject('object "o":\nwhen start do\nsay type("hello") == "boolean"\nend\nend');
  assert.equal(wrong.errors[0]!.code, 'E0011');
  const missing = compileProject('object "o":\nwhen start do\nsay type() == "number"\nend\nend');
  assert.equal(missing.errors[0]!.code, 'E0006');
});

test('variables and functions can shadow device and type inside comparisons', () => {
  const project = compile(`var device = "mobile"\nvar result = false\nvar typed = false
function type(n):
  stop
  return "custom"
end
object "o":
  when start do
    result = device == "mobile"
    typed = type(1) == "custom"
  end
end`);
  assert.equal(run(project).result, true);
  assert.equal(run(project).typed, true);
});

test('power expansion preserves side effects, including an exponent of zero', () => {
  for (const exponent of [0, 1, 2, 3, -3, 0.75]) {
    const project = compile(`var calls = 0\nvar result = 0
function next_():
  calls += 1
  return 4
end
object "o":
  when start do
    result = next_() ** ${exponent}
  end
end`);
    for (const built of [project, roundtrip(project)]) {
      const values = run(built);
      assert.equal(Number(values.calls), 1, `exponent ${exponent}`);
      assert.equal(Number(values.result), 4 ** exponent);
    }
  }
  assert.ok(compileProject('object "o":\nwhen start do\nsay missing ** 0\nend\nend').errors.some(item => item.code === 'E0004'));
});

test('compound list assignments freeze their index and read the old value before the right side', () => {
  const project = compile(`var calls = 0
list items = [10, 20]
function next_():
  calls += 1
  return calls
end
function amount_():
  items[1] = 100
  return 5
end
function update_():
  items[next_()] += amount_()
end
object "o":
  when start do
    update_()
  end
end`);
  for (const built of [project, roundtrip(project)]) {
    const vm = new Vm({ renderer: null, audio: null, kernel: false });
    vm.load(built as never); vm.start(); for (let i = 0; i < 10; i++) vm.tick();
    assert.deepEqual(vm.errors, []);
    assert.equal(Number(vm.variables.find(v => v.name === 'calls')!.getValue()), 1);
    assert.deepEqual(vm.variables.find(v => v.name === 'items')!.getArray().map(item => Number(item.data)), [15, 20]);
  }
  const keyword = compileProject('list items = [1]\nobject "o":\n when start do\n items["RANDOM"] += 1\n end\nend');
  assert.equal(keyword.errors[0]!.code, 'E0010');
  assert.match(keyword.errors[0]!.help!, /random\(1, length/);
});

test('unused and duplicate display-name signals retain order and distinct references', () => {
  const source = `signal "unused"
signal "first" as "same"
signal "second" as "same"
var one = 0
var two = 0
object "o":
  when start do
    send "first"
  end
  when signal "first" do
    one += 1
  end
  when signal "second" do
    two += 1
  end
end`;
  let project = compile(source);
  for (let round = 0; round < 3; round++) {
    project = roundtrip(project);
    assert.deepEqual(project.messages.map(item => item.name), ['unused', 'same', 'same']);
    const script = JSON.parse(project.objects[0]!.script);
    assert.equal(script[0][1].params[0], project.messages[1]!.id);
    assert.equal(script[1][0].params[1], project.messages[1]!.id);
    assert.equal(script[2][0].params[1], project.messages[2]!.id);
    const values = run(project);
    assert.equal(Number(values.one), 1);
    assert.equal(Number(values.two), 0);
  }
  const duplicate = compileProject('signal "a"\nsignal "a"');
  assert.equal(duplicate.errors[0]!.code, 'E0001');
  assert.equal(duplicate.errors[0]!.related![0]!.line, 1);
});

test('resource IDs stored as data or read as values survive shared ownership', () => {
  const original = compile(`var saved = "same"\nvar result = 0\nlist ids = ["same"]
object "one":
  costume first_ "a.png" size 1 1 force id "same"
  when start do
    result = 0
    costume = saved
  end
end
object "two":
  costume second_ "b.png" size 1 1 force id "same"
end`);
  const script = JSON.parse(original.objects[0]!.script);
  script[0][1].params[1] = { type: 'get_pictures', params: ['same'] };
  original.objects[0]!.script = JSON.stringify(script);
  const rebuilt = roundtrip(original);
  assert.equal(rebuilt.objects[0]!.sprite.pictures[0]!.id, 'same');
  assert.equal(rebuilt.objects[1]!.sprite.pictures[0]!.id, 'same');
  assert.equal(run(rebuilt).result, 'same', 'a dropdown used as a value returns its ID');
  assert.equal(rebuilt.variables.find(v => v.name === 'saved')!.value, 'same');
  assert.equal(rebuilt.variables.find(v => v.name === 'ids')!.array![0]!.data, 'same');
});

test('forced resources are reserved before other generated IDs', () => {
  const baseline = compileProject('object "o":\nend', { seed: 'same-seed' }).project!;
  const forced = baseline.scenes[0]!.id;
  const result = compileProject(`object "o":\n costume p "a.png" size 1 1 force id "${forced}"\nend`, { seed: 'same-seed' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.project!.objects[0]!.sprite.pictures[0]!.id, forced);
  assert.notEqual(result.project!.scenes[0]!.id, forced);
});

test('data that may contain regenerated signal IDs carries a location and caveat', () => {
  const original = compile('signal "go"\nvar saved = ""\nobject "o":\nend');
  original.variables[0]!.value = original.messages[0]!.id;
  const result = decompileProject(original, [], { inline: true });
  const notice = result.diagnostics.find(item => item.code === 'D2002')!;
  assert.equal(notice.path, 'variables[0].value');
  assert.match(notice.help!, /실제 ID 참조/);
});

test('function display names, notes and moved monitors survive repeated decompilation', () => {
  let project = compile(`project:\n description ""\nend
var score = "7" visible at -90 37
# Explain the function.
function calculate(n) as "계산하기!":
  return n + 1
end
object "o":
  when start do
    score = calculate(2)
  end
end`);
  for (let round = 0; round < 3; round++) {
    project = roundtrip(project);
    const definition = JSON.parse(project.functions[0]!.content)[0][0];
    assert.equal(definition.params[0].params[0], '계산하기!');
    assert.equal(definition.comment.value, 'Explain the function.');
    assert.equal(project.variables[0]!.value, '7');
    assert.equal(project.variables[0]!.x, -90);
    assert.equal(project.variables[0]!.y, 37);
    assert.equal(project.description, '');
  }
});

test('decompiler diagnostics identify the exact original block and explain lost behavior', () => {
  const project = compile('object "o":\n when start do\n say 1\n end\nend');
  const script = JSON.parse(project.objects[0]!.script);
  script[0][1].params[0] = { id: 'original-value', type: 'future_reporter', params: [] };
  project.objects[0]!.script = JSON.stringify(script);
  const result = decompileProject(project, [], { inline: true });
  const diagnostic = result.diagnostics.find(item => item.code === 'D1001')!;
  assert.equal(diagnostic.path, 'objects[0].script[0][1].params[0]');
  assert.equal(diagnostic.blockId, 'original-value');
  assert.match(diagnostic.help!, /대체/);
  assert.match(result.warnings[0]!, /original-value/);
});

test('unknown dropdown values cannot resolve through Object.prototype', () => {
  const project = compile('object "o":\nwhen start do\nsay is_korean("hi")\nend\nend');
  for (const field of ['__proto__', 'constructor', 'toString']) {
    const script = JSON.parse(project.objects[0]!.script);
    script[0][1].params[0].params[2] = field;
    project.objects[0]!.script = JSON.stringify(script);
    const result = decompileProject(project, [], { inline: true });
    assert.ok(result.diagnostics.some(item => item.code === 'D1001'));
    assert.deepEqual(compileProject(result.source).errors, []);
    assert.doesNotThrow(() => compareEntryProjects(project, roundtrip(compile(result.source))));
  }
});

test('original data and unknown metadata losses are reported even when the new source is stable', () => {
  const original: RawEntity = compile('var score = "7"\nobject "o":\nend');
  const changed = structuredClone(original);
  changed.variables[0].value = 7;
  original.objects[0].futureMetadata = { enabled: true };
  const report = compareEntryProjects(original, changed);
  assert.equal(report.counts.data, 1);
  assert.equal(report.counts.metadata, 1);
  assert.ok(report.differences.some(item => item.path.endsWith('.value') && item.before === '"7"' && item.after === '7'));
  assert.ok(report.differences.some(item => item.path.endsWith('.futureMetadata') && item.after === '(missing)'));
  const capped = compareEntryProjects(original, changed, { maxDifferences: 0 });
  assert.deepEqual(capped.counts, report.counts);
  assert.equal(capped.differences.length, 0);
  assert.equal(capped.truncated, true);
});

test('audit ignores regenerated IDs but reports removed code and same-size changed media', () => {
  const original = compile('var score = 0\nobject "o":\n costume p "a.png" size 1 1\n when start do\n score = 1\n end\nend');
  const rebuilt = roundtrip(original);
  assert.deepEqual(compareEntryProjects(original, rebuilt).counts, { data: 0, metadata: 0, code: 0, layout: 0, asset: 0 });
  const script = JSON.parse(rebuilt.objects[0]!.script);
  script[0].pop();
  rebuilt.objects[0]!.script = JSON.stringify(script);
  const report = compareEntryProjects(original, rebuilt, {
    beforeAssets: [{ name: original.objects[0]!.sprite.pictures[0]!.fileurl, data: new Uint8Array([1, 2]) }],
    afterAssets: [{ name: rebuilt.objects[0]!.sprite.pictures[0]!.fileurl, data: new Uint8Array([1, 3]) }],
  });
  assert.ok(report.counts.code > 0);
  assert.equal(report.counts.asset, 1);
  assert.equal(report.checkedAssets, 1);
});

test('nested runtime errors map to the expression in its included file', () => {
  const source = 'function bad(n):\n  return join("x", "abc"[n])\nend';
  const compiled = compileProject('use "func.etp"\nobject "o":\n when start do\n say bad(0)\n end\nend', {
    path: 'entry.etp', readFile: () => source,
  });
  assert.deepEqual(compiled.errors, []);
  const vm = new Vm({ renderer: null, audio: null, kernel: false });
  vm.load(compiled.project as never); vm.start(); vm.tick();
  const span = compiled.sourceMap![vm.errors[0]!.blockId!];
  assert.match(span!.file!, /func\.etp$/);
  assert.equal(span!.line, 2);
  assert.equal(source.split('\n')[1]!.slice(span!.column - 1, span!.endColumn - 1), '"abc"[n]');
});
