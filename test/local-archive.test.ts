import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readTar } from '../packages/decompiler/src/tar.ts';
import { localArchiveProject } from '../packages/extension/src/page/local-archive.ts';
import { localArchiveWorker } from '../packages/extension/src/page/local-archive-worker.ts';
import { stub } from './stub.ts';

async function archive(project: unknown, assets: Map<string, Blob>): Promise<Buffer> {
  const chunks: ArrayBuffer[] = [];
  let resolve!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const names = [...assets.keys()];
  const scope = vm.createContext({ TextEncoder, Blob, ReadableStream, CompressionStream, Uint8Array,
    postMessage(data: any) {
      if (data.type === 'asset') queueMicrotask(() => scope.onmessage({ data: { type: 'asset', id: data.id, blob: assets.get(names[data.id]!) } }));
      else if (data.type === 'chunk') chunks.push(data.bytes);
      else if (data.type === 'done') resolve();
      else if (data.type === 'error') reject(new Error(data.message));
    } });
  vm.runInContext(`(${localArchiveWorker.toString()})()`, scope);
  scope.onmessage({ data: { type: 'start', project, names } }); await done;
  return Buffer.from(await new Blob(chunks).arrayBuffer());
}
function work() {
  return { id: 'work', name: '작품', thumb: null, scenes: [], variables: [], functions: [], messages: [],
    objects: [{ id: 'actor', script: '[[{"id":"block","type":"when_run_button_click","params":[]}]]',
      sprite: { pictures: [{ id: 'p', filename: 'aabbpicture', imageType: 'svg', dimension: { width: 10, height: 20 } }],
        sounds: [{ id: 's', filename: 'ccddsound', ext: '.wav', duration: 1 }] } }] };
}

test('local export produces a native gzip/TAR archive, preserves UTF-8 metadata and packages undecodable media bytes unchanged', async t => {
  stub(t, globalThis, 'location' as never, { origin: 'https://playentry.org', href: 'https://playentry.org/ws/work' });
  const original = work(), before = JSON.stringify(original);
  const { project, assets } = localArchiveProject(original);
  assert.equal(assets.length, 3);
  assert.ok(assets.every(asset => asset.url.startsWith('https://playentry.org/uploads/')));
  const bytes = new Uint8Array([0, 255, 8, 19]);
  const files = new Map(assets.map(asset => [asset.name, new Blob([bytes])]));
  const compressed = await archive(project, files);
  assert.equal(compressed[0], 0x1f); assert.equal(compressed[1], 0x8b);
  const entries = await readTar(compressed);
  const exported = JSON.parse(entries.find(entry => entry.name === 'temp/project.json')!.data.toString());
  assert.equal(exported.name, '작품');
  assert.equal(exported.objects[0].script, original.objects[0]!.script);
  for (const asset of assets) assert.deepEqual(entries.find(entry => entry.name === asset.name)!.data, Buffer.from(bytes));
  assert.ok(exported.objects[0].sprite.pictures[0].fileurl.startsWith('temp/aa/bb/image/'));
  assert.equal(exported.objects[0].sprite.sounds[0].fileurl, 'temp/cc/dd/sound/ccddsound.wav');
  assert.equal(JSON.stringify(original), before, 'saving must not rewrite the editor model');
});

test('local archives accept JSON larger than the server save limit without compacting script defaults', async () => {
  const project = { name: 'large', text: '한'.repeat(5_600_000), script: '[[{"readOnly":null,"params":[]}]]' };
  const entries = await readTar(await archive(project, new Map()));
  const json = entries[0]!.data;
  assert.ok(json.length > 16_730_000);
  const restored = JSON.parse(json.toString());
  assert.equal(restored.text, project.text); assert.equal(restored.script, project.script);
});

test('repeated media is packaged once and unsafe archive paths are rejected', t => {
  stub(t, globalThis, 'location' as never, { origin: 'https://playentry.org', href: 'https://playentry.org/ws/work' });
  const project = work(); project.objects.push(structuredClone(project.objects[0]!));
  assert.equal(localArchiveProject(project).assets.length, 3);
  project.objects[0]!.sprite.pictures[0]!.filename = '../../outside';
  assert.throws(() => localArchiveProject(project), /파일명/);
});

test('native empty zero-duration sound slots preserve metadata and do not block saving or request nonexistent files', async t => {
  stub(t, globalThis, 'location' as never, { origin: 'https://playentry.org', href: 'https://playentry.org/ws/work' });
  const original = work();
  const empty = { id: 'empty', name: 'empty slot', filename: '', ext: '.mp3', duration: 0 };
  original.objects[0]!.sprite.sounds.push(empty);
  const before = JSON.stringify(original);
  const { project, assets } = localArchiveProject(original);
  assert.equal(assets.length, 3);
  assert.ok(assets.every(asset => !asset.url.includes('/.mp3')));
  const entries = await readTar(await archive(project, new Map(assets.map(asset => [asset.name, new Blob(['original bytes'])]))));
  const restored = JSON.parse(entries.find(entry => entry.name === 'temp/project.json')!.data.toString());
  assert.deepEqual(restored.objects[0].sprite.sounds[1], empty);
  assert.equal(JSON.stringify(original), before);
});

test('a playable sound with missing source metadata reports the object and sound instead of silently omitting it', t => {
  stub(t, globalThis, 'location' as never, { origin: 'https://playentry.org', href: 'https://playentry.org/ws/work' });
  const original = work();
  original.objects[0]!.sprite.sounds[0]!.filename = '';
  assert.throws(() => localArchiveProject(original), /오브젝트 'actor'의 소리 's'.*파일명/);
});
