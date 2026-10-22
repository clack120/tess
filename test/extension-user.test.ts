import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypes } from '@tess/core/strip-types';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readerFor(payload: string | null) {
  const dom = new JSDOM(
    payload === null
      ? '<!doctype html><body></body>'
      : `<!doctype html><body><script id="__NEXT_DATA__" type="application/json">${payload}</script></body>`,
  );
  const source = stripTypes(fs.readFileSync(path.join(root, 'packages/extension/src/page/signed-in.ts'), 'utf-8'));
  const sandbox: Record<string, unknown> = { document: dom.window.document };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${source.replace(/^import[^;]*;$/gm, '').replace(/^export /gm, '')}\nthis.read = signedInUser;`,
    sandbox,
  );
  const read = sandbox.read as () => { id: string; nickname: string } | null;
  // Copy cross-realm results before comparison because their prototypes differ.
  return () => {
    const user = read();
    return user && { id: user.id, nickname: user.nickname };
  };
}

const wrap = (user: unknown) =>
  JSON.stringify({ props: { pageProps: { initialState: { common: { user } } } } });

test('로그인한 사람의 아이디와 닉네임을 읽는다', () => {
  const read = readerFor(wrap({ username: 'ddtt786', nickname: '치로', role: 'member' }));
  assert.deepEqual(read(), { id: 'ddtt786', nickname: '치로' });
});

test('로그인하지 않았으면 아무도 아니다', () => {
  for (const payload of [wrap(null), wrap(undefined), wrap({})]) {
    assert.equal(readerFor(payload)(), null, payload);
  }
});

test('페이지가 넘겨준 것이 없거나 읽을 수 없으면 아무도 아니다', () => {
  assert.equal(readerFor(null)(), null, '스크립트 자체가 없는 페이지');
  assert.equal(readerFor('')(), null, '빈 내용');
  assert.equal(readerFor('{ 이건 JSON 이 아니다')(), null, '깨진 내용');
  assert.equal(readerFor('{"props":{}}')(), null, '자리는 있지만 사람이 없다');
});

test('아이디나 닉네임 한쪽만 있어도 로그인한 것으로 본다', () => {
  assert.deepEqual(readerFor(wrap({ username: 'ddtt786' }))(), { id: 'ddtt786', nickname: '' });
  assert.deepEqual(readerFor(wrap({ nickname: '치로' }))(), { id: '', nickname: '치로' });
  assert.equal(readerFor(wrap({ username: 7, nickname: null }))(), null);
});

test('엔트리 작품 -> Tess -> 다시 엔트리 작품에서 자산 주소가 남는다', async () => {
  const { decompileProject } = await import('../packages/decompiler/src/index.ts');
  const { compileProject } = await import('../packages/compiler/src/index.ts');
  const work = {
    name: '주소만 남기기',
    speed: 60,
    scenes: [{ id: 'sc1', name: '장면 1' }],
    variables: [],
    messages: [],
    functions: [],
    objects: [{
      id: 'obj1',
      name: '주인공',
      objectType: 'sprite',
      scene: 'sc1',
      rotateMethod: 'free',
      selectedPictureId: 'pic1',
      entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true },
      sprite: {
        pictures: [{
          id: 'pic1',
          name: '그림',
          imageType: 'svg',
          fileurl: '/uploads/ab/cd/image/abcd0001.svg',
          dimension: { width: 320, height: 180 },
        }],
        sounds: [{
          id: 'snd1',
          name: '소리',
          ext: '.mp3',
          duration: 2.5,
          fileurl: '/uploads/ab/cd/abcd0002.mp3',
        }],
      },
      script: JSON.stringify([[
        { type: 'when_run_button_click', params: [null], statements: [] },
        { type: 'move_x', params: [{ type: 'number', params: ['10'] }, null], statements: [] },
      ]]),
    }],
  };

  const decompiled = decompileProject(work as never, [], {
    inline: true, sizes: true, keepSvg: true,
  });
  assert.equal(decompiled.assets.length, 0);
  assert.doesNotMatch(decompiled.source, /useobject|usetext/);
  assert.match(decompiled.source, /object "주인공":/);
  assert.match(decompiled.source, /"\/uploads\/ab\/cd\/image\/abcd0001\.svg" size 320 180/);

  const compiled = compileProject(decompiled.source, {
    path: 'w.tess', name: work.name, assetUrls: true, comments: new Map(),
  });
  assert.deepEqual(compiled.errors, []);
  const picture = compiled.project!.objects[0]!.sprite.pictures[0]!;
  const sound = compiled.project!.objects[0]!.sprite.sounds[0]!;
  assert.equal(picture.fileurl, '/uploads/ab/cd/image/abcd0001.svg');
  assert.equal(picture.pngurl, '/uploads/ab/cd/image/abcd0001.png');
  assert.deepEqual(picture.dimension, { width: 320, height: 180 });
  assert.equal(sound.fileurl, '/uploads/ab/cd/abcd0002.mp3');
  assert.equal(sound.duration, 2.5);
  assert.match(JSON.stringify(compiled.project!.objects[0]!.script), /move_x/);
});
