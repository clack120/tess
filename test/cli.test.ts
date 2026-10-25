import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileProject, makeTar } from '@entropy/compiler';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function cli(...args: string[]) {
  try {
    const stdout = execFileSync('node', [path.join(root, 'packages/cli/index.ts'), ...args], { encoding: 'utf-8' });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { status: number; stdout?: string; stderr?: string };
    return { code: failure.status, output: (failure.stdout ?? '') + (failure.stderr ?? '') };
  }
}

function project(t: any, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

test('check 는 문법만 맞으면 통과하는 코드도 컴파일 단계까지 검사한다', (t) => {
  const dir = project(t, {
    'main.etp': `scene "s":
  object "주인공":
    default costume 기본 "a.png" size 10 10
    when start do
      jump "없는장면"
    end
  end
end`,
  });

  const result = cli('check', path.join(dir, 'main.etp'));
  assert.equal(result.code, 1);
  assert.match(result.output, /없는장면/);
  assert.doesNotMatch(result.output, /OK/);
});

test('check 는 useobject 로 불러오는 조각 파일 안까지 검사한다', (t) => {
  // Includes must be expanded before their statements can be checked.
  const dir = project(t, {
    'main.etp': 'scene "s":\n  useobject "objects/주인공.etp"\nend',
    'objects/주인공.etp': `default costume 기본 "a.png" size 10 10

when start do
  jump "없는장면"
end`,
  });

  const result = cli('check', path.join(dir, 'main.etp'));
  assert.equal(result.code, 1);
  // Report positions in the included file rather than the main file.
  assert.match(result.output, /주인공\.etp:\d+:\d+/);
  assert.match(result.output, /없는장면/);
});

test('멀쩡한 작품은 check 가 OK 로 통과시킨다', () => {
  const result = cli('check', path.join(root, 'examples/all_blocks.etp'));
  assert.equal(result.code, 0);
  assert.match(result.output, /OK/);
});

test('check 는 .ent 를 세 번 왕복해 누적 변형과 Entry 스키마를 검사한다', (t) => {
  const dir = project(t, { 'main.etp': `function twice(n) do
  var result = n * 2
  return result
end
scene "s":
  object "o":
    when start do
      say twice(3)
    end
  end
end` });
  const bundle = path.join(dir, 'work.ent');
  assert.equal(cli('build', path.join(dir, 'main.etp'), '-o', bundle).code, 0);

  const result = cli('check', bundle);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /왕복 검사\s+3회/);
  assert.match(result.output, /Entry 스키마\s+문제 없음/);
  assert.match(result.output, /OK/);
});

test('.ent check 는 손상된 묶음과 잘못된 왕복 횟수를 친절하게 거절한다', (t) => {
  const dir = project(t, { 'broken.ent': 'not an entry archive' });
  const broken = cli('check', path.join(dir, 'broken.ent'));
  assert.equal(broken.code, 1);
  assert.match(broken.output, /\.ent 압축을 읽지 못했습니다|project\.json 이 없는/);
  assert.match(broken.output, /올바른 Entry 작품|project\.json/);

  const misleading = path.join(dir, 'misleading.ent');
  fs.writeFileSync(misleading, makeTar([{ name: 'not-project.json', data: Buffer.from('{}') }]));
  const unrelated = cli('check', misleading);
  assert.equal(unrelated.code, 1);
  assert.match(unrelated.output, /project\.json 이 없는/);

  const rounds = cli('check', path.join(dir, 'broken.ent'), '--rounds', '0');
  assert.equal(rounds.code, 2);
  assert.match(rounds.output, /1부터 10 사이의 정수/);
});

test('.ent check 는 지원하지 못한 블록을 버린 왕복을 OK로 보고하지 않는다', (t) => {
  const dir = project(t, {});
  const compiled = compileProject('object "o":\n  when start do\n    say 1\n  end\nend');
  const work = structuredClone(compiled.project!);
  const script = JSON.parse(work.objects[0]!.script);
  script[0].push({ id: 'future-block', type: 'entry_future_block', x: 0, y: 0, params: [], statements: [] });
  work.objects[0]!.script = JSON.stringify(script);
  const bundle = makeTar([{ name: 'temp/project.json', data: Buffer.from(JSON.stringify(work)) }]);
  const file = path.join(dir, 'future.ent');
  fs.writeFileSync(file, bundle);

  const result = cli('check', file, '--rounds', '1');
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /되돌리기 경고\s+1개/);
  assert.match(result.output, /되돌리기 경고.*왕복 호환성을 보장할 수 없음/);
  assert.doesNotMatch(result.output, /\bOK\b/);
});

test('문법 에러는 그대로 위치와 함께 알려 준다', (t) => {
  const dir = project(t, { 'main.etp': 'object "o":\n  when start do\n    x +=\n' });
  const result = cli('check', path.join(dir, 'main.etp'));
  assert.equal(result.code, 1);
  assert.match(result.output, /main\.etp:\d+:\d+/);
});

test('진단은 오류 번호와 도움말, 처음 선언한 파일을 함께 보여준다', (t) => {
  const dir = project(t, {
    'main.etp': 'var score = 0\nuse "nested/shared.etp"',
    'nested/shared.etp': 'var score = 1',
  });
  const result = cli('check', path.join(dir, 'main.etp'));
  assert.equal(result.code, 1);
  assert.match(result.output, /\[E0001\]/);
  assert.match(result.output, /nested\/shared\.etp:1:1/);
  assert.match(result.output, /main\.etp:1:1/);
  assert.match(result.output, /var score = 0/);
  assert.match(result.output, /var score = 1/);
  assert.match(result.output, /도움말:.*대입/);
});

test('여덟 개를 넘는 오류도 위치와 코드를 모두 보여준다', (t) => {
  const names = Array.from({ length: 10 }, (_, at) => `missing_${at}`);
  const dir = project(t, { 'main.etp': `object "o":\n  when start do\n${names.map(name => `    say ${name}`).join('\n')}\n  end\nend` });
  const result = cli('check', path.join(dir, 'main.etp'));
  assert.equal(result.code, 1);
  assert.match(result.output, /에러 10개/);
  for (const name of names) assert.ok(result.output.includes(`'${name}'`));
  assert.doesNotMatch(result.output, /… 외/);
});

const LOOSE_PROJECT = `scene "s":
  object "주인공":
    default costume 기본 "a.png" size 10 10
    when start do
      jump "없는장면"
      x += 1
    end
  end
end`;

test('--no-strict build 는 에러가 있어도 그 문장만 빼고 내보낸다', (t) => {
  const dir = project(t, { 'main.etp': LOOSE_PROJECT });
  const outPath = path.join(dir, 'out.json');

  const result = cli('build', path.join(dir, 'main.etp'), '-o', outPath, '--no-strict');
  assert.equal(result.code, 0);
  assert.match(result.output, /--no-strict 를 썼기 때문에 계속 진행합니다/);

  // Loose mode drops only the failed jump and keeps the later movement.
  const built = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  const types = JSON.parse(built.objects[0].script)[0].map((block: any) => block.type);
  assert.deepEqual(types, ['when_run_button_click', 'move_x']);
});

test('기본 strict 는 에러가 있으면 아무것도 내보내지 않는다', (t) => {
  const dir = project(t, { 'main.etp': LOOSE_PROJECT });
  const outPath = path.join(dir, 'out.json');

  const result = cli('build', path.join(dir, 'main.etp'), '-o', outPath);
  assert.equal(result.code, 1);
  assert.match(result.output, /내보낼 수 없습니다/);
  assert.equal(fs.existsSync(outPath), false);
});

const MISSING_COSTUME = `scene "s":
  object "주인공":
    default costume 기본 "a.png" size 10 10
    when start do
      costume = "없는모양"
    end
  end
end`;

test('기본 strict 는 주의를 경고로 올리고 --no-strict 는 주의로 남긴다', (t) => {
  const dir = project(t, { 'main.etp': MISSING_COSTUME });

  const loose = cli('check', path.join(dir, 'main.etp'), '--no-strict');
  assert.equal(loose.code, 0);
  assert.match(loose.output, /주의 1개/);
  assert.doesNotMatch(loose.output, /경고 1개/);

  // Strict mode promotes notices to warnings without turning them into errors.
  const strict = cli('check', path.join(dir, 'main.etp'));
  assert.equal(strict.code, 0);
  assert.match(strict.output, /경고 1개/);
  assert.doesNotMatch(strict.output, /주의 1개/);
});
