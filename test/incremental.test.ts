import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileProject, createCompileCache } from '@entropy/compiler';

const MAIN = `scene "s":
  useobject "objects/가.etp"
  useobject "objects/나.etp"
end`;

const FRAGMENT = (message: string) => `default costume 기본 "a.png" size 10 10
when start do
  say "${message}"
end`;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-incremental-'));
  fs.mkdirSync(path.join(dir, 'objects'));
  fs.writeFileSync(path.join(dir, 'main.etp'), MAIN);
  fs.writeFileSync(path.join(dir, 'objects/가.etp'), FRAGMENT('가'));
  fs.writeFileSync(path.join(dir, 'objects/나.etp'), FRAGMENT('나'));
  return dir;
}

function build(dir: any, cache: any) {
  const mainFile = path.join(dir, 'main.etp');
  return compileProject(fs.readFileSync(mainFile, 'utf-8'), {
    path: mainFile, assetDirs: [dir], cache,
  });
}

test('캐시를 쓴 결과는 캐시 없이 컴파일한 것과 완전히 같다', () => {
  const dir = makeProject();
  const cache = createCompileCache();

  const cold = build(dir, cache);
  const warm = build(dir, cache);
  const plain = build(dir, undefined);

  assert.deepEqual(cold.errors, []);
  assert.deepEqual(JSON.stringify(warm.project), JSON.stringify(plain.project));
  assert.deepEqual(JSON.stringify(cold.project), JSON.stringify(warm.project));
});

test('바뀐 게 없으면 한 파일도 다시 파싱하지 않는다', () => {
  const dir = makeProject();
  const cache = createCompileCache();

  build(dir, cache);
  assert.equal(cache.parsed, 3);
  assert.equal(cache.reused, 0);

  build(dir, cache);
  assert.equal(cache.parsed, 3);
  assert.equal(cache.reused, 3);
});

test('한 파일만 고치면 그 파일만 다시 파싱한다', () => {
  const dir = makeProject();
  const cache = createCompileCache();

  build(dir, cache);
  fs.writeFileSync(path.join(dir, 'objects/가.etp'), FRAGMENT('바뀐 인사'));

  const before = cache.parsed;
  const result = build(dir, cache);
  assert.equal(cache.parsed - before, 1);

  const object = result.project!.objects.find((o) => o.name === '가');
  assert.match(object!.script, /바뀐 인사/);
});

test('main.etp 를 고치면 조각 파일은 그대로 다시 쓴다', () => {
  const dir = makeProject();
  const cache = createCompileCache();

  build(dir, cache);
  fs.writeFileSync(path.join(dir, 'main.etp'), `${MAIN}\n`);

  const before = { parsed: cache.parsed, reused: cache.reused };
  build(dir, cache);
  assert.equal(cache.parsed - before.parsed, 1);
  assert.equal(cache.reused - before.reused, 2);
});

test('문법 에러가 난 파일은 캐시에 남지 않고 매번 다시 알려준다', () => {
  const dir = makeProject();
  const cache = createCompileCache();
  const broken = path.join(dir, 'objects/가.etp');

  build(dir, cache);
  fs.writeFileSync(broken, 'when start do\n  say (\nend');

  const first = build(dir, cache);
  assert.ok(first.errors.length > 0);
  // Report cached-file errors again on subsequent builds.
  const second = build(dir, cache);
  assert.deepEqual(second.errors, first.errors);

  fs.writeFileSync(broken, FRAGMENT('고침'));
  const fixed = build(dir, cache);
  assert.deepEqual(fixed.errors, []);
  assert.match(fixed.project!.objects.find((o) => o.name === '가')!.script, /고침/);
});

test('두 오브젝트가 같은 조각을 use 하면 한 번만 파싱한다', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'objects/공통.etp'), 'when start do\n  say "공통"\nend');
  for (const name of ['가', '나']) {
    fs.writeFileSync(
      path.join(dir, `objects/${name}.etp`),
      `default costume 기본 "a.png" size 10 10\nuse "공통.etp"`,
    );
  }

  const cache = createCompileCache();
  const result = build(dir, cache);

  assert.deepEqual(result.errors, []);
  assert.equal(cache.parsed, 4);
  assert.equal(cache.reused, 1);
});

// Missing includes must report errors instead of silently removing an object.
test('불러올 파일이 없으면 에러로 알려준다', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'main.etp'), 'scene "s":\n  useobject "objects/없는파일.etp"\nend');

  const result = build(dir, createCompileCache());
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /불러올 파일이 없습니다/);
});
