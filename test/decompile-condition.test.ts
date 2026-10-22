import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@tess/compiler';
import { decompileProject } from '@tess/decompiler';
import { Vm } from '@tess/vm';

function fixture() {
  const built = compileProject(`
var input = 0
var hits = 0
var out = 0
var entry_condition = 0
var entry_no_value = 0
function probe():
  hits += 1
  return input
end
object "o":
  when start do
    if true:
      out = 1
    end
  end
end`);
  assert.deepEqual(built.errors, []);
  const project = built.project!;
  const stacks = JSON.parse(project.objects[0]!.script);
  const condition = stacks[0][1];
  const call = { type: `func_${project.functions[0]!.id}`, params: [] };
  return { project, stacks, condition, call };
}

function roundtrip(project: ReturnType<typeof fixture>['project']) {
  const decompiled = decompileProject(project, [], { inline: true });
  assert.deepEqual(decompiled.warnings, []);
  const result = compileProject(decompiled.source);
  assert.deepEqual(result.errors, []);
  return result.project!;
}

function run(project: ReturnType<typeof fixture>['project'], input: unknown) {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as never);
  vm.start();
  vm.variables.find(v => v.name === 'input')!.setValue(input as string | number);
  for (let i = 0; i < 30; i++) vm.tick();
  assert.deepEqual(vm.errors, []);
  const value = (name: string) => vm.variables.find(v => v.name === name)!.getValue();
  return { out: Number(value('out')), hits: Number(value('hits')) };
}

test('round-trip preserves numeric condition conversion and evaluates a value call once', () => {
  const cases: Array<[unknown, boolean]> = [
    [0, false], [1, true], [-2, true], ['', false], [' ', false],
    ['0', false], ['0.00', false], ['0e2', false], ['0x0', false],
    ['FALSE', true], ['false', true], ['undefined', true], [false, false], [true, true],
  ];
  for (const negate of [false, true]) {
    const { project, stacks, condition, call } = fixture();
    condition.params[0] = negate ? { type: 'boolean_not', params: [null, call, null] } : call;
    project.objects[0]!.script = JSON.stringify(stacks);
    const converted = roundtrip(project);
    for (const [input, truth] of cases) {
      const expected = { out: Number(negate ? !truth : truth), hits: 1 };
      assert.deepEqual(run(project, input), expected, `original ${JSON.stringify({ input, negate })}`);
      assert.deepEqual(run(converted, input), expected, `roundtrip ${JSON.stringify({ input, negate })}`);
    }
  }
});

test('round-trip keeps an undefined return falsy without discarding its side effects', () => {
  const { project, stacks, condition, call } = fixture();
  const fn = project.functions[0]!;
  const content = JSON.parse(fn.content);
  content[0][0].type = 'function_create';
  content[0][0].params = content[0][0].params.slice(0, 2);
  fn.type = 'normal';
  fn.content = JSON.stringify(content);
  condition.params[0] = call;
  project.objects[0]!.script = JSON.stringify(stacks);
  const expected = { out: 0, hits: 1 };
  assert.deepEqual(run(project, 1), expected);
  assert.deepEqual(run(roundtrip(project), 1), expected);
});

test('a function returning a boolean block retains false in a condition', () => {
  const { project, stacks, condition, call } = fixture();
  const fn = project.functions[0]!;
  const content = JSON.parse(fn.content);
  content[0][0].params[3] = { type: 'False', params: [null] };
  fn.content = JSON.stringify(content);
  condition.params[0] = call;
  project.objects[0]!.script = JSON.stringify(stacks);
  const expected = { out: 0, hits: 1 };
  assert.deepEqual(run(project, 1), expected);
  assert.deepEqual(run(roundtrip(project), 1), expected);
});

test('numeric conditions survive if/else, loop and wait conversion', () => {
  for (const kind of ['if_else', 'repeat_while_true', 'wait_until_true']) {
    const { project, stacks, condition, call } = fixture();
    condition.type = kind;
    condition.params = [call, 'while', null];
    const inputId = project.variables.find(v => v.name === 'input')!.id;
    if (kind === 'if_else') {
      condition.statements[1] = [{ type: 'set_variable', params: [
        project.variables.find(v => v.name === 'out')!.id, { type: 'number', params: ['2'] },
      ] }];
    } else if (kind === 'repeat_while_true') {
      condition.statements[0].push({ type: 'set_variable', params: [inputId, { type: 'number', params: ['0'] }] });
    } else {
      stacks[0].push(...condition.statements[0]);
      condition.statements = [];
    }
    project.objects[0]!.script = JSON.stringify(stacks);
    const converted = roundtrip(project);
    for (const input of [0, 1]) assert.deepEqual(run(converted, input), run(project, input), `${kind}: ${input}`);
  }
});

test('boolean return types are preserved through chained value functions', () => {
  const { project, stacks, condition } = fixture();
  const first = project.functions[0]!;
  const content = JSON.parse(first.content);
  content[0][0].params[3] = { type: 'False', params: [null] };
  first.content = JSON.stringify(content);
  const relay = structuredClone(first);
  relay.id = 'relay';
  const relayContent = JSON.parse(relay.content);
  relayContent[0][0].params[0] = { type: 'function_field_label', params: ['relay', null] };
  relayContent[0][0].params[3] = { type: `func_${first.id}`, params: [] };
  relayContent[0][0].statements = [[]];
  relay.content = JSON.stringify(relayContent);
  project.functions.push(relay);
  condition.params[0] = { type: 'func_relay', params: [] };
  project.objects[0]!.script = JSON.stringify(stacks);
  const expected = { out: 0, hits: 1 };
  assert.deepEqual(run(project, 1), expected);
  assert.deepEqual(run(roundtrip(project), 1), expected);
});
