import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';

function createVm(message: unknown) {
  const block = (id: string, type: string, params: unknown[]) => ({ id, type, params, statements: [] });
  const script = [[block('start', 'when_run_button_click', []), block('ask', 'ask_and_wait', [message]),
    block('after', 'set_variable', ['out', 1])]];
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], variables: [{ id: 'out', name: 'out', value: 0 }],
    objects: [{ id: 'o', name: 'o', scene: 's', script, entity: {} }], messages: [], functions: [] } as never);
  vm.start(); vm.tick();
  return vm;
}

test('empty question stops the script with an identifiable error', () => {
  const vm = createVm('');
  assert.equal(vm.errors[0]?.code, 'empty_question');
  assert.equal(vm.errors[0]?.blockType, 'ask_and_wait');
  assert.equal(vm.question, null);
  assert.equal(vm.variables[0]!.value, 0);
});

test('zero and false questions are valid', () => {
  for (const message of [0, false]) {
    const vm = createVm(message);
    assert.equal(vm.errors.length, 0);
    assert.equal(vm.question, String(message));
  }
});
