import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';

const block = (id: string, type: string, params: unknown[] = []) => ({ id, type, params, statements: [] });

test('send-and-wait in a condition starts receivers and returns a truthy scope', () => {
  const script = [
    [block('start', 'when_run_button_click'),
      block('condition', 'wait_until_true', [block('send', 'message_cast_wait', ['message'])]),
      block('continued', 'set_variable', ['continued', 1])],
    [block('receiver', 'when_message_cast', [null, 'message']),
      block('received', 'set_variable', ['received', 1]),
      block('delay', 'wait_second', [100]),
      block('finished', 'set_variable', ['finished', 1])],
  ];
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 'scene', name: 'scene' }],
    variables: ['continued', 'received', 'finished'].map(id => ({ id, name: id, value: 0 })),
    messages: [{ id: 'message', name: 'message' }], functions: [],
    objects: [{ id: 'actor', name: 'actor', scene: 'scene', script: JSON.stringify(script), entity: {} }],
  } as never);
  assert.equal(vm.unknownBlocks.has('message_cast_wait'), false);
  vm.start();
  vm.tick();
  const values = () => vm.variables.slice(0, 3).map(variable => Number(variable.value));
  assert.deepEqual(values(), [1, 1, 0]);
  assert.ok(vm.targets[0]!.threads.some(thread => thread.script.event === 'when_message_cast' && !thread.done));
});

test('a missing signal reports an error and stops the sending script', () => {
  for (const type of ['message_cast', 'message_cast_wait']) {
    const script = [[block('start', 'when_run_button_click'), block('send', type, ['missing']),
      block('after', 'set_variable', ['out', 1])]];
    const vm = new Vm({ renderer: null, audio: null });
    vm.load({ scenes: [{ id: 's', name: 'scene' }], variables: [{ id: 'out', name: 'out', value: 0 }],
      messages: [], functions: [], objects: [{ id: 'actor', name: 'actor', scene: 's', script: JSON.stringify(script), entity: {} }],
    } as never);
    vm.start(); vm.tick();
    assert.equal(vm.variables[0]!.value, 0, type);
    assert.equal(vm.errors[0]?.blockType, type);
    assert.match(vm.errors[0]?.message ?? '', /신호를 찾을 수 없습니다/);
  }
});
