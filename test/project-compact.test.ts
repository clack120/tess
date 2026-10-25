import test from 'node:test';
import assert from 'node:assert/strict';
import { compactLargeProject, PROJECT_JSON_LIMIT, type CompactionCache } from '../packages/extension/src/page/project-compact.ts';
import { stub } from './stub.ts';

const defaults = { movable: null, deletable: 1, emphasized: false, readOnly: null,
  copyable: true, assemble: true, extensions: [], params: [], statements: [], x: 0, y: 0 };

test('small exports keep their identity and data, including explicit defaults', () => {
  const work = { objects: [{ script: JSON.stringify([[{ id: 'hat', type: 'when_run_button_click', ...defaults }]]) }] };
  const size = new TextEncoder().encode(JSON.stringify(work)).byteLength;
  assert.strictEqual(compactLargeProject(work, size).project, work);
  assert.equal(PROJECT_JSON_LIMIT, 16_700_000);
});

test('large exports remove only known defaults from scripts, functions and PNG metadata', () => {
  const code = [[{ id: 'head', type: 'when_run_button_click', ...defaults, x: 25, y: 40 },
    { id: 'body', type: 'dialog', ...defaults, params: [
      { id: 'value', type: 'number', ...defaults, params: ['0'] },
      { type: 'literal-data', copyable: true, extensions: [] },
    ], copyable: false, assemble: false, deletable: 0, emphasized: true, readOnly: true, custom: { keep: true } }]];
  const work = { objects: [{ id: 'object', script: JSON.stringify(code), sprite: { pictures: [
    { id: 'png', imageType: 'png', filename: 'hash', dimension: { width: 32, height: 32 } },
    { id: 'svg', imageType: 'svg', filename: 'vector' },
  ] } }], functions: [{ id: 'function', localVariables: [{ id: 'local', value: '' }], content: JSON.stringify(code) }],
    variables: [{ id: 'list', array: [{ data: '001' }, { data: '한글' }] }], custom: { version: 123 } };
  const before = JSON.stringify(work);
  const result = compactLargeProject(work, 1);
  assert.equal(JSON.stringify(work), before, 'the live editor model must remain unchanged');
  assert(result.afterBytes < result.beforeBytes);
  const stripped = JSON.parse(result.project.objects[0]!.script);
  assert.deepEqual(stripped[0][0], { id: 'head', type: 'when_run_button_click', x: 25, y: 40 });
  assert.deepEqual(stripped[0][1], { id: 'body', type: 'dialog', deletable: 0, emphasized: true,
    readOnly: true, copyable: false, assemble: false, params: [
      { id: 'value', type: 'number', params: ['0'] }, { type: 'literal-data', copyable: true, extensions: [] },
    ], custom: { keep: true } });
  assert.equal(result.project.functions[0]!.content, result.project.objects[0]!.script);
  assert.deepEqual(result.project.functions[0]!.localVariables, work.functions[0]!.localVariables);
  assert.deepEqual(result.project.variables, work.variables);
  assert.deepEqual(result.project.custom, work.custom);
  assert.deepEqual(result.project.objects[0]!.sprite.pictures, [
    { id: 'png', filename: 'hash', dimension: { width: 32, height: 32 } }, { id: 'svg', imageType: 'svg', filename: 'vector' },
  ]);
  assert.deepEqual(compactLargeProject(result.project, 1).project, result.project);
});

test('size threshold counts UTF-8 bytes, and oversize payloads never lose actual data', () => {
  const work = { objects: [{ script: JSON.stringify([[{ id: 'hat', type: 'when_run_button_click', ...defaults }]]) }],
    variables: [{ value: '한글😀'.repeat(50) }] };
  const text = JSON.stringify(work), bytes = new TextEncoder().encode(text).byteLength;
  const limit = Math.floor((text.length + bytes) / 2);
  assert(text.length < limit && bytes > limit);
  const result = compactLargeProject(work, limit);
  assert.notStrictEqual(result.project, work);
  assert.equal(result.beforeBytes, bytes);
  assert.deepEqual(result.project.variables, work.variables);
  const tooBig = compactLargeProject(work, 1);
  assert(tooBig.afterBytes > 1, 'compaction does not bypass the actual server limit');
  assert.deepEqual(tooBig.project.variables, work.variables);
});

test('malformed scripts, unfamiliar metadata and array-form code survive compaction', () => {
  const work = { objects: [{ script: 'not JSON' }, { script: [[{ id: 'hat', type: 'when_run_button_click', ...defaults }]] }],
    functions: [{ content: '{broken' }], sprite: { imageType: 'png', copyable: true } };
  const result = compactLargeProject(work, 1).project;
  assert.equal(result.objects[0]!.script, 'not JSON');
  assert.deepEqual(result.objects[1]!.script, [[{ id: 'hat', type: 'when_run_button_click', x: 0, y: 0 }]]);
  assert.equal(result.functions[0]!.content, '{broken');
  assert.deepEqual(result.sprite, work.sprite);
});

test('repeated autosaves compact only changed code and release code removed from the current export', t => {
  const first = JSON.stringify([[{ id: 'first', type: 'when_run_button_click', ...defaults }]]);
  const second = JSON.stringify([[{ id: 'second', type: 'when_run_button_click', ...defaults }]]);
  const work = { objects: [{ script: first }, { script: second }], functions: [{ content: second }] };
  const cache: CompactionCache = new Map();
  const parse = JSON.parse;
  let parses = 0;
  stub(t, JSON, 'parse', (text: string) => { parses++; return parse(text); });
  const result = compactLargeProject(work, 1, cache);
  assert.equal(parses, 2, 'identical function/object code is compacted once');
  assert.deepEqual(compactLargeProject(structuredClone(work), 1, cache).project, result.project);
  assert.equal(parses, 2, 'the next autosave reuses all unchanged code');
  work.objects[0]!.script = first.replace('first', 'edited');
  compactLargeProject(work, 1, cache);
  assert.equal(parses, 3);
  assert.equal(cache.has(first), false);
  assert.equal(cache.has(second), true);
});

test('incremental byte counts match JSON for escaped code, Unicode, PNG-only records and omitted fields', () => {
  const cache: CompactionCache = new Map();
  for (let i = 0; i < 40; i++) {
    const code = JSON.stringify([[{ id: 'hat', type: 'when_run_button_click', ...defaults,
      params: ['한글😀"\\\n\ud800'.repeat(i)] }]]);
    const work = { objects: [{ script: code, sprite: { pictures: [
      { imageType: 'png' }, { imageType: 'png', omitted: undefined },
      { id: 'picture', imageType: 'png', name: '한글😀' },
      { imageType: 'svg', filename: 'keep' },
    ] } }], functions: [{ content: code }], variables: [{ value: '글'.repeat(i) }], custom: { value: i } };
    const result = compactLargeProject(work, 1, cache);
    assert.equal(result.beforeBytes, new TextEncoder().encode(JSON.stringify(work)).byteLength);
    assert.equal(result.afterBytes, new TextEncoder().encode(JSON.stringify(result.project)).byteLength);
    assert.equal(work.objects[0]!.sprite.pictures[0]!.imageType, 'png');
  }
});
