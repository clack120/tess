import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';
import { compileProject } from '@entropy/compiler';
import { stub } from './stub.ts';

const block = (id: string, type: string, params: unknown[] = [], statements?: unknown[][]) => ({ id, type, params, ...(statements ? { statements } : {}) });
const stack = (id: string, value: number) => [block(id, 'when_run_button_click'),
  block(id + '-set', 'set_variable', ['out', value]), block(id + '-wait', 'wait_second', [100])];
function setup() {
  const project = { scenes: [{ id: 's', name: 'scene' }], variables: [{ id: 'out', name: 'out', value: 0 }],
    objects: [{ id: 'actor', name: 'actor', scene: 's', script: JSON.stringify([stack('first', 1), stack('second', 3)]), entity: { x: 10, y: 20 } }],
    functions: [], messages: [], tables: [{ id: 't', name: 't', fields: ['A'], data: [[1]] }] };
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project); vm.start(); vm.tick();
  return { vm, project, target: vm.targets[0]! };
}

test('code edits keep live entities, clones, values, tables, clock and unmodified waiting threads', () => {
  const { vm, project, target } = setup();
  const kept = target.threads[1]!;
  const replaced = target.threads[0]!;
  const previousIterator = replaced.iterator;
  const entity = target.entity;
  const clone = target.addClone(entity);
  entity.x = 93; clone.y = 71;
  vm.tables[0]!.replaceValue(1, 1, 44);
  vm.variables[0]!.value = 20;
  vm.pause();
  const clock = vm.clock, frame = vm.frame;
  project.objects[0]!.script = JSON.stringify([stack('first', 9), stack('second', 3)]);
  assert.equal(vm.patchCode(project), 2, 'only the edited start stack is restarted for the original and clone');
  assert.equal(vm.state, 'pause'); assert.equal(vm.clock, clock); assert.equal(vm.frame, frame);
  assert.equal(target.entity, entity); assert.equal(target.clones[0], clone);
  assert.equal(entity.x, 93); assert.equal(clone.y, 71);
  assert.equal(vm.tables[0]!.getValue(1, 1), 44);
  assert.equal(vm.variables[0]!.value, 20, 'applying while paused does not execute code');
  assert.ok(target.threads.includes(kept)); assert.equal(kept.done, false);
  assert.ok(target.threads.includes(replaced)); assert.notEqual(replaced.iterator, previousIterator);
  vm.start(); vm.tick(); assert.equal(vm.variables[0]!.value, 9);
});

test('editing a message receiver preserves concurrent deliveries and their send-and-wait callers', () => {
  const { vm, project } = setup();
  const receiver = (seconds: number) => [[block('receiver', 'when_message_cast', [null, 'message']),
    block('wait', 'wait_second', [seconds])]];
  project.objects[0]!.script = JSON.stringify(receiver(100));
  vm.stop(); vm.load(project); vm.start();
  const first = vm.ops.castMessageWait('message'), second = vm.ops.castMessageWait('message');
  assert.equal(first.next().done, false); assert.equal(second.next().done, false);
  vm.tick();
  const deliveries = [...vm.targets[0]!.threads];
  project.objects[0]!.script = JSON.stringify(receiver(0));
  assert.equal(vm.patchCode(project), 2);
  assert.deepEqual(vm.targets[0]!.threads, deliveries, 'each delivery keeps its identity');
  assert.equal(first.next().done, false); assert.equal(second.next().done, false);
  vm.tick(); vm.tick();
  assert.equal(first.next().done, true); assert.equal(second.next().done, true);
});

test('board moves and expanded Entry defaults leave the existing code and threads untouched', () => {
  const { vm, project, target } = setup();
  const threads = [...target.threads];
  const raw = JSON.parse(project.objects[0]!.script);
  for (const blocks of raw) for (const item of blocks) {
    item.x = -39; item.y = 144; item.movable = null; item.copyable = true; item.statements ??= [];
  }
  project.objects[0]!.script = JSON.stringify(raw);
  assert.equal(vm.patchCode(project), 0);
  assert.deepEqual(target.threads, threads);
  assert.equal(vm.state, 'run');
});

test('removing a stack cancels its wait and changed event hats wait for their next event', () => {
  const { vm, project, target } = setup();
  const removed = target.threads[0]!;
  project.objects[0]!.script = JSON.stringify([[block('first', 'when_message_cast', [null, 'message']),
    block('message-set', 'set_variable', ['out', 88])], stack('second', 3)]);
  assert.equal(vm.patchCode(project), 0);
  assert.equal(removed.done, true); assert.equal(target.threads.length, 1);
  vm.fireEvent('when_message_cast', 'message'); vm.tick();
  assert.equal(vm.variables[0]!.value, 88);
});

test('unsupported live edits leave the working code and active waits intact', () => {
  const { vm, project, target } = setup();
  const threads = [...target.threads], scripts = [...target.scripts];
  project.objects[0]!.script = JSON.stringify([[...stack('first', 9), block('unsupported', 'future_block')], stack('second', 3)]);
  assert.throws(() => vm.patchCode(project), /future_block/);
  assert.deepEqual(target.threads, threads); assert.deepEqual(target.scripts, scripts);
  assert.equal(vm.state, 'run'); assert.equal(threads[0]!.done, false);
});

test('cancelling a question during a live edit removes its input and dialog without accepting an answer', () => {
  const { vm, project } = setup();
  project.objects[0]!.script = JSON.stringify([[block('ask-hat', 'when_run_button_click'),
    block('ask', 'ask_and_wait', ['question'])]]);
  vm.stop(); vm.load(project); vm.start(); vm.tick();
  const entity = vm.targets[0]!.entity;
  let hidden = 0;
  vm.renderer = { hideQuestion() { hidden++; } } as never;
  vm.pendingAnswer = 'obsolete answer';
  project.objects[0]!.script = JSON.stringify([[block('ask-hat', 'when_run_button_click'), block('done', 'locate_x', [5])]]);
  vm.patchCode(project);
  assert.equal(vm.question, null); assert.equal(vm.pendingAnswer, null);
  assert.equal(entity.dialog, null); assert.equal(hidden, 1);
  assert.equal(vm.answer, '', 'cancelling must not commit an unconsumed answer');
  vm.tick(); assert.equal(entity.x, 5); assert.deepEqual(vm.errors, []);
});

test('cancelling an older question cannot dismiss a newer question with the same text', () => {
  const { vm, project } = setup();
  const ask = (id: string) => [block(id, 'when_run_button_click'), block(id + '-ask', 'ask_and_wait', ['same'])];
  project.objects[0]!.script = JSON.stringify([ask('older'), ask('newer')]);
  vm.stop(); vm.load(project); vm.start(); vm.tick();
  const dialog = vm.targets[0]!.entity.dialog;
  project.objects[0]!.script = JSON.stringify([ask('newer')]);
  vm.pendingAnswer = 'new answer';
  vm.patchCode(project);
  assert.equal(vm.question, 'same'); assert.equal(vm.pendingAnswer, 'new answer');
  assert.equal(vm.targets[0]!.entity.dialog, dialog);
  vm.tick(); assert.equal(vm.answer, 'new answer'); assert.equal(vm.question, null);
});

test('an older waiting question cannot consume the answer submitted to its replacement', () => {
  const { vm, project } = setup();
  const ask = (id: string, value: number) => [block(id, 'when_run_button_click'),
    block(id + '-ask', 'ask_and_wait', ['same']), block(id + '-set', 'set_variable', ['out', value])];
  project.objects[0]!.script = JSON.stringify([ask('older', 1), ask('newer', 2)]);
  vm.stop(); vm.load(project); vm.start(); vm.tick();
  vm.pendingAnswer = 'current answer';
  vm.tick();
  assert.equal(vm.answer, 'current answer'); assert.equal(vm.question, null);
  assert.equal(vm.variables[0]!.value, 2);
  assert.equal(vm.targets[0]!.threads.every(thread => thread.done), true);
});

test('untouched running code reads current block counts after repeated edits elsewhere', async () => {
  const { vm, project } = setup();
  const counter = [block('counter', 'when_run_button_click'), block('loop', 'repeat_inf', [], [[
    block('count', 'set_variable', ['out', block('reporter', 'get_block_count', ['all'])]),
    block('yield', 'wait_second', [0]),
  ]])];
  const other = [block('other', 'when_object_click')];
  project.objects[0]!.script = JSON.stringify([counter, other]);
  vm.stop(); vm.load(project); vm.start();
  const advance = async () => { for (let i = 0; i < 6; i++) { vm.tick(); await Promise.resolve(); } };
  await advance();
  const thread = vm.targets[0]!.threads[0]!;
  const initial = Number(vm.variables[0]!.value);
  for (let i = 1; i <= 2; i++) {
    other.push(block('added-' + i, 'locate_x', [i]));
    project.objects[0]!.script = JSON.stringify([counter, other]);
    assert.equal(vm.patchCode(project), 0);
    assert.equal(vm.targets[0]!.threads[0], thread);
    await advance(); assert.equal(Number(vm.variables[0]!.value), initial + i);
  }
  assert.deepEqual(vm.errors, []);
  project.objects[0]!.script = JSON.stringify([counter, [block('other', 'when_object_click')]]);
  vm.stop(); vm.load(project); vm.start(); await advance();
  assert.equal(Number(vm.variables[0]!.value), initial, 'loading again discards counts from previous live edits');
});

test('function edits replace calls without resetting the running project', () => {
  const result = compileProject('var out = 0\nfunction f():\n  return 1\nend\nobject "actor":\n  when start do\n    forever do\n      out = f()\n      wait 0.1\n    end\n  end\nend');
  assert.deepEqual(result.errors, []);
  const project = result.project!;
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as never); vm.start(); vm.tick();
  const target = vm.targets[0]!;
  target.entity.x = 123;
  const fn = project.functions[0]!;
  fn.content = String(fn.content).replace('"params":["1"]', '"params":["7"]');
  assert.ok(String(fn.content).includes('"params":["7"]'));
  vm.patchCode(project as never); vm.tick();
  assert.equal(target.entity.x, 123);
  assert.equal(Number(vm.variables.find(value => value.name === 'out')!.value), 7);
  assert.deepEqual(vm.errors, []);
});

test('repeated live apply reuses unchanged object parsing after partial patches and layout-only edits', t => {
  const { vm, project, target } = setup();
  const parse = JSON.parse;
  let parses = 0;
  stub(t, JSON, 'parse', (text: string, ...args: any[]) => {
    if (text.startsWith('[[{"id":"first"')) parses++;
    return parse(text, ...args);
  });
  assert.equal(vm.patchCode(project), 0); assert.equal(parses, 0);
  project.objects[0]!.script = JSON.stringify([stack('first', 20), stack('second', 3)]);
  vm.patchCode(project); assert.equal(parses, 1);
  const threads = [...target.threads];
  vm.patchCode({ objects: [], functions: [] });
  assert.equal(vm.patchCode(project), 0); assert.equal(parses, 1);
  const blocks = parse(project.objects[0]!.script); blocks[0][0].x = 23;
  project.objects[0]!.script = JSON.stringify(blocks);
  assert.equal(vm.patchCode(project), 0); assert.equal(parses, 2);
  assert.equal(vm.patchCode(project), 0); assert.equal(parses, 2);
  assert.deepEqual(target.threads, threads);
  project.objects[0]!.script = JSON.stringify([stack('first', 42)]);
  vm.stop(); vm.load(project); vm.start(); vm.tick();
  assert.equal(vm.variables[0]!.value, 42, 'reload reads edited source instead of the previous cache');
  assert.deepEqual(vm.errors, []);
});
