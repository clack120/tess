import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@entropy/vm';

test('Entry math operations validate inverse trig ranges and unknown menu values', () => {
  const vm = new Vm({ renderer: null, audio: null });
  assert.equal(vm.ops.mathOp(1, 'asin_radian'), 90);
  assert.equal(vm.ops.mathOp(-1, 'acos_radian'), 180);
  assert.throws(() => vm.ops.mathOp(1.01, 'asin_radian'), /-1 이상 1 이하/);
  assert.throws(() => vm.ops.mathOp(-1.01, 'acos_radian'), /-1 이상 1 이하/);
  assert.equal(vm.ops.mathOp(1.8, 'sin_unknown'), 2);
  assert.equal(vm.ops.mathOp(0.8, 'asin'), 1);
  assert.equal(vm.ops.mathOp(0.8, 'atan_radian'), Math.atan(0.8) * 180 / Math.PI);
});

test('an out-of-range inverse trig input reports an error instead of continuing', () => {
  const block = (id: string, type: string, params: unknown[]) => ({ id, type, params, statements: [] });
  const script = [[block('start', 'when_run_button_click', []),
    block('set', 'set_variable', ['v', block('math', 'calc_operation', [null, 2, null, 'asin_radian'])]),
    block('after', 'set_variable', ['v', 7])]];
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 'scene' }], variables: [{ id: 'v', name: 'v', value: 0 }],
    objects: [{ id: 'o', name: 'actor', scene: 's', script: JSON.stringify(script), entity: {} }],
    functions: [], messages: [] } as never);
  vm.start(); vm.tick();
  assert.equal(vm.variables[0]!.value, 0);
  assert.equal(vm.errors[0]?.blockType, 'calc_operation');
  assert.match(vm.errors[0]?.message ?? '', /-1 이상 1 이하/);
});

test('optimized value functions fall back before reporting inverse trig domain errors', async () => {
  const { compileProject } = await import('@entropy/compiler');
  const compiled = compileProject(`var out = 0
function f():
 stop
 return asin(2)
end
object "o":
 when start do
  out = f()
 end
end`);
  assert.deepEqual(compiled.errors, []);
  for (const kernel of [false, true]) {
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(structuredClone(compiled.project) as never); vm.start(); vm.tick();
    assert.equal(vm.errors[0]?.code, 'math_domain', `kernel=${kernel}`);
    assert.equal(vm.variables[0]!.value, 0);
    if (kernel) {
      assert.ok(vm.kernel!.roots.size > 0);
      assert.ok(vm.kernel!.stats.fallbacks > 0);
    }
  }
});

test('optimized functions use Entry fallback for unknown math menu values', async () => {
  const { compileProject } = await import('@entropy/compiler');
  for (const operator of ['sin_unknown', 'asin']) {
    const compiled = compileProject(`var out = 0
function f():
 stop
 return sin(0.8)
end
object "o":
 when start do
  out = f()
 end
end`);
    const fn = compiled.project!.functions[0]!;
    const content = JSON.parse(fn.content as string);
    content[0][0].params[3].params[3] = operator;
    fn.content = JSON.stringify(content);
    for (const kernel of [false, true]) {
      const vm = new Vm({ renderer: null, audio: null, kernel });
      vm.load(structuredClone(compiled.project) as never); vm.start(); vm.tick();
      assert.equal(vm.variables[0]!.value, 1, `${operator} kernel=${kernel}`);
      if (kernel) assert.ok(vm.kernel!.stats.runs > 0);
    }
  }
});
