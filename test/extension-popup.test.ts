import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypes } from '@tess/core/strip-types';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const POPUP = path.join(root, 'packages/extension/src/popup');

async function mountPopup(t: any, stored: Record<string, boolean>, saved: unknown[] = [], cacheSize: unknown = null) {
  const html = fs.readFileSync(path.join(POPUP, 'popup.html'), 'utf-8');
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());

  const written: Array<[string, boolean]> = [];
  const dropped: string[] = [];
  let rows: any[] = saved.slice();
  const source = stripTypes(fs.readFileSync(path.join(POPUP, 'popup.ts'), 'utf-8'));
  const settings = { enabled: true, svg: true, cache: false, ...stored };
  const sizeListeners: Array<(changes: any, area: string) => void> = [];
  const sandbox: Record<string, unknown> = {
    document: dom.window.document,
    readSettings: () => Promise.resolve(settings),
    write: (key: string, value: boolean) => {
      written.push([key, value]);
      return Promise.resolve();
    },
    ENABLED_KEY: 'enabled',
    SVG_KEY: 'svg',
    CACHE_KEY: 'assetCache',
    CACHE_SIZE_KEY: 'assetCacheSize',
    api: { storage: {
      local: { get: () => Promise.resolve({ assetCacheSize: cacheSize }) },
      onChanged: { addListener: (listener: (changes: any, area: string) => void) => sizeListeners.push(listener) },
    } },
    Intl: globalThis.Intl,
    listWorks: () => Promise.resolve(rows.slice()),
    exportName: () => 'tessvm-save-2026-09-14.json',
    exportAll: () => Promise.resolve({ size: 884 }),
    importAll: (picked: { name?: string }) =>
      picked?.name === '남의것.json'
        ? Promise.reject(new Error('tessvm 이 내보낸 파일이 아닙니다.'))
        : Promise.resolve(2),
    removeWork: (work: string) => {
      dropped.push(work);
      rows = rows.filter((row: any) => row.work !== work);
      return Promise.resolve();
    },
    clearWorks: () => {
      dropped.push('*');
      rows = [];
      return Promise.resolve();
    },
  };
  // Capture blob downloads because jsdom has no object-URL implementation.
  const downloads: string[] = [];
  sandbox.URL = { createObjectURL: () => 'blob:tessvm', revokeObjectURL: () => undefined };
  sandbox.setTimeout = (run: () => void, delay: number) =>
    dom.window.setTimeout(run, delay);
  dom.window.HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    downloads.push(this.download);
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Require whitespace after import so identifiers such as importButton are not stripped.
  vm.runInContext(source.replace(/^import\s[\s\S]*?;$/gm, ''), sandbox);
  await new Promise((done) => setTimeout(done, 0));

  const find = (id: string) => dom.window.document.getElementById(id)!;
  return {
    written,
    dropped,
    reportSize: (value: unknown) => sizeListeners.forEach(listener => listener({ assetCacheSize: { newValue: value } }, 'local')),
    downloads,
    find,
    pick(name: string) {
      const input = find('file') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [{ name }], configurable: true });
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    note: () => {
      const line = find('saves-note');
      return { text: line.textContent ?? '', hidden: line.hidden, bad: line.classList.contains('is-bad') };
    },
    saves: () =>
      [...dom.window.document.querySelectorAll('.save')].map((row) => ({
        title: row.querySelector('.save-title')?.textContent ?? '',
        meta: row.querySelector('.save-meta')?.textContent ?? '',
        drop: row.querySelector('.save-drop') as HTMLButtonElement,
      })),
    press(button: HTMLElement) {
      button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    },
    settle: () => new Promise((done) => setTimeout(done, 0)),
    power: find('enabled'),
    on: () => find('enabled').getAttribute('aria-checked') === 'true',
    click(id: string) {
      find(id).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    },
    toggle(id: string) {
      const box = find(id) as HTMLInputElement;
      box.checked = !box.checked;
      box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
  };
}

test('실행기 단추는 한 번 누르면 켜지고 다시 누르면 꺼진다', async (t) => {
  const popup = await mountPopup(t, { enabled: true });
  assert.equal(popup.on(), true, '저장된 값을 그대로 보여 줍니다');

  popup.click('enabled');
  assert.equal(popup.on(), false);
  assert.equal(popup.find('chip').textContent, '꺼짐');
  assert.match(popup.find('note').textContent ?? '', /켭니다/);
  assert.equal(popup.find('note').querySelectorAll('br').length, 1);

  popup.click('enabled');
  assert.equal(popup.on(), true);
  assert.equal(popup.find('chip').textContent, '켜짐');
  assert.deepEqual(popup.written, [
    ['enabled', false],
    ['enabled', true],
  ]);
});

test('꺼진 채로 열면 꺼진 모습으로 시작한다', async (t) => {
  const popup = await mountPopup(t, { enabled: false });
  assert.equal(popup.on(), false);
  assert.equal(popup.find('chip').textContent, '꺼짐');
  assert.deepEqual(popup.written, [], '연 것만으로는 아무것도 쓰지 않습니다');
});

test('벡터 스위치는 저장된 값을 보여 주고, 바꾸면 그대로 쓴다', async (t) => {
  const popup = await mountPopup(t, { svg: true });
  assert.equal((popup.find('svg') as HTMLInputElement).checked, true);
  assert.equal(popup.find('mask'), null);
  assert.equal(popup.find('notice'), null);

  popup.toggle('svg');
  assert.deepEqual(popup.written, [['svg', false]]);
});

test('에셋 저장 스위치는 기본으로 꺼져 있고, 마지막으로 알린 용량을 보여 준다', async (t) => {
  const popup = await mountPopup(t, {});
  assert.equal((popup.find('cache') as HTMLInputElement).checked, false);
  assert.equal(popup.find('cache-size').hidden, true);
  popup.toggle('cache');
  assert.deepEqual(popup.written, [['assetCache', true]]);
  popup.reportSize({ count: 1234, bytes: 5 * 1024 * 1024 });
  assert.equal(popup.find('cache-size').hidden, false);
  assert.equal(popup.find('cache-size').textContent, '저장한 파일 1,234개 · 5.0 MB');
  popup.reportSize({ count: 0, bytes: 0 });
  assert.equal(popup.find('cache-size').hidden, true);
});

test('열 때 이미 알려진 용량이 있으면 바로 보여 준다', async (t) => {
  const popup = await mountPopup(t, { cache: true }, [], { count: 3, bytes: 2048 });
  assert.equal((popup.find('cache') as HTMLInputElement).checked, true);
  assert.equal(popup.find('cache-size').textContent, '저장한 파일 3개 · 2.0 KB');
});

const WORKS = [
  { work: '60a1', title: '마법사 키우기', names: 3, bytes: 2048, updated: Date.UTC(2026, 8, 1, 3) },
  { work: '77b2', title: '농장', names: 1, bytes: 120, updated: 0 },
];

test('저장한 작품이 있으면 목록으로 보여 준다', async (t) => {
  const popup = await mountPopup(t, {}, WORKS);
  const rows = popup.saves();
  assert.deepEqual(rows.map((row) => row.title), ['마법사 키우기', '농장']);
  assert.match(rows[0]!.meta, /3개 · 2\.0 KB/);
  assert.match(rows[1]!.meta, /1개 · 120 B/);
  assert.equal(popup.find('saves-empty').hidden, true);
  assert.equal(popup.find('clear').hidden, false);
});

test('저장한 것이 없으면 그렇다고 알리고 전체 삭제도 감춘다', async (t) => {
  const popup = await mountPopup(t, {}, []);
  assert.equal(popup.saves().length, 0);
  assert.equal(popup.find('saves-empty').hidden, false);
  assert.equal(popup.find('clear').hidden, true);
});

test('삭제는 한 번 더 눌러야 지워지고, 지우면 목록에서 사라진다', async (t) => {
  const popup = await mountPopup(t, {}, WORKS);
  const [first] = popup.saves();

  popup.press(first!.drop);
  assert.deepEqual(popup.dropped, [], '한 번 누른 것만으로는 지우지 않습니다');
  assert.match(first!.drop.textContent ?? '', /정말/);

  popup.press(first!.drop);
  await popup.settle();
  assert.deepEqual(popup.dropped, ['60a1']);
  assert.deepEqual(popup.saves().map((row) => row.title), ['농장']);
});

test('전체 삭제도 한 번 더 눌러야 지운다', async (t) => {
  const popup = await mountPopup(t, {}, WORKS);
  popup.press(popup.find('clear'));
  popup.press(popup.find('clear'));
  await popup.settle();
  assert.deepEqual(popup.dropped, ['*']);
  assert.equal(popup.saves().length, 0);
  assert.equal(popup.find('saves-empty').hidden, false);
});

test('내보내기는 파일 하나를 받아 내리고 그렇게 알린다', async (t) => {
  const popup = await mountPopup(t, {}, WORKS);
  popup.press(popup.find('export'));
  await popup.settle();
  assert.deepEqual(popup.downloads, ['tessvm-save-2026-09-14.json']);
  assert.match(popup.note().text, /내보냈습니다/);
  assert.equal(popup.note().bad, false);
});

test('가져오기는 파일 칸을 열고, 읽어 들이면 목록을 다시 그린다', async (t) => {
  const popup = await mountPopup(t, {}, []);
  assert.equal(popup.saves().length, 0);

  popup.press(popup.find('import'));
  popup.pick('tessvm-save-2026-09-14.json');
  await popup.settle();
  assert.match(popup.note().text, /작품 2개를 가져왔습니다/);
  assert.equal(popup.note().bad, false);
});

test('tessvm 이 내보낸 파일이 아니면 그렇다고 알린다', async (t) => {
  const popup = await mountPopup(t, {}, WORKS);
  popup.pick('남의것.json');
  await popup.settle();
  assert.match(popup.note().text, /tessvm 이 내보낸 파일이 아닙니다/);
  assert.equal(popup.note().bad, true, '빨간 줄로 알립니다');
  assert.equal(popup.saves().length, 2, '목록은 그대로입니다');
});
