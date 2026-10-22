import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@tess/vm';
import fs from 'node:fs';
import { ENTRY_SCHEMA_VERSION } from '../packages/tessvm/src/compile/block-shapes.ts';
import { Codegen } from '../packages/tessvm/src/compile/codegen.ts';
import type { FunctionEntry, RawBlock } from '../packages/tessvm/src/compile/codegen.ts';

let nextId = 0;
const block = (type: string, params: unknown[] = [], statements?: RawBlock[][]): RawBlock => ({
  id: `block-${nextId++}`, type, params, ...(statements ? { statements } : {}),
});

function work(target: unknown = 'all') {
  return {
    scenes: [{ id: 'one', name: 'one' }, { id: 'two', name: 'two' }],
    variables: [{ id: 'out', name: 'out', variableType: 'variable', value: -1 }],
    messages: [], functions: [] as FunctionEntry[], tables: [],
    objects: [
      { id: 'a', name: 'a', scene: 'one', objectType: 'sprite', entity: {},
        script: [
          [block('when_run_button_click'), block('set_variable', ['out', block('get_block_count', [target])]), block('locate_x', [10])],
          [block('move_direction', [20])],
          [block('comment', ['workspace note'])],
        ],
      },
      { id: 'b', name: 'b', scene: 'one', objectType: 'sprite', entity: {},
        script: [[block('when_object_click'), block('repeat_basic', [block('number', ['3'])], [[block('move_direction', [block('calc_plus', [1, null, 2])])]])]],
      },
      { id: 'c', name: 'c', scene: 'two', objectType: 'sprite', entity: {},
        script: [[block('when_run_button_click'), block('move_direction', [1])]],
      },
    ],
  };
}

function shapedWork() {
  const project = work();
  project.objects[1]!.script = [[block('when_object_click'),
    block('unknown_future_block', [block('calc_plus', [1, null, 2])], [[block('move_direction', [1])]]),
    block('move_direction', [block('number', [block('calc_plus', [1, null, 2])])]),
    block('set_variable', [block('calc_plus', [1, null, 2]), block('calc_plus', [
      1, block('calc_plus', [1, null, 2]), block('calc_plus', [1, null, 2]),
    ])]),
    block('repeat_basic', [block('True', [block('calc_plus', [1, null, 2])])], [
      [block('move_direction', [1])], [block('move_direction', [block('calc_plus', [1, null, 2])])],
    ]),
    block('move_direction', [block('unknown_future_block', [block('calc_plus', [1, null, 2])])]),
    block('move_direction', [block('stringParam_unknown')]),
    block('move_direction', [block('constructor')]),
    block('comment', ['note']),
  ], [block('pingpong_lite_g2_when_button_pressed'), block('move_direction', [1])]];
  project.objects[2]!.script.push([block('function_create')]);
  return project;
}

function functionWork() {
  const project = work();
  const param = 'stringParam_arg';
  project.functions = [{ id: 'f', type: 'value', localVariables: [], content: [[
    block('function_create_value', [block('function_field_string', [block(param)])]),
    block('move_direction', [block('calc_plus', [1, null, 2])]),
    block('move_direction', [block('stringParam_other')]),
  ]] }];
  project.objects[1]!.script = [[block('when_object_click'),
    block('func_f', [block('calc_plus', [1, null, 2]), block('calc_plus', [1, null, 2])]),
    block('move_direction', [block(param)]),
    block('move_direction', [block('stringParam_other')]),
    block('move_direction', [block('stringParam_unknown')]),
    block('func_missing', [block('calc_plus', [1, null, 2])]),
  ]];
  return project;
}

async function run(project: ReturnType<typeof work>, kernel = false) {
  const vm = new Vm({ renderer: null, audio: null, kernel });
  vm.load(project as never); vm.start();
  for (let i = 0; i < 10; i++) {
    vm.tick();
    await Promise.resolve();
  }
  assert.deepEqual(vm.errors, []);
  return vm;
}

test('block counts include only event threads and exclude primitive inputs', async () => {
  for (const kernel of [false, true]) {
    for (const [target, expected] of [
      ['all', 10], ['self', 4], ['object-a', 4], ['object-b', 4], ['object-c', 2],
      ['scene-one', 8], ['scene-two', 2], ['scene-missing', 0], ['object-missing', 10],
      ['missing', 0], ['', 0], [null, 0], [0, 0], [false, 0], [[], 0], [['all'], 0],
    ] as const) {
      const vm = await run(work(target), kernel);
      assert.equal(vm.variables[0]!.value, expected, `${String(target)} / kernel=${kernel}`);
    }
  }
});

test('block count waits for a promise even when its target has no blocks', async () => {
  const vm = new Vm({ renderer: null, audio: null, kernel: false });
  vm.load(work('scene-missing') as never); vm.start(); vm.tick();
  assert.equal(vm.variables[0]!.value, -1);
  assert.equal(vm.targets[0]!.entity.x, 0);
  vm.pause();
  await Promise.resolve();
  vm.advance(1000);
  assert.equal(vm.variables[0]!.value, -1);
  vm.start();
  for (let i = 0; i < 3; i++) { await Promise.resolve(); vm.tick(); }
  assert.equal(vm.variables[0]!.value, 0);
  assert.equal(vm.targets[0]!.entity.x, 10);
});

test('projects without a block-count read have no count table in their generated source', () => {
  const project = work();
  project.objects[0]!.script = [[block('when_run_button_click'), block('move_direction', [1])]];
  const source = new Codegen(project as never).compile().source;
  assert.doesNotMatch(source, /\bconst B\s*=/);
});

test('block counts follow native schema slots, defaults, hardware hats, and unknown blocks', async () => {
  for (const kernel of [false, true]) {
    const vm = await run(shapedWork(), kernel);
    assert.equal(vm.variables[0]!.value, 21);
  }
});

test('block counts register function inputs without expanding function bodies', async () => {
  for (const kernel of [false, true]) {
    const vm = await run(functionWork(), kernel);
    assert.equal(vm.variables[0]!.value, 14);
  }
});

test('reporter and stack probes count the loaded work without adding themselves or clones', async () => {
  const project = work();
  const vm = await run(project);
  vm.addClone(vm.targets[0]!, vm.targets[0]!.entity);
  assert.equal(await vm.evaluate(block('get_block_count', ['all']), 'a'), 10);
  assert.equal(await vm.evaluate(block('get_block_count', ['self']), 'b'), 4);
  vm.runStack([block('switch_scope', ['b']), block('set_variable', ['out', block('get_block_count', ['self'])])], 'a');
  for (let i = 0; i < 3; i++) { await Promise.resolve(); vm.tick(); }
  assert.equal(vm.variables[0]!.value, 4);
  const built = new Function('R', vm.compiledSource(project as never))(vm);
  const task = built.scripts[0](vm.targets[0]!.entity, { state: {} });
  assert.equal(task.next().done, false);
  await Promise.resolve(); task.next();
  assert.equal(vm.variables[0]!.value, 10);
});

test('invalid dropdown data is not evaluated and rejects with the original reporter location', async () => {
  for (const kernel of [false, true]) for (const target of [true, 1, {}, ['scene-'], ['object-'], block('set_variable', ['out', 99])]) {
    const project = work(target);
    const reporter = (project.objects[0]!.script[0]![1]!.params[1] as RawBlock);
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.onError = () => vm.stop();
    vm.load(project as never); vm.start(); vm.tick();
    assert.equal(vm.variables[0]!.value, -1);
    assert.equal(vm.errors.length, 0);
    await Promise.resolve(); vm.tick();
    assert.equal(vm.variables[0]!.value, -1);
    assert.equal(vm.targets[0]!.entity.x, 0);
    assert.equal(vm.errors.length, 1);
    assert.equal(vm.errors[0]!.blockId, reporter.id);
    assert.equal(vm.errors[0]!.blockType, 'get_block_count');
    assert.match(vm.errors[0]!.stack!, /indexOf|substr/);
    assert.equal(vm.state, 'stop');
  }
});

test('block schema traits match the installed Entry version', () => {
  const entry = JSON.parse(fs.readFileSync(new URL('../node_modules/@entrylabs/entry/package.json', import.meta.url), 'utf8'));
  assert.equal(ENTRY_SCHEMA_VERSION, entry.version, 'Refresh block shapes after upgrading Entry');
});
