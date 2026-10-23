import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@entropy/compiler';
import { Vm, formatVmError } from '@entropy/vm';
import { blockOfError, runtimeValue, snapshotVm } from '../packages/vm/src/runtime/diagnostics.ts';
import type { RawBlock } from '../packages/vm/src/compile/codegen.ts';

function load(source: string, kernel = false) {
  const compiled = compileProject(source, { path: 'runtime.etp' });
  assert.deepEqual(compiled.errors, []);
  assert.ok(compiled.project);
  const blocks: RawBlock[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if ('type' in value && 'id' in value) blocks.push(value as RawBlock);
      Object.values(value).forEach(walk);
    }
  };
  for (const object of compiled.project.objects) walk(JSON.parse(object.script));
  for (const fn of compiled.project.functions) walk(typeof fn.content === 'string' ? JSON.parse(fn.content) : fn.content);
  const vm = new Vm({ renderer: null, audio: null, kernel });
  vm.load(compiled.project as never);
  vm.start();
  return { vm, blocks };
}

test('errors locate the actual nested value block and retain its inputs and clone call stack before stop', () => {
  for (const kernel of [false, true]) {
    const { vm, blocks } = load(`var text = "🙂abc"
var calls = 0
function next() do
  calls += 1
  return 12
end
function inner() do
  return join("🙂", text[next()])
end
function outer() do
  return inner()
end
scene "main":
  object "actor":
    when start do
      clone
    end
    when cloned do
      say outer()
    end
  end
end`, kernel);
    vm.onError = () => vm.stop();
    vm.tick();
    vm.tick();
    assert.equal(vm.errors.length, 1);
    const error = vm.errors[0]!;
    assert.equal(error.blockId, blocks.find((block) => block.type === 'char_at')!.id);
    assert.equal(error.blockType, 'char_at');
    assert.match(error.stack!, /entropy-generated-\d+\.js(?:, <anonymous>)?:\d+:\d+/);
    assert.deepEqual(error.inputs, {
      text: { type: 'string', value: '🙂abc', length: 5, truncated: false },
      index: { type: 'number', value: 12 },
    });
    assert.equal(Number(vm.variables.find((v) => v.name === 'calls')!.getValue()), 1, 'recording inputs cannot evaluate them again');
    assert.equal(error.context!.isClone, true);
    assert.equal(error.context!.sceneName, 'main');
    assert.equal(error.context!.targetName, 'actor');
    assert.equal(error.context!.event, 'when_clone_start');
    assert.notEqual(error.context!.eventBlockId, error.blockId);
    assert.ok(error.context!.entityId);
    assert.deepEqual(error.context!.calls.map((call) => call.name.split(' ')[0]), ['outer', 'inner']);
    assert.equal(vm.state, 'stop');
    assert.equal(vm.targets[0]!.threads.length, 0);
    assert.match(formatVmError(error), /입력 index: 12/);
    assert.equal(JSON.parse(JSON.stringify(error)).blockId, error.blockId);
  }
});

test('a host failure identifies its statement, not the event hat', () => {
  const { vm, blocks } = load(`object "actor":
  when start do
    forward 1
    x += 2
  end
end`);
  vm.ops.moveX = () => { throw new Error('host failed'); };
  vm.tick();
  assert.equal(vm.errors[0]!.message, 'host failed');
  assert.equal(vm.errors[0]!.blockId, blocks.find((block) => block.type === 'move_x')!.id);
  assert.equal(vm.errors[0]!.blockType, 'move_x');
});

test('a false increment stops at its statement with the evaluated input and no repeated call', () => {
  for (const kernel of [false, true]) {
    const { vm, blocks } = load(`var total = 12
var calls = 0
var after = 0
function amount() do
  calls += 1
  return false
end
function change() do
  total += amount()
  return total
end
object "actor":
  when start do
    say change()
    after = 1
  end
end`, kernel);
    vm.onError = () => vm.stop();
    vm.tick();
    assert.equal(vm.errors.length, 1);
    const error = vm.errors[0]!;
    const total = vm.variables.find((item) => item.name === 'total')!;
    assert.equal(error.blockType, 'change_variable');
    assert.equal(error.blockId, blocks.find((block) => block.type === 'change_variable' && block.params[0] === total.id)!.id);
    assert.match(error.message, /false/);
    assert.deepEqual(error.inputs!.increment, { type: 'boolean', value: false });
    assert.deepEqual(error.inputs!.variable, { type: 'string', value: 'total', length: 5, truncated: false });
    assert.equal(vm.state, 'stop');
    const stored = (name: string) => vm.variables.find((item) => item.name === name)!.value;
    assert.equal(stored('calls'), '1');
    assert.equal(stored('total'), 12);
    assert.equal(stored('after'), 0);
    if (kernel) assert.ok(vm.kernel!.stats.fallbacks > 0);
  }
});

test('block-like comments inside work strings stay text and cannot forge trace sites', () => {
  const text = '/*@entropy:999999*/ "🙂" \\ /*@entropy:0*/';
  const { vm, blocks } = load(`var text = ${JSON.stringify(text)}
var index = 0
object "actor":
  when start do
    say join(${JSON.stringify(text)}, text[index])
  end
end`);
  vm.tick();
  assert.equal(vm.errors[0]!.blockId, blocks.find((block) => block.type === 'char_at')!.id);
  assert.deepEqual(vm.errors[0]!.inputs!.text, { type: 'string', value: text, length: text.length, truncated: false });
});

test('Unicode line separators in literals cannot shift a failing block location', () => {
  const text = 'first\u2028second\u2029third';
  const { vm } = load('object "actor":\nend');
  const access: RawBlock = { id: 'bad-index', type: 'char_at', params: [null, text, null, 0, null], statements: [] };
  const join: RawBlock = { id: 'join', type: 'combine_something', params: [null, text, null, access, null], statements: [] };
  vm.runStack([
    { id: 'print', type: 'dialog', params: [join, 'speak', null], statements: [] },
    { id: 'later', type: 'dialog', params: ['later', 'speak', null], statements: [] },
    { id: 'after', type: 'dialog', params: ['after', 'speak', null], statements: [] },
  ], vm.targets[0]!.id);
  assert.equal(vm.errors[0]!.blockId, access.id);
  assert.deepEqual(vm.errors[0]!.inputs!.text, { type: 'string', value: text, length: text.length, truncated: false });
});

test('ad hoc stacks get their own trace and slice inputs survive JSON export', () => {
  const { vm } = load('object "actor":\nend');
  const block: RawBlock = { id: 'slice-failed', type: 'substring', params: [null, 'abc', null, 0, null, 2, null], statements: [] };
  vm.runStack([{ id: 'print', type: 'dialog', params: [block, 'speak', null], statements: [] }], vm.targets[0]!.id);
  vm.tick();
  assert.equal(vm.errors[0]!.blockId, block.id);
  assert.deepEqual(vm.errors[0]!.inputs, {
    text: { type: 'string', value: 'abc', length: 3, truncated: false },
    start: { type: 'number', value: 0 }, end: { type: 'number', value: 2 },
  });
});

test('frame failures preserve their JS stack and frame context', () => {
  const { vm } = load('object "actor":\nend');
  const cause = new Error('render failed');
  vm.tick();
  const frame = vm.frame;
  vm.fail(cause);
  assert.equal(vm.state, 'stop');
  assert.equal(vm.errors[0]!.stack, cause.stack);
  assert.equal(vm.errors[0]!.context!.frame, frame);
  assert.equal(vm.errors[0]!.context!.event, null);
  assert.equal(vm.errors[0]!.blockId, null);
});

test('value probes still reject and also report their exact failing block', async () => {
  const { vm } = load('object "actor":\nend');
  const block: RawBlock = { id: 'bad-index', type: 'char_at', params: [null, 'abc', null, 7, null], statements: [] };
  const reported: string[] = [];
  vm.onError = (error) => reported.push(error.blockId!);
  await assert.rejects(vm.evaluate(block, vm.targets[0]!.id), /글자 위치 7/);
  assert.deepEqual(reported, ['bad-index']);
  assert.equal(vm.errors[0]!.context!.event, 'probe');
});

test('the last failure retains pre-reset variables and input after the host resets the work', () => {
  const { vm } = load(`var text = "abc"
var index = 9
object "actor":
  when start do
    text = "changed"
    say text[index]
  end
end`);
  vm.pressedKeys.add(13);
  vm.onError = () => { vm.stop(); vm.reset(); };
  vm.tick();
  assert.equal(vm.errors.length, 0);
  assert.equal(vm.variables.find((item) => item.name === 'text')!.getValue(), 'abc');
  const before = vm.lastError!.snapshot!;
  assert.equal(before.state, 'run');
  assert.deepEqual(before.input.keys, [13]);
  assert.deepEqual(before.variables.find((item) => item.name === 'text')!.values[0],
    { type: 'string', value: 'changed', length: 7, truncated: false });
});

test('state previews are detached, bounded and report the full list length', () => {
  const { vm } = load('list items = [1, 2]\nobject "actor":\nend');
  const list = vm.variables.find((item) => item.name === 'items')!;
  list.array = Array.from({ length: 10000 }, (_, i) => ({ data: i }));
  const snapshot = snapshotVm(vm);
  const preview = snapshot.variables.find((item) => item.name === 'items')!;
  assert.equal(preview.length, 10000);
  assert.equal(preview.values.length, 20);
  list.array[0]!.data = 999;
  assert.deepEqual(preview.values[0], { type: 'number', value: 0 });
  assert.equal(snapshot.counts.listItems, 10000);
});

test('runtime value snapshots bound text and preserve falsy and nonfinite values without coercion', () => {
  assert.deepEqual(runtimeValue(false), { type: 'boolean', value: false });
  assert.deepEqual(runtimeValue(0), { type: 'number', value: 0 });
  assert.deepEqual(runtimeValue(Infinity), { type: 'number', value: 'Infinity' });
  assert.deepEqual(runtimeValue(NaN), { type: 'number', value: 'NaN' });
  assert.deepEqual(runtimeValue(''), { type: 'string', value: '', length: 0, truncated: false });
  assert.deepEqual(runtimeValue('x'.repeat(2000)), { type: 'string', value: 'x'.repeat(1024), length: 2000, truncated: true });
  const hostile = { toString() { throw new Error('must not run'); } };
  assert.deepEqual(runtimeValue(hostile), { type: 'object' });
  assert.doesNotThrow(() => JSON.stringify([hostile, 1n, Symbol('x'), undefined, null].map(runtimeValue)));
});

test('Chrome, Firefox and Deno stack positions resolve consistently and unknown sources stay unknown', () => {
  const trace = { sourceId: 'entropy-generated-123.js', sites: [
    { line: 5, column: 2, blockId: 'statement', blockType: 'text_read' },
    { line: 6, column: 30, blockId: 'inner', blockType: 'char_at' },
  ] };
  for (const stack of [
    'Error: bad\n    at Object.charAt (ops.js:100:2)\n    at F (entropy-generated-123.js:6:31)',
    'charAt@ops.js:100:2\nF@entropy-generated-123.js:6:31',
    'Error: bad\n    at Array.eval (entropy-generated-123.js, <anonymous>:6:31)',
  ]) assert.equal(blockOfError(stack, trace)?.blockId, 'inner');
  assert.equal(blockOfError('at F (entropy-generated-123.js:6:29)', trace)?.blockId, 'statement');
  assert.equal(blockOfError('at F (entropy-generated-123.js:1:1)', trace), null);
  assert.equal(blockOfError('at F (other.js:6:31)', trace), null);
  assert.equal(blockOfError(undefined, trace), null);
});
