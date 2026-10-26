import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@entropy/compiler';
import { Vm } from '@entropy/vm';
import { scenarios } from './fixtures/entry-function-scheduling.ts';

const values = (vm: Vm) => ['calls', 'out', 'after'].map(name => vm.variables.find(v => v.name === name)!.value);

function machine(name: string, kernel = false, liveEditing = false): Vm {
  const scenario = scenarios.find(item => item.name === name)!;
  const compiled = compileProject(scenario.source);
  assert.deepEqual(compiled.errors, []);
  const project = compiled.project!;
  if (name === 'raw_value_statement') {
    const object = project.objects[0]!;
    const blocks = JSON.parse(String(object.script));
    blocks[0][1] = blocks[0][1].params[1];
    object.script = JSON.stringify(blocks);
  }
  const vm = new Vm({ renderer: null, audio: null, kernel, liveEditing });
  vm.load(project as never);
  vm.start();
  return vm;
}

for (const scenario of scenarios) {
  test(`Entry function scheduling: ${scenario.name}`, () => {
    for (const kernel of [false, true]) for (const liveEditing of [false, true]) {
      const vm = machine(scenario.name, kernel, liveEditing);
      const trace = [values(vm)];
      for (let tick = 1; tick <= 8; tick++) {
        if (scenario.name.startsWith('pause_') && scenario.name !== 'pause_empty_early' && tick === 2) vm.pause();
        if (scenario.name.startsWith('pause_') && tick === 5) vm.start();
        if (tick === 3) vm.variables.find(v => v.name === 'gate')!.setValue(1);
        if (vm.state === 'run') vm.tick(undefined, false);
        trace.push(values(vm));
        if (scenario.name === 'pause_empty_early' && tick === 1) vm.pause();
        vm.flushFunctionCalls();
        trace.push(values(vm));
      }
      assert.deepEqual(vm.errors, []);
      assert.deepEqual(trace, scenario.trace, `kernel=${kernel}, liveEditing=${liveEditing}`);
    }
  });
}

test('animation continuations run independently of catch-up ticks and the engine frame rate', () => {
  const vm = machine('nested_empty_value');
  vm.advance(0);
  assert.deepEqual(values(vm), ['3', 0, 0]);
  const ticks = vm.frame;
  vm.advance(1);
  assert.equal(vm.frame, ticks);
  assert.deepEqual(values(vm), ['4', 0, 0]);
  vm.advance(2);
  assert.deepEqual(values(vm), ['6', '6', 0]);
  vm.advance(1000 / vm.frameRate);
  assert.deepEqual(values(vm), ['6', '6', '1']);

  const delayed = machine('nested_empty_value');
  delayed.advance(0);
  delayed.advance(1000);
  assert.ok(delayed.frame > 2);
  assert.deepEqual(values(delayed), ['4', 0, 0]);
});

test('empty functions stay outside the kernel while their synchronous callees can use it', () => {
  const vm = machine('nested_empty_value', true);
  assert.deepEqual([...vm.kernel!.roots.keys()], [0]);
  assert.ok([...vm.kernelPlan!.rejected.values()].includes('empty function body yields'));
});

test('stopping a suspended empty function cancels its continuation and restart uses fresh frames', () => {
  const vm = machine('empty_value');
  vm.tick(undefined, false);
  assert.deepEqual(values(vm), ['1', 0, 0]);
  vm.stop();
  vm.flushFunctionCalls();
  assert.deepEqual(values(vm), ['1', 0, 0]);
  vm.start(); vm.tick(); vm.tick();
  assert.deepEqual(values(vm), ['3', '3', '1']);
  assert.deepEqual(vm.errors, []);
});

test('editing a suspended empty return uses the new expression without replaying the caller', async () => {
  const compiled = compileProject(scenarios.find(item => item.name === 'empty_value')!.source);
  const project = compiled.project!;
  const vm = new Vm({ renderer: null, audio: null, liveEditing: true });
  vm.load(project as never); vm.start(); vm.tick(undefined, false);
  assert.deepEqual(values(vm), ['1', 0, 0]);
  const fn = project.functions[1]!;
  const blocks = JSON.parse(String(fn.content));
  blocks[0][0].params[3] = { id: 'new-return', type: 'number', params: ['9'] };
  fn.content = JSON.stringify(blocks);
  vm.pause(false);
  await vm.patchCodeAsync(project as never);
  vm.flushFunctionCalls();
  assert.deepEqual(values(vm), ['1', 0, 0]);
  vm.start(); vm.flushFunctionCalls();
  assert.deepEqual(values(vm), ['1', '9', 0]);
  vm.tick();
  assert.deepEqual(values(vm), ['1', '9', '1']);
  assert.deepEqual(vm.errors, []);
});

test('a failing repeated return keeps its source block and function call stack', () => {
  const compiled = compileProject(`var calls = 0
var out = 0
function next_():
  calls += 1
  return calls
end
function outer_():
  return "ab"[next_()]
end
object "o":
  when start do
    out = outer_()
  end
end`);
  assert.deepEqual(compiled.errors, []);
  for (const liveEditing of [false, true]) {
    const vm = new Vm({ renderer: null, audio: null, liveEditing });
    vm.load(compiled.project as never); vm.start(); vm.tick();
    assert.equal(vm.variables.find(v => v.name === 'calls')!.value, '3');
    assert.equal(vm.variables.find(v => v.name === 'out')!.value, 0);
    assert.equal(vm.errors.length, 1);
    assert.equal(vm.errors[0]!.blockType, 'char_at');
    assert.ok(vm.errors[0]!.context?.calls.some(call => call.name === 'outer_'));
  }
});
