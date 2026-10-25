import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProject } from '@entropy/compiler';
import { Vm } from '@entropy/vm';
import { EntryExpansionReader } from '../packages/vm/src/web/expansion.ts';
import { stub } from './stub.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('강원도 코드와 시간별 강수 필드는 Entry 4.0.23 형식을 따른다', async (t) => {
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
