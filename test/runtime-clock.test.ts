import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';

function setup() {
  const block = (type: string, ...params: unknown[]) => ({ type, params });
  const vm = new Vm({ fps: 50 });
  vm.load({
    scenes: [{ id: 'scene', name: 'scene' }], messages: [], functions: [],
    variables: [{ id: 'time', name: 'time', variableType: 'variable', value: -1 }],
    objects: [{ id: 'actor', name: 'actor', scene: 'scene', entity: {}, script: [[
      block('when_run_button_click'),
      { ...block('repeat_inf'), statements: [[block('set_variable', 'time', block('get_project_timer_value'))]] },
    ]] }],
  });
  vm.start();
  vm.advance(0);
  vm.startTimer();
  return vm;
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

test('wall time survives repeated stalls while catch-up work stays bounded', () => {
  const vm = setup();
  let now = 0;
  for (const delay of [1010, 3, 7, 2500, 20, 50, 5000]) {
    const before = vm.frame;
    vm.advance(now += delay);
    near(vm.timerValue(), now / 1000);
    assert.ok(vm.frame - before <= 4);
    if (vm.frame > before) near(Number(vm.variables[0]!.value), now / 1000);
  }
  assert.deepEqual(vm.errors, []);
});

test('expired deadlines use current wall time without aging newly created deadlines during catch-up', () => {
  const vm = setup();
  const entity = vm.targets[0]!.entity;
  const dialog = vm.ops.dialogTime(entity, 'hello', 1, 'speak');
  const wait = vm.ops.waitSecond(1);
  assert.equal(dialog.next().done, false);
  assert.equal(wait.next().done, false);
  const events: number[] = [];
  vm.setTimeout(() => {
    events.push(vm.clock);
    vm.setTimeout(() => events.push(vm.clock), 10);
  }, 1000);
  vm.advance(2000);
  assert.equal(dialog.next().done, true);
  assert.equal(wait.next().done, true);
  assert.equal(entity.dialog, null);
  assert.deepEqual(events, [2020]);
  vm.advance(2020);
  assert.deepEqual(events, [2020, 2040]);
});

test('engine pause and stopped project timers exclude elapsed wall time', () => {
  const vm = setup();
  vm.advance(1000);
  vm.pause();
  vm.advance(9000);
  near(vm.timerValue(), 1);
  vm.start();
  vm.advance(10000);
  const resumed = vm.timerValue();
  vm.advance(10500);
  near(vm.timerValue() - resumed, .5);
  vm.pauseTimer();
  const held = vm.timerValue();
  vm.advance(20000);
  near(vm.timerValue(), held);
  vm.startTimer();
  vm.advance(20500);
  near(vm.timerValue() - held, .5);
  vm.stop();
  vm.start();
  vm.advance(30000);
  assert.equal(vm.timerValue(), 0);
  assert.deepEqual(vm.errors, []);
});

test('manual ticks retain deterministic elapsed time', () => {
  const vm = setup();
  vm.tick(1250);
  near(vm.timerValue(), 1.25);
  vm.tick();
  near(vm.timerValue(), 1.27);
});
