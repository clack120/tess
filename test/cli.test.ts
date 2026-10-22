import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-cli-'));
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
    'main.tess': `scene "s":
  object "주인공":
    default costume 기본 "a.png" size 10 10
    when start do
      jump "없는장면"
    end
  end
end`,
  });

  const result = cli('check', path.join(dir, 'main.tess'));
  assert.equal(result.code, 1);
  assert.match(result.output, /없는장면/);
  assert.doesNotMatch(result.output, /OK/);
});

test('check 는 useobject 로 불러오는 조각 파일 안까지 검사한다', (t) => {
  // Includes must be expanded before their statements can be checked.
  const dir = project(t, {
    'main.tess': 'scene "s":\n  useobject "objects/주인공.tess"\nend',
    'objects/주인공.tess': `default costume 기본 "a.png" size 10 10

when start do
  jump "없는장면"
end`,
  });

  const result = cli('check', path.join(dir, 'main.tess'));
  assert.equal(result.code, 1);
  // Report positions in the included file rather than the main file.
  assert.match(result.output, /주인공\.tess:\d+:\d+/);
  assert.match(result.output, /없는장면/);
});

test('멀쩡한 작품은 check 가 OK 로 통과시킨다', () => {
  const result = cli('check', path.join(root, 'examples/all_blocks.tess'));
  assert.equal(result.code, 0);
  assert.match(result.output, /OK/);
});

test('문법 에러는 그대로 위치와 함께 알려 준다', (t) => {
  const dir = project(t, { 'main.tess': 'object "o":\n  when start do\n    x +=\n' });
  const result = cli('check', path.join(dir, 'main.tess'));
  assert.equal(result.code, 1);
  assert.match(result.output, /main\.tess:\d+:\d+/);
});

test('진단은 오류 번호와 도움말, 처음 선언한 파일을 함께 보여준다', (t) => {
  const dir = project(t, {
    'main.tess': 'var score = 0\nuse "nested/shared.tess"',
    'nested/shared.tess': 'var score = 1',
  });
  const result = cli('check', path.join(dir, 'main.tess'));
  assert.equal(result.code, 1);
  assert.match(result.output, /\[E0001\]/);
  assert.match(result.output, /nested\/shared\.tess:1:1/);
  assert.match(result.output, /main\.tess:1:1/);
  assert.match(result.output, /var score = 0/);
  assert.match(result.output, /var score = 1/);
  assert.match(result.output, /도움말:.*대입/);
});

test('여덟 개를 넘는 오류도 위치와 코드를 모두 보여준다', (t) => {
  const names = Array.from({ length: 10 }, (_, at) => `missing_${at}`);
  const dir = project(t, { 'main.tess': `object "o":\n  when start do\n${names.map(name => `    say ${name}`).join('\n')}\n  end\nend` });
  const result = cli('check', path.join(dir, 'main.tess'));
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

test('build 는 에러가 있어도 그 문장만 빼고 내보낸다', (t) => {
  const dir = project(t, { 'main.tess': LOOSE_PROJECT });
  const outPath = path.join(dir, 'out.json');

  const result = cli('build', path.join(dir, 'main.tess'), '-o', outPath);
  assert.equal(result.code, 0);
  assert.match(result.output, /--strict 를 붙이면 여기서 멈춥니다/);

  // Loose mode drops only the failed jump and keeps the later movement.
  const built = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  const types = JSON.parse(built.objects[0].script)[0].map((block: any) => block.type);
  assert.deepEqual(types, ['when_run_button_click', 'move_x']);
});

test('--strict 는 에러가 있으면 아무것도 내보내지 않는다', (t) => {
  const dir = project(t, { 'main.tess': LOOSE_PROJECT });
  const outPath = path.join(dir, 'out.json');

  const result = cli('build', path.join(dir, 'main.tess'), '-o', outPath, '--strict');
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

test('없는 모양은 주의로 알리고 check 를 통과시킨다', (t) => {
  const dir = project(t, { 'main.tess': MISSING_COSTUME });

  const loose = cli('check', path.join(dir, 'main.tess'));
  assert.equal(loose.code, 0);
  assert.match(loose.output, /주의 1개/);
  assert.doesNotMatch(loose.output, /경고 1개/);

  // Strict mode promotes notices to warnings without turning them into errors.
  const strict = cli('check', path.join(dir, 'main.tess'), '--strict');
  assert.equal(strict.code, 0);
  assert.match(strict.output, /경고 1개/);
  assert.doesNotMatch(strict.output, /주의 1개/);
});
