import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileProject } from '@entropy/compiler';
import {
  ENTRY_BEHAVIOR_OPTIONS, ENTRY_GUIDELINE_OPTIONS, ENTRY_WEATHER_LOCATIONS,
  entryBehaviorCategoryValue, entryBehaviorSubcategoryValue,
  entryGuidelineCategoryValue, entryGuidelineSubcategoryValue,
  entryWeatherAreaCode, entryWeatherAreaValue, entryWeatherSubareaValue,
} from '@entropy/core';
import { Vm } from '@entropy/vm';
import { EntryExpansionReader } from '../packages/vm/src/web/expansion.ts';
import { stub } from './stub.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPackage = JSON.parse(fs.readFileSync(
  path.join(root, 'node_modules/@entrylabs/entry/package.json'), 'utf-8',
));
const refreshExpansionData = `설치된 @entrylabs/entry ${entryPackage.version} 정의가 바뀌었습니다. `
  + 'bun packages/core/tools/update-entry-expansion-data.ts 를 실행해 생성 데이터를 갱신하세요.';

test('생성된 확장 선택지 데이터는 현재 설치된 Entry와 같다', () => {
  const output = execFileSync('bun', [
    path.join(root, 'packages/core/tools/update-entry-expansion-data.ts'), '--check',
  ], { cwd: root, encoding: 'utf-8' });
  assert.match(output, /현재 설치된 @entrylabs\/entry와 일치/);
});

function blocks(project: NonNullable<ReturnType<typeof compileProject>['project']>): any[] {
  const found: any[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const block = value as Record<string, unknown>;
      if (typeof block.type === 'string') found.push(block);
      Object.values(block).forEach(visit);
    }
  };
  project.objects.forEach((object) => visit(JSON.parse(object.script)));
  return found;
}

test('확장 블록의 한글 선택지는 엔트리가 저장하는 값으로 바뀐다', () => {
  const file = path.join(root, 'examples/all_blocks.etp');
  const result = compileProject(fs.readFileSync(file, 'utf-8'), { path: file });
  assert.ok(result.project, result.errors.map((error) => error.message).join('\n'));
  const byType = new Map(blocks(result.project).map((block) => [block.type, block]));

  assert.deepEqual(byType.get('get_korea_area_code').params, ['Seoul', 'jung_gu']);
  assert.deepEqual(byType.get('get_weather_data').params, ['today', 'Seoul', 'the_lowest_temperature']);
  assert.deepEqual(byType.get('check_weather').params, ['today', 'Seoul', 'sunny']);
  assert.deepEqual(byType.get('count_festival').params, ['Seoul', 'May']);
  assert.equal(byType.get('get_festival_info').params[3], 'title');
  assert.deepEqual(byType.get('check_disaster_alert').params, ['all']);
  assert.equal(byType.get('get_disaster_alert').params[2], 'MSG_CN');
  assert.deepEqual(byType.get('count_disaster_guideline').params, ['01001', '01001001']);
});

test('all_blocks 예제의 모든 블록을 VM이 인식한다', () => {
  const file = path.join(root, 'examples/all_blocks.etp');
  const result = compileProject(fs.readFileSync(file, 'utf-8'), { path: file });
  assert.ok(result.project);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(result.project as never);
  assert.deepEqual([...vm.unknownBlocks], []);
});

test('확장 블록은 비동기 호스트의 값을 기다려 돌려준다', async () => {
  const result = compileProject('scene "s":\n  object "o":\n  end\nend', { path: 'main.etp' });
  assert.ok(result.project);
  const calls: Array<[string, unknown[]]> = [];
  const vm = new Vm({
    renderer: null,
    audio: null,
    expansion: { async read(type, params) {
      calls.push([type, params]);
      return type === 'get_korea_area_code' ? '1114000000' : '맑음';
    } },
  });
  vm.load(result.project as never);
  const value = await vm.evaluate({
    id: 'weather', type: 'get_cur_weather',
    params: [{ id: 'area', type: 'get_korea_area_code', params: ['Seoul', 'Jung-gu'] }],
  }, vm.targets[0]!.id);
  assert.equal(value, '맑음');
  assert.deepEqual(calls, [
    ['get_korea_area_code', ['Seoul', 'Jung-gu']],
    ['get_cur_weather', ['1114000000']],
  ]);
});

test('엔트리 날씨 응답을 현재 날씨와 미세먼지 값으로 읽는다', async (t) => {
  let requests = 0;
  stub(t, globalThis, 'fetch', async () => {
    requests += 1;
    return Response.json({
      '1114000000': {
        now: { sky: '맑음', sky_code: '1', winddir: 'W', pm10: '25', temp: 12 },
      },
    });
  });
  const reader = new EntryExpansionReader();
  assert.equal(await reader.read('get_cur_weather', ['1114000000']), '맑음');
  assert.equal(await reader.read('check_finedust', ['1114000000', 'good']), true);
  assert.equal(requests, 1, '같은 날씨 응답은 한 번만 받는다');
});

test('강원도 코드와 시간별 강수 필드는 현재 설치된 Entry 형식을 따른다', async (t) => {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  stub(t, globalThis, 'fetch', async () => Response.json({
    '5100000000': { [`${date}03`]: { rainAmt: 7, rain: 80 } },
  }));
  const reader = new EntryExpansionReader();
  assert.equal(await reader.read('get_korea_area_code', ['강원', '시/도 선택']), '5100000000');
  assert.equal(await reader.read('get_time_weather_data', ['5100000000', '3', 'precipitation']), 7);
  assert.equal(
    await reader.read('get_time_weather_data', ['5100000000', '3', 'precipitation_probability']),
    80,
  );
});

test('17개 시도와 228개 세부 지역을 Entry 저장값과 행정 코드로 바꾼다', () => {
  let subdivisions = 0;
  for (const [area, location] of Object.entries(ENTRY_WEATHER_LOCATIONS)) {
    assert.equal(entryWeatherAreaValue(location.label), area);
    assert.equal(entryWeatherAreaCode(location.label), location.code);
    for (const [slug, sub] of Object.entries(location.sub)) {
      subdivisions += 1;
      assert.equal(entryWeatherSubareaValue(area, sub.label), slug, `${area} ${sub.label}`);
      assert.equal(entryWeatherAreaCode(area, sub.label), sub.code, `${area} ${sub.label}`);
    }
  }
  assert.equal(Object.keys(ENTRY_WEATHER_LOCATIONS).length, 17);
  assert.equal(subdivisions, 228);

  const result = compileProject(`scene "s":
  object "o":
    when start do
      say get_korea_area_code("대전", "서구")
      say get_korea_area_code("부산", "서구")
      say get_korea_area_code("강원", "속초시")
    end
  end
end`);
  assert.ok(result.project);
  const calls = blocks(result.project!).filter((block) => block.type === 'get_korea_area_code');
  assert.deepEqual(calls.map((block) => block.params), [
    ['Daejeon', 'western'],
    ['Busan', 'seo_gu'],
    ['Gangwon', 'sokcho city'],
  ]);
});

test('내장 지역 코드 표는 현재 설치된 Entry 정의와 일치한다', () => {
  const file = path.join(root, 'node_modules/@entrylabs/entry/src/playground/blocks/block_expansion_weather.js');
  const source = fs.readFileSync(file, 'utf-8');
  const start = source.indexOf('    locationMap: {') + '    locationMap: '.length;
  const end = source.indexOf('\n    propertyMap:', start);
  assert.ok(start > 0 && end > start, 'Entry weather locationMap source');
  const entry = Function(`return (${source.slice(start, end).trim().replace(/,$/, '')})`)();

  const local = Object.fromEntries(Object.entries(ENTRY_WEATHER_LOCATIONS).map(([area, item]) => [
    area,
    { code: item.code, sub: Object.fromEntries(
      Object.entries(item.sub).map(([slug, sub]) => [slug, sub.code]),
    ) },
  ]));
  assert.deepEqual(local, entry, refreshExpansionData);
});

test('Entry의 국민행동요령·행동수칙 선택지 전체를 코드로 바꾼다', () => {
  let guidelineCategories = 0;
  let guidelineSubcategories = 0;
  for (const [family, categories] of Object.entries(ENTRY_GUIDELINE_OPTIONS)) {
    for (const [category, item] of Object.entries(categories)) {
      guidelineCategories += 1;
      assert.equal(entryGuidelineCategoryValue(family, item.label), category);
      for (const [sub, label] of Object.entries(item.sub)) {
        guidelineSubcategories += 1;
        assert.equal(entryGuidelineSubcategoryValue(family, item.label, String(label)), sub);
      }
    }
  }
  assert.equal(guidelineCategories, 53);
  assert.equal(guidelineSubcategories, 212);

  let behaviorCategories = 0;
  let behaviorSubcategories = 0;
  for (const [family, categories] of Object.entries(ENTRY_BEHAVIOR_OPTIONS)) {
    for (const [category, item] of Object.entries(categories)) {
      behaviorCategories += 1;
      assert.equal(entryBehaviorCategoryValue(family, item.label), category);
      for (const [sub, label] of Object.entries(item.sub)) {
        behaviorSubcategories += 1;
        assert.equal(entryBehaviorSubcategoryValue(family, item.label, String(label)), sub);
      }
    }
  }
  assert.equal(behaviorCategories, 27);
  assert.equal(behaviorSubcategories, 56);
});

test('재난 선택지는 블록 계열별 문맥을 구분해 Entry 코드로 컴파일한다', () => {
  const result = compileProject(`scene "s":
  object "o":
    when start do
      say count_disaster_guideline("지진", "지진 대비")
      say count_social_disaster_guideline("화재", "아파트 화재 시")
      say count_safety_accident_guideline("소화기", "소화기의 종류")
      say count_disaster_behavior("지진", "지진이 오기 전")
      say count_lifeSafety_behavior("소화기사용법", "분말소화기 사용")
    end
  end
end`);
  assert.deepEqual(result.errors, []);
  assert.ok(result.project);
  const wanted = blocks(result.project!).filter((block) => /(?:guideline|behavior)$/.test(block.type));
  assert.deepEqual(wanted.map((block) => [block.type, block.params]), [
    ['count_disaster_guideline', ['01011', '01011009']],
    ['count_social_disaster_guideline', ['02011', '02011009']],
    ['count_safety_accident_guideline', ['03004', '03004004']],
    ['count_disaster_behavior', ['01011', '01011009']],
    ['count_lifeSafety_behavior', ['03004', '03004001']],
  ]);
});

test('재난 코드 표는 현재 설치된 Entry 정의와 일치한다', () => {
  const readMap = (name: string): any => {
    const source = fs.readFileSync(path.join(
      root, 'node_modules/@entrylabs/entry/src/playground/blocks', name,
    ), 'utf-8');
    const fn = source.indexOf('function getInitialCategoryMap()');
    const returned = source.indexOf('return', fn);
    const start = source.indexOf('{', returned);
    let depth = 0;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}' && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    assert.ok(start > 0 && end > start, `${name} category map`);
    const object = source.slice(start, end).replace(
      /Lang\.Blocks\.([A-Za-z0-9_]+)/g, (_, key: string) => JSON.stringify(key),
    );
    return Function(`return (${object})`)();
  };
  const codesOnly = (families: Record<string, any>) => Object.fromEntries(
    Object.entries(families).map(([family, categories]) => [family, Object.fromEntries(
      Object.entries(categories as Record<string, any>).map(([code, item]) => [
        code, { sub: Array.isArray(item.sub) ? item.sub : Object.keys(item.sub) },
      ]),
    )]),
  );

  const guidelineEntry = readMap('block_expansion_emergencyActionGuidelines.js');
  assert.deepEqual(
    codesOnly(ENTRY_GUIDELINE_OPTIONS), codesOnly(guidelineEntry), refreshExpansionData,
  );
  const behaviorEntry = {
    '01': readMap('block_expansion_behaviorconduct_disaster.js'),
    '03': readMap('block_expansion_behaviorconduct_lifesafety.js'),
  };
  assert.deepEqual(
    codesOnly(ENTRY_BEHAVIOR_OPTIONS), codesOnly(behaviorEntry), refreshExpansionData,
  );
});

test('확장 API 실패는 기본값을 주되 다음 호출에서 다시 시도한다', async (t) => {
  let requests = 0;
  let warnings = 0;
  stub(t, console, 'warn', () => { warnings += 1; });
  stub(t, globalThis, 'fetch', async () => {
    requests += 1;
    if (requests === 1) throw new Error('offline');
    return Response.json({
      '1100000000': { now: { sky: '맑음' } },
    });
  });
  const reader = new EntryExpansionReader();
  assert.equal(await reader.read('get_cur_weather', ['1100000000']), '데이터 없음');
  assert.equal(await reader.read('get_cur_weather', ['1100000000']), '맑음');
  assert.equal(requests, 2);
  assert.equal(warnings, 1);
});

test('국민행동요령과 행동수칙은 Entry와 같은 경로·세부분류를 쓴다', async (t) => {
  const paths: string[] = [];
  stub(t, globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    paths.push(url);
    if (url.includes('emergencyActionGuidelines')) {
      return Response.json({ body: [
        { safety_cate3: '01011009', actRmks: '지진 대비 A' },
        { safety_cate3: '01011010', actRmks: '다른 항목' },
      ] });
    }
    return Response.json({ response: { body: { items: { item: [
      { safetyCate3: '03004001', actRmks: '분말소화기 A' },
      { safetyCate3: '03016001', actRmks: '다른 항목' },
    ] } } } });
  });
  const reader = new EntryExpansionReader();
  assert.equal(await reader.read('count_disaster_guideline', ['01011', '01011009']), 1);
  assert.equal(await reader.read('get_disaster_guideline', ['01011', '01011009', 1]), '지진 대비 A');
  assert.equal(await reader.read('count_lifeSafety_behavior', ['03004', '03004001']), 1);
  assert.equal(await reader.read('get_lifeSafety_behavior', ['03004', '03004001', 1]), '분말소화기 A');
  assert.deepEqual(paths, [
    '/api/expansionBlock/emergencyActionGuidelines/01/01011',
    '/api/expansionBlock/behaviorConduct/03/03004',
  ]);
});
