import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';

test('fractional character positions return undefined, including when used as text', () => {
  const block = (id: string, type: string, params: unknown[]) => ({ id, type, params, statements: [] });
  const character = block('char', 'char_at', [null, 'abc', null, 1.5]);
  const length = block('length', 'length_of_string', [null, character]);
  const script = [[block('start', 'when_run_button_click', []), block('set', 'set_variable', ['out', length])]];
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 'scene' }], variables: [{ id: 'out', name: 'out', value: 0 }],
    objects: [{ id: 'o', name: 'actor', scene: 's', script: JSON.stringify(script), entity: {} }],
    functions: [], messages: [] } as never);
  assert.equal(vm.ops.charAt('abc', 1.5), undefined);
  vm.start(); vm.tick();
  assert.equal(vm.variables[0]!.value, 9);
  assert.equal(vm.errors.length, 0);
});
