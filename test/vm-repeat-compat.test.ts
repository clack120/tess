import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';

const block = (id: string, type: string, params: unknown[] = [], statements: unknown[][] = []) => ({ id, type, params, statements });

test('negative repeat counts report the Entry error without running following blocks', () => {
  for (const count of [-1, -0.01, -Infinity]) {
    const script = [[block('start', 'when_run_button_click'), block('repeat', 'repeat_basic', [count], [[]]),
      block('after', 'set_variable', ['out', 1])]];
    const vm = new Vm({ renderer: null, audio: null });
    vm.load({ scenes: [{ id: 's', name: 's' }], variables: [{ id: 'out', name: 'out', value: 0 }],
      objects: [{ id: 'o', name: 'o', scene: 's', script, entity: {} }], messages: [], functions: [] } as never);
    vm.start(); vm.tick();
    assert.equal(vm.variables[0]!.value, 0);
    assert.equal(vm.errors[0]?.code, 'negative_repeat');
    assert.equal(vm.errors[0]?.blockType, 'repeat_basic');
  }
});

test('zero and positive fractional repeat counts keep Entry rounding', () => {
  for (const [count, expected] of [[0, 0], [0.99, 0], [2.99, 2]]) {
    const vm = new Vm({ renderer: null, audio: null });
    assert.equal(vm.ops.repeatCount(count!), expected);
  }
});
