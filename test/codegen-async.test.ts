import test from 'node:test';
import assert from 'node:assert/strict';
import { Codegen, type CompileInput, type RawBlock } from '../packages/vm/src/compile/codegen.ts';
import { compileProject } from '@entropy/compiler';
import { Vm } from '@entropy/vm';

const source = `var out = 0
function f(n):
  var local = n
  repeat 3 do
    local += 1
    if local > 5 then
      continue
    end
    out += local
  end
  return local
end
object "actor":
  when start do
    repeat 2 do
      out += f(3)
    end
    say "🙂 /*@entropy:999*/ \\u2028"
  end
end`;

for (const liveEditing of [false, true]) {
  test(`cooperative compilation preserves code, trace locations and scoped control flow (live=${liveEditing})`, async () => {
    const result = compileProject(source); assert.deepEqual(result.errors, []);
    const vm = new Vm({ liveEditing, renderer: null, audio: null });
    vm.load(result.project as never);
    const input = (vm as unknown as { compileInput: CompileInput }).compileInput;
    const sync = new Codegen(input).compile();
    let yields = 0;
    const asyncProgram = await new Codegen(input).compileAsync(() => { yields++; return Promise.resolve(); });
    assert.ok(yields > 0);
    assert.equal(asyncProgram.source.replace(asyncProgram.trace.sourceId, 'source.js'), sync.source.replace(sync.trace.sourceId, 'source.js'));
    assert.deepEqual(asyncProgram.trace.sites, sync.trace.sites);
    assert.deepEqual(asyncProgram.plans, sync.plans);
    assert.deepEqual(asyncProgram.unknown, sync.unknown); assert.deepEqual(asyncProgram.keys, sync.keys);
    vm.start(); for (let i = 0; i < 30; i++) vm.tick();
    assert.deepEqual(vm.errors, []);
    assert.equal(Number(vm.variables.find(variable => variable.name === 'out')!.value), 30);
  });
}

function largeInput(nested: boolean): CompileInput {
  const body: RawBlock[] = Array.from({ length: 2000 }, (_, index) => ({ id: String(index), type: 'future_block', params: [] }));
  return { liveEditing: true, objects: [{ id: 'o', script: [[{ id: 'hat', type: 'when_run_button_click', params: [] },
    ...(nested ? [{ id: 'loop', type: 'repeat_basic', params: [2], statements: [body] }] : body)]] }],
    variables: [], functions: [], scenes: [], messages: [], tables: [] };
}

for (const nested of [false, true]) {
  test(`a large ${nested ? 'nested' : 'flat'} stack can be cancelled before all its blocks compile`, async () => {
    const codegen = new Codegen(largeInput(nested)), controller = new AbortController();
    await assert.rejects(codegen.compileAsync(() => {
      assert.ok((codegen.unknown.get('future_block') ?? 0) < 2000);
      controller.abort(); return Promise.resolve();
    }, controller.signal), { name: 'AbortError' });
  });
}

test('trace indexing yields and allows cancellation while a large module is being emitted', async () => {
  const codegen = new Codegen(largeInput(false)), controller = new AbortController();
  let cancelledDuringEmission = false;
  await assert.rejects(codegen.compileAsync(() => {
    if (codegen.trace.sites.length > 0 && codegen.trace.sites.length < 2000) {
      cancelledDuringEmission = true; controller.abort();
    }
    return Promise.resolve();
  }, controller.signal), { name: 'AbortError' });
  assert.equal(cancelledDuringEmission, true);
});
