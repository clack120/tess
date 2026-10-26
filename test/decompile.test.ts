import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decompileProject, restoreTableRows } from '@entropy/decompiler';
import { compileProject } from '@entropy/compiler';
import type { RawEntity } from '@entropy/decompiler';
import { safeIdentifier } from '../packages/decompiler/src/ident.ts';

const utf8 = (data: Uint8Array) => new TextDecoder('utf-8').decode(data);

test('very deep Entry reporter blocks still unfold into editable Entropy source', () => {
  const depth = 4_000;
  const open = Array.from({ length: depth }, (_, index) =>
    `{"id":"deep-${index}","type":"boolean_not","params":[null,`).join('');
  const leaf = '{"id":"leaf","type":"True","params":[null],"statements":[]}';
  const project = minimalProject();
  const value = `${open}${leaf}${'],"statements":[]}'.repeat(depth)}`;
  const hat = '{"type":"when_run_button_click","params":[null],"statements":[]}';
  const say = `{"type":"dialog","params":[${value},"speak",null],"statements":[]}`;
  project.objects[0].script = `[[${hat},${say}]]`;
  const source = decompileProject(project, [], { inline: true }).source;
  assert.match(source, /say true/);
  const compiled = compileProject(source);
  assert.deepEqual(compiled.errors, []);
  assert.ok(compiled.project);
});

test('paired not blocks keep Boolean conversion for non-Boolean values', () => {
  const project = minimalProject();
  project.objects = project.objects.slice(0, 1);
  const text = { type: 'text', params: ['hello'], statements: [] };
  const inner = { type: 'boolean_not', params: [null, text, null], statements: [] };
  const outer = { type: 'boolean_not', params: [null, inner, null], statements: [] };
  project.objects[0].script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: 'dialog', params: [outer, 'speak', null], statements: [] },
  ]]);
  const result = decompileProject(project, [], { inline: true });
  assert.match(result.source, /say not \(not \("hello"\)\)/);
  const compiled = compileProject(result.source);
  assert.deepEqual(compiled.errors, []);
  const value = JSON.parse(compiled.project!.objects[0]!.script)[0][1].params[0];
  assert.equal(value.type, 'boolean_not');
  assert.equal(value.params[1].type, 'boolean_not');
  assert.equal(decompileProject(compiled.project!, [], { inline: true }).source, result.source);
});

test('many colliding names advance their suffix instead of rescanning from two', () => {
  const used = new Set(['same_2', 'same_4']);
  assert.equal(safeIdentifier('same', used), 'same');
  assert.equal(safeIdentifier('same', used), 'same_3');
  assert.equal(safeIdentifier('same', used), 'same_5');
  for (let index = 0; index < 10_000; index += 1) safeIdentifier('same', used);
  assert.equal(used.size, 10_005);
});

test('duplicate reserved names keep their spelling over repeated decompilation', () => {
  const names = new Set<string>();
  const first = safeIdentifier('reset', names);
  const second = safeIdentifier('reset', names);
  assert.equal(first, 'reset_');
  assert.equal(second, 'reset_2');
  const next = new Set<string>();
  assert.equal(safeIdentifier(first, next), first);
  assert.equal(safeIdentifier(second, next), second);
});

test('initial values preserve leading zeroes, precision and boolean spelling', () => {
  const values = ['000190', '030', '01', '1.0', '-0', '9007199254740993',
    '000001012023024025026027028029002003004005006007008009',
    'true', 'false', 'TRUE', 'FALSE', '', '12', '-0.5'];
  const project = minimalProject();
  project.variables = [
    ...values.map((value, index) => ({
      id: `value${index}`, name: `value${index}`, variableType: 'variable', value,
    })),
    { id: 'packed', name: 'packed', variableType: 'list', array: values.map((data) => ({ data })) },
  ];
  const decompiled = decompileProject(project, [], { inline: true });
  const compiled = compileProject(decompiled.source);
  assert.deepEqual(compiled.errors, []);
  const variables = compiled.project!.variables;
  values.forEach((value, index) => {
    assert.equal(variables.find((item) => item.name === `value${index}`)!.value, value);
  });
  assert.deepEqual(variables.find((item) => item.name === 'packed')!.array!.map((item) => item.data), values);
});


function minimalProject(sceneCount = 1): RawEntity {
  const startHat = () => ({ type: 'when_run_button_click', params: [null], statements: [] });
  const waitOneSecond = () => ({
    type: 'wait_second',
    params: [{ type: 'number', params: ['1'] }, null],
    statements: [],
  });

  const scenes = sceneCount === 1
    ? [{ id: 'scene1', name: '장면 1' }]
    : [{ id: 'scene1', name: '장면 1' }, { id: 'scene2', name: '장면 2' }];

  return {
    name: '되돌리기 테스트',
    speed: 60,
    scenes,
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [
      {
        id: 'obj1',
        name: '주인공',
        objectType: 'sprite',
        scene: 'scene1',
        rotateMethod: 'free',
        script: JSON.stringify([[startHat(), waitOneSecond()]]),
        entity: { x: 10, y: 0, scaleX: 1, scaleY: 1, visible: true },
        sprite: { pictures: [], sounds: [] },
        selectedPictureId: null,
      },
      {
        id: 'obj2',
        name: '점수판',
        objectType: 'textBox',
        scene: sceneCount === 1 ? 'scene1' : 'scene2',
        rotateMethod: 'free',
        script: JSON.stringify([[startHat(), waitOneSecond()]]),
        entity: {
          x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true,
          colour: '#ff0000', bgColor: '#ffffff', font: '20px Nanum Gothic', fontSize: 20,
        },
        text: '점수: 0',
        sprite: { pictures: [], sounds: [] },
      },
    ],
  };
}

test('되돌리기는 기본적으로 오브젝트마다 objects/이름.etp 조각 파일을 만든다', () => {
  const project = minimalProject(1);
  const result = decompileProject(project, []);

  assert.match(result.source, /use "scene\/장면_1\.etp"/);
  const scene = utf8(result.files.find((file) => file.path === 'scene/장면_1.etp')!.data);
  assert.match(scene, /useobject "\.\.\/objects\/주인공\.etp"/);
  assert.match(scene, /usetext "\.\.\/objects\/점수판\.etp"/);
  assert.doesNotMatch(result.source, /object "주인공"/);
  assert.doesNotMatch(result.source, /text "점수판"/);

  const fragmentPaths = result.files.map((a) => a.path).sort();
  assert.deepEqual(fragmentPaths, ['objects/점수판.etp', 'objects/주인공.etp', 'scene/장면_1.etp']);
  assert.deepEqual(result.assets, []);

  const heroFragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.doesNotMatch(heroFragment, /^object /m);
  assert.match(heroFragment, /^when start do$/m);
  assert.match(heroFragment, /^ {2}wait 1$/m);
});

test('장면이 여러 개면 objects/장면이름/이름.etp 로 장면마다 폴더를 나눈다', () => {
  const project = minimalProject(2);
  const result = decompileProject(project, []);

  const scenes = result.files.filter((file) => file.path.startsWith('scene/')).map((file) => utf8(file.data)).join('\n');
  assert.match(scenes, /useobject "\.\.\/objects\/장면_1\/주인공\.etp"/);
  assert.match(scenes, /usetext "\.\.\/objects\/장면_2\/점수판\.etp"/);

  const fragmentPaths = result.files.map((a) => a.path).sort();
  assert.deepEqual(fragmentPaths, ['objects/장면_1/주인공.etp', 'objects/장면_2/점수판.etp', 'scene/장면_1.etp', 'scene/장면_2.etp']);
});

test('되돌린 결과(main.etp + 조각 파일)는 다시 정상적으로 컴파일된다', () => {
  const project = minimalProject(1);
  const result = decompileProject(project, []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-'));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }

  const recompiled = compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));
  assert.equal(recompiled.project!.objects.length, 2);
  assert.deepEqual(
    recompiled.project!.objects.map((o) => o.objectType).sort(),
    ['sprite', 'textBox'],
  );
});

function trickProject() {
  const startHat = () => ({ type: 'when_run_button_click', params: [null], statements: [] });
  const literal = (value: any) => ({ type: 'text', params: [value] });

  return {
    name: '트릭 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: {
        pictures: [
          { id: 'pic1', name: '기본', fileurl: null, dimension: { width: 10, height: 10 } },
          { id: '0cdd', name: '점프', fileurl: null, dimension: { width: 10, height: 10 } },
        ],
        sounds: [
          { id: 'snd1', name: '점프음', fileurl: null, ext: '.mp3', duration: 1 },
          { id: 'xk9q', name: '효과음', fileurl: null, ext: '.mp3', duration: 1 },
        ],
      },
      script: JSON.stringify([[
        startHat(),
        // Use literal resource IDs rather than dropdown blocks to exercise hardcoded references.
        { type: 'sound_something_with_block', params: [literal('xk9q'), null], statements: [] },
        { type: 'change_to_some_shape', params: [literal('0cdd'), null], statements: [] },
        // Numeric resource values are indices, not hardcoded IDs.
        { type: 'change_to_some_shape', params: [{ type: 'number', params: ['2'] }, null], statements: [] },
      ]]),
    }],
  };
}

// Another function's parameter is absent from Entry's running paramMap and reads as empty.
test('슬라이드 변수는 범위째로 되돌아오고 다시 컴파일해도 슬라이드다', () => {
  const project = minimalProject() as unknown as Record<string, unknown>;
  project.variables = [
    { id: 'v1', name: 'depth', variableType: 'slide', value: 2, minValue: 0, maxValue: 4, visible: false },
    { id: 'v2', name: 'plain', variableType: 'variable', value: 7, visible: false },
  ];
  const result = decompileProject(project as unknown as RawEntity, [], { inline: true });
  assert.match(result.source, /^var depth = 2 from 0 to 4$/m);
  assert.match(result.source, /^var plain = 7$/m);

  const compiled = compileProject(result.source, { path: 'main.etp' });
  assert.equal(compiled.errors.length, 0, compiled.errors[0]?.message);
  const depth = compiled.project!.variables.find((item) => item.name === 'depth')!;
  assert.equal(depth.variableType, 'slide');
  assert.equal(depth.minValue, 0);
  assert.equal(depth.maxValue, 4);
});

test('다른 함수의 매개변수를 가리키는 블록은 이름이 아니라 빈 값으로 되돌린다', () => {
  const project = minimalProject() as unknown as Record<string, unknown>;
  const header = (label: string, param: string) => ({
    type: 'function_field_label',
    params: [label, { type: 'function_field_string', params: [{ type: param, params: [] }] }],
  });
  project.functions = [
    {
      id: 'aaaa',
      content: JSON.stringify([[
        { type: 'function_create_value', params: [header('mine', 'stringParam_own'), null, null,
          { type: 'stringParam_other', params: [] }], statements: [[]] },
      ]]),
    },
    {
      id: 'bbbb',
      content: JSON.stringify([[
        { type: 'function_create_value', params: [header('yours', 'stringParam_other'), null, null,
          { type: 'stringParam_other', params: [] }], statements: [[]] },
      ]]),
    },
  ];
  const result = decompileProject(project as unknown as RawEntity, [], { inline: true });
  const mine = result.source.slice(result.source.indexOf('function mine('));
  assert.match(mine.slice(0, mine.indexOf('end')), /return 0/, '다른 함수의 매개변수는 빈 값이 된다');
  const yours = result.source.slice(result.source.indexOf('function yours('));
  assert.match(yours.slice(0, yours.indexOf('end')), /return a/, '자기 매개변수는 이름 그대로다');
  const compiled = compileProject(result.source, { path: 'main.etp' });
  assert.equal(
    compiled.errors.filter((error) => /선언되지 않은 이름/.test(error.message)).length,
    0,
    '되돌린 소스에 그 함수에 없는 이름이 남지 않는다',
  );
});

test('모양/소리 값에 진짜 엔트리 id 를 그대로 박아 넣은 트릭은 이름으로 되돌린다', () => {
  const result = decompileProject(trickProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^ {2}play sound "효과음"$/m);
  assert.match(fragment, /^ {2}costume = "점프"$/m);
  assert.match(fragment, /^ {2}costume = 2$/m);
  assert.doesNotMatch(fragment, /xk9q/);
  assert.doesNotMatch(fragment, /0cdd/);
});

test('되돌린 트릭 코드도 다시 정상적으로 컴파일된다', () => {
  const result = decompileProject(trickProject(), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-trick-'));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }

  const recompiled = compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));
});

const NUMBER_VALUES = [
  ['number 블록', (value: any) => ({ type: 'number', params: [value] })],
  ['text 블록', (value: any) => ({ type: 'text', params: [value] })],
  ['text 블록 · 숫자', (value: any) => ({ type: 'text', params: [Number(value)] })],
  ['number 블록 · 숫자', (value: any) => ({ type: 'number', params: [Number(value)] })],
  ['맨 문자열', (value: any) => value],
  ['맨 숫자', (value: any) => Number(value)],
];

function nthResourceProject(numberValue: any) {
  const startHat = () => ({ type: 'when_run_button_click', params: [null], statements: [] });

  return {
    name: '순번 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: {
        pictures: [
          { id: 'pic1', name: '기본', fileurl: null, dimension: { width: 10, height: 10 } },
          { id: 'pic2', name: '점프', fileurl: null, dimension: { width: 10, height: 10 } },
        ],
        sounds: [{ id: 'snd1', name: '점프음', fileurl: null, ext: '.mp3', duration: 1 }],
      },
      script: JSON.stringify([[
        startHat(),
        { type: 'change_to_some_shape', params: [numberValue('1'), null], statements: [] },
        { type: 'sound_something_with_block', params: [numberValue('1'), null], statements: [] },
      ]]),
    }],
  };
}

for (const [label, numberValue] of NUMBER_VALUES) {
  test(`모양·소리 순번(${label})은 문자열이 아니라 숫자로 되돌아온다`, () => {
    const result = decompileProject(nthResourceProject(numberValue), []);
    const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

    assert.match(fragment, /^ {2}costume = 1$/m);
    assert.match(fragment, /^ {2}play sound 1$/m);
    assert.doesNotMatch(fragment, /costume = "1"/);
    assert.doesNotMatch(fragment, /play sound "1"/);
  });

  test(`순번(${label})으로 되돌린 코드도 다시 정상적으로 컴파일된다`, () => {
    const result = decompileProject(nthResourceProject(numberValue), []);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-nth-'));
    const mainFile = path.join(dir, 'main.etp');
    fs.writeFileSync(mainFile, result.source);
    for (const asset of [...result.files, ...result.assets]) {
      const target = path.join(dir, asset.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, asset.data);
    }

    const recompiled = compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
    assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

    const thread = JSON.parse(recompiled.project!.objects[0].script)[0];
    const shape = thread.find((b: any) => b.type === 'change_to_some_shape');
    assert.equal(shape.params[0].type, 'number');
    assert.deepEqual(shape.params[0].params, ['1']);
  });
}

// Keep numeric-looking text unchanged when conversion would alter its spelling.
test('"01" 처럼 다시 적으면 달라지는 값은 숫자로 바꾸지 않는다', () => {
  const result = decompileProject(nthResourceProject(() => ({ type: 'text', params: ['01'] })), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^ {2}costume = "01"$/m);
});

test('coordinate_object 의 모양 번호·모양 이름도 자리표시자 없이 되돌아온다', () => {
  const source = `
scene "s":
  object "다른":
    default costume 기본 "a.png" size 1 1
  end
  object "o":
    default costume 기본 "a.png" size 1 1
    when start do
      var 이름 = costume("다른")
      var 번호 = costume_number("다른")
      var 내이름 = costume
      var 내번호 = costume_number
    end
  end
end`;
  const compiled = compileProject(source, { path: 'x.etp' });
  assert.deepEqual(compiled.errors, []);

  const decompiled = decompileProject(compiled.project!, []);
  assert.deepEqual(decompiled.warnings, []);

  const fragment = utf8(decompiled.files.find((a) => a.path === 'objects/o.etp')!.data);
  assert.doesNotMatch(fragment, /\[decompile/);
  assert.match(fragment, /^ {2}이름 = costume\("다른"\)$/m);
  assert.match(fragment, /^ {2}번호 = costume_number\("다른"\)$/m);
  assert.match(fragment, /^ {2}내이름 = costume$/m);
  assert.match(fragment, /^ {2}내번호 = costume_number$/m);
});

// Exercise both literal IDs and dropdown IDs inside functions.
const SHAPE_VALUES = [
  ['손으로 박아 넣은 id', (value: any) => ({ type: 'text', params: [value] })],
  ['드롭다운으로 고른 모양', (value: any) => ({ type: 'get_pictures', params: [value] })],
];

// A shared function also references the second object's costume.
function hardcodedFunctionProject(shapeValue: any, { shared = false } = {}) {
  const startHat = () => ({ type: 'when_run_button_click', params: [null], statements: [] });
  const sprite = (id: string, name: string, pictures: any) => ({
    id,
    name,
    objectType: 'sprite',
    scene: 'scene1',
    rotateMethod: 'free',
    selectedPictureId: pictures[0].id,
    entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true, regX: 5, regY: 5 },
    sprite: { pictures, sounds: [] },
    script: JSON.stringify([[startHat(), { type: 'func_fn1', params: [null], statements: [] }]]),
  });
  const picture = (id: string, name: string) => ({ id, name, fileurl: null, dimension: { width: 10, height: 10 } });

  const body = [{ type: 'change_to_some_shape', params: [shapeValue('qio1'), null], statements: [] }];
  if (shared) body.push({ type: 'change_to_some_shape', params: [shapeValue('zzz1'), null], statements: [] });

  return {
    name: '하드코딩 함수 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    aiUtilizeBlocks: [],
    objects: [
      sprite('obj1', '주인공', [picture('pic1', '기본'), picture('qio1', '점프')]),
      sprite('obj2', '조연', [picture('pic2', '기본'), picture('zzz1', '구르기')]),
    ],
    functions: [{
      id: 'fn1',
      content: JSON.stringify([[{
        type: 'function_create',
        params: [{ type: 'function_field_label', params: ['점프하기', null] }],
        statements: [body],
      }]]),
    }],
  };
}

for (const shared of [false, true]) {
  test(`배열로 저장된 스크립트와 함수도 본문·변수 복구·리소스 참조를 보존한다 (shared=${shared})`, () => {
    const project: RawEntity = hardcodedFunctionProject(
      (value: any) => ({ type: 'text', params: [value] }), { shared },
    );
    const script = JSON.parse(project.objects[0].script);
    script[0].push({ type: 'set_variable', params: [
      'deleted', { type: 'number', params: ['1'] }, null,
    ] });
    project.objects[0].script = JSON.stringify(script);
    const expected = decompileProject(project, []);

    for (const object of project.objects) object.script = JSON.parse(object.script);
    for (const fn of project.functions) fn.content = JSON.parse(fn.content);
    const actual = decompileProject(project, []);

    assert.deepEqual(actual, expected);
    assert.match(utf8(actual.files.find((file) => file.path === "var.etp")!.data), /^var missing_var_deleted = 0$/m);
    const fragment = utf8(actual.files.find((asset) => asset.path === 'objects/주인공.etp')!.data);
    assert.match(fragment, /^when start do\n  점프하기\(\)\n  missing_var_deleted = 1\nend$/m);
  });
}

function recompileResult(result: any, prefix: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }
  return compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
}

for (const [label, shapeValue] of SHAPE_VALUES) {
  test(`한 오브젝트만 건드리는 함수(${label})는 그 오브젝트 조각 파일로 옮기고 이름을 쓴다`, () => {
    const result = decompileProject(hardcodedFunctionProject(shapeValue), []);
    assert.deepEqual(result.warnings, []);

    assert.doesNotMatch(result.source, /^function /m);

    const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
    assert.match(fragment, /^function 점프하기\(\):$/m);
    assert.match(fragment, /^ {2}costume = "점프"$/m);
    assert.doesNotMatch(fragment, /qio1/);

    assert.ok(fragment.indexOf('when start do') < fragment.indexOf('function 점프하기'));
  });

  test(`옮긴 함수(${label})를 다시 컴파일하면 원래 모양을 그대로 가리킨다`, () => {
    const result = decompileProject(hardcodedFunctionProject(shapeValue), []);
    const recompiled = recompileResult(result, 'entropy-decompile-owned-');
    assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

    const hero = recompiled.project!.objects.find((o) => o.name === '주인공');
    const jump = hero!.sprite.pictures.find((p) => p.name === '점프');
    const block = JSON.parse(recompiled.project!.functions[0].content)[0][0].statements[0][0];
    assert.equal(block.type, 'change_to_some_shape');
    assert.equal(block.params[0].type, 'get_pictures');
    assert.equal(block.params[0].params[0], jump!.id);
  });

  test(`두 오브젝트를 건드리는 함수(${label})는 전역에 남고 force id 를 쓴다`, () => {
    const result = decompileProject(hardcodedFunctionProject(shapeValue, { shared: true }), []);
    assert.deepEqual(result.warnings, []);

    assert.match(utf8(result.files.find((file) => file.path === "func.etp")!.data), /^function 점프하기\(\):$/m);
    assert.match(utf8(result.files.find((file) => file.path === "func.etp")!.data), /^ {2}costume = "qio1"$/m); // A global function must keep IDs because resource names depend on the caller.
    assert.match(utf8(result.files.find((file) => file.path === "func.etp")!.data), /^ {2}costume = "zzz1"$/m);

    const hero = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
    const other = utf8(result.files.find((a) => a.path === 'objects/조연.etp')!.data);
    assert.match(hero, /^costume 점프 "점프\.png" size 10 10 force id "qio1"$/m);
    assert.match(other, /^costume 구르기 "구르기\.png" size 10 10 force id "zzz1"$/m);
    assert.doesNotMatch(hero, /^function /m);
  });

  test(`전역에 남은 함수(${label})도 다시 컴파일하면 id 가 그대로 고정된다`, () => {
    const result = decompileProject(hardcodedFunctionProject(shapeValue, { shared: true }), []);
    const recompiled = recompileResult(result, 'entropy-decompile-forceid-');
    assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

    const hero = recompiled.project!.objects.find((o) => o.name === '주인공');
    assert.equal(hero!.sprite.pictures.find((p) => p.name === '점프')!.id, 'qio1');

    const block = JSON.parse(recompiled.project!.functions[0].content)[0][0].statements[0][0];
    assert.equal(block.params[0], 'qio1');
  });
}

// A function without resource references has no object owner and stays global.
test('모양·소리를 안 쓰는 함수는 전역에 그대로 둔다', () => {
  const project = hardcodedFunctionProject((value: any) => ({ type: 'text', params: [value] }));
  project.functions[0].content = JSON.stringify([[{
    type: 'function_create',
    params: [{ type: 'function_field_label', params: ['인사하기', null] }],
    statements: [[{ type: 'dialog', params: [{ type: 'text', params: ['안녕'] }, 'speak', null], statements: [] }]],
  }]]);

  const result = decompileProject(project, []);
  assert.match(utf8(result.files.find((file) => file.path === "func.etp")!.data), /^function 인사하기\(\):$/m);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.doesNotMatch(fragment, /^function /m);
});

function builtinObjectProject() {
  const media = (file: string) => `./bower_components/entry-js/images/media/${file}`;
  return {
    name: '엔트리봇 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    aiUtilizeBlocks: [],
    functions: [],
    objects: [{
      id: 'obj1',
      name: '엔트리봇',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'vx80',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: {
        pictures: [
          { id: 'vx80', name: '엔트리봇_걷기1', imageType: 'svg', fileurl: media('entrybot1.svg'), dimension: { width: 144, height: 246 } },
          { id: '4t48', name: '엔트리봇_걷기2', imageType: 'svg', fileurl: media('entrybot2.svg'), dimension: { width: 144, height: 246 } },
        ],
        sounds: [{ id: '8el5', name: '강아지 짖는 소리', ext: '.mp3', duration: 1.3, fileurl: media('bark.mp3') }],
      },
      script: JSON.stringify([[]]),
    }],
  };
}

test('엔트리 기본 오브젝트의 모양·소리는 entryjs 에서 꺼내 와 assets/ 에 담는다', () => {
  const result = decompileProject(builtinObjectProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/엔트리봇.etp')!.data);

  // Never emit unavailable bower_components paths into the source.
  assert.doesNotMatch(fragment, /bower_components/);
  // Let the compiler measure real image files so replacing an image does not require editing its size.
  assert.match(fragment, /^default costume 엔트리봇_걷기1 "assets\/image\/엔트리봇_엔트리봇_걷기1\.svg"$/m);
  assert.match(fragment, /^costume 엔트리봇_걷기2 "assets\/image\/엔트리봇_엔트리봇_걷기2\.svg"$/m);
  assert.match(fragment, /^sound 강아지_짖는_소리 "assets\/sound\/엔트리봇_강아지_짖는_소리\.mp3" for 1\.3 as "강아지 짖는 소리"$/m);

  for (const relative of ['assets/image/엔트리봇_엔트리봇_걷기1.svg', 'assets/image/엔트리봇_엔트리봇_걷기2.svg', 'assets/sound/엔트리봇_강아지_짖는_소리.mp3']) {
    const asset = result.assets.find((a) => a.path === relative);
    assert.ok(asset && asset.data.length > 0, `${relative} 의 실제 파일이 담겨 있어야 한다`);
  }
  assert.match(utf8(result.assets.find((a) => a.path === 'assets/image/엔트리봇_엔트리봇_걷기1.svg')!.data), /<svg/);
});

test('되돌린 기본 오브젝트를 다시 컴파일하면 그림 파일에서 잰 원본 크기가 나온다', () => {
  const result = decompileProject(builtinObjectProject(), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-builtin-'));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }

  const recompiled = compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

  const sprite = recompiled.project!.objects[0].sprite;
  assert.deepEqual(sprite.pictures[0].dimension, { width: 144, height: 246 });
  assert.deepEqual(sprite.pictures[1].dimension, { width: 144, height: 246 });
  assert.equal(recompiled.assets.length, 3);
});

test('모양 없이 만든 "새 오브젝트"의 _1x1.png 도 꺼내 오고, 선언된 크기를 그대로 지킨다', () => {
  // The blank 1x1 asset must retain saved dimensions or recompilation shrinks the object to one pixel.
  const project = builtinObjectProject();
  project.objects[0].name = '새 오브젝트';
  project.objects[0].sprite.pictures = [{
    id: 'p1x1',
    name: '새그림',
    imageType: 'png',
    fileurl: './bower_components/entryjs/images/_1x1.png',
    dimension: { width: 960, height: 540 },
  }];
  project.objects[0].sprite.sounds = [];
  project.objects[0].selectedPictureId = 'p1x1';

  const result = decompileProject(project, []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/새_오브젝트.etp')!.data);
  assert.doesNotMatch(fragment, /bower_components/);
  assert.match(fragment, /^default costume 새그림 "assets\/image\/새_오브젝트_새그림\.png" size 960 540$/m);
  assert.ok(result.assets.find((a) => a.path === 'assets/image/새_오브젝트_새그림.png')?.data.length! > 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-1x1-'));
  fs.writeFileSync(path.join(dir, 'main.etp'), result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }
  const recompiled = compileProject(result.source, { path: path.join(dir, 'main.etp'), assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));
  assert.deepEqual(recompiled.project!.objects[0].sprite.pictures[0].dimension, { width: 960, height: 540 });
});

const fieldLabel = (text: string, next: any) => ({ type: 'function_field_label', params: [text, next] });
const fieldString = (id: string, next: any) => ({
  type: 'function_field_string', params: [{ type: `stringParam_${id}`, params: [] }, next],
});
const fieldBoolean = (id: string, next: any) => ({
  type: 'function_field_boolean', params: [{ type: `booleanParam_${id}`, params: [null] }, next],
});

function functionHeadProject(field: any, body: any[] = []): RawEntity {
  return {
    name: '함수 머리 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    aiUtilizeBlocks: [],
    objects: [],
    functions: [{
      id: 'fn1',
      content: JSON.stringify([[{ type: 'function_create', params: [field, null], statements: [body] }]]),
    }],
  };
}

const declarationOf = (field: any, body?: any[]) => decompileProject(functionHeadProject(field, body), [], { inline: true })
  .source.match(/^function .*/m)![0];

test('함수 머리의 라벨·판단 칸을 지나서 매개변수를 끝까지 읽는다', () => {
  assert.equal(declarationOf(fieldLabel('스폰', fieldString('p1', fieldString('p2', null)))),
    'function 스폰(a, b):');

  assert.equal(declarationOf(fieldLabel('스폰', fieldString('p1', fieldLabel('체력', fieldString('p2', null))))),
    'function 스폰(a, 체력):');

  assert.equal(declarationOf(fieldLabel('스폰', fieldString('p1', fieldLabel('체력', null)))),
    'function 스폰(a):');

  // Keep boolean parameter slots and every parameter following them.
  assert.equal(
    declarationOf(fieldLabel('스폰', fieldBoolean('b1', fieldString('p2', fieldLabel('이름', fieldString('p3', null)))))),
    'function 스폰(a?, b, 이름):',
  );
});

test('자동 이름은 알파벳을 다 쓰면 a1, a2 로 이어진다', () => {
  const field = fieldLabel('많이', Array.from({ length: 28 })
    .reduceRight((next, _, i) => fieldString(`p${i}`, next), null));
  // Skip coordinate names x and y when assigning automatic parameter names.
  assert.match(declarationOf(field), /, v, w, z, a1, a2, a3, a4\):$/);
});

test('함수 본문의 매개변수 블록은 이름으로 되짚는다', () => {
  const field = fieldLabel('스폰', fieldString('p1', fieldLabel('체력', fieldBoolean('b1', null))));
  const body = [{
    type: 'dialog',
    params: [{ type: 'stringParam_p1', params: [] }, 'speak'],
    statements: [],
  }, {
    type: '_if',
    params: [{ type: 'booleanParam_b1', params: [null] }],
    statements: [[]],
  }];
  const result = decompileProject(functionHeadProject(field, body), [], { inline: true });
  assert.deepEqual(result.warnings, []);
  assert.match(result.source, /^ {2}say a$/m);
  assert.match(result.source, /^ {2}if 체력:$/m);
});

test('되돌린 함수 머리는 다시 컴파일하면 원래 사슬로 돌아간다', () => {
  const field = fieldLabel('스폰', fieldString('p1', fieldLabel('체력', fieldString('p2', null))));
  const body = [{ type: 'dialog', params: [{ type: 'stringParam_p2', params: [] }, 'speak'], statements: [] }];
  const result = decompileProject(functionHeadProject(field, body), [], { inline: true });

  const recompiled = compileProject(result.source, { path: 'main.etp' });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

  const chain = [];
  let node = JSON.parse(recompiled.project!.functions[0].content)[0][0].params[0];
  while (node && typeof node === 'object') {
    chain.push(node.type === 'function_field_label' ? `label:${node.params[0]}` : 'param');
    node = node.params[1];
  }
  assert.deepEqual(chain, ['label:스폰', 'param', 'label:체력', 'param']);
});

test('(<판단>의 값) 블록은 boolean_value 로 옮긴다', () => {
  const field = fieldLabel('스폰', fieldString('p1', null));
  const body = [{
    type: 'dialog',
    params: [{ type: 'get_boolean_value', params: [{ type: 'True', params: [null] }] }, 'speak'],
    statements: [],
  }];
  const result = decompileProject(functionHeadProject(field, body), [], { inline: true });
  assert.deepEqual(result.warnings, []);
  assert.match(result.source, /^ {2}say boolean_value\(true\)$/m);
});

test('when 본문은 한 단 들여쓰고, 선언 뭉치 뒤에는 두 줄을 띄운다', () => {
  const result = decompileProject(minimalProject(1), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.equal(fragment, 'x = 10\n\n\nwhen start do\n  wait 1\nend\n');
});

test('파일을 담은 모양은 크기를 적지 않고, 1×1 빈 그림만 예외다', () => {
  // Omit measurable image sizes except for Entry's special 1x1 blank costume.
  const project = builtinObjectProject();
  project.objects[0].sprite.pictures.push({
    id: 'p1x1',
    name: '새그림',
    imageType: 'png',
    fileurl: './bower_components/entryjs/images/_1x1.png',
    dimension: { width: 960, height: 540 },
  });

  const result = decompileProject(project, []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/엔트리봇.etp')!.data);
  assert.match(fragment, /^default costume 엔트리봇_걷기1 "assets\/image\/엔트리봇_엔트리봇_걷기1\.svg"$/m);
  assert.match(fragment, /^sound 강아지_짖는_소리 "assets\/sound\/엔트리봇_강아지_짖는_소리\.mp3" for 1\.3 as "강아지 짖는 소리"$/m);
  assert.match(fragment, /^costume 새그림 "assets\/image\/엔트리봇_새그림\.png" size 960 540$/m);
});

test('sizes 옵션을 켜면 모든 모양에 size 가로 세로 를 적는다', () => {
  const result = decompileProject(builtinObjectProject(), [], { sizes: true });
  const fragment = utf8(result.files.find((a) => a.path === 'objects/엔트리봇.etp')!.data);

  assert.match(fragment, /^default costume 엔트리봇_걷기1 "assets\/image\/엔트리봇_엔트리봇_걷기1\.svg" size 144 246$/m);
  assert.match(fragment, /^costume 엔트리봇_걷기2 "assets\/image\/엔트리봇_엔트리봇_걷기2\.svg" size 144 246$/m);
  assert.match(fragment, /^sound 강아지_짖는_소리 "assets\/sound\/엔트리봇_강아지_짖는_소리\.mp3" for 1\.3 as "강아지 짖는 소리"$/m);
});

function textBoxProject(entityExtra: RawEntity = {}): RawEntity {
  return {
    name: '글상자 크기 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '안내문',
      objectType: 'textBox',
      scene: 'scene1',
      rotateMethod: 'free',
      text: '이름:\n\n죄목:',
      entity: {
        x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true,
        colour: '#000000', bgColor: '#ffffff', font: '13.98px Nanum Gothic', fontSize: 13.98,
        lineBreak: true, width: 65.49, height: 104.65, ...entityExtra,
      },
      sprite: { pictures: [], sounds: [] },
      script: JSON.stringify([[]]),
    }],
  };
}

test('글상자는 옵션 없이도 size 가로 세로 를 적는다', () => {
  const result = decompileProject(textBoxProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/안내문.etp')!.data);

  assert.match(fragment, /^size 65\.49 104\.65$/m);
});

test('되돌린 글상자를 다시 컴파일하면 원본 틀 크기가 그대로 나온다', () => {
  const result = decompileProject(textBoxProject(), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-textbox-'));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }

  const recompiled = compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

  const { entity } = recompiled.project!.objects[0];
  assert.equal(entity.width, 65.49);
  assert.equal(entity.height, 104.65);
  assert.equal(entity.lineBreak, true);
});

// Entry number and text blocks both return their stored text; only canonical numbers can become literals.
function numberShapeProject() {
  const startHat = () => ({ type: 'when_run_button_click', params: [null], statements: [] });
  const text = (value: any) => ({ type: 'text', params: [value] });
  const number = (value: any) => ({ type: 'number', params: [value] });
  const compare = (left: any, op: any, right: any) => ({ type: 'boolean_basic_operator', params: [left, op, right] });
  const calc = (left: any, op: any, right: any) => ({ type: 'calc_basic', params: [left, op, right] });

  return {
    name: '숫자 모양 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [
      { id: 'v1', name: '단계', value: 0 },
      { id: 'l1', name: '기록', variableType: 'list', array: [{ data: 'ㄱ' }] },
    ],
    messages: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: {
        pictures: [{ id: 'pic1', name: '기본', fileurl: null, dimension: { width: 10, height: 10 } }],
        sounds: [],
      },
      script: JSON.stringify([[
        startHat(),
        { type: '_if', params: [compare({ type: 'get_variable', params: ['v1'] }, 'EQUAL', text('14'))], statements: [[]] },
        { type: 'set_variable', params: ['v1', calc(text('3'), 'MULTI', calc(text('2'), 'PLUS', number('5')))], statements: [] },
        { type: 'func_fn1', params: [text('7'), null], statements: [] },
        { type: 'remove_value_from_list', params: [text('3'), 'l1', null], statements: [] },
        { type: 'dialog', params: [text('007'), 'speak', null], statements: [] },
      ]]),
    }],
    functions: [{
      id: 'fn1',
      content: JSON.stringify([[{
        type: 'function_create',
        params: [{
          type: 'function_field_label',
          params: ['더하기', { type: 'function_field_string', params: [{ type: 'stringParam_a' }, null] }],
        }],
        statements: [[]],
      }]]),
    }],
  };
}

test('판단값 · 계산식 · 함수 인수 · 순번 안의 숫자는 숫자로 되돌아온다', () => {
  const result = decompileProject(numberShapeProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^ {2}if \(단계 == 14\):$/m);
  assert.match(fragment, /^ {2}단계 = \(3 \* \(2 \+ 5\)\)$/m);
  assert.match(fragment, /^ {2}더하기\(7\)$/m);
  assert.match(fragment, /^ {2}remove 기록\[3\]$/m);
  assert.doesNotMatch(fragment, /"14"|"2"|"7"/);

  assert.match(fragment, /^ {2}say "007"$/m);
});

test('숫자로 되돌린 코드는 다시 컴파일해도 값이 그대로다', () => {
  const result = decompileProject(numberShapeProject(), []);
  const recompiled = recompileResult(result, 'entropy-decompile-number-');
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

  const thread = JSON.parse(recompiled.project!.objects[0].script)[0];
  const condition = thread.find((b: any) => b.type === '_if').params[0];
  assert.equal(condition.params[2].params[0], '14');
  const assign = thread.find((b: any) => b.type === 'set_variable').params[1];
  assert.equal(assign.params[0].params[0], '3');
  assert.equal(assign.params[2].params[0].params[0], '2');
});

// Exponent text must remain quoted because Entropy has no exponent literal syntax.
function exponentProject(entityX: number) {
  const startHat = () => ({ type: 'when_run_button_click', params: [null], statements: [] });
  const text = (value: any) => ({ type: 'text', params: [value] });
  const calc = (left: any, op: any, right: any) => ({ type: 'calc_basic', params: [left, op, right] });

  return {
    name: '지수 표기 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [{ id: 'v1', name: '값', value: 0 }],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: entityX, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: {
        pictures: [{ id: 'pic1', name: '기본', fileurl: null, dimension: { width: 10, height: 10 } }],
        sounds: [],
      },
      script: JSON.stringify([[
        startHat(),
        { type: 'set_variable', params: ['v1', calc(text('1.6059043836821613e-10'), 'MULTI', text('2')), null], statements: [] },
      ]]),
    }],
  };
}

test('지수 표기 값은 글자 그대로 두고 되돌린 소스는 다시 컴파일된다', () => {
  const result = decompileProject(exponentProject(0) as unknown as RawEntity, []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^ {2}값 = \("1\.6059043836821613e-10" \* 2\)$/m);

  const recompiled = recompileResult(result, 'entropy-decompile-exponent-');
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e: any) => e.message).join('\n'));

  const thread = JSON.parse(recompiled.project!.objects[0].script)[0];
  const assign = thread.find((b: any) => b.type === 'set_variable').params[1];
  assert.equal(assign.params[0].params[0], '1.6059043836821613e-10');
});

test('지수 표기로 적히는 수는 소수점 표기로 펴서 적는다', () => {
  const result = decompileProject(exponentProject(1e-7) as unknown as RawEntity, []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^x = 0\.0000001$/m);

  const recompiled = recompileResult(result, 'entropy-decompile-exponent-x-');
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e: any) => e.message).join('\n'));
  assert.equal(recompiled.project!.objects[0].entity.x, 1e-7);
});

test('소리 길이와 색 고르기 칸을 되돌리고 다시 컴파일한다', () => {
  const project = {
    name: 't',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [{ id: 'v1', name: '길이', value: 0 }],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '점수판',
      objectType: 'textBox',
      scene: 'scene1',
      rotateMethod: 'free',
      text: '가',
      entity: {
        x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true,
        colour: '#000000', bgColor: '#ffffff', font: '20px Nanum Gothic', fontSize: 20,
      },
      sprite: {
        pictures: [],
        sounds: [{ id: 'snd1', name: '점프음', fileurl: null, ext: '.mp3', duration: 2.5 }],
      },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        { type: 'set_variable', params: ['v1', { type: 'get_sound_duration', params: [null, 'snd1', null] }], statements: [] },
        { type: 'text_change_font_color', params: [{ type: 'text_color', params: ['#16d8a3'] }, null], statements: [] },
      ]]),
    }],
  };

  const result = decompileProject(project, []);
  assert.deepEqual([...result.warnings], []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/점수판.etp')!.data);
  assert.match(fragment, /^ {2}길이 = sound_duration\("점프음"\)$/m);
  assert.match(fragment, /^ {2}font_color = #16d8a3$/m);
  assert.doesNotMatch(fragment, /\[decompile/);

  const recompiled = recompileResult(result, 'entropy-decompile-sound-');
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));
  const thread = JSON.parse(recompiled.project!.objects[0].script)[0];
  const duration = thread.find((b: any) => b.type === 'set_variable').params[1];
  assert.equal(duration.type, 'get_sound_duration');
  assert.equal(duration.params[1], recompiled.project!.objects[0].sprite.sounds[0].id);
  assert.equal(thread.find((b: any) => b.type === 'text_change_font_color').params[0], '#16d8a3');
});

// A missing sound-speed value can turn a wait condition into one that never succeeds.
test('sound_speed 를 되돌리고 다시 컴파일한다', () => {
  const project = minimalProject(1);
  project.variables.push({ id: 'v1', name: '속도', value: 0, object: null });
  project.objects[0].script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: 'set_variable', params: ['v1', { type: 'get_sound_speed', params: [null] }], statements: [] },
  ]]);

  const result = decompileProject(project, []);
  assert.deepEqual([...result.warnings], []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.match(fragment, /^ {2}속도 = sound_speed$/m);
  assert.doesNotMatch(fragment, /\[decompile/);

  const recompiled = recompileResult(result, 'entropy-decompile-soundspeed-');
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));
  const thread = JSON.parse(recompiled.project!.objects[0].script)[0];
  assert.equal(thread.find((b: any) => b.type === 'set_variable').params[1].type, 'get_sound_speed');
});

// Preserve leading digits when renaming resources so numbered costumes do not collapse to one name.
test('숫자로 시작하는 모양 이름도 숫자를 잃지 않는다', () => {
  const picture = (id: string, name: string) => ({ id, name, fileurl: null, dimension: { width: 10, height: 10 } });
  const project = {
    name: 't',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'p1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: { pictures: [picture('p1', '3.png'), picture('p2', '1.png'), picture('p3', '2.png')], sounds: [] },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        { type: 'change_to_some_shape', params: [{ type: 'get_pictures', params: ['p3'] }, null], statements: [] },
      ]]),
    }],
  };

  const result = decompileProject(project, []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.match(fragment, /^default costume costume_3_png /m);
  assert.match(fragment, /^costume costume_1_png /m);
  assert.match(fragment, /^costume costume_2_png /m);
  assert.match(fragment, /^ {2}costume = "costume_2_png"$/m);
});

// Preserve moved registration points because they determine where stage coordinates place the drawing.
function centerProject(regX: any, regY: any) {
  return {
    name: '중심점 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true, regX, regY },
      sprite: {
        pictures: [{ id: 'pic1', name: '기본', fileurl: null, dimension: { width: 144, height: 246 } }],
        sounds: [],
      },
      script: JSON.stringify([[]]),
    }],
  };
}

test('옮겨진 중심점은 center 가로 세로 로 되돌아온다', () => {
  const result = decompileProject(centerProject(461.84, 116.7), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.match(fragment, /^center 461\.84 116\.7$/m);
});

test('중심점이 모양 한가운데면 center 줄을 적지 않는다', () => {
  const result = decompileProject(centerProject(72, 123), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.doesNotMatch(fragment, /^center /m);
});

test('되돌린 중심점을 다시 컴파일하면 regX/regY 가 그대로 나온다', () => {
  const result = decompileProject(centerProject(461.84, 116.7), []);
  const recompiled = recompileResult(result, 'entropy-decompile-center-');
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

  const { entity } = recompiled.project!.objects[0];
  assert.equal(entity.regX, 461.84);
  assert.equal(entity.regY, 116.7);
  assert.notEqual(entity.regX, 72);
});

test('center 를 안 적으면 모양 한가운데가 기본값이다', () => {
  const result = decompileProject(centerProject(72, 123), []);
  const recompiled = recompileResult(result, 'entropy-decompile-center-default-');
  const { entity } = recompiled.project!.objects[0];
  assert.equal(entity.regX, 72);
  assert.equal(entity.regY, 123);
});

test('크기를 모르는 글상자는 size 줄을 적지 않는다', () => {
  const project = textBoxProject();
  delete project.objects[0].entity.width;
  delete project.objects[0].entity.height;

  const result = decompileProject(project, []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/안내문.etp')!.data);
  assert.doesNotMatch(fragment, /^size /m);
});

test('판단 매개변수는 이름? 로 되돌아오고, 다시 컴파일해도 판단 칸이다', () => {
  const field = fieldLabel('스폰', fieldString('p1', fieldLabel('살았나', fieldBoolean('b1', null))));
  const body = [{ type: '_if', params: [{ type: 'booleanParam_b1', params: [null] }], statements: [[]] }];
  const result = decompileProject(functionHeadProject(field, body), [], { inline: true });
  assert.match(result.source, /^function 스폰\(a, 살았나\?\):$/m);
  assert.match(result.source, /^ {2}if 살았나:$/m);

  const recompiled = compileProject(result.source, { path: 'main.etp' });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));
  const chain = [];
  let node = JSON.parse(recompiled.project!.functions[0].content)[0][0].params[0];
  while (node && typeof node === 'object') {
    chain.push(node.type === 'function_field_label' ? `label:${node.params[0]}` : node.type);
    node = node.params[1];
  }
  assert.deepEqual(chain,
    ['label:스폰', 'function_field_string', 'label:살았나', 'function_field_boolean']);
});

// Different objects can share resource names; filenames must not overwrite one another.
function samePictureNameProject(sceneCount = 1) {
  const scenes = sceneCount === 1
    ? [{ id: 'scene1', name: '장면 1' }]
    : [{ id: 'scene1', name: '장면 1' }, { id: 'scene2', name: '장면 2' }];

  const object = (id: string, name: string, sceneId: any, fileurl: any) => ({
    id,
    name,
    objectType: 'sprite',
    scene: sceneId,
    rotateMethod: 'free',
    selectedPictureId: `${id}_pic`,
    entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
    sprite: {
      pictures: [{ id: `${id}_pic`, name: '새그림', imageType: 'png', fileurl, dimension: { width: 4, height: 4 } }],
      sounds: [{ id: `${id}_snd`, name: '소리', ext: '.mp3', duration: 1, fileurl: `${fileurl}.mp3` }],
    },
    script: JSON.stringify([[]]),
  });

  return {
    name: '이름 겹침 테스트',
    speed: 60,
    scenes,
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [
      object('obj1', '치로', 'scene1', 'temp/aa/bb/image/aaa.png'),
      object('obj2', '엔트리봇', sceneCount === 1 ? 'scene1' : 'scene2', 'temp/cc/dd/image/ccc.png'),
    ],
  };
}

// Give each referenced archive path distinct bytes to detect accidental overwrites.
const fakeEntries = (project: any) => (project.objects ?? []).flatMap((object: any) => [
  ...(object.sprite.pictures ?? []).map((p: any) => ({ name: p.fileurl, data: Buffer.from(object.name + ' 그림') })),
  ...(object.sprite.sounds ?? []).map((s: any) => ({ name: s.fileurl, data: Buffer.from(object.name + ' 소리') })),
]);

test('모양 이름이 겹쳐도 오브젝트 이름을 붙여서 파일이 안 덮인다', () => {
  const project = samePictureNameProject(1);
  const result = decompileProject(project, fakeEntries(project));

  const images = result.assets.filter((a) => a.path.startsWith('assets/image/')).map((a) => a.path);
  assert.deepEqual(images.sort(), ['assets/image/엔트리봇_새그림.png', 'assets/image/치로_새그림.png']);

  const contents = result.assets
    .filter((a) => a.path.startsWith('assets/image/'))
    .map((a) => utf8(a.data));
  assert.equal(new Set(contents).size, 2);

  const chiro = utf8(result.files.find((a) => a.path === 'objects/치로.etp')!.data);
  assert.match(chiro, /"assets\/image\/치로_새그림\.png"/);
});

test('장면이 여러 개면 리소스도 장면별 폴더로 나눈다', () => {
  const project = samePictureNameProject(2);
  const result = decompileProject(project, fakeEntries(project));

  const paths = result.assets.map((a) => a.path).filter((p) => p.startsWith('assets/'));
  assert.deepEqual(paths.sort(), [
    'assets/image/장면_1/치로_새그림.png',
    'assets/image/장면_2/엔트리봇_새그림.png',
    'assets/sound/장면_1/치로_소리.mp3',
    'assets/sound/장면_2/엔트리봇_소리.mp3',
  ]);
});

test('여러 모양이 같은 파일을 쓰면 한 번만 저장한다', () => {
  const project = samePictureNameProject(1);
  project.objects[1].sprite.pictures[0].fileurl = project.objects[0].sprite.pictures[0].fileurl;
  const result = decompileProject(project, fakeEntries(project));

  const images = result.assets.filter((a) => a.path.startsWith('assets/image/'));
  assert.equal(images.length, 1);
  for (const name of ['치로', '엔트리봇']) {
    const fragment = utf8(result.files.find((a) => a.path === `objects/${name}.etp`)!.data);
    assert.match(fragment, new RegExp(images[0].path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('경로가 그래도 겹치면 뒤에 번호를 붙인다', () => {
  // Exercise filename collision handling even after object names are made unique.
  const project = samePictureNameProject(1);
  project.objects[1].name = '치로';
  const result = decompileProject(project, fakeEntries(project));

  const images = result.assets.filter((a) => a.path.startsWith('assets/image/')).map((a) => a.path);
  assert.equal(images.length, 2);
  assert.equal(new Set(images).size, 2, images.join(', '));
});

test('숫자 모양의 유니코드 글자(¼·²)는 이름에서 _ 로 바뀌어 다시 컴파일된다', () => {
  const project = minimalProject(1);
  project.variables = [{ id: 'v1', name: '3ì¼ ì¤í²', value: 0, variableType: 'variable' }];
  const result = decompileProject(project, [], { inline: true });
  assert.match(result.source, /^var var_3ì_ì_í as "3ì¼ ì¤í²"/m);
  const compiled = compileProject(result.source, { path: 'main.etp' });
  assert.deepEqual(compiled.errors, []);
});

function svgPictureProject(): RawEntity {
  const project = minimalProject(1);
  project.objects[0].sprite.pictures = [{
    id: 'pic1',
    name: '배경',
    filename: 'aaaa',
    imageType: 'svg',
    fileurl: 'temp/aa/aa/image/aaaa.svg',
    dimension: { width: 960, height: 540 },
  }];
  project.objects[0].selectedPictureId = 'pic1';
  return project;
}

const svgEntries = (withPng: any) => [
  { name: 'temp/aa/aa/image/aaaa.svg', data: Buffer.from('<svg viewBox="0 0 1100 670"></svg>') },
  ...(withPng ? [{ name: 'temp/aa/aa/image/aaaa.png', data: Buffer.from('가운데로 안 옮겨진 그림') }] : []),
];

test('SVG 모양은 기본적으로 엔트리가 함께 저장한 PNG 로 가져온다', () => {
  const result = decompileProject(svgPictureProject(), svgEntries(true));

  const images = result.assets.filter((a) => a.path.startsWith('assets/image/'));
  assert.deepEqual(images.map((a) => a.path), ['assets/image/주인공_배경.png']);
  assert.equal(utf8(images[0].data), '가운데로 안 옮겨진 그림');

  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.match(fragment, /default costume 배경 "assets\/image\/주인공_배경\.png"/);
});

test('--keep-svg 를 주면 SVG 를 그대로 가져온다', () => {
  const result = decompileProject(svgPictureProject(), svgEntries(true), { keepSvg: true });

  const images = result.assets.filter((a) => a.path.startsWith('assets/image/'));
  assert.deepEqual(images.map((a) => a.path), ['assets/image/주인공_배경.svg']);
  assert.match(utf8(images[0].data), /<svg/);
});

test('함께 저장한 PNG 가 없으면 SVG 를 그대로 가져온다', () => {
  const result = decompileProject(svgPictureProject(), svgEntries(false));

  const images = result.assets.filter((a) => a.path.startsWith('assets/image/'));
  assert.deepEqual(images.map((a) => a.path), ['assets/image/주인공_배경.svg']);
});

function funcLocalProject(
  localVariables: any[],
  body: any[],
  globals: RawEntity[] = [],
): RawEntity {
  const field = fieldLabel('계산', fieldString('p1', null));
  return {
    name: '지역 변수 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: globals,
    messages: [],
    aiUtilizeBlocks: [],
    objects: [],
    functions: [{
      id: 'fn1',
      localVariables,
      useLocalVariables: localVariables.length > 0,
      content: JSON.stringify([[{ type: 'function_create', params: [field, null], statements: [body] }]]),
    }],
  };
}

const getLocal = (id: string) => ({ type: 'get_func_variable', params: [id, null], statements: [] });
const setLocal = (id: string, value: any) => ({
  type: 'set_func_variable',
  params: [id, { type: 'number', params: [String(value)] }, null],
  statements: [],
});

test('함수 지역 변수는 이름을 되찾아 몸통 맨 위에 var 로 선언된다', () => {
  const project = funcLocalProject(
    [{ name: '누적', value: 0, id: 'fn1_a' }],
    [setLocal('fn1_a', 3), { type: 'dialog', params: [getLocal('fn1_a'), 'speak'], statements: [] }],
  );
  const result = decompileProject(project, [], { inline: true });

  assert.deepEqual(result.warnings, []);
  assert.match(result.source, /^function 계산\(a\):\n {2}var 누적 = 0\n {2}누적 = 3\n {2}say 누적$/m);
});

test('지역 변수 이름이 매개변수·전역과 겹치면 다른 이름을 준다', () => {
  const project = funcLocalProject(
    [{ name: 'a', value: 0, id: 'fn1_a' }, { name: '점수', value: 0, id: 'fn1_b' }],
    [setLocal('fn1_a', 1), setLocal('fn1_b', 2)],
    [{ id: 'g1', name: '점수', variableType: 'variable', value: 0, object: null }],
  );
  const result = decompileProject(project, [], { inline: true });

  assert.match(result.source, /^ {2}var a_2 as "a" = 0$/m);
  assert.match(result.source, /^ {2}var 점수_2 as "점수" = 0$/m);
});

test('이름으로 쓸 수 없는 낱말은 뒤에 _ 를 붙여 되돌린다', () => {
  const project = funcLocalProject(
    [{ name: 'skip', value: 0, id: 'fn1_a' }],
    [setLocal('fn1_a', 1)],
  );
  const result = decompileProject(project, [], { inline: true });

  assert.match(result.source, /^ {2}var skip_ as "skip" = 0$/m);
  assert.match(result.source, /^ {2}skip_ = 1$/m);
});

test('지역 변수 이름이 내장 이름과 겹치면 내장 이름을 가리지 않게 비껴 준다', () => {
  const coordinate = { type: 'coordinate_object', params: [null, 'self', null, 'x'], statements: [] };
  const project = funcLocalProject(
    [{ name: 'x', value: 0, id: 'fn1_a' }],
    [{ type: 'set_func_variable', params: ['fn1_a', coordinate, null], statements: [] }],
  );
  const result = decompileProject(project, [], { inline: true });

  // Rename the local x so it cannot hide the coordinate read on the assignment's right side.
  assert.match(result.source, /^ {2}var x_ as "x" = 0$/m);
  assert.match(result.source, /^ {2}x_ = x$/m);

  const recompiled = compileProject(result.source, { path: 'main.etp' });
  assert.deepEqual(recompiled.errors, []);
  const fn = recompiled.project!.functions[0];
  assert.deepEqual(fn.localVariables.map((v: any) => v.name), ['x']);
  const body = JSON.parse(fn.content as unknown as string)[0][0].statements[0];
  const assignment = body[body.length - 1];
  assert.equal(assignment.params[1].type, 'coordinate_object');
  assert.deepEqual(assignment.params[1].params, [null, 'self', null, 'x']);
});

test('내장 이름과 겹치는 전역 변수·함수 이름도 비껴 준다', () => {
  const project = funcLocalProject(
    [],
    [],
    [{ id: 'g1', name: 'size', variableType: 'variable', value: 0, object: null }],
  );
  const result = decompileProject(project, [], { inline: true });

  assert.match(result.source, /^var size_ as "size" = 0$/m);
});

test('되돌린 지역 변수는 다시 컴파일해도 함수의 지역 변수로 남는다', () => {
  const project = funcLocalProject(
    [{ name: '누적', value: 0, id: 'fn1_a' }],
    [setLocal('fn1_a', 3), { type: 'dialog', params: [getLocal('fn1_a'), 'speak'], statements: [] }],
  );
  const result = decompileProject(project, [], { inline: true });

  const recompiled = compileProject(result.source, { path: 'main.etp' });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));
  assert.deepEqual(recompiled.project!.functions[0].localVariables.map((v) => v.name), ['누적']);
});

test('함수 정의 앞에 주석 블록이 놓여 있어도 정의를 찾아낸다', () => {
  // A workspace comment above the function definition can be the first stack.
  const project = funcLocalProject(
    [{ name: '누적', value: 0, id: 'fn1_a' }],
    [setLocal('fn1_a', 3)],
  );
  const content = JSON.parse(project.functions[0].content);
  project.functions[0].content = JSON.stringify([
    [{ id: 'c1', type: 'comment', value: '메모', params: [], statements: [] }],
    content[0],
  ]);
  const result = decompileProject(project, [], { inline: true });

  assert.match(result.source, /^function 계산\(a\):\n {2}var 누적 = 0\n {2}누적 = 3\nend$/m);
});

// Preserve display names with as because Entry resolves resource names at runtime.
function namedResourceProject() {
  const project = minimalProject();
  project.objects[0].sprite.pictures = [
    { id: 'pic1', name: '상호작용1*1', filename: 'a', fileurl: 'a.png', dimension: { width: 4, height: 4 } },
  ];
  project.objects[0].sprite.sounds = [
    { id: 'snd1', name: 'snd_select.mp3', filename: 'b', fileurl: 'b.mp3', duration: 1 },
  ];
  project.objects[0].selectedPictureId = 'pic1';
  project.objects[0].script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: 'change_to_some_shape',
      params: [{ type: 'text', params: ['상호작용1*1'], statements: [] }, null],
      statements: [],
    },
  ]]);
  return project;
}

function fragmentOf(result: any, name = '주인공') {
  return utf8(result.files.find((a: any) => a.path === `objects/${name}.etp`).data);
}

test('식별자로 적을 수 없는 모양 · 소리 이름은 as 로 남긴다', () => {
  const fragment = fragmentOf(decompileProject(namedResourceProject(), []));
  assert.match(fragment, /costume 상호작용1_1 "[^"]+"( size \d+ \d+)? as "상호작용1\*1"/);
  assert.match(fragment, /sound snd_select "[^"]+"( for \d+)? as "snd_select\.mp3"/);
});

test('as 로 남긴 이름은 다시 컴파일해도 그대로 붙는다', () => {
  const result = decompileProject(namedResourceProject(), []);
  const recompiled = recompileResult(result, 'entropy-decompile-asname-');
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

  const object = recompiled.project!.objects.find((o) => o.name === '주인공');
  assert.deepEqual(object!.sprite.pictures.map((p) => p.name), ['상호작용1*1']);
  assert.deepEqual(object!.sprite.sounds.map((s) => s.name), ['snd_select.mp3']);
  // Two name aliases must still refer to one costume rather than duplicating it.
  assert.equal(object!.sprite.pictures.length, 1);
});

test('공유 · 실시간 변수는 shared · realtime 로 적고 그대로 되돌아온다', () => {
  const project = minimalProject();
  project.variables = [
    {
      id: 'v1', name: '순위(공유)', variableType: 'list', array: [], object: null,
      isCloud: true, isRealTime: false, cloudDate: false, visible: false, value: 0, x: 0, y: 0,
    },
    {
      id: 'v2', name: '접속자', variableType: 'variable', object: null,
      isCloud: false, isRealTime: true, cloudDate: false, visible: false, value: 0, x: 0, y: 0,
    },
  ];
  const result = decompileProject(project, [], { inline: true });
  assert.match(result.source, /^shared list 순위_공유 as "순위\(공유\)" = \[\]$/m);
  assert.match(result.source, /^realtime var 접속자 = 0$/m);

  const recompiled = recompileResult(result, 'entropy-decompile-cloud-');
  assert.deepEqual(recompiled.errors, []);
  const list = recompiled.project!.variables.find((v) => v.name === '순위(공유)');
  const variable = recompiled.project!.variables.find((v) => v.name === '접속자');
  assert.equal(list!.isCloud, true);
  assert.equal(list!.isRealTime, false);
  assert.equal(variable!.isRealTime, true);
  assert.equal(variable!.isCloud, false);
});

test('공유 · 실시간은 오브젝트 안의 변수에는 붙일 수 없다', () => {
  const source = 'scene "s":\n  object "o":\n    shared var 점수 = 0\n  end\nend';
  const result = compileProject(source, { path: 'main.etp' });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /전역 선언에만 붙일 수 있습니다/);
});

test('작품에 없는 변수 id 를 가리키는 블록은 선언을 되살려서 컴파일된다', () => {
  const project = minimalProject();
  project.objects[0].script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: 'set_variable', params: ['지워진id', { type: 'number', params: ['1'], statements: [] }, null], statements: [] },
  ]]);
  const result = decompileProject(project, [], { inline: true });
  assert.match(result.source, /^var missing_var_지워진id = 0$/m);

  const recompiled = recompileResult(result, 'entropy-decompile-missing-');
  assert.deepEqual(recompiled.errors, []);
});

test('테이블 블록은 컴파일한 뒤 되돌려도 글자 하나까지 그대로다', () => {
  const body = [
    'in 점수표 add row',
    'in 점수표 add column',
    'in 점수표 insert row at 2',
    'in 점수표 insert column at 2',
    'remove 점수표 row 1',
    'remove 점수표 column 1',
    '점수표[1, "점수"] = 5',
    '점수표["B2"] = 6',
    'save 점수표',
    'show 점수표',
    'show 점수표 for 3',
    'show 점수표 chart 1',
    'hide chart',
    'say 점수표[1, "점수"]',
    'say 점수표["B2"]',
    'say row_count(점수표)',
    'say column_count(점수표)',
    'say last_row(점수표, "점수")',
    'say sum(점수표, "점수")',
    'say average(점수표, "점수")',
    'say maximum(점수표, "점수")',
    'say minimum(점수표, "점수")',
    'say stdev(점수표, "점수")',
    'say median(점수표, "점수")',
    'say correlation(점수표, "이름", "점수")',
    'say lookup(점수표, "이름", "철수", "점수")',
  ];
  const source = `table 점수표:
  columns "이름", "점수"
  row "철수", 10
end

scene "s":
  object "o":
    when start do
${body.map((line) => `      ${line}`).join('\n')}
    end
  end
end`;

  const compiled = compileProject(source, { path: 'main.etp' });
  assert.deepEqual(compiled.errors, [], compiled.errors.map((e) => e.message).join('\n'));

  const back = decompileProject(compiled.project!, []);
  assert.deepEqual(back.warnings, []);
  assert.match(utf8(back.files.find((file) => file.path === "table.etp")!.data), /^table 점수표:\n {2}columns "이름", "점수"\n {2}row "철수", "10"\nend$/m);
  const fragment = utf8(back.files.find((a) => a.path === 'objects/o.etp')!.data);
  assert.equal(
    fragment.trim(),
    ['when start do', ...body.map((line) => `  ${line}`), 'end'].join('\n'),
  );
});

// Site tables can store keyed row records instead of plain cell arrays.
test('표의 줄이 {key, value} 로 담겨 와도 되돌린다', () => {
  const project = minimalProject();
  project.tables = [{
    id: 'tb',
    name: '점수표',
    fields: ['이름', '점수'],
    data: [
      { key: 'r1', value: ['철수', 10] },
      { key: 'r2', value: ['영희', 20] },
    ],
  }];

  const back = decompileProject(project, [], { inline: true });
  assert.match(
    back.source,
    /^table 점수표:\n {2}columns "이름", "점수"\n {2}row "철수", 10\n {2}row "영희", 20\nend$/m,
  );
  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  assert.deepEqual(again.project!.tables[0].data, [['철수', '10'], ['영희', '20']]);
});

// Parenthesize variables named row or column to avoid table-operation parsing.
test('리스트에 넣는 값이 row 라는 이름이어도 다시 읽힌다', () => {
  const project = minimalProject();
  project.variables = [
    { id: 'v1', name: 'row', variableType: 'variable', value: 0, visible: true, object: null },
    { id: 'v2', name: '줄들', variableType: 'list', array: [], visible: true, object: null },
  ];
  const object = (project.objects as RawEntity[])[0]!;
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: 'add_value_to_list',
      params: [{ type: 'get_variable', params: ['v1', null] }, 'v2', null],
      statements: [],
    },
    {
      type: 'insert_value_to_list',
      params: [
        { type: 'get_variable', params: ['v1', null] },
        'v2',
        { type: 'number', params: ['1'] },
        null,
      ],
      statements: [],
    },
  ]]);

  const back = decompileProject(project, [], { inline: true });
  assert.match(back.source, /in 줄들 add \(row\)/);
  assert.match(back.source, /in 줄들 insert \(row\) at 1/);
  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
});

// Invalid saved font sizes must use the canvas fallback rather than Entry's 20px default.
test('읽을 수 없는 글꼴 크기는 캔버스가 실제로 그리는 글꼴로 되돌린다', () => {
  const project = minimalProject();
  project.objects = [{
    id: 'tx',
    name: '예측 결과',
    objectType: 'textBox',
    scene: 'scene1',
    text: '예측 결과: -',
    sprite: { pictures: [], sounds: [] },
    script: '[]',
    entity: {
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, direction: 90, visible: true,
      width: 49.27, height: 10, font: 'NaNpx Nanum Gothic', fontSize: null,
    },
  }];

  const back = decompileProject(project, []);
  const fragment = utf8(back.files.find((a) => a.path.endsWith('.etp'))!.data);
  assert.match(fragment, /^font_size = 10$/m);
  assert.match(fragment, /^font = "sans-serif"$/m);
  assert.doesNotMatch(fragment, /NaNpx/);
});

// Translation modules belong in aiUtilizeBlocks so Entry initializes them.
test('번역 블록은 되돌렸다가 다시 컴파일해도 그대로다', () => {
  const source = `var 원문 = "hello"
var 결과 = ""
scene "s":
  object "o":
    when start do
      결과 = get_translated_string("en", 원문, "ko")
      결과 = check_language(원문)
    end
  end
end`;
  const compiled = compileProject(source, { path: 'main.etp' });
  assert.deepEqual(compiled.errors, [], compiled.errors.map((e) => e.message).join('\n'));
  assert.deepEqual(compiled.project!.aiUtilizeBlocks, ['translate']);
  assert.deepEqual(compiled.project!.expansionBlocks, []);

  const back = decompileProject(compiled.project!, [], { inline: true });
  assert.deepEqual(back.warnings, []);
  assert.match(back.source, /결과 = get_translated_string\("en", 원문, "ko"\)/);
  assert.match(back.source, /결과 = check_language\(원문\)/);

  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  assert.deepEqual(again.project!.aiUtilizeBlocks, ['translate']);
});

test('번역 블록의 언어 자리는 문자열로 적어야 한다', () => {
  const result = compileProject(
    'var 원문 = ""\nscene "s":\n  object "o":\n    when start do\n      say get_translated_string(원문, "hi", "ko")\n    end\n  end\nend',
    { path: 'main.etp' },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /목록에서 고르는 자리/);
});

// Input flow tricks can skip without a frame inside loops and wait forever outside them.
test('값 자리에 놓인 반복 중단도 이어 하기와 같은 skip 으로 옮긴다', () => {
  const project = minimalProject();
  const object = (project.objects as RawEntity[])[0]!;
  const trick = (type: string) => ({
    type: 'wait_until_true',
    params: [{ type: 'boolean_not', params: [null, { type, params: [null] }] }, null],
    statements: [],
  });
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: 'repeat_inf',
      params: [null],
      statements: [[trick('stop_repeat')]],
    },
    {
      type: 'repeat_inf',
      params: [null],
      statements: [[trick('continue_repeat')]],
    },
  ]]);

  const back = decompileProject(project, [], { inline: true });
  assert.deepEqual(back.warnings, [], back.warnings.join('\n'));
  assert.equal((back.source.match(/forever:\n\s+skip\n\s+end/g) ?? []).length, 2);
  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
});

test('반복 밖에 놓인 값 자리 흐름 블록은 끝나지 않는 기다리기로 옮긴다', () => {
  const project = minimalProject();
  const object = (project.objects as RawEntity[])[0]!;
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: 'wait_until_true',
      params: [{
        type: 'boolean_not',
        params: [null, { type: 'stop_repeat', params: [null] }],
      }, null],
      statements: [],
    },
  ]]);

  const back = decompileProject(project, [], { inline: true });
  assert.deepEqual(back.warnings, [], back.warnings.join('\n'));
  assert.match(back.source, /when start do\n\s+wait false\n\s+end/);
  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
});

test('미로 수업의 반복 블록은 프레임을 쓰지 않는 무한 반복으로 옮긴다', () => {
  const project = minimalProject();
  const object = (project.objects as RawEntity[])[0]!;
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: 'ai_repeat_until_reach',
      params: [null],
      statements: [[{ type: 'move_y', params: [{ type: 'number', params: ['10'] }, null], statements: [] }]],
    },
  ]]);

  const back = decompileProject(project, [], { inline: true });
  assert.deepEqual(back.warnings, [], back.warnings.join('\n'));
  assert.match(back.source, /forever:\n\s+y \+= 10\n\s+skip\n\s+end/);
  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));

  // Empty maze loops are skipped by Entry too.
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: 'ai_repeat_until_reach', params: [null], statements: [[]] },
  ]]);
  const bare = decompileProject(project, [], { inline: true });
  assert.doesNotMatch(bare.source, /forever:/);
});

test('보이기로 켜 둔 변수와 리스트는 선언에 그대로 남는다', () => {
  const project = minimalProject();
  project.variables = [
    { id: 'v1', name: '점수', variableType: 'variable', value: 3, visible: true, object: null },
    { id: 'v2', name: '숨김', variableType: 'variable', value: 0, visible: false, object: null },
    { id: 'v3', name: '기록', variableType: 'list', array: [{ data: 'a' }], visible: true, object: null },
    {
      id: 'v4', name: '배속', variableType: 'slide', value: 1,
      minValue: 1, maxValue: 5, visible: true, object: null,
    },
  ];

  const back = decompileProject(project, [], { inline: true });
  assert.match(back.source, /^var 점수 = 3 visible$/m);
  assert.match(back.source, /^var 숨김 = 0$/m, '꺼 둔 것에는 붙이지 않습니다');
  assert.match(back.source, /^list 기록 = \["a"\] visible$/m);
  assert.match(back.source, /^var 배속 = 1 from 1 to 5 visible$/m);

  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  const seen = again.project!.variables
    .filter((v: { name: string }) => ['점수', '숨김', '기록', '배속'].includes(v.name))
    .map((v: { name: string; visible: boolean }) => [v.name, v.visible]);
  assert.deepEqual(seen, [['점수', true], ['숨김', false], ['기록', true], ['배속', true]]);
});

// Read origin when data is empty because Entry restores the original rows before running.
test('표는 origin 에만 자료가 있어도 줄을 그대로 옮긴다', () => {
  const project = minimalProject();
  project.tables = [{
    id: 'tb', name: '표', fields: ['A', 'B'],
    data: [],
    origin: [[0, 1], [2, 3]],
  }];

  const back = decompileProject(project, [], { inline: true });
  assert.match(back.source, /table 표:\n {2}columns "A", "B"\n {2}row 0, 1\n {2}row 2, 3\nend/);
  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  assert.deepEqual(again.project!.tables[0].data, [['0', '1'], ['2', '3']]);
});

test('변수 상자 자리는 positions 를 켰을 때만 적는다', () => {
  const project = minimalProject();
  project.variables = [
    { id: 'v1', name: '점수', variableType: 'variable', value: 0, visible: true, object: null, x: -120, y: 80 },
    { id: 'v2', name: '기록', variableType: 'list', array: [], visible: true, object: null, x: 40, y: -30 },
  ];

  const plain = decompileProject(project, [], { inline: true });
  assert.match(plain.source, /^var 점수 = 0 visible$/m, '기본은 자리를 적지 않습니다');
  assert.doesNotMatch(plain.source, / at /);

  const placed = decompileProject(project, [], { inline: true, positions: true });
  assert.match(placed.source, /^var 점수 = 0 visible at -120 80$/m);
  assert.match(placed.source, /^list 기록 = \[\] visible at 40 -30$/m);

  const again = compileProject(placed.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  const placedAt = again.project!.variables
    .filter((v: { name: string }) => ['점수', '기록'].includes(v.name))
    .map((v: { name: string; x: number; y: number }) => [v.name, v.x, v.y]);
  assert.deepEqual(placedAt, [['점수', -120, 80], ['기록', 40, -30]]);
});

// Field dropdowns store one-based column numbers even when they display names.
test('표의 열 고르기 드롭다운은 열 번호로 옮긴다', () => {
  const project = minimalProject();
  project.tables = [{ id: 'tb', name: '점수표', fields: ['이름', '점수'], data: [['철수', 90]] }];
  const object = (project.objects as RawEntity[])[0]!;
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: 'dialog', params: [{
        type: 'get_value_from_table',
        params: ['tb', { type: 'number', params: ['1'] }, { type: 'get_table_fields', params: ['2'] }, null],
      }, 'speak', null],
      statements: [],
    },
  ]]);

  const back = decompileProject(project, [], { inline: true });
  assert.deepEqual(back.warnings, [], back.warnings.join('\n'));
  assert.match(back.source, /점수표\[1, 2\]/);
  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
});

test('표의 차트 정의는 되돌렸다가 다시 컴파일해도 그대로다', () => {
  const project = minimalProject();
  project.tables = [{
    id: 'tb', name: '자료', fields: ['일자', '신규', '누적'],
    data: [['1/3', 1, 2]],
    chart: [
      { type: 'line', title: '꺾은선 차트', xIndex: 0, yIndex: -1, categoryIndexes: [1, 2] },
      { type: 'pie', title: '원 차트', xIndex: 0, yIndex: 2, categoryIndexes: [] },
    ],
  }];

  const back = decompileProject(project, [], { inline: true });
  assert.deepEqual(back.warnings, [], back.warnings.join('\n'));
  // Convert Entry's zero-based chart columns to one-based Entropy columns.
  assert.match(back.source, /^ {2}chart line "꺾은선 차트" x 1 series 2, 3$/m);
  assert.match(back.source, /^ {2}chart pie "원 차트" x 1 y 3$/m);

  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  assert.deepEqual(again.project!.tables[0].chart, [
    { type: 'line', title: '꺾은선 차트', xIndex: 0, yIndex: -1, categoryIndexes: [1, 2] },
    { type: 'pie', title: '원 차트', xIndex: 0, yIndex: 2, categoryIndexes: [] },
  ]);
});

test('차트 종류와 열 번호는 있는 것만 받는다', () => {
  const table = (chart: string) => `table 자료:\n  columns "A", "B"\n  row 1, 2\n  ${chart}\nend`;
  const kind = compileProject(table('chart donut x 1 y 2'), { path: 'main.etp' });
  assert.equal(kind.ok, false);
  assert.match(kind.errors[0].message, /차트는 없습니다/);

  const column = compileProject(table('chart bar x 1 series 5'), { path: 'main.etp' });
  assert.equal(column.ok, false);
  assert.match(column.errors[0].message, /5번째 열이 없습니다/);
});

test('테이블 선언은 엔트리 project.tables 항목이 된다', () => {
  const { project, errors } = compileProject(
    'table 점수표 as "점수 표":\n  columns "이름", "점수"\n  row "철수", 10\n  row "영희", 20\nend',
    { path: 'main.etp' },
  );
  assert.deepEqual(errors, []);
  assert.equal(project!.tables.length, 1);
  const [table] = project!.tables;
  assert.equal(table.name, '점수 표');
  assert.deepEqual(table.fields, ['이름', '점수']);
  assert.deepEqual(table.data, [['철수', '10'], ['영희', '20']]);
});

test('테이블 줄의 칸 수가 열 개수와 다르면 에러다', () => {
  const result = compileProject(
    'table T:\n  columns "a", "b"\n  row 1\nend',
    { path: 'main.etp' },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /열 개수\(2\)와 같아야 합니다/);
});

// Rename parameters that would hide ID-based variable references after decompilation.
function paramClashProject() {
  const param = (blockType: string, next: unknown) => ({
    type: 'function_field_string',
    params: [{ type: blockType, params: [null], statements: [] }, next],
    statements: [],
  });
  const labelField = (text: string, next: unknown) => ({
    type: 'function_field_label',
    params: [text, next],
    statements: [],
  });

  const create = {
    type: 'function_create',
    params: [
      labelField('걷기', param('stringParam_aaaa', labelField('넉백횟수', param('stringParam_bbbb', null)))),
      null,
    ],
    statements: [[
      { type: 'set_variable', params: ['var1', { type: 'stringParam_bbbb', params: [null], statements: [] }, null], statements: [] },
    ]],
  };

  return {
    name: '이름 충돌 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [{ id: 'var1', name: '넉백횟수', variableType: 'variable', value: 0, visible: false, x: 0, y: 0 }],
    messages: [],
    functions: [{ id: 'fn01', type: 'normal', localVariables: [], useLocalVariables: false, content: JSON.stringify([[create]]) }],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: {
        pictures: [{ id: 'pic1', name: '기본', fileurl: null, dimension: { width: 1, height: 1 } }],
        sounds: [],
      },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        { type: 'func_fn01', params: [{ type: 'number', params: ['1'] }, { type: 'number', params: ['3'] }, null], statements: [] },
      ]]),
    }],
  } as unknown as RawEntity;
}

test('변수와 이름이 겹치는 라벨은 매개변수 이름으로 그대로 쓰지 않는다', () => {
  const result = decompileProject(paramClashProject(), [], { inline: true });

  assert.match(result.source, /^function 걷기\(a, (?!넉백횟수\))[\p{L}\p{N}_]+\):$/mu);
  assert.match(result.source, /^ {2}넉백횟수 = [\p{L}\p{N}_]+$/mu);
  assert.doesNotMatch(result.source, /^ {2}넉백횟수 = 넉백횟수$/m);
});

test('이름이 겹쳐도 되돌린 함수는 다시 컴파일되어 전역 변수에 값을 넣는다', () => {
  const result = decompileProject(paramClashProject(), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-clash-'));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }

  const recompiled = compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));

  const body = JSON.parse(recompiled.project!.functions[0].content)[0][0].statements[0];
  const write = body.find((block: any) => block.type === 'set_variable');
  assert.ok(write, '전역 변수 대입 블록이 남아 있어야 한다');
  const variable = recompiled.project!.variables.find((v: any) => v.name === '넉백횟수');
  assert.equal(write.params[0], variable!.id);
  assert.match(write.params[1].type, /^stringParam_/);
});

function valueProject(script: any[], extra: RawEntity = {}): RawEntity {
  return {
    name: '값 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: extra.variables ?? [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true, ...(extra.entity ?? {}) },
      sprite: {
        pictures: [{ id: 'pic1', name: '기본', fileurl: null, dimension: { width: 10, height: 10 } }],
        sounds: extra.sounds ?? [],
      },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        ...script,
      ]]),
    }],
  } as unknown as RawEntity;
}

function recompiledThread(project: RawEntity) {
  const result = decompileProject(project, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-value-'));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }
  const recompiled = compileProject(result.source, { path: mainFile, assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, [], recompiled.errors.map((e) => e.message).join('\n'));
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  return {
    source: fragment,
    warnings: result.warnings,
    blocks: JSON.parse(recompiled.project!.objects[0].script)[0] as any[],
    project: recompiled.project!,
  };
}

// Primitive brush colors must remain colors instead of placeholder text.
test('붓 색 고르기(color) 블록은 색상 리터럴로 되돌아온다', () => {
  const color = (hex: string) => ({ type: 'color', params: [hex], statements: [] });
  const { source, warnings, blocks } = recompiledThread(valueProject([
    { type: 'set_color', params: [color('#ffdc69'), null], statements: [] },
    { type: 'set_fill_color', params: [color('#616161'), null], statements: [] },
  ]));

  assert.deepEqual(warnings, []);
  assert.match(source, /^ {2}draw_color = #ffdc69$/m);
  assert.match(source, /^ {2}fill_color = #616161$/m);
  assert.equal(blocks.find((b) => b.type === 'set_color').params[0], '#ffdc69');
  assert.equal(blocks.find((b) => b.type === 'set_fill_color').params[0], '#616161');
});

// Keep char_at indexing single-evaluation; slice(text, i, i) would evaluate i twice.
test('변수의 글자 하나 읽기는 이름[번호] 로 되돌려 자리 번호를 한 번만 계산한다', () => {
  const project = valueProject([
    {
      type: 'set_variable',
      params: ['v1', {
        type: 'char_at',
        params: [null, { type: 'get_variable', params: ['v1', null] }, null,
          { type: 'calc_rand', params: [null, { type: 'number', params: ['1'] }, null, { type: 'number', params: ['5'] }, null] }, null],
      }, null],
      statements: [],
    },
  ], { variables: [{ id: 'v1', name: '글자', variableType: 'variable', value: 0, visible: false, x: 0, y: 0 }] } as RawEntity);

  const { source, warnings, blocks } = recompiledThread(project);
  assert.deepEqual(warnings, []);
  assert.match(source, /^ {2}글자 = 글자\[random\(1, 5\)\]$/m);
  const value = blocks.find((b) => b.type === 'set_variable').params[1];
  assert.equal(value.type, 'char_at');
  assert.equal(value.params[3].type, 'calc_rand');
});

// Fractional parts need decimal subtraction; binary modulo changes digit-sensitive results.
test('소수점 부분(unnatural) 은 10진으로 빼는 계산으로 되돌아온다', () => {
  const { source, warnings, blocks } = recompiledThread(valueProject([
    {
      type: 'move_x',
      params: [{ type: 'calc_operation', params: [null, { type: 'number', params: ['-1.3'] }, null, 'unnatural'] }, null],
      statements: [],
    },
  ]));

  assert.deepEqual(warnings, []);
  assert.match(source, /^ {2}x \+= \(abs\(-1\.3\) - floor\(abs\(-1\.3\)\)\)$/m);
  const value = blocks.find((b) => b.type === 'move_x').params[0];
  assert.equal(value.type, 'calc_basic');
  assert.equal(value.params[1], 'MINUS');
  assert.equal(value.params[0].params[3], 'abs');
  assert.equal(value.params[2].params[3], 'floor');
});

// Entry ignores calc_operation suffixes after the first underscore.
test('역삼각함수의 도 단위 이름도 자리표시자 없이 되돌아온다', () => {
  for (const [entryName, entropyName] of [['asin', 'asin'], ['acos', 'acos'], ['atan', 'atan']]) {
    const { source, warnings } = recompiledThread(valueProject([
      {
        type: 'move_x',
        params: [{ type: 'calc_operation', params: [null, { type: 'number', params: ['0.5'] }, null, entryName] }, null],
        statements: [],
      },
    ]));
    assert.deepEqual(warnings, [], entryName);
    assert.match(source, new RegExp(`^ {2}x \\+= ${entropyName}\\(0\\.5\\)$`, 'm'));
  }
});

test('엔트리 키 목록의 모든 키 코드가 그대로 되돌아온다', () => {
  const codes = [8, 9, 13, 16, 17, 18, 27, 32, 37, 38, 39, 40, 48, 57, 65, 90,
    186, 187, 188, 189, 190, 191, 192, 219, 220, 221, 222];
  const project = valueProject([]);
  project.objects[0].script = JSON.stringify(codes.map((code) => [
    { type: 'when_some_key_pressed', params: [null, String(code)], statements: [] },
    {
      type: '_if',
      params: [{ type: 'is_press_some_key', params: [String(code), null], statements: [] }, null],
      statements: [[{ type: 'move_x', params: [{ type: 'number', params: ['1'] }, null], statements: [] }]],
    },
  ]));

  const { warnings, project: recompiled } = recompiledThread(project);
  assert.deepEqual(warnings, []);

  const threads = JSON.parse(recompiled.objects[0].script);
  assert.deepEqual(threads.map((t: any[]) => Number(t[0].params[1])), codes);
  assert.deepEqual(
    threads.map((t: any[]) => Number(t[1].params[0].params[0])),
    codes,
    '판단 블록의 키 코드도 그대로여야 한다',
  );
});

// Preserve fractional scale percentages instead of rounding to whole percentages.
test('배율은 퍼센트 소수점을 버리지 않고 되돌아온다', () => {
  const project = valueProject([], { entity: { scaleX: 0.513, scaleY: 1.564 } } as RawEntity);
  const { source, project: recompiled } = recompiledThread(project);

  assert.match(source, /^scale_x = 51\.3$/m);
  assert.match(source, /^scale_y = 156\.4$/m);
  assert.equal(recompiled.objects[0].entity.scaleX, 0.513);
  assert.equal(recompiled.objects[0].entity.scaleY, 1.564);
});

// Preserve saved sound duration because it controls waiting and whether Entry loads the sound.
test('소리 길이는 원본 값을 늘 적는다', () => {
  const project = valueProject([], {
    sounds: [{ id: 'snd1', name: '짖는 소리', fileurl: null, ext: '.mp3', duration: 1.3 }],
  } as RawEntity);
  const { source, project: recompiled } = recompiledThread(project);

  assert.match(source, /^sound 짖는_소리 ".*\.mp3" for 1\.3 as "짖는 소리"$/m);
  assert.equal(recompiled.objects[0].sprite.sounds[0].duration, 1.3);
});

function danglingResourceProject(): RawEntity {
  return {
    name: '없는 자원 테스트',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: {
        pictures: [{ id: 'pic1', name: '기본', fileurl: null, dimension: { width: 10, height: 10 } }],
        sounds: [],
      },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        {
          type: 'change_to_some_shape',
          params: [{ type: 'get_pictures', params: ['지워진모양'] }, null],
          statements: [],
        },
      ]]),
    }],
  } as RawEntity;
}

test('작품에 없는 모양 id 는 그대로 남기고 주의로 알린다', () => {
  const result = decompileProject(danglingResourceProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^ {2}costume = "지워진모양"$/m);
  assert.deepEqual(result.warnings, []);
  assert.match(result.notices[0]!, /모양 id '지워진모양' 가 작품에 없어 그대로 남겼습니다/);
});

test('되돌리기의 strict 는 주의를 경고로 올린다', () => {
  const loose = decompileProject(danglingResourceProject(), [], { inline: true });
  const strict = decompileProject(danglingResourceProject(), [], { strict: true });

  assert.deepEqual(strict.notices, []);
  assert.deepEqual(strict.warnings, loose.notices);
});


// Plain continue yields a frame; the boolean-slot trick does not.
function loopFlowProject(): RawEntity {
  return {
    name: '흐름 제어',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: null,
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: { pictures: [], sounds: [] },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        {
          type: 'repeat_inf',
          params: [null, null],
          statements: [[
            { type: 'continue_repeat', params: [null], statements: [] },
            {
              type: 'wait_until_true',
              params: [{
                type: 'boolean_not',
                params: [null, { type: 'continue_repeat', params: [null], statements: [] }, null],
              }, null],
              statements: [],
            },
          ]],
        },
      ]]),
    }],
  } as RawEntity;
}

test("'이번 반복 건너뛰기' 는 continue 로, 판단 자리에 넣은 트릭은 skip 으로 되돌린다", () => {
  const result = decompileProject(loopFlowProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^ {4}continue$/m);
  assert.match(fragment, /^ {4}skip$/m);
  assert.doesNotMatch(fragment, /decompile: continue_repeat/);
  assert.deepEqual(result.warnings, []);
});

test('되돌린 continue · skip 은 원래 블록 모양 그대로 다시 컴파일된다', () => {
  const result = decompileProject(loopFlowProject(), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-flow-'));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }

  const recompiled = compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, []);
  const types = JSON.stringify(JSON.parse(recompiled.project!.objects[0]!.script))
    .match(/"type":"[a-z_]+"/g);
  assert.deepEqual(types, [
    '"type":"when_run_button_click"',
    '"type":"repeat_inf"',
    '"type":"continue_repeat"',
    '"type":"wait_until_true"',
    '"type":"boolean_not"',
    '"type":"continue_repeat"',
  ]);
});

function calcOperationProject(op: string): RawEntity {
  return {
    name: '계산',
    speed: 60,
    scenes: [{ id: 'sc1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'sc1',
      rotateMethod: 'free',
      selectedPictureId: null,
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: { pictures: [], sounds: [] },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        {
          type: 'dialog_time',
          params: [
            {
              type: 'calc_operation',
              params: [null, { type: 'number', params: ['5'] }, null, op],
            },
            { type: 'number', params: ['1'] },
            'hide',
            null,
          ],
          statements: [],
        },
      ]]),
    }],
  } as RawEntity;
}

test('calc_operation 은 어떤 연산자로도 옮길 수 있다 — 모르는 블록이 아니다', () => {
  const known = [
    'square', 'root', 'sin', 'cos', 'tan', 'asin_radian', 'acos_radian', 'atan_radian',
    'log', 'ln', 'unnatural', 'floor', 'ceil', 'round', 'factorial', 'abs',
  ];
  for (const op of known) {
    const result = decompileProject(calcOperationProject(op), [], { inline: true });
    assert.deepEqual(result.warnings, [], op);
    assert.doesNotMatch(result.source, /calc_operation/, op);
  }
});

test('엔트리가 모르는 연산자는 엔트리와 같이 round 로 읽는다', () => {
  // Entry treats unrecognized calc_operation names as round.
  const result = decompileProject(calcOperationProject('없는연산'), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.match(fragment, /round\(5\)/);
  assert.deepEqual(result.warnings, []);
});

test('factorial 은 컴파일해서 되돌려도 그대로다', () => {
  const source = `scene "s":
  object "o":
    when start do
      say factorial(5) for 1
    end
  end
end`;
  const compiled = compileProject(source, { path: 'f.etp' });
  assert.deepEqual(compiled.errors, []);
  const blocks = JSON.stringify(JSON.parse(compiled.project!.objects[0]!.script as string));
  assert.match(blocks, /"type":"calc_operation","params":\[null,.*"factorial"/);
  const back = decompileProject(compiled.project as never, []);
  const fragment = utf8(back.files.find((a) => a.path === 'objects/o.etp')!.data);
  assert.match(fragment, /say factorial\(5\) for 1/);
  assert.deepEqual(back.warnings, []);
});

function skipCarrierProject(inLoop: boolean): RawEntity {
  const carrier = {
    type: 'Talebot_Move',
    params: [
      { type: 'continue_repeat', params: [null], statements: [] },
      { type: 'continue_repeat', params: [null], statements: [] },
      null,
    ],
    statements: [],
  };
  const body = inLoop
    ? [{ type: 'repeat_inf', params: [null, null], statements: [[carrier]] }]
    : [carrier];
  return {
    name: '치트 블록',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: null,
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: { pictures: [], sounds: [] },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        ...body,
      ]]),
    }],
  } as RawEntity;
}

test('하드웨어 블록으로 만든 반복 건너뛰기 치트는 조용히 skip 으로 되돌린다', () => {
  const result = decompileProject(skipCarrierProject(true), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^ {4}skip$/m);
  assert.doesNotMatch(fragment, /Talebot_Move/);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.notices, []);
});

test('반복문 밖의 같은 치트는 아무것도 남기지 않는다', () => {
  const result = decompileProject(skipCarrierProject(false), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.doesNotMatch(fragment, /skip/);
  assert.doesNotMatch(fragment, /Talebot_Move/);
  assert.deepEqual(result.warnings, []);
});

// Check recognized carrier blocks too; their inputs can prevent the block itself from running.
test('되돌리기도 아는 블록에 실린 치트를 같이 읽는다', () => {
  const carriers: Array<[string, unknown[]]> = [
    ['sound_something_wait_with_block', []],
    ['sound_something_second_wait_with_block', [{ type: 'number', params: ['0'] }]],
    ['dialog_time', [{ type: 'number', params: ['0'] }, 'speak']],
    ['locate_xy_time', [{ type: 'number', params: ['0'] }, { type: 'number', params: ['0'] }]],
    ['wait_second', []],
  ];
  for (const [type, rest] of carriers) {
    const project = minimalProject();
    const object = (project.objects as RawEntity[])[0]!;
    object.script = JSON.stringify([[
      { type: 'when_run_button_click', params: [null], statements: [] },
      {
        type: 'repeat_inf',
        params: [null],
        statements: [[{
          type,
          params: [{ type: 'continue_repeat', params: [null] }, ...rest, null],
          statements: [],
        }]],
      },
    ]]);

    const back = decompileProject(project, [], { inline: true });
    assert.deepEqual(back.warnings, [], `${type}: ${back.warnings.join('\n')}`);
    assert.match(back.source, /forever:\n\s+skip\n\s+end/, type);
    assert.doesNotMatch(back.source, new RegExp(type.replace(/_/g, '[_]')), type);
    const again = compileProject(back.source, { path: 'main.etp' });
    assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  }
});

// Statements wrapped in function fields execute before the surrounding block.
function parkedStatementProject(): RawEntity {
  return {
    name: "값 자리에 끼운 문장",
    speed: 60,
    scenes: [{ id: "scene1", name: "장면 1" }],
    variables: [
      { id: "l1", name: "기록", variableType: "list", array: [], visible: false, object: null, x: 0, y: 0 },
    ],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: "obj1",
      name: "주인공",
      objectType: "sprite",
      scene: "scene1",
      rotateMethod: "free",
      selectedPictureId: null,
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: { pictures: [], sounds: [] },
      script: JSON.stringify([[
        { type: "when_run_button_click", params: [null], statements: [] },
        {
          type: "whalesbot_eagle_1001_rise",
          params: [{
            type: "function_field_string",
            params: [
              { type: "add_value_to_list", params: [{ type: "number", params: ["1"] }, "l1", null], statements: [] },
              null,
            ],
            statements: [],
          }],
          statements: [],
        },
      ]]),
    }],
  } as RawEntity;
}

test("값 자리에 끼워 둔 문장은 바깥 블록을 못 옮겨도 살아남는다", () => {
  const result = decompileProject(parkedStatementProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === "objects/주인공.etp")!.data);

  assert.match(fragment, /in 기록 add 1/);
  // Unsupported parent hardware blocks remain notes with warnings.
  assert.match(fragment, /whalesbot_eagle_1001_rise/);
  assert.ok(
    result.warnings.some((warning) => warning.includes("whalesbot_eagle_1001_rise")),
    result.warnings.join("\n"),
  );
});

function unattachedProject(): RawEntity {
  return {
    name: '떼어 놓은 블록',
    speed: 60,
    scenes: [{ id: 'scene1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    aiUtilizeBlocks: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'scene1',
      rotateMethod: 'free',
      selectedPictureId: null,
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: { pictures: [], sounds: [] },
      script: JSON.stringify([
        [{ type: 'when_run_button_click', params: [null], statements: [] }],
        [{
          type: 'move_direction',
          params: [{ type: 'number', params: ['10'] }, null],
          statements: [],
        }],
      ]),
    }],
  } as RawEntity;
}

test('연결되지 않은 블록을 주석으로 남기는 것은 아무것도 알리지 않는다', () => {
  const result = decompileProject(unattachedProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^# forward 10$/m);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.notices, []);
});

test('워크스페이스에 떨어져 있던 블록은 옮기지 못했다고 알리지 않는다', () => {
  const project = unattachedProject();
  const object = (project as any).objects[0];
  object.script = JSON.stringify([
    [{ type: 'when_run_button_click', params: [null], statements: [] }],
    // Detached reporter stacks are workspace fragments, not executable scripts.
    [{ type: 'calc_rand', params: [null, { type: 'number', params: ['1'] }, null, { type: 'number', params: ['10'] }, null], statements: [] }],
  ]);

  const result = decompileProject(project, [], { inline: true });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.notices, []);
});

test('연결된 코드의 못 옮기는 블록은 그대로 알린다', () => {
  const project = unattachedProject();
  const object = (project as any).objects[0];
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: '아직_없는_블록', params: [], statements: [] },
  ]]);

  const result = decompileProject(project, [], { inline: true });
  assert.match(result.warnings[0]!, /'아직_없는_블록' 은\(는\) 아직 옮길 수 없습니다/);
});

function loneCommentProject(): RawEntity {
  const project = unattachedProject();
  (project as any).objects[0].script = JSON.stringify([
    [{ type: 'when_run_button_click', params: [null], statements: [] }],
    { ...COMMENT_BLOCK, value: '메모 첫 줄\n메모 둘째 줄' },
    { ...COMMENT_BLOCK, id: 'cmt2', value: '   ' },
  ].map((thread) => (Array.isArray(thread) ? thread : [thread])));
  return project;
}

const COMMENT_BLOCK = {
  id: 'cmt1', x: 0, y: 0, width: 160, height: 160, value: '',
  readOnly: false, visible: true, display: true, movable: true,
  isOpened: true, deletable: 1, type: 'comment',
};

test('떠 있는 메모(comment)는 블록이 아니라 주석으로 되돌린다', () => {
  const result = decompileProject(loneCommentProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^# 메모 첫 줄$/m);
  assert.match(fragment, /^# 메모 둘째 줄$/m);
  assert.doesNotMatch(fragment, /지원하지 않는 블록/);
  assert.doesNotMatch(fragment, /^#\s*$/m);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.notices, []);
});


function attachedCommentProject(): RawEntity {
  const note = (value: string) => ({
    x: 0, y: 0, width: 160, height: 100, value, readOnly: false, visible: true,
    display: true, movable: true, isOpened: true, deletable: 1, type: 'comment',
  });
  const project = unattachedProject();
  (project as any).objects[0].script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [], comment: note('시작할 때') },
    {
      type: 'move_direction',
      params: [{ type: 'number', params: ['10'] }, null],
      statements: [],
      comment: note('앞으로\n두 줄짜리 메모'),
    },
    { type: 'bounce_wall', params: [null], statements: [], comment: note('   ') },
  ]]);
  return project;
}

test('블록에 붙은 메모는 그 문장 위의 주석으로 되돌아온다', () => {
  const result = decompileProject(attachedCommentProject(), []);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);

  assert.match(fragment, /^# 시작할 때\nwhen start do$/m);
  assert.match(fragment, /^ {2}# 앞으로\n {2}# 두 줄짜리 메모\n {2}forward 10$/m);
  assert.doesNotMatch(fragment, /^\s*#\s*$/m);
  assert.deepEqual(result.warnings, []);
});

test('되돌린 주석은 다시 컴파일하면 같은 블록에 붙는다', () => {
  const result = decompileProject(attachedCommentProject(), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-decompile-note-'));
  const mainFile = path.join(dir, 'main.etp');
  fs.writeFileSync(mainFile, result.source);
  for (const asset of [...result.files, ...result.assets]) {
    const target = path.join(dir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }

  const recompiled = compileProject(fs.readFileSync(mainFile, 'utf-8'), { path: mainFile, assetDirs: [dir] });
  assert.deepEqual(recompiled.errors, []);
  const [hat, move] = JSON.parse(recompiled.project!.objects[0]!.script)[0];
  assert.equal(hat.type, 'when_run_button_click');
  assert.equal(hat.comment.value, '시작할 때');
  assert.equal(move.type, 'move_direction');
  assert.equal(move.comment.value, '앞으로\n두 줄짜리 메모');
});

test('함수 정의에 붙은 메모도 되돌아온다', () => {
  const project = unattachedProject();
  (project as any).functions = [{
    id: 'fn1',
    content: JSON.stringify([[{
      type: 'function_create',
      params: [{ type: 'function_field_label', params: ['인사'] }, null],
      statements: [[]],
      comment: {
        x: 0, y: 0, width: 160, height: 100, value: '쓰는 법: 인사()', readOnly: false,
        visible: true, display: true, movable: true, isOpened: true, deletable: 1, type: 'comment',
      },
    }]]),
  }];

  const result = decompileProject(project, [], { inline: true });
  assert.match(result.source, /^# 쓰는 법: 인사\(\)\nfunction 인사\(\):$/m);
});

test('팔레트에서 내려간 boolean_and · boolean_or 는 and · or 로 되돌아온다', () => {
  const bool = (value: boolean) => ({ type: value ? 'True' : 'False', params: [], statements: [] });
  const project = unattachedProject();
  project.objects![0]!.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    {
      type: '_if',
      params: [{ type: 'boolean_and', params: [bool(true), null, bool(false)], statements: [] }, null],
      statements: [[{ type: 'move_direction', params: [{ type: 'number', params: ['10'] }, null], statements: [] }]],
    },
    {
      type: '_if',
      params: [{ type: 'boolean_or', params: [bool(true), null, bool(false)], statements: [] }, null],
      statements: [[{ type: 'move_direction', params: [{ type: 'number', params: ['20'] }, null], statements: [] }]],
    },
  ]]);

  const result = decompileProject(project, []);
  const fragment = utf8(result.files
    .find((asset) => asset.path === 'objects/주인공.etp')!.data);
  assert.match(fragment, /if \(true and false\):/);
  assert.match(fragment, /if \(true or false\):/);
  // Placeholder strings are truthy and must not turn unsupported conditions into unconditional branches.
  assert.doesNotMatch(fragment, /\[decompile/);
  assert.deepEqual([...result.warnings], []);
});

test('함수 정의 다음에 이어 붙은 본문도 되돌린다 (playentry 작품 형태)', () => {
  const define = {
    id: 'd', type: 'function_create',
    params: [{ id: 'l', type: 'function_field_label', params: ['짓기', null] }, null],
  };
  const body = { id: 'b', type: 'move_direction', params: [{ type: 'number', params: ['10'] }, null] };

  // playentry stores the body after the definition in its stack.
  const flat = unattachedProject();
  (flat as any).functions = [{ id: 'fn1', content: JSON.stringify([[define, body]]) }];
  assert.match(decompileProject(flat, [], { inline: true }).source, /^function 짓기\(\):\n {2}forward 10\nend$/m);

  // Saved archives nest the same body inside the definition's statement slot.
  const nested = unattachedProject();
  (nested as any).functions = [{
    id: 'fn1',
    content: JSON.stringify([[{ ...define, statements: [[body]] }]]),
  }];
  assert.match(decompileProject(nested, [], { inline: true }).source, /^function 짓기\(\):\n {2}forward 10\nend$/m);
});

// Sound probes read as loaded because entropy preloads every sound before starting.
test('값 자리에 놓인 소리 블록은 1 로 되돌린다', () => {
  const project = minimalProject(1);
  const probe = {
    type: 'set_variable',
    params: [
      'v1',
      {
        type: 'sound_something_second_with_block',
        params: [
          { type: 'get_sounds', params: ['s1'] },
          { type: 'text', params: ['Infinity'] },
          null,
        ],
      },
      null,
    ],
    statements: [],
  };
  project.variables = [{ id: 'v1', name: '로딩됨', variableType: 'variable', value: 0 }] as never;
  (project.objects as never[])[0] = {
    ...(project.objects as Record<string, unknown>[])[0],
    script: JSON.stringify([[{ type: 'when_run_button_click', params: [null], statements: [] }, probe]]),
  } as never;

  const result = decompileProject(project, [], { inline: true });
  assert.match(result.source, /로딩됨 = 1/, '자리표시자가 아니라 1 이 들어갑니다');
  assert.equal(
    result.warnings.some((warning) => warning.includes('sound_something_second_with_block')),
    false,
    '옮기지 못한 블록으로 세지 않습니다',
  );
  assert.ok(compileProject(result.source, { path: 'main.etp' }).project);
});

test('stop_run 은 stop project 로 되돌아가고 다시 그 블록이 된다', () => {
  const project = minimalProject(1);
  (project.objects as never[])[0] = {
    ...(project.objects as Record<string, unknown>[])[0],
    script: JSON.stringify([
      [{ type: 'when_run_button_click', params: [null], statements: [] },
       { type: 'stop_run', params: [null], statements: [] }],
    ]),
  } as never;

  const result = decompileProject(project, [], { inline: true });
  assert.match(result.source, /stop project/);
  assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));

  const again = compileProject(result.source, { path: 'main.etp' });
  assert.ok(again.project, again.errors[0]?.message);
  assert.match(JSON.stringify(again.project), /stop_run/);
});

// Scope reused parameter types and local IDs to each function instead of the whole project.
test('여러 함수가 같은 매개변수·지역변수 id 를 가져도 각자 자기 것으로 읽는다', () => {
  const project = minimalProject() as unknown as Record<string, unknown>;
  const header = (label: string) => ({
    type: 'function_field_label',
    params: [label, { type: 'function_field_string', params: [{ type: 'stringParam_same', params: [] }] }],
  });
  const copy = (id: string, label: string) => ({
    id,
    localVariables: [{ id: 'same_local', name: 'n', value: 0 }],
    content: JSON.stringify([[
      {
        type: 'function_create_value',
        params: [header(label), null, null, { type: 'get_func_variable', params: ['same_local', null] }],
        statements: [[
          { type: 'set_func_variable', params: ['same_local', { type: 'stringParam_same', params: [] }, null], statements: [] },
        ]],
      },
    ]]),
  });
  project.functions = [copy('aaaa', 'first'), copy('bbbb', 'second')];

  const result = decompileProject(project as unknown as RawEntity, [], { inline: true });
  for (const label of ['first', 'second']) {
    const body = result.source.slice(result.source.indexOf(`function ${label}(`));
    const upToEnd = body.slice(0, body.indexOf('\nend'));
    assert.match(upToEnd, /n = a/, `${label}: 자기 매개변수를 읽습니다`);
    assert.match(upToEnd, /return n/, `${label}: 자기 지역변수를 읽습니다`);
  }
  const compiled = compileProject(result.source, { path: 'main.etp' });
  assert.equal(
    compiled.errors.filter((error) => /선언되지 않은 이름/.test(error.message)).length,
    0,
    compiled.errors[0]?.message ?? '',
  );
});

// Preserve unnamed key codes so their entire event scripts survive.
test('엔트리 목록에 없는 키도 이름이나 번호로 되돌린다', () => {
  const project = minimalProject();
  const object = (project.objects as RawEntity[])[0]!;
  const move = (type: string) => ({
    type, params: [{ type: 'number', params: ['10'] }, null], statements: [],
  });
  object.script = JSON.stringify([
    [{ type: 'when_some_key_pressed', params: [null, '45'], statements: [] }, move('move_x')],
    [
      { type: 'when_run_button_click', params: [null], statements: [] },
      {
        type: '_if',
        params: [{ type: 'is_press_some_key', params: ['45', null] }, null],
        statements: [[move('move_y')]],
      },
    ],
    [{ type: 'when_some_key_pressed', params: [null, '145'], statements: [] }, move('move_x')],
  ]);

  const back = decompileProject(project, [], { inline: true });
  assert.deepEqual(back.warnings, [], back.warnings.join('\n'));
  assert.match(back.source, /when key "insert" do/);
  assert.match(back.source, /if key_down\("insert"\):/);
  assert.match(back.source, /when key "145" do/);

  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  const script = JSON.parse(
    String(((again.project as unknown as RawEntity).objects as RawEntity[])[0]!.script),
  ) as RawEntity[][];
  const codes = script.map((stack) => String((stack[0]!.params as unknown[])[1] ?? '')).sort();
  assert.deepEqual(codes, ['', '145', '45'], '키 코드가 그대로 돌아옵니다');
});

// Rename command-like function names because statement parsing takes precedence over calls.
test('문장을 여는 낱말과 같은 함수·변수 이름은 비껴 간다', () => {
  const project = minimalProject();
  const object = (project.objects as RawEntity[])[0]!;
  project.functions = [{
    id: 'fn1',
    type: 'normal',
    content: JSON.stringify([[{
      type: 'function_create',
      params: [{ type: 'function_field_label', params: ['move', null] }, null],
      statements: [[]],
    }]]),
  }];
  project.variables = [
    { id: 'v1', name: 'repeat', variableType: 'variable', value: 0, visible: false, object: null },
  ];
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: 'func_fn1', params: [null], statements: [] },
    { type: 'set_variable', params: ['v1', { type: 'number', params: ['1'] }, null], statements: [] },
  ]]);

  const back = decompileProject(project, [], { inline: true });
  assert.match(back.source, /function move_\(\)/);
  assert.match(back.source, /^\s+move_\(\)$/m);
  assert.match(back.source, /var repeat_ as "repeat" = 0/);
  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
});

// Preserve eight-digit colors because dropping alpha makes translucent text opaque.
test('알파가 붙은 색도 알파째로 오간다', () => {
  const project = minimalProject();
  const object = (project.objects as RawEntity[])[1]!;
  object.script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: 'text_change_font_color', params: ['#00000050', null], statements: [] },
  ]]);

  const back = decompileProject(project, [], { inline: true });
  assert.match(back.source, /font_color = #00000050/);

  const again = compileProject(back.source, { path: 'main.etp' });
  assert.deepEqual(again.errors, [], again.errors.map((e) => e.message).join('\n'));
  const script = JSON.parse(
    String(((again.project as unknown as RawEntity).objects as RawEntity[])
      .find((item) => item.objectType === 'textBox')!.script),
  ) as RawEntity[][];
  const color = (script[0]![1]!.params as unknown[])[0];
  assert.equal(color, '#00000050', '알파가 그대로 남습니다');
});

// Scan beyond the SVG header because late text tags also need the saved raster's font rendering.
test('앞머리 밖에 있는 <text> 도 찾아서 PNG 를 고른다', () => {
  const filler = '<path d="M0 0"></path>'.repeat(300); // Put the tag beyond the 4096-byte header scan.
  const late = `<svg viewBox="0 0 960 540">${filler}<text font-family="yg-jalnan">안녕</text></svg>`;
  assert.ok(late.indexOf('<text') > 4096, '<text> 가 앞머리 밖에 있어야 합니다');

  const result = decompileProject(svgPictureProject(), [
    { name: 'temp/aa/aa/image/aaaa.svg', data: Buffer.from(late) },
    { name: 'temp/aa/aa/image/aaaa.png', data: Buffer.from('글자가 그대로 담긴 그림') },
  ] as never);

  const images = result.assets.filter((a) => a.path.startsWith('assets/image/'));
  assert.deepEqual(images.map((a) => a.path), ['assets/image/주인공_배경.png']);
});

// textPath is not a text tag and should not force raster selection.
test('<textPath> 는 <text> 로 치지 않는다', () => {
  const drawing = '<svg viewBox="0 0 960 540"><textPath href="#p">x</textPath></svg>';
  const result = decompileProject(svgPictureProject(), [
    { name: 'temp/aa/aa/image/aaaa.svg', data: Buffer.from(drawing) },
    { name: 'temp/aa/aa/image/aaaa.png', data: Buffer.from('png') },
  ] as never);

  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.match(fragment, /default costume 배경 "assets\/image\/주인공_배경\.svg"/);
});

// Allow one-pixel size differences caused by Entry's save rounding.
test('한 픽셀 어긋난 벡터는 같은 그림으로 보고 그대로 쓴다', () => {
  const project = svgPictureProject();
  project.objects[0].sprite.pictures[0].dimension = { width: 960, height: 540 };
  const near = [
    { name: 'temp/aa/aa/image/aaaa.svg', data: Buffer.from('<svg viewBox="0 0 960 539"></svg>') },
    { name: 'temp/aa/aa/image/aaaa.png', data: Buffer.from('png') },
  ] as never;
  const result = decompileProject(project, near);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.match(fragment, /default costume 배경 "assets\/image\/주인공_배경\.svg"/);

  const reframed = [
    { name: 'temp/aa/aa/image/aaaa.svg', data: Buffer.from('<svg viewBox="0 0 1100 670"></svg>') },
    { name: 'temp/aa/aa/image/aaaa.png', data: Buffer.from('png') },
  ] as never;
  const far = decompileProject(svgPictureProject(), reframed);
  const other = utf8(far.files.find((a) => a.path === 'objects/주인공.etp')!.data);
  assert.match(other, /default costume 배경 "assets\/image\/주인공_배경\.png"/);
});

function tableProject(rows: number): RawEntity {
  const project = minimalProject(1);
  project.tables = [{
    id: 't1',
    name: '가중치',
    fields: ['값'],
    data: Array.from({ length: rows }, (_, index) => ({ key: `r${index}`, value: [String(index)] })),
    chart: [],
  }];
  return project;
}

test('행이 아주 많은 테이블도 스택을 넘치지 않고 되돌린다', () => {
  const result = decompileProject(tableProject(200_000), [], { inline: true });
  assert.equal(result.source.split('\n').filter((line) => line.startsWith('  row ')).length, 200_000);
});

test('tableRows: false 면 행을 소스 밖에 두고 restoreTableRows 가 컴파일 결과에 되돌린다', () => {
  const result = decompileProject(tableProject(3), [], { inline: true, tableRows: false });
  assert.doesNotMatch(result.source, /^\s*row /m);
  const compiled = compileProject(result.source, { path: 'main.etp' });
  assert.ok(compiled.project, compiled.errors.map((error) => error.message).join('\n'));
  restoreTableRows(compiled.project as never, result.tableRows);
  assert.deepEqual((compiled.project as unknown as { tables: Array<{ data: string[][] }> }).tables[0]!.data, [['0'], ['1'], ['2']]);
});

test('그림 오브젝트의 글상자 블록은 주석으로 남겨 컴파일을 막지 않는다', () => {
  const project = minimalProject(1);
  project.objects[0].script = JSON.stringify([[
    { type: 'when_run_button_click', params: [null], statements: [] },
    { type: 'text_write', params: [{ type: 'text', params: ['안녕'] }, null], statements: [] },
  ]]);
  const result = decompileProject(project, [], { inline: true });
  assert.doesNotMatch(result.source, /^\s*write /m);
  const compiled = compileProject(result.source, { path: 'main.etp' });
  assert.deepEqual(compiled.errors.map((error) => error.message), []);
});

test('a costume whose file measures differently from its saved size keeps the saved size', () => {
  const png = new Uint8Array(fs.readFileSync(new URL('../examples/cat_idle.png', import.meta.url)));
  const project = builtinObjectProject();
  const picture = (id: string, file: string, width: number, height: number) => ({
    id, name: id, imageType: 'png', fileurl: file, dimension: { width, height },
  });
  project.objects[0]!.sprite.pictures = [
    picture('shrunk', 'temp/aa/bb/image/shrunk.png', 100, 100),
    picture('same', 'temp/aa/bb/image/same.png', 220, 350),
  ] as never;
  project.objects[0]!.selectedPictureId = 'shrunk';
  const entries = [{ name: 'temp/aa/bb/image/shrunk.png', data: png }, { name: 'temp/aa/bb/image/same.png', data: png.slice() }];
  const result = decompileProject(project as never, entries);
  const fragment = utf8(result.files.find((a) => a.path === 'objects/엔트리봇.etp')!.data);
  assert.match(fragment, /^default costume shrunk "[^"]+" size 100 100$/m);
  assert.match(fragment, /^costume same "[^"]+"$/m);
});
