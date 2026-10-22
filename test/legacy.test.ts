import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@tess/compiler';
import { decompileProject } from '@tess/decompiler';
import { Vm } from '@tess/vm';
import { Codegen } from '../packages/tessvm/src/compile/codegen.ts';
import type { RawEntity } from '@tess/decompiler';

const number = (value: string) => ({ type: 'number', params: [value] });

function legacyProject(): RawEntity {
  return {
    name: 'legacy', speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [
      { id: 'v1', name: '값', variableType: 'variable', value: 0, visible: false, object: null, x: 0, y: 0 },
      { id: 'v2', name: '처음', variableType: 'variable', value: '', visible: false, object: null, x: 0, y: 0 },
      { id: 'l1', name: '기록', variableType: 'list', array: [{ data: 'a' }, { data: 'b' }], visible: false, object: null, x: 0, y: 0 },
    ],
    messages: [], functions: [], aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1', name: '주인공', objectType: 'sprite', scene: 'scene1', rotateMethod: 'free',
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        { type: 'set_scale_percent', params: [number('50'), null], statements: [] },
        { type: 'change_scale_percent', params: [number('-20'), null], statements: [] },
        { type: 'set_entity_effect', params: ['transparency', number('30'), null], statements: [] },
        { type: 'set_effect', params: ['opacity', number('70'), null], statements: [] },
        { type: 'set_effect_amount', params: ['transparency', number('-2'), null], statements: [] },
        { type: 'reset_project_timer', params: [null], statements: [] },
        { type: 'set_variable', params: ['v2', {
          type: 'value_of_index_from_list', params: [null, 'l1', null, { type: 'options_for_list', params: ['FIRST'] }, null],
        }, null], statements: [] },
        { type: 'remove_value_from_list', params: [number('1'), 'l1', null], statements: [] },
        {
          type: 'set_variable',
          params: ['v1', {
            type: 'calc_mod',
            params: [{ type: 'calc_share', params: [number('17'), null, number('5'), null] }, null, number('2'), null],
          }, null],
          statements: [],
        },
      ]]),
      entity: { x: 12, y: -8, scaleX: 1, scaleY: 1, visible: true },
      sprite: { pictures: [], sounds: [] }, selectedPictureId: null,
    }],
  } as unknown as RawEntity;
}

test('옛 블록도 tessvm 이 그대로 돈다', () => {
  const project = legacyProject();
  const program = new Codegen(project as never).compile();
  assert.deepEqual([...program.unknown.keys()], [], '모르는 블록이 없습니다');

  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as never);
  vm.start();
  vm.tick();
  assert.deepEqual(vm.errors, []);

  const entity = vm.targets[0]!.entity;
  assert.ok(Math.abs(entity.getScaleX() - 0.4) < 1e-9, String(entity.getScaleX()));
  assert.ok(Math.abs(entity.getScaleY() - 0.4) < 1e-9);
  assert.ok(Math.abs(entity.effect.alpha - 0.72) < 1e-9, String(entity.effect.alpha));
  const list = vm.variables.find((variable) => variable.name === '기록')!;
  assert.equal(vm.variables.find((variable) => variable.name === '처음')!.getValue(), 'a');
  assert.deepEqual(list.getArray(), [{ data: 'b' }], '첫 항목이 지워집니다');
  assert.equal(Number(vm.variables.find((variable) => variable.name === '값')!.getValue()), 1);
});

test('옛 좌표 블록은 지금 좌표와 같은 값을 읽는다', () => {
  const project = legacyProject();
  const object = (project.objects as RawEntity[])[0]!;
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: 'set_variable',
      params: ['v1', {
        type: 'calc_basic',
        params: [{ type: 'get_x_coordinate', params: [null] }, 'PLUS', { type: 'get_y_coordinate', params: [null] }],
      }, null],
      statements: [],
    },
  ]]);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as never);
  vm.start();
  vm.tick();
  assert.equal(Number(vm.variables.find((variable) => variable.name === '값')!.getValue()), 4, 'x(12) + y(-8)');
});

test('옛 블록은 되돌릴 때 지금 문법으로 옮겨지고 다시 컴파일된다', () => {
  const back = decompileProject(legacyProject(), [], { inline: true });
  assert.deepEqual(back.warnings, [], back.warnings.join('\n'));
  for (const line of [
    /scale_x = 50 \* 100 \/ 100/, /scale_y = 50 \* 100 \/ 100/,
    /size = size \* \(-20 \+ 100\) \/ 100/,
    /effect_alpha = 30/,
    /effect_alpha = 100 - 70/,
    /effect_alpha \+= -2/,
    /reset timer/,
    /처음 = 기록\["FIRST"\]/,
    /remove 기록\[1\]/,
    /값 = \(\(17 \/\/ 5\) % 2\)/,
  ]) {
    assert.match(back.source, line, String(line));
  }
  const again = compileProject(back.source, { path: 'main.tess' });
  assert.deepEqual(again.errors.map((error) => error.message), []);
});

// Legacy sizes use saved scale, while Tess axis scales use the original costume size.
test('옛 크기 블록은 저장된 배율에서 잰다', () => {
  const project = legacyProject();
  const object = (project.objects as RawEntity[])[0]!;
  (object.entity as RawEntity).scaleX = 0.54;
  (object.entity as RawEntity).scaleY = 0.54;
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: 'set_scale_percent', params: [number('10'), null], statements: [] },
  ]]);

  const direct = new Vm({ renderer: null, audio: null });
  direct.load(project as never);
  direct.start();
  direct.tick();
  assert.ok(Math.abs(direct.targets[0]!.entity.getScaleX() - 0.054) < 1e-9, '저장된 배율의 10%');

  const back = decompileProject(project, [], { inline: true });
  assert.match(back.source, /scale_x = 10 \* 54 \/ 100/);
  const again = compileProject(back.source, { path: 'main.tess' });
  assert.deepEqual(again.errors.map((error) => error.message), []);
  const rebuilt = again.project as unknown as RawEntity;
  const entity = ((rebuilt.objects as RawEntity[])[0]!.entity as RawEntity);
  entity.width = 100;
  entity.height = 100;
  const round = new Vm({ renderer: null, audio: null });
  round.load(rebuilt as never);
  round.start();
  for (let i = 0; i < 3; i += 1) round.tick();
  // Measuring an axis can leave a small floating-point error in both runtimes.
  const scaled = round.targets[0]!.entity.getScaleX();
  assert.ok(Math.abs(scaled - 0.054) / 0.054 < 1e-5, `되돌린 뒤에도 같아야 합니다 (${scaled})`);
});

test('`stop object` 는 복제본까지 이 오브젝트의 코드를 멈춘다', () => {
  const source = 'scene "s":\n  object "o":\n    when start do\n      stop object\n    end\n  end\nend';
  const result = compileProject(source, { path: 'main.tess' });
  assert.deepEqual(result.errors.map((error) => error.message), []);
  const block = JSON.parse(
    String(((result.project as unknown as RawEntity).objects as RawEntity[])[0]!.script),
  )[0][1];
  assert.equal(block.type, 'stop_object');
  assert.equal(block.params[0], 'thisObject', '엔트리의 옛 값 그대로 나갑니다');

  const back = decompileProject(result.project as unknown as RawEntity, [], { inline: true });
  assert.match(back.source, /stop object/);
});

// Legacy arithmetic stores the operator in the block type and operands at indices 0 and 2.
test('옛 연산 블록은 지금 연산자와 같은 값을 낸다', () => {
  const project = legacyProject();
  const object = (project.objects as RawEntity[])[0]!;
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: 'set_variable',
      params: ['v1', {
        type: 'calc_plus',
        params: [
          { type: 'calc_times', params: [number('3'), null, number('4')] },
          null,
          {
            type: 'calc_divide',
            params: [{ type: 'calc_minus', params: [number('10'), null, number('4')] }, null, number('2')],
          },
        ],
      }, null],
      statements: [],
    },
    {
      type: '_if',
      params: [{ type: 'boolean_bigger', params: [number('5'), null, number('3')] }],
      statements: [[
        { type: 'add_value_to_list', params: [number('1'), 'l1', null], statements: [] },
      ]],
    },
    {
      type: '_if',
      params: [{ type: 'boolean_smaller', params: [number('5'), null, number('3')] }],
      statements: [[
        { type: 'add_value_to_list', params: [number('2'), 'l1', null], statements: [] },
      ]],
    },
    {
      type: '_if',
      params: [{ type: 'boolean_equal', params: [number('3'), null, number('3')] }],
      statements: [[
        { type: 'add_value_to_list', params: [number('3'), 'l1', null], statements: [] },
      ]],
    },
  ]]);

  const program = new Codegen(project as never).compile();
  assert.deepEqual([...program.unknown.keys()], [], '모르는 블록이 없습니다');

  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as never);
  vm.start();
  vm.tick();
  assert.equal(Number(vm.variables.find((variable) => variable.name === '값')!.getValue()), 15);
  const list = vm.variables.find((variable) => variable.name === '기록')!;
  assert.deepEqual(
    list.getArray().map((item: { data: unknown }) => String(item.data)),
    ['a', 'b', '1', '3'],
    '5 > 3 과 3 == 3 만 참입니다',
  );

  const back = decompileProject(project, [], { inline: true });
  assert.deepEqual(back.warnings, [], back.warnings.join('\n'));
  for (const line of [
    /값 = \(\(3 \* 4\) \+ \(\(10 - 4\) \/ 2\)\)/,
    /if \(5 > 3\):/, /if \(5 < 3\):/, /if \(3 == 3\):/,
  ]) {
    assert.match(back.source, line, String(line));
  }
  const again = compileProject(back.source, { path: 'main.tess' });
  assert.deepEqual(again.errors.map((error) => error.message), []);
});
