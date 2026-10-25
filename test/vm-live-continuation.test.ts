import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';
import { compileProject } from '@entropy/compiler';

const block = (id: string, type: string, params: unknown[] = [], statements?: unknown[][]) => ({ id, type, params, ...(statements ? { statements } : {}) });
const change = (id: string, value: number) => block(id, 'change_variable', ['out', value]);
function setup(body: ReturnType<typeof block>[]) {
  const project = { scenes: [{ id: 's', name: 'scene' }], variables: [{ id: 'out', name: 'out', value: 0 }],
    objects: [{ id: 'actor', scene: 's', script: JSON.stringify([[block('hat', 'when_run_button_click'), ...body]]), entity: {} }],
    functions: [], messages: [], tables: [] };
  const vm = new Vm({ renderer: null, audio: null, liveEditing: true });
  vm.load(project); vm.start(); vm.tick();
  const apply = (next: typeof body) => {
    project.objects[0]!.script = JSON.stringify([[block('hat', 'when_run_button_click'), ...next]]);
    assert.equal(vm.patchCode(project), 0, 'live edits never restart a running script');
  };
  return { vm, project, apply, value: () => Number(vm.variables[0]!.value) };
}

test('forever edits preserve the current wait and never repeat initialization', () => {
  const initial = change('initialize', 1);
  const loop = block('loop', 'repeat_inf', [], [[change('add', 10), block('wait', 'wait_second', [1])]]);
  const s = setup([initial, loop]);
  assert.equal(s.value(), 11);
  const thread = s.vm.targets[0]!.threads[0]!, iterator = thread.iterator;
  (loop.statements![0]![0] as ReturnType<typeof block>).params[1] = 100;
  s.apply([initial, loop]);
  s.vm.tick(100); assert.equal(s.value(), 11, 'the old one-second wait still holds');
  s.vm.tick(1000); s.vm.tick();
  assert.equal(s.value(), 111);
  assert.equal(s.vm.targets[0]!.threads[0], thread); assert.equal(thread.iterator, iterator);
  s.apply([initial, loop]); s.vm.tick(1000); s.vm.tick();
  assert.equal(s.value(), 211); assert.deepEqual(s.vm.errors, []);
});

test('edits after an active wait apply next without resetting its deadline or repeating previous blocks', () => {
  const wait = block('wait', 'wait_second', [1]);
  const s = setup([change('before', 1), wait, change('after', 10)]);
  s.apply([change('before', 99), wait, change('inserted', 20), change('after', 100)]);
  s.vm.tick(100); assert.equal(s.value(), 1);
  s.vm.tick(1000); assert.equal(s.value(), 121); assert.deepEqual(s.vm.errors, []);
});

test('deleting an active waiting block continues after it and cleans up its question', () => {
  const s = setup([change('before', 1), block('ask', 'ask_and_wait', ['question']), change('after', 10)]);
  assert.equal(s.vm.question, 'question');
  s.apply([change('before', 100), change('inserted', 20), change('after', 30)]);
  assert.equal(s.vm.question, null); assert.equal(s.vm.targets[0]!.entity.dialog, null);
  s.vm.tick(); assert.equal(s.value(), 51); assert.deepEqual(s.vm.errors, []);
});

test('counted and nested loops retain their remaining iterations after an edit', () => {
  const inner = block('inner', 'repeat_basic', [2], [[change('add', 1), block('wait', 'wait_second', [1])]]);
  const outer = block('outer', 'repeat_basic', [2], [[inner]]);
  const s = setup([outer, change('after', 1000)]);
  assert.equal(s.value(), 1);
  (inner.statements![0]![0] as ReturnType<typeof block>).params[1] = 10;
  s.apply([outer, change('after', 1000)]);
  for (let i = 0; i < 20; i++) s.vm.tick(1000);
  assert.equal(s.value(), 1031, 'one original iteration plus three edited iterations');
  assert.deepEqual(s.vm.errors, []);
});

test('editing a wait-until condition can release the existing waiting block', () => {
  const s = setup([block('wait', 'wait_until_true', [false]), change('after', 7)]);
  s.apply([block('wait', 'wait_until_true', [true]), change('after', 7)]);
  s.vm.tick(); assert.equal(s.value(), 7); assert.deepEqual(s.vm.errors, []);
});

test('finished start scripts are not replayed and newly triggered events use edited code', () => {
  const s = setup([change('once', 1)]);
  s.apply([change('once', 100)]);
  s.vm.tick(); assert.equal(s.value(), 1);
  s.vm.fireEvent('start'); s.vm.tick(); assert.equal(s.value(), 101);
});

test('live execution preserves function and loop control behavior', () => {
  const programs = [
    'var out = 0\nfunction f():\n  repeat 3 do\n    out += 1\n  end\n  return 7\nend\nobject "actor":\n  when start do\n    out += f()\n  end\nend',
    'var out = 0\nobject "actor":\n  when start do\n    repeat 3 do\n      out += 1\n      break\n      out += 100\n    end\n    out += 10\n  end\nend',
    'var out = 0\nobject "actor":\n  when start do\n    repeat 3 do\n      out += 1\n      continue\n      out += 100\n    end\n    out += 10\n  end\nend',
  ];
  for (const text of programs) {
    const result = compileProject(text); assert.deepEqual(result.errors, []);
    const run = (liveEditing: boolean) => {
      const vm = new Vm({ renderer: null, audio: null, liveEditing });
      vm.load(result.project as never); vm.start(); for (let i = 0; i < 50; i++) vm.tick();
      assert.deepEqual(vm.errors, []); return vm.variables.map(variable => variable.value);
    };
    assert.deepEqual(run(true), run(false));
  }
});

test('function edits preserve active arguments, local values and caller position', async () => {
  const result = compileProject('var out = 0\nvar initialized = 0\nfunction f(n):\n  var local = n\n  wait 1\n  local += 1\n  return local\nend\nobject "actor":\n  when start do\n    initialized += 1\n    out = f(5)\n  end\nend');
  assert.deepEqual(result.errors, []);
  const project = result.project!;
  const vm = new Vm({ renderer: null, audio: null, liveEditing: true });
  vm.load(project as never); vm.start(); vm.tick();
  const fn = project.functions[0]!, code = JSON.parse(String(fn.content));
  const change = code[0][0].statements[0].find((item: any) => item.params[1]?.type === 'calc_basic');
  assert.ok(change); change.params[1].params[2].params[0] = '10';
  fn.content = JSON.stringify(code);
  vm.pause(false);
  await vm.patchCodeAsync(project as never);
  assert.equal(Number(vm.variables.find(variable => variable.name === 'out')!.value), 0);
  vm.start(); vm.tick(100);
  assert.equal(Number(vm.variables.find(variable => variable.name === 'out')!.value), 0);
  vm.tick(1000);
  assert.equal(Number(vm.variables.find(variable => variable.name === 'out')!.value), 15);
  assert.equal(Number(vm.variables.find(variable => variable.name === 'initialized')!.value), 1);
  assert.equal(vm.targets[0]!.threads[0]!.depth, 0);
  assert.deepEqual(vm.errors, []);
});

test('cancelling asynchronous compilation leaves the running program intact', async () => {
  const wait = block('wait', 'wait_second', [1]);
  const s = setup([wait, change('after', 1)]);
  const thread = s.vm.targets[0]!.threads[0]!, iterator = thread.iterator;
  s.vm.pause(false);
  s.project.objects[0]!.script = JSON.stringify([[block('hat', 'when_run_button_click'), wait, change('after', 10)]]);
  const controller = new AbortController();
  const applying = s.vm.patchCodeAsync(s.project, controller.signal);
  controller.abort();
  await assert.rejects(applying, { name: 'AbortError' });
  assert.equal(thread.iterator, iterator); assert.equal(s.vm.state, 'pause');
  s.vm.start(); s.vm.tick(1000); assert.equal(s.value(), 1);
});

test('changing an active block type replaces that block without replaying its predecessors', () => {
  const s = setup([change('before', 1), block('active', 'repeat_inf', [], [[block('wait', 'wait_second', [100])]]), change('after', 10)]);
  s.apply([change('before', 100), change('active', 20), change('after', 30)]);
  s.vm.tick(); assert.equal(s.value(), 51); assert.deepEqual(s.vm.errors, []);
});

test('loop condition edits release an existing loop and preserve its caller', () => {
  const loop = block('loop', 'repeat_while_true', [true, 'while'], [[change('add', 1)]]);
  const s = setup([loop, change('after', 10)]);
  loop.params[0] = false;
  s.apply([loop, change('after', 10)]);
  s.vm.tick(); assert.equal(s.value(), 11); assert.deepEqual(s.vm.errors, []);
});

test('errors in edited nested blocks retain the location in the new code', () => {
  const wait = block('wait', 'wait_second', [1]);
  const loop = block('loop', 'repeat_inf', [], [[wait, change('after', 1)]]);
  const s = setup([loop]);
  loop.statements![0]![1] = block('bad-edit', 'change_variable', ['out', false]);
  s.apply([loop]); s.vm.tick(1000);
  assert.equal(s.vm.errors.length, 1);
  assert.equal(s.vm.errors[0]!.blockId, 'bad-edit');
  assert.equal(s.vm.errors[0]!.blockType, 'change_variable');
});
