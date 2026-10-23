import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { playerPage, findPreactDir } from '@entropy/player';
import { compileProject } from '@entropy/compiler';
import { stripTypes } from '@entropy/core/strip-types';

// bun's vm gives jsdom a window that is not its own global, so window.addEventListener throws there.
const test = 'Bun' in globalThis ? nodeTest.skip : nodeTest;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const preactDist = () => findPreactDir();

async function mountDebugPanel(t: any) {
  const html = playerPage({
    name: '치로', base: '/lib', summary: { scenes: 1, objects: 1, blocks: 1 }, entName: 'a.ent', reload: false,
  });
  const shell = html.slice(0, html.indexOf('<script')) + '</body></html>';
  const dom = new JSDOM(shell, { runScripts: 'outside-only', pretendToBeVisual: true });
  const window: any = dom.window;
  t.after(() => window.close()); // Close the window to clear polling intervals.

  const engine = {
    state: 'stop',
    fired: [] as Array<[string, string]>,
    isState(state: any) { return state === this.state; },
    toggleRun() { this.state = 'run'; },
    togglePause() { this.state = this.state === 'pause' ? 'run' : 'pause'; },
    toggleStop() { this.state = 'stop'; },
    fireEvent(type: string, id: string) { this.fired.push([type, id]); },
  };
  const blocks = {
    is_boost_mode: { func: () => '실제부스트' },
    is_touch_supported: { func: () => '실제터치' },
    is_current_device_type: { func: (sprite: any, script: any) => '실제' + script.getField('DEVICE', script) },
  };
  const live: {
    variables: Record<string, number>;
    lists: Record<string, Array<{ data: unknown }>>;
    visible: Record<string, boolean>;
  } = {
    variables: { v1: 42 },
    lists: { l1: [{ data: 'ㄱ' }, { data: 'ㄴ' }] },
    visible: { v1: false, l1: false },
  };
  const seen = (id: string) => ({
    isVisible: () => live.visible[id],
    setVisible: (value: any) => { live.visible[id] = value; },
  });
  const fakeVariable = (id: string) => (id in live.variables ? {
    ...seen(id),
    getValue: () => live.variables[id],
    setValue: (value: any) => { live.variables[id] = value; },
  } : null);
  const fakeList = (id: string) => (id in live.lists ? {
    ...seen(id),
    getArray: () => live.lists[id]!,
    replaceValue: (index: number, data: any) => { live.lists[id]![index - 1]!.data = data; },
    appendValue: (data: any) => { live.lists[id]!.push({ data }); },
    deleteValue: (index: number) => { live.lists[id]!.splice(index - 1, 1); },
  } : null);

  const entity: any = {
    x: 12.345, y: -7, size: 100, rotation: 0, direction: 90, visible: true,
    picture: { id: 'p2', name: '점프' },
    getX() { return this.x; }, setX(v: any) { this.x = v; },
    getY() { return this.y; }, setY(v: any) { this.y = v; },
    getSize() { return this.size; }, setSize(v: any) { this.size = v; },
    getRotation() { return this.rotation; }, setRotation(v: any) { this.rotation = v; },
    getDirection() { return this.direction; }, setDirection(v: any) { this.direction = v; },
    getScaleX() { return 1; }, getScaleY() { return 1; },
    getWidth() { return 100; }, getHeight() { return 100; },
    getVisible() { return this.visible; },
    setVisible(v: any) { this.visible = v; },
    setImage(picture: any) { this.picture = picture; },
  };
  const stageObject = {
    id: 'o1',
    name: '치로',
    rotateMethod: 'free',
    pictures: [{ id: 'p1', name: '기본' }, { id: 'p2', name: '점프' }],
    entity,
    getPicture(id: string) { return this.pictures.find((p) => p.id === id) || null; },
    setRotateMethod(method: any) { this.rotateMethod = method; },
  };
  entity.parent = stageObject;

  const scenes = [{ id: 's1', name: '장면 1' }, { id: 's2', name: '장면 2' }];
  const scene = {
    selected: scenes[0],
    getSceneById: (sceneId: any) => scenes.find((s) => s.id === sceneId) || null,
    selectScene(target: any) { this.selected = target; },
  };

  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  window.Entry = {
    engine,
    block: blocks,
    requestUpdate: false,
    scene,
    variableContainer: { getVariable: fakeVariable, getList: fakeList },
    container: { getObject: (id: string) => (id === 'o1' ? stageObject : null) },
    addEventListener: (name: string, fn: any) => { (listeners[name] = listeners[name] || []).push(fn); },
    dispatchEvent: (name: string, ...args: any[]) => (listeners[name] || []).forEach((fn) => fn(...args)),
  };
  window.entropyDebugSink = (fn: any) => { window.__sink = fn; };
  window.entropyReportError = (kind: string, error: any) => window.__sink({
    kind: String(kind), message: String(error && error.message), stack: '', time: Date.now(),
  });
  window.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });

  // Point Node globals at jsdom because Preact is imported in the Node realm.
  const globals = ['document', 'Node', 'Element', 'HTMLElement', 'DocumentFragment',
    'Text', 'Comment', 'NodeFilter', 'MutationObserver', 'requestAnimationFrame'];
  const scope = globalThis as Record<string, unknown>;
  const saved = globals.map((key) => [key, scope[key]] as const);
  for (const key of globals) scope[key] = window[key];
  t.after(() => { for (const [key, value] of saved) scope[key] = value; });

  // Use the same Preact file and type-stripped UI source that the browser receives.
  const source = stripTypes(fs.readFileSync(path.join(root, 'packages/player/src/debug-ui.ts'), 'utf-8'));
  const preactFile = source.match(/from ["']\/preact\/([^"']+)["']/)![1];
  const preact = await import(path.join(preactDist()!, preactFile));
  window.h = preact.h;
  window.render = preact.render;
  window.eval(source.replace(/^import[^;]+;$/m, 'const { h, render } = window;'));

  const byId = (id: string) => window.document.getElementById(id);
  return {
    window,
    engine,
    blocks,
    live,
    entity,
    stageObject,
    scene,
    byId,
    click: (id: string) => byId(id)!.dispatchEvent(new window.MouseEvent('click')),
    choose: (id: string, value: any) => {
      byId(id)!.value = value;
      byId(id)!.dispatchEvent(new window.Event('change'));
    },
    tab: (name: string) => window.document.querySelector('.debug-tab[data-tab="' + name + '"]')!
      .dispatchEvent(new window.MouseEvent('click')),
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
    async edit(node: any, value: any) {
      node.dispatchEvent(new window.MouseEvent('click'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const input = window.document.querySelector('.debug-edit-input');
      assert.ok(input, '입력칸이 열려야 한다');
      input.value = value;
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

test('디버그 패널은 탭으로 나뉘고, 한 번에 하나만 보인다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const tabs = [...ui.window.document.querySelectorAll('.debug-tab')];
  assert.deepEqual(tabs.map((button) => button.dataset.tab), ['run', 'data', 'objects', 'errors']);

  assert.equal(ui.byId('tab-run')!.hidden, false);
  assert.equal(ui.byId('tab-data')!.hidden, true);

  ui.tab('objects');
  await ui.settle();
  assert.equal(ui.byId('tab-objects')!.hidden, false);
  assert.equal(ui.byId('tab-run')!.hidden, true);
  assert.equal(tabs.find((b) => b.dataset.tab === 'objects')!.getAttribute('aria-selected'), 'true');
  assert.equal(tabs.find((b) => b.dataset.tab === 'run')!.getAttribute('aria-selected'), 'false');
});

test('정지한 뒤에도 시작하기로 다시 실행할 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();

  ui.click('run-btn');
  assert.equal(ui.engine.state, 'run');
  ui.click('run-btn');
  assert.equal(ui.engine.state, 'pause');
  ui.click('run-btn');
  assert.equal(ui.engine.state, 'run');

  ui.click('stop-btn');
  assert.equal(ui.engine.state, 'stop');
  ui.click('run-btn');
  assert.equal(ui.engine.state, 'run');
});

test('실행 상태에 따라 버튼과 안내 글이 바뀐다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();

  const stateText = () => ui.window.document.querySelector('.debug-run-state')!.textContent;

  ui.click('stop-btn');
  await ui.settle();
  assert.match(stateText(), /멈춰/);
  assert.equal(ui.byId('stop-btn')!.disabled, true);
  assert.equal(ui.byId('run-btn')!.textContent, '시작하기');
  assert.equal(ui.byId('run-btn')!.disabled, false);

  ui.click('run-btn');
  await ui.settle();
  assert.match(stateText(), /실행 중/);
  assert.equal(ui.byId('run-btn')!.textContent, '일시정지');

  ui.click('run-btn');
  await ui.settle();
  assert.equal(ui.byId('run-btn')!.textContent, '이어서 하기');
  assert.equal(ui.byId('pause-btn'), null);
});

test('부스트 모드 · 기기 · 터치를 디버그 창에서 정한 값으로 바꿔치기한다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyPatchEnvironmentBlocks();
  const askMobile = { getField: () => 'mobile' };

  assert.equal(ui.blocks.is_boost_mode.func(), '실제부스트');
  assert.equal(ui.blocks.is_touch_supported.func(), '실제터치');
  assert.equal(ui.blocks.is_current_device_type.func(null, askMobile), '실제mobile');

  ui.choose('env-boost', 'true');
  assert.equal(ui.blocks.is_boost_mode.func(), true);
  ui.choose('env-boost', 'false');
  assert.equal(ui.blocks.is_boost_mode.func(), false);
  ui.choose('env-boost', '');
  assert.equal(ui.blocks.is_boost_mode.func(), '실제부스트');

  ui.choose('env-touch', 'false');
  assert.equal(ui.blocks.is_touch_supported.func(), false);

  ui.choose('env-device', 'mobile');
  assert.equal(ui.blocks.is_current_device_type.func(null, askMobile), true);
  ui.choose('env-device', 'desktop');
  assert.equal(ui.blocks.is_current_device_type.func(null, askMobile), false);
});

const dataProject = {
  scenes: [{ id: 's1', name: '장면 1' }],
  objects: [{ id: 'o1', name: '치로', scene: 's1', script: '[]' }],
  variables: [
    { id: 'v1', name: '점수', value: 0 },
    { id: 'l1', name: '기록', variableType: 'list', array: [] },
    { id: 't1', name: '초시계', variableType: 'timer' },
  ],
  messages: [{ id: 'm1', name: '게임 시작' }],
  functions: [{
    id: 'f1',
    content: JSON.stringify([[{
      type: 'function_create',
      params: [{
        type: 'function_field_label',
        params: ['스폰', { type: 'function_field_string', params: [{ type: 'stringParam_a' }, null] }],
      }],
    }]]),
  }],
};

const functionProject = {
  ...dataProject,
  functions: [{
    id: 'f1',
    content: JSON.stringify([[{
      type: 'function_create',
      params: [{
        type: 'function_field_label',
        params: ['스폰', { type: 'function_field_string', params: [{ type: 'stringParam_a' }, null] }],
      }],
      statements: [[{ id: 'b1', type: 'move_direction', params: [{ id: 'b2', type: 'number', params: ['10'] }] }]],
    }]]),
  }],
};

test('자료 탭에서 변수의 지금 값 · 신호 · 함수를 볼 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('data');
  await ui.settle();

  const variables = ui.byId('var-list')!.textContent;
  assert.match(variables, /점수/);
  assert.match(variables, /42/);
  assert.match(variables, /기록/);
  assert.match(variables, /\[2개\]/);
  assert.doesNotMatch(variables, /초시계/);

  assert.match(ui.byId('signal-list')!.textContent, /게임 시작/);
  const functions = ui.byId('function-list')!.textContent;
  assert.match(functions, /스폰/);
  assert.match(functions, /1개 인자/);
});

async function openData(ui: any, project = dataProject) {
  ui.window.entropyRenderProjectDebug(project);
  ui.tab('data');
  await ui.settle();
  return ui.byId('var-list');
}

test('변수 값을 눌러서 바로 고칠 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const list = await openData(ui);

  const cell = [...list.querySelectorAll('.debug-edit')].find((node) => node.textContent === '42');
  assert.ok(cell, '지금 값이 눌러서 고칠 수 있는 칸이어야 한다');
  await ui.edit(cell, '77');

  // Numeric edits must be stored as numbers for Entry arithmetic.
  assert.equal(ui.live.variables.v1, 77);
  assert.match(ui.byId('var-list')!.textContent, /77/);
});

test('숫자가 아닌 값은 글자 그대로 넣는다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const list = await openData(ui);

  await ui.edit([...list.querySelectorAll('.debug-edit')].find((n) => n.textContent === '42'), '가나다');
  assert.equal(ui.live.variables.v1, '가나다');
});

test('리스트는 이름을 눌러 펼치고 다시 눌러 접는다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const list = await openData(ui);

  const name = [...list.querySelectorAll('.debug-expand')].find((node) => node.textContent === '기록');
  assert.ok(name);
  assert.equal(list.querySelectorAll('.debug-list-items').length, 0);

  name.dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  const items = ui.byId('var-list')!.querySelectorAll('.debug-list-ol li');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /ㄱ/);

  ui.byId('var-list')!.querySelector('.debug-expand.open')!.dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  assert.equal(ui.byId('var-list')!.querySelectorAll('.debug-list-items').length, 0);
});

test('펼친 리스트에서 항목을 고치고 넣고 지울 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const list = await openData(ui);
  [...list.querySelectorAll('.debug-expand')].find((n) => n.textContent === '기록')
    .dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();

  await ui.edit(ui.byId('var-list')!.querySelectorAll('.debug-list-ol .debug-edit')[1], 'ㄷ');
  assert.deepEqual(ui.live.lists.l1.map((item) => item.data), ['ㄱ', 'ㄷ']);

  ui.byId('var-list')!.querySelector('.debug-add-btn')!.dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  assert.equal(ui.live.lists.l1.length, 3);

  ui.byId('var-list')!.querySelectorAll('.debug-list-ol .debug-mini-btn')[0]
    .dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  assert.deepEqual(ui.live.lists.l1.map((item) => item.data), ['ㄷ', '']);
});

// Empty list items must remain clickable for editing.
test('값이 빈 리스트 항목도 눌러서 고칠 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.live.lists.l1 = [{ data: '' }];
  const list = await openData(ui);
  [...list.querySelectorAll('.debug-expand')].find((n) => n.textContent === '기록')
    .dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();

  const cell = ui.byId('var-list')!.querySelector('.debug-list-ol .debug-edit');
  assert.ok(cell!.textContent.trim().length > 0, '빈 값이어도 누를 자리가 있어야 한다');
  assert.match(cell!.className, /empty/);

  await ui.edit(cell, '채움');
  assert.deepEqual(ui.live.lists.l1.map((item) => item.data), ['채움']);
});

test('펼친 리스트 항목과 함수 블록은 세로로 쌓인다', () => {
  const css = playerPage({
    name: 'a', base: '/lib', summary: { scenes: 1, objects: 1, blocks: 1 }, entName: 'a.ent', reload: false,
  });
  assert.match(css, /\.debug-rows > li \{[^}]*display: flex/);
  assert.doesNotMatch(css, /\.debug-rows li \{/);
  assert.match(css, /\.debug-rows > li\.debug-items-row \{[^}]*display: block/);
});

test('항목을 넣고 지우면 목록이 바로 다시 그려진다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const list = await openData(ui);
  [...list.querySelectorAll('.debug-expand')].find((n) => n.textContent === '기록')
    .dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  const rows = () => ui.byId('var-list')!.querySelectorAll('.debug-list-ol > li').length;
  assert.equal(rows(), 2);

  ui.byId('var-list')!.querySelector('.debug-add-btn')!.dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  assert.equal(rows(), 3, '넣은 항목이 바로 보여야 한다');

  ui.byId('var-list')!.querySelectorAll('.debug-list-ol .debug-mini-btn')[0]
    .dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  assert.equal(rows(), 2, '지운 항목이 바로 사라져야 한다');
});

test('한 항목을 고친 뒤 다른 항목을 열면 그 항목의 값이 뜬다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const list = await openData(ui);
  [...list.querySelectorAll('.debug-expand')].find((n) => n.textContent === '기록')
    .dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();

  const cells = () => ui.byId('var-list')!.querySelectorAll('.debug-list-ol .debug-edit');
  await ui.edit(cells()[0], '바뀐값');
  assert.deepEqual(ui.live.lists.l1.map((i) => i.data), ['바뀐값', 'ㄴ']);

  // Editing another item must not reuse the previous item's input state.
  cells()[1].dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  assert.equal(ui.window.document.querySelector('.debug-edit-input')!.value, 'ㄴ');
});

test('변수와 리스트를 무대에서 보이거나 숨길 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const list = await openData(ui);

  const toggles = list.querySelectorAll('.debug-toggle');
  assert.equal(toggles.length, 2);
  assert.equal(toggles[0].textContent, '숨김');

  toggles[0].dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  assert.equal(ui.live.visible.v1, true);
  assert.equal(ui.byId('var-list')!.querySelectorAll('.debug-toggle')[0].textContent, '보임');

  ui.byId('var-list')!.querySelectorAll('.debug-toggle')[1]
    .dispatchEvent(new ui.window.MouseEvent('click'));
  assert.equal(ui.live.visible.l1, true);
});

test('리스트가 길어도 펼친 높이에는 한계가 있다', () => {
  const css = playerPage({
    name: 'a', base: '/lib', summary: { scenes: 1, objects: 1, blocks: 1 }, entName: 'a.ent', reload: false,
  });
  assert.match(css, /\.debug-list-items\s*\{[^}]*max-height:\s*\d+px/);
  assert.match(css, /\.debug-list-items\s*\{[^}]*overflow:\s*auto/);
});

test('함수 이름을 누르면 그 함수의 블록이 펼쳐진다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug(functionProject);
  ui.tab('data');
  await ui.settle();

  const name = ui.byId('function-list')!.querySelector('.debug-expand');
  assert.match(name!.textContent, /스폰/);
  assert.equal(ui.byId('function-list')!.querySelectorAll('.debug-func-code').length, 0);

  name!.dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  const code = ui.byId('function-list')!.querySelector('.debug-func-code');
  assert.ok(code, '함수 코드가 열려야 한다');
  assert.match(code.textContent, /move_direction/);

  name!.dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();
  assert.equal(ui.byId('function-list')!.querySelectorAll('.debug-func-code').length, 0);
});

test('자료 탭의 신호를 눌러서 바로 보낼 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('data');
  await ui.settle();

  ui.byId('signal-list')!.querySelector('.debug-send-btn')!
    .dispatchEvent(new ui.window.MouseEvent('click'));
  assert.deepEqual(ui.engine.fired, [['when_message_cast', 'm1']]);
});

test('오브젝트 정보에 좌표 · 크기 · 방향 · 모양이 나온다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('objects');
  await ui.settle();

  const info = ui.byId('object-info')!.textContent.replace(/\s+/g, ' ');
  assert.match(info, /x 좌표 12.35/);
  assert.match(info, /y 좌표 -7/);
  assert.match(info, /크기 100/);
  assert.match(info, /이동 방향 90/);
  assert.match(info, /모양 번호 2 \/ 2/);

  const [costume, rotate] = ui.byId('object-info')!.querySelectorAll('select');
  assert.deepEqual([...costume.options].map((o) => o.textContent), ['기본', '점프']);
  assert.equal(costume.value, 'p2');
  assert.deepEqual([...rotate.options].map((o) => o.value), ['free', 'vertical', 'none']);
  assert.equal(rotate.value, 'free');
  assert.equal(ui.byId('object-info')!.querySelector('.debug-toggle')!.textContent, '보임');
});

test('모양·회전 방식을 드롭다운으로 바꾸고 보이기를 토글한다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('objects');
  await ui.settle();

  const [costume, rotate] = ui.byId('object-info')!.querySelectorAll('select');
  costume.value = 'p1';
  costume.dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.entity.picture.id, 'p1');

  rotate.value = 'vertical';
  rotate.dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.stageObject.rotateMethod, 'vertical');

  const toggle = ui.byId('object-info')!.querySelector('.debug-toggle');
  toggle!.dispatchEvent(new ui.window.MouseEvent('click'));
  assert.equal(ui.entity.visible, false);
  await ui.settle();
  assert.equal(ui.byId('object-info')!.querySelector('.debug-toggle')!.textContent, '숨김');
});

test('오브젝트 좌표를 눌러서 바로 옮길 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('objects');
  await ui.settle();

  const cell = [...ui.byId('object-info')!.querySelectorAll('.debug-edit')]
    .find((node) => node.textContent === '12.35');
  await ui.edit(cell, '-100');
  assert.equal(ui.entity.x, -100);
});

test('실행기가 아직 없으면 오브젝트 정보는 안내만 보여 준다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.Entry!.container = { getObject: () => null };
  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('objects');
  await ui.settle();
  assert.match(ui.byId('object-info')!.textContent, /한 번 실행해 보세요/);
});

test('실행기가 오브젝트를 아직 모르면 안내만 보여 준다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const labels = () => [...ui.byId('object-info')!.querySelectorAll('li')]
    .map((li) => li.querySelector('.key')?.textContent ?? '');

  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('objects');
  await ui.settle();
  assert.ok(labels().length > 5, '실행기가 아는 오브젝트는 값 줄이 나온다');

  ui.window.Entry!.container = { getObject: () => null };
  ui.click('debug-toggle');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(labels(), ['']);
  assert.match(ui.byId('object-info')!.textContent, /한 번 실행해 보세요/);
});

test('글상자는 글 내용을 고칠 수 있고, 모양 줄은 내지 않는다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.entity.text = '점수: 0';
  ui.entity.setText = (value: any) => { ui.entity.text = value; };
  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('objects');
  await ui.settle();

  const row = (label: string) => [...ui.byId('object-info')!.querySelectorAll('li')]
    .find((li) => li.querySelector('.key')?.textContent === label);
  assert.ok(row('글 내용'), '글상자는 글 내용을 고칠 수 있다');
  assert.equal(row('모양'), undefined);
  assert.equal(row('회전 방식'), undefined);

  await ui.edit(row('글 내용')!.querySelector('.debug-edit'), '점수: 99');
  assert.equal(ui.entity.text, '점수: 99');
});

async function openScenes(ui: any) {
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    scenes: [{ id: 's1', name: '장면 1' }, { id: 's2', name: '장면 2' }],
  });
  ui.tab('objects');
  await ui.settle();
  return ui.byId('scene-tree').querySelectorAll('.debug-scene-go');
}

const firedTypes = (ui: any) => ui.engine.fired.map(([type]: [string, string]) => type);

test('장면 바로가기로 그 장면으로 넘어가고 장면 시작 이벤트가 돈다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const buttons = await openScenes(ui);
  assert.equal(buttons.length, 2);
  assert.equal(ui.scene.selected.id, 's1');

  buttons[1].dispatchEvent(new ui.window.MouseEvent('click'));
  assert.equal(ui.scene.selected.id, 's2');
  // Selecting a scene alone must not fire its start scripts.
  assert.deepEqual(firedTypes(ui), ['when_scene_start']);
});

test('장면 바로가기는 멈춰 있거나 일시정지여도 그 장면을 돌린다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  let buttons = await openScenes(ui);

  // Start the engine before scene events because stopped engines drop them.
  assert.equal(ui.engine.state, 'stop');
  buttons[1].dispatchEvent(new ui.window.MouseEvent('click'));
  assert.equal(ui.engine.state, 'run');
  assert.deepEqual(firedTypes(ui), ['when_scene_start']);

  ui.tab('run');
  await ui.settle();
  ui.click('run-btn');
  assert.equal(ui.engine.state, 'pause');
  buttons = await openScenes(ui);

  buttons[0].dispatchEvent(new ui.window.MouseEvent('click'));
  assert.equal(ui.engine.state, 'run');
  assert.equal(ui.scene.selected.id, 's1');
  assert.deepEqual(firedTypes(ui), ['when_scene_start', 'when_scene_start']);

  buttons[0].dispatchEvent(new ui.window.MouseEvent('click'));
  assert.equal(ui.engine.fired.length, 3);
});

test('장면 바로가기 뒤에는 실행 탭이 실행 중으로 보인다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const buttons = await openScenes(ui);

  buttons[1].dispatchEvent(new ui.window.MouseEvent('click'));
  ui.tab('run');
  await ui.settle();
  assert.match(ui.window.document.querySelector('.debug-run-state')!.textContent, /실행 중/);
});

test('항목 추가 단추는 목록 맨 위에 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const list = await openData(ui);
  [...list.querySelectorAll('.debug-expand')].find((n) => n.textContent === '기록')
    .dispatchEvent(new ui.window.MouseEvent('click'));
  await ui.settle();

  const box = ui.byId('var-list')!.querySelector('.debug-list-items');
  const kids = [...box!.children];
  assert.ok(kids[0].classList.contains('debug-add-btn'), '추가 단추가 첫 자식이어야 한다');
  assert.ok(kids.indexOf(box!.querySelector('.debug-list-ol')) > 0);
});

function withStage(ui: any, objects: any, current = objects) {
  const doc = ui.window.document;
  const canvas = doc.createElement('canvas');
  canvas.id = 'entryCanvas';
  canvas.getBoundingClientRect = () => ({
    left: 100, top: 50, width: 480, height: 270, right: 580, bottom: 320, x: 100, y: 50,
  });
  ui.byId('workspace').append(canvas);
  ui.window.Entry.container.objects_ = objects;
  ui.window.Entry.container.getCurrentObjects = () => current;
  ui.window.entropyWatchStagePicks();
  return { canvas, center: { clientX: 340, clientY: 185 } };
}

function armInspector(ui: any) {
  ui.click('inspect-btn');
}

function overStage(ui: any, canvas: any, type: string, clientX: number, clientY: number) {
  canvas.dispatchEvent(new ui.window.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX, clientY,
  }));
}

function stageActor(id: string, name: string, x = 0, y = 0) {
  return {
    id,
    name,
    entity: {
      getX: () => x, getY: () => y,
      getWidth: () => 100, getHeight: () => 100,
      getScaleX: () => 1, getScaleY: () => 1,
      getVisible: () => true,
    },
  };
}

test('고르기를 켜고 무대에 마우스를 대면 그 오브젝트가 디버거에서 열린다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    objects: [
      { id: 'o0', name: '다른', scene: 's1', script: '[]' },
      { id: 'o1', name: '치로', scene: 's1', script: '[]' },
    ],
  });
  ui.tab('objects');
  await ui.settle();
  assert.equal(ui.byId('object-info-name')!.textContent, '— 다른');

  const { canvas, center } = withStage(ui, [stageActor('o1', '치로')]);
  overStage(ui, canvas, 'pointermove', center.clientX, center.clientY);
  await ui.settle();
  assert.equal(ui.byId('object-info-name')!.textContent, '— 다른');

  armInspector(ui);
  overStage(ui, canvas, 'pointermove', center.clientX, center.clientY);
  await ui.settle();

  assert.equal(ui.byId('object-info-name')!.textContent, '— 치로');
  assert.equal(ui.byId('tab-objects')!.hidden, false);
});

test('마우스를 옮길 때마다 그 자리의 오브젝트로 계속 따라간다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    objects: [
      { id: 'o1', name: '치로', scene: 's1', script: '[]' },
      { id: 'o2', name: '엔트리봇', scene: 's1', script: '[]' },
    ],
  });
  ui.tab('objects');
  await ui.settle();

  const { canvas } = withStage(ui, [stageActor('o2', '엔트리봇', 0, 100), stageActor('o1', '치로')]);
  armInspector(ui);

  const picked = [];
  for (let i = 0; i < 4; i += 1) {
    overStage(ui, canvas, 'pointermove', 340, i % 2 === 0 ? 85 : 185);
    await ui.settle();
    picked.push(ui.byId('object-info-name')!.textContent);
  }
  assert.deepEqual(picked, ['— 엔트리봇', '— 치로', '— 엔트리봇', '— 치로']);
});

test('누르면 그 오브젝트에 붙박고, 한 번 더 누르면 다시 따라간다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    objects: [
      { id: 'o1', name: '치로', scene: 's1', script: '[]' },
      { id: 'o2', name: '엔트리봇', scene: 's1', script: '[]' },
    ],
  });
  ui.tab('objects');
  await ui.settle();

  const { canvas } = withStage(ui, [stageActor('o2', '엔트리봇', 0, 100), stageActor('o1', '치로')]);
  armInspector(ui);

  overStage(ui, canvas, 'pointermove', 340, 85);
  await ui.settle();
  assert.equal(ui.byId('object-info-name')!.textContent, '— 엔트리봇');

  overStage(ui, canvas, 'pointerdown', 340, 85);
  await ui.settle();
  overStage(ui, canvas, 'pointermove', 340, 185);
  await ui.settle();
  assert.equal(ui.byId('object-info-name')!.textContent, '— 엔트리봇');

  overStage(ui, canvas, 'pointerdown', 340, 185);
  await ui.settle();
  assert.equal(ui.byId('object-info-name')!.textContent, '— 치로');
  overStage(ui, canvas, 'pointermove', 340, 85);
  await ui.settle();
  assert.equal(ui.byId('object-info-name')!.textContent, '— 엔트리봇');
});

test('고르기를 끄면 붙박은 것도 풀리고 무대를 놓아 준다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    objects: [
      { id: 'o1', name: '치로', scene: 's1', script: '[]' },
      { id: 'o2', name: '엔트리봇', scene: 's1', script: '[]' },
    ],
  });
  ui.tab('objects');
  await ui.settle();

  const { canvas } = withStage(ui, [stageActor('o2', '엔트리봇', 0, 100), stageActor('o1', '치로')]);
  armInspector(ui);
  overStage(ui, canvas, 'pointermove', 340, 85);
  overStage(ui, canvas, 'pointerdown', 340, 85);
  await ui.settle();
  assert.equal(ui.byId('inspect-btn')!.getAttribute('aria-pressed'), 'true');

  ui.click('inspect-btn');
  await ui.settle();
  assert.equal(ui.byId('inspect-btn')!.getAttribute('aria-pressed'), 'false');

  const event = new ui.window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, clientX: 340, clientY: 185,
  });
  canvas.dispatchEvent(event);
  await ui.settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(ui.byId('object-info-name')!.textContent, '— 엔트리봇');
});

test('모양이 비어 있는 큰 판은 그 밑의 오브젝트를 가리지 않는다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    objects: [
      { id: 'o2', name: '덮개', scene: 's1', script: '[]' },
      { id: 'o1', name: '치로', scene: 's1', script: '[]' },
    ],
  });
  ui.tab('objects');
  await ui.settle();

  // Put an empty full-stage texture above the visible object.
  const cover = stageActor('o2', '덮개');
  cover.entity.getWidth = () => 960;
  cover.entity.getHeight = () => 540;
  const objects = [cover, stageActor('o1', '치로')];
  const { canvas } = withStage(ui, objects);

  // Make the pixel-aware runtime reject the empty overlay at every point.
  const idle = () => undefined;
  ui.window.entropyRuntime = {
    stageCanvas: () => canvas,
    stageSize: () => ({ width: 480, height: 270 }),
    currentObjects: () => objects,
    hitTest: (entity: any) => entity.getWidth() !== 960,
    state: () => 'stop',
    run: idle, pause: idle, stop: idle, goToScene: idle, sendSignal: idle,
    variable: () => null, list: () => null, object: () => null,
    realBoost: () => false, patchEnvironment: idle, requestUpdate: idle,
    layoutCanvas: idle, refreshRect: idle,
  };

  armInspector(ui);
  overStage(ui, canvas, 'pointermove', 340, 185);
  await ui.settle();
  assert.equal(ui.byId('object-info-name')!.textContent, '— 치로');
});

test('픽셀로 답하지 못하는 실행기에서는 상자로 고른다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    objects: [{ id: 'o1', name: '치로', scene: 's1', script: '[]' }],
  });
  ui.tab('objects');
  await ui.settle();

  const { canvas } = withStage(ui, [stageActor('o1', '치로')]);
  armInspector(ui);
  overStage(ui, canvas, 'pointermove', 340, 185);
  await ui.settle();
  assert.equal(ui.byId('object-info-name')!.textContent, '— 치로');
});

test('그냥 누른 것은 디버거가 가로채지 않는다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    objects: [
      { id: 'o0', name: '다른', scene: 's1', script: '[]' },
      { id: 'o1', name: '치로', scene: 's1', script: '[]' },
    ],
  });
  ui.tab('objects');
  await ui.settle();

  const { canvas, center } = withStage(ui, [stageActor('o1', '치로')]);
  const event = new ui.window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, ...center,
  });
  canvas.dispatchEvent(event);
  await ui.settle();

  assert.equal(ui.byId('object-info-name')!.textContent, '— 다른');
  assert.equal(event.defaultPrevented, false);
});

test('고르는 클릭은 무대까지 내려가지 않는다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug(dataProject);
  ui.tab('objects');
  await ui.settle();

  const { canvas, center } = withStage(ui, [stageActor('o1', '치로')]);
  const reached: string[] = [];
  canvas.addEventListener('pointerdown', () => reached.push('stage'));
  canvas.addEventListener('click', () => reached.push('stage'));

  armInspector(ui);
  for (const type of ['pointerdown', 'click']) {
    overStage(ui, canvas, type, center.clientX, center.clientY);
  }
  await ui.settle();
  assert.deepEqual(reached, [], '무대는 이 클릭을 보지 못한다');
});

test('다른 장면의 오브젝트는 고르지 않는다', async (t) => {
  // Other scenes remain in memory, so picking must filter to the current scene.
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    ...dataProject,
    scenes: [{ id: 's1', name: '인트로' }, { id: 's2', name: '전투' }],
    objects: [
      { id: 'old', name: '인트로배경', scene: 's1', script: '[]' },
      { id: 'now', name: '전투배경', scene: 's2', script: '[]' },
    ],
  });
  ui.tab('objects');
  await ui.settle();

  const intro = stageActor('old', '인트로배경');
  const battle = stageActor('now', '전투배경');
  const { canvas, center } = withStage(ui, [intro, battle], [battle]);

  armInspector(ui);
  overStage(ui, canvas, 'pointermove', center.clientX, center.clientY);
  await ui.settle();

  assert.equal(ui.byId('object-info-name')!.textContent, '— 전투배경');
});

test('부스트 모드처럼 캔버스가 여럿이어도 무대에서 오브젝트를 고른다', async (t) => {
  // PIXI helper canvases must not be mistaken for the visible stage.
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug(dataProject);
  await ui.settle();

  const doc = ui.window.document;
  const rect = (left: any, top: any, width: number, height: number) => () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
  });

  const workspace = ui.byId('workspace');
  const decoy = doc.createElement('canvas');
  decoy.getBoundingClientRect = rect(0, 0, 0, 0);
  const stage = doc.createElement('canvas');
  stage.id = 'entryCanvas';
  stage.getBoundingClientRect = rect(100, 50, 480, 270);
  workspace!.append(decoy, stage);

  ui.window.Entry!.container.objects_ = [ui.stageObject];
  ui.window.entropyWatchStagePicks();

  ui.entity.x = 0;
  ui.entity.y = 0;
  armInspector(ui);
  overStage(ui, stage, 'pointermove', 340, 185);
  await ui.settle();

  assert.equal(ui.byId('object-info-name')!.textContent, '— 치로');
  assert.equal(ui.byId('tab-objects')!.hidden, false);
});

test('섹션을 끝까지 줄이면 딱 붙어서 높이가 0 이 된다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const section = ui.byId('tab-run')!.querySelector('.debug-section');
  const drag = (from: any, to: any) => {
    section!.querySelector('.debug-vresize')!
      .dispatchEvent(new ui.window.MouseEvent('mousedown', { clientY: from, bubbles: true }));
    ui.window.dispatchEvent(new ui.window.MouseEvent('mousemove', { clientY: to }));
    ui.window.dispatchEvent(new ui.window.MouseEvent('mouseup'));
  };

  // jsdom reports zero layout height, so drag distance becomes the section's final height.
  drag(100, 130);
  await ui.settle();
  assert.match(section!.getAttribute('style'), /height:\s*0px/);
  assert.match(section!.getAttribute('class'), /collapsed/);
  // Keep resize handles reachable after a section snaps closed.
  assert.equal(section!.querySelectorAll('.debug-vresize').length, 1);

  drag(100, 200);
  await ui.settle();
  assert.match(section!.getAttribute('style'), /height:\s*100px/);
  assert.doesNotMatch(section!.getAttribute('class'), /collapsed/);
});

test('패널도 끝까지 줄이면 딱 붙어서 폭이 0 이 된다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.innerWidth = 1200;
  const panel = ui.byId('debug-panel');
  const drag = (to: any) => {
    ui.byId('debug-resize-handle')!
      .dispatchEvent(new ui.window.MouseEvent('mousedown', { clientX: 800, bubbles: true }));
    ui.window.dispatchEvent(new ui.window.MouseEvent('mousemove', { clientX: to }));
    ui.window.dispatchEvent(new ui.window.MouseEvent('mouseup'));
  };

  drag(1180);
  assert.equal(panel!.style.width, '0px');
  assert.match(panel!.className, /collapsed/);

  drag(1000);
  assert.equal(panel!.style.width, '200px');
  assert.doesNotMatch(panel!.className, /collapsed/);
});

test('접어 둔 패널을 다시 열면 폭이 되살아난다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.innerWidth = 1200;
  ui.byId('debug-resize-handle')!
    .dispatchEvent(new ui.window.MouseEvent('mousedown', { clientX: 800, bubbles: true }));
  ui.window.dispatchEvent(new ui.window.MouseEvent('mousemove', { clientX: 1190 }));
  ui.window.dispatchEvent(new ui.window.MouseEvent('mouseup'));
  assert.equal(ui.byId('debug-panel')!.style.width, '0px');

  ui.click('debug-toggle');
  await ui.settle();
  assert.equal(ui.byId('debug-panel')!.style.width, '');
});

test('작품 안의 이름은 어떤 것도 태그가 되지 않는다 (XSS)', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.entropyRenderProjectDebug({
    scenes: [{ id: 's1', name: '<img src=x onerror=window.PWNED=1>' }],
    objects: [{ id: 'o1', name: '<script>window.PWNED=1</script>', scene: 's1', script: '[]' }],
    variables: [{ id: 'v9', name: '<svg onload=window.PWNED=1>', value: '<b>굵게</b>' }],
    messages: [{ id: 'm9', name: '<iframe src=javascript:1>' }],
    functions: [],
  });
  // Check only the title because the run-tab body intentionally contains UI markup.
  const areas = ['#tab-data', '#tab-objects'];
  const selector = areas.flatMap((area) => ['img', 'svg', 'iframe', 'script', 'b'].map((tag) => area + ' ' + tag)).join(', ');
  for (const name of ['data', 'objects']) {
    ui.tab(name);
    await ui.settle();
    const injected = ui.window.document.querySelectorAll(selector);
    assert.equal(injected.length, 0, [...injected].map((node) => node.outerHTML).join('\n'));
  }
  assert.equal(ui.window.PWNED, undefined);
  // Keep escaped project text readable even when its markup cannot execute.
  assert.match(ui.byId('scene-tree')!.textContent, /<img src=x/);
});

test('페이지에 넣는 값은 HTML 로도 스크립트로도 새어 나가지 않는다', () => {
  const evil = '</script><img src=x onerror=alert(1)><svg/onload=alert(2)>"\'`&<>';
  const html = playerPage({
    name: evil, base: evil, summary: { scenes: 1, objects: 1, blocks: 1 }, entName: evil, reload: true,
  });

  const withoutComments = html.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(withoutComments, /<img/);
  assert.doesNotMatch(withoutComments, /<svg/);

  const bodies = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(bodies.length, 4);
  for (const body of bodies) {
    assert.doesNotMatch(body, /<\/script/i);
    assert.doesNotThrow(() => new Function(body)); // eslint-disable-line no-new-func
  }
});

test('탭 안의 섹션들은 마지막을 빼고 위아래로 크기를 조절할 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();

  const sections = [...ui.byId('tab-run')!.querySelectorAll('.debug-section')];
  assert.equal(sections.length, 2);
  // The last section fills remaining space and needs no resize handle.
  assert.equal(sections[0].querySelectorAll('.debug-vresize').length, 1);
  assert.equal(sections[1].querySelectorAll('.debug-vresize').length, 0);
  assert.match(sections[0].getAttribute('style'), /height:\s*200px/);

  const handle = sections[0].querySelector('.debug-vresize');
  handle!.dispatchEvent(new ui.window.MouseEvent('mousedown', { clientY: 100, bubbles: true }));
  ui.window.dispatchEvent(new ui.window.MouseEvent('mousemove', { clientY: 160 }));
  ui.window.dispatchEvent(new ui.window.MouseEvent('mouseup'));
  await ui.settle();

  assert.match(sections[0].getAttribute('style'), /height:\s*60px/);
});

test('패널 폭은 좌우로 조절할 수 있다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  ui.window.innerWidth = 1200;

  const handle = ui.byId('debug-resize-handle');
  handle!.dispatchEvent(new ui.window.MouseEvent('mousedown', { clientX: 800, bubbles: true }));
  ui.window.dispatchEvent(new ui.window.MouseEvent('mousemove', { clientX: 700 }));
  ui.window.dispatchEvent(new ui.window.MouseEvent('mouseup'));

  assert.equal(ui.byId('debug-panel')!.style.width, '500px');
});

test('패널이 실제로 그려진다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();
  const panel = ui.byId('debug-panel');

  assert.equal(panel!.querySelectorAll('.debug-tab').length, 4);

  // Do not render inactive tabs because large block trees can be expensive.
  const titles = [];
  for (const name of ['run', 'data', 'objects', 'errors']) {
    ui.tab(name);
    await ui.settle();
    titles.push(...[...panel!.querySelectorAll('.debug-section h3')].map((h) => h.textContent.trim()));
  }
  assert.deepEqual(titles, ['실행 제어', '실행 환경 흉내내기', '변수 · 리스트', '신호', '함수',
    '장면 · 오브젝트', '오브젝트 정보', '컴파일된 블록', '오류 로그']);

  ui.tab('run');
  await ui.settle();
  const text = panel!.textContent;
  assert.doesNotMatch(text, /appendChild|=>\s*\{|function\s*\(/);
  assert.match(text, /시작하기/);
});

test('실제 작품을 넣으면 네 탭이 모두 내용을 채운다', async (t) => {
  const ui = await mountDebugPanel(t);
  await ui.settle();

  const file = path.join(root, 'examples/all_blocks.etp');
  const { project } = compileProject(fs.readFileSync(file, 'utf-8'), { path: file });
  ui.window.entropyRenderProjectDebug(project);
  await ui.settle();

  const textOf = (id: string) => ui.byId(id)!.textContent.replace(/\s+/g, ' ');

  ui.click('run-btn');
  await ui.settle();
  assert.match(textOf('tab-run'), /실행 중/);

  ui.tab('data');
  await ui.settle();
  const data = textOf('tab-data');
  assert.match(data, /점수/);
  assert.match(data, /전역 · 변수/);
  assert.match(data, /기록 전역 · 리스트 \[3개\] \[1,2,3\]/);
  assert.match(data, /체력 주인공 · 변수 100/);
  assert.match(data, /신호1/);
  assert.match(data, /두배 … 값/);
  assert.match(data, /값 함수/);

  ui.tab('objects');
  await ui.settle();
  const objects = textOf('tab-objects');
  assert.match(objects, /주인공/);
  assert.match(objects, /when_run_button_click/);
  assert.match(objects, /스크립트 1/);
  assert.ok(ui.byId('block-tree')!.querySelectorAll('li').length > 20, '블록 트리가 펼쳐져야 한다');

  ui.window.entropyReportError('실행 오류', new Error('일부러 낸 오류'));
  await ui.settle();
  assert.match(textOf('tab-errors'), /일부러 낸 오류/);
  assert.equal(ui.window.document.querySelector('.debug-tab[aria-selected="true"]')!.dataset.tab, 'errors');
});
