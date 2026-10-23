import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeTar } from '@entropy/compiler';
import { loadProject, serveVm, Vm } from '@entropy/vm';

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const media = { 'temp/image/original.svg': SVG, 'temp/image/original.png': PNG, 'temp/sound/original.wav': Buffer.from('original sound') };

function project() {
  return {
    name: 'original work', speed: 30, scenes: [{ id: 'scene-original', name: 's' }],
    variables: [{ id: 'value-original', name: 'out', variableType: 'variable', value: false }],
    messages: [], functions: [], tables: [{ id: 'table-original', name: 'table', fields: ['A'], data: [[1], [false]] }],
    objects: [
      { id: 'actor-original', name: 'actor', scene: 'scene-original', objectType: 'sprite',
        script: JSON.stringify([[{ id: 'hat-original', type: 'when_run_button_click' },
          { id: 'scope-original', type: 'switch_scope', params: ['other-original'] },
          { id: 'move-original', type: 'locate_x', params: [37] },
          { id: 'write-original', type: 'set_variable', params: ['value-original', true] }]]),
        entity: { x: 0, y: 0, visible: true, width: 1, height: 1, scaleX: 1, scaleY: 1 },
        selectedPictureId: 'picture-original', sprite: {
          pictures: [{ id: 'picture-original', name: 'original', fileurl: 'temp/image/original.svg', pngurl: 'temp/image/original.png', imageType: 'svg', dimension: { width: 1, height: 1 } }],
          sounds: [{ id: 'sound-original', name: 'sound', fileurl: 'temp/sound/original.wav', duration: 12 }],
        },
      },
      { id: 'other-original', name: 'other', scene: 'scene-original', objectType: 'sprite', script: '[]', entity: { x: 0, y: 0 } },
    ],
    customMetadata: { keep: ['all', 'fields'] },
  };
}

function fixture(t: any, work = project(), extra: Record<string, Buffer> = media) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-load-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'original.ent');
  fs.writeFileSync(file, zlib.gzipSync(makeTar([
    { name: 'temp/project.json', data: Buffer.from(JSON.stringify(work)) },
    ...Object.entries(extra).map(([name, data]) => ({ name, data })),
  ])));
  return { dir, file, work };
}

async function load(t: any, file: string, options: Parameters<typeof loadProject>[1] = {}) {
  const loaded = await loadProject(file, options);
  const folder = loaded.assetDirs.at(-1)!;
  assert.ok(path.basename(folder).startsWith('entropy-assets-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return loaded;
}

test('.ent loading preserves original blocks, IDs, types, tables, and media', async (t) => {
  const { file, work } = fixture(t);
  const loaded = await load(t, file);
  assert.deepEqual(loaded.project, work);
  assert.equal(loaded.sourcePath, file);
  assert.equal(loaded.decompiledTo, undefined);
  assert.equal(loaded.sourceMap, undefined);
  for (const [url, bytes] of Object.entries(media)) {
    const asset = loaded.assets.find((item) => item.target === url);
    assert.ok(asset, url);
    assert.deepEqual(fs.readFileSync(asset.source), bytes);
  }
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(loaded.project as never); vm.start(); vm.tick();
  assert.deepEqual(vm.errors, []);
  assert.equal(vm.targetOf('other-original')!.entity.x, 37);
  assert.equal(vm.variables[0]!.value, true);
});

test('keeping Entropy source never makes it the execution input', async (t) => {
  const { file, dir, work } = fixture(t);
  const kept = path.join(dir, 'kept');
  const loaded = await load(t, file, { decompileTo: kept });
  assert.ok(fs.existsSync(path.join(kept, 'main.etp')));
  assert.equal(loaded.decompiledTo, kept);
  assert.deepEqual(loaded.project, work);
});

test('unknown blocks and runtime errors retain their original identifiers after .ent loading', async (t) => {
  const work = project();
  work.objects[0]!.script = JSON.stringify([[{ id: 'hat-original', type: 'when_run_button_click' },
    { id: 'unknown-original', type: 'unknown_future_block', params: [] },
    { id: 'write-original', type: 'set_variable', params: ['value-original', { id: 'bad-original', type: 'char_at', params: [null, 'abc', null, 9] }] },
  ]]);
  const { file } = fixture(t, work);
  const loaded = await load(t, file);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(loaded.project as never); vm.start(); vm.tick();
  assert.equal(vm.unknownBlocks.get('unknown_future_block'), 1);
  assert.equal(vm.errors.length, 1);
  assert.equal(vm.errors[0]!.blockId, 'bad-original');
  assert.equal(vm.errors[0]!.blockType, 'char_at');
  assert.ok(vm.errors[0]!.stack); assert.ok(vm.errors[0]!.snapshot);
});

test('bundled Entry images remain available when the archive omits them', async (t) => {
  const work = project();
  const picture = work.objects[0]!.sprite!.pictures[0]!;
  picture.fileurl = '/bower_components/entry-js/images/_1x1.png';
  const { file } = fixture(t, work, {});
  const loaded = await load(t, file);
  const asset = loaded.assets.find((item) => item.target === picture.fileurl);
  assert.ok(asset);
  assert.deepEqual(fs.readFileSync(asset.source).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.deepEqual(loaded.project, work);
});

test('missing archive assets can use explicit search folders without changing the project', async (t) => {
  const { file, dir, work } = fixture(t, project(), {});
  const extra = path.join(dir, 'fallback');
  fs.mkdirSync(path.join(extra, 'temp', 'image'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'temp', 'image', 'original.png'), PNG);
  const loaded = await load(t, file, { assetDirs: [extra], name: 'custom name' });
  assert.equal(loaded.name, 'custom name');
  assert.deepEqual(loaded.project, work);
  assert.deepEqual(fs.readFileSync(loaded.assets.find((item) => item.target === 'temp/image/original.png')!.source), PNG);
});

test('archive paths cannot escape the media folder and unrelated JSON is not a project', async (t) => {
  const { file, dir } = fixture(t, project(), { '../outside.png': PNG });
  await assert.rejects(loadProject(file), /폴더 밖/);
  assert.equal(fs.existsSync(path.join(dir, '..', 'outside.png')), false);
  fs.writeFileSync(file, makeTar([{ name: 'not-project.json', data: Buffer.from(JSON.stringify(project())) }]));
  await assert.rejects(loadProject(file), /project\.json.*찾지 못했습니다/);
});

test('raw .ent media URLs are served with their original bytes', async (t) => {
  const { file } = fixture(t);
  const loaded = await load(t, file);
  const server = await serveVm({ ...loaded, port: 0 });
  try {
    const response = await fetch(new URL('project.json', server.url));
    const served = await response.json() as any;
    assert.equal(served.objects[0].selectedPictureId, 'picture-original');
    for (const [url, expected] of [[served.objects[0].sprite.pictures[0].fileurl, SVG],
      [served.objects[0].sprite.pictures[0].pngurl, PNG], [served.objects[0].sprite.sounds[0].fileurl, media['temp/sound/original.wav']]] as const) {
      const fetched = await fetch(new URL(url, server.url));
      assert.equal(fetched.status, 200);
      assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), expected);
    }
  } finally { await server.close(); }
});

test('raw .ent block counts use the original object and scene IDs', async (t) => {
  const work = project();
  work.objects[0]!.script = JSON.stringify([[{ id: 'hat-original', type: 'when_run_button_click' },
    { id: 'write-original', type: 'set_variable', params: ['value-original',
      { id: 'count-original', type: 'get_block_count', params: ['scene-scene-original'] },
    ] },
  ]]);
  const { file } = fixture(t, work);
  const loaded = await load(t, file);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(loaded.project as never); vm.start();
  for (let i = 0; i < 5; i++) { vm.tick(); await Promise.resolve(); }
  assert.equal(vm.variables[0]!.value, 3);
  assert.deepEqual(vm.errors, []);
});
