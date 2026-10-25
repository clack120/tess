import test from 'node:test';
import assert from 'node:assert/strict';
import { exportNativeProject } from '../packages/extension/src/page/native-project.ts';
import type { EntryWork } from '../packages/extension/src/page/entry-project.ts';

function editor() {
  let syncs = 0;
  const container = { objects_: [{ id: 'a', name: 'one' }, { id: 'b', name: 'two' }],
    toJSON() { return this.objects_.map(object => ({ ...object, extensionField: true })); } };
  const variableContainer = { functions_: { first: { content: '[]' }, second: { content: '[[]]' } },
    getFunctionJSON(): unknown[] { return Object.entries(this.functions_).map(([id, fn]) => ({ id, ...fn, nativeDefault: 1 })); } };
  const entry = { container, variableContainer, getMainWS: () => ({ syncCode() { syncs++; } }),
    exportProject() { return { objects: this.container.toJSON(), functions: this.variableContainer.getFunctionJSON(),
      scenes: [{ id: 'scene' }], extra: { preserved: true } } as unknown as EntryWork; } };
  return { entry, syncs: () => syncs };
}

test('cooperative export preserves native serializers and extra project fields', async () => {
  const { entry, syncs } = editor();
  const expected = entry.exportProject();
  const objects = entry.container.toJSON, functions = entry.variableContainer.getFunctionJSON;
  const progress: number[][] = [];
  const result = await exportNativeProject(entry, entry.exportProject, new AbortController().signal,
    (done, total) => progress.push([done, total]));
  assert.deepEqual(result, expected);
  assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.equal(entry.container.toJSON, objects);
  assert.equal(entry.variableContainer.getFunctionJSON, functions);
  assert.equal(syncs(), 1);
});

test('cancelled export never calls the final native export or replaces its methods', async () => {
  const { entry } = editor();
  const objects = entry.container.toJSON, functions = entry.variableContainer.getFunctionJSON;
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(exportNativeProject(entry, () => { calls++; return false; }, controller.signal,
    () => controller.abort()), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(entry.container.toJSON, objects);
  assert.equal(entry.variableContainer.getFunctionJSON, functions);
});

test('native export exceptions and rejected method replacements restore both serializers', async () => {
  for (const readonly of [false, true]) {
    const { entry } = editor();
    const objects = entry.container.toJSON, functions = entry.variableContainer.getFunctionJSON;
    if (readonly) Object.defineProperty(entry.variableContainer, 'getFunctionJSON', { writable: false });
    await assert.rejects(exportNativeProject(entry, () => { throw new Error('native failed'); }, new AbortController().signal));
    assert.equal(entry.container.toJSON, objects);
    assert.equal(entry.variableContainer.getFunctionJSON, functions);
    assert.deepEqual(entry.exportProject().objects, objects.call(entry.container));
  }
});
