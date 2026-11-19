import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypes } from '@entropy/core/strip-types';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readerFor(payload: string | null, live?: { getState(): unknown; legacy?: boolean }) {
  const dom = new JSDOM(
    payload === null
      ? '<!doctype html><body></body>'
      : `<!doctype html><body><script id="__NEXT_DATA__" type="application/json">${payload}</script></body>`,
  );
  if (live) {
    const root = dom.window.document.createElement('div'); root.id = '__next'; dom.window.document.body.append(root);
    const current = { child: { memoizedProps: { store: live } } };
    Object.assign(root, live.legacy ? { _reactRootContainer: { _internalRoot: { current } } }
      : { '__reactContainer$entry': { stateNode: { current } } });
  }
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
  const read = readerFor(wrap({ username: 'sample_user', nickname: '별이', role: 'member' }));
  assert.deepEqual(read(), { id: 'sample_user', nickname: '별이' });
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
  assert.deepEqual(readerFor(wrap({ username: 'sample_user' }))(), { id: 'sample_user', nickname: '' });
  assert.deepEqual(readerFor(wrap({ nickname: '별이' }))(), { id: '', nickname: '별이' });
  assert.equal(readerFor(wrap({ username: 7, nickname: null }))(), null);
});

test('현재 계정 정보를 우선하고 로그인, 이름 변경, 로그아웃을 반영한다', () => {
  for (const legacy of [false, true]) {
    let user: unknown = null;
    const read = readerFor(wrap({ username: 'old', nickname: 'old' }), { legacy, getState: () => ({ common: { user } }) });
    assert.equal(read(), null);
    user = { username: 'first', nickname: 'one' };
    assert.deepEqual(read(), { id: 'first', nickname: 'one' });
    user = { username: 'first', nickname: 'two' };
    assert.deepEqual(read(), { id: 'first', nickname: 'two' });
    user = null; assert.equal(read(), null);
  }
  const fallback = readerFor(wrap({ username: 'first' }), { getState: () => { throw new Error('unavailable'); } });
  assert.deepEqual(fallback(), { id: 'first', nickname: '' });
});
