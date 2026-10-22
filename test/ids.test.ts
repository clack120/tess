import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdFactory } from '../packages/compiler/src/ids.ts';
import { compileProject } from '@tess/compiler';
import { Vm } from '@tess/vm';

test('generated asset IDs never take precedence over numeric costume selection', () => {
  const next = createIdFactory(12345);
  const result = compileProject('object "o":\nend');
  assert.deepEqual(result.errors, []);
  const project = result.project!;
  project.objects[0]!.sprite!.pictures = Array.from({ length: 5000 }, (_, index) => ({
    id: next(), name: `picture_${index}`, filename: 'picture', fileurl: '', dimension: { width: 1, height: 1 },
  }));
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as never);
  const target = vm.targets[0]!;
  target.pictures.forEach((picture, index) => {
    assert.equal(target.getPicture(index + 1), picture, `costume ${index + 1} must resolve by position`);
  });
});

test('ID generation remains deterministic and unique and respects reserved IDs', () => {
  const first = createIdFactory(7);
  const second = createIdFactory(7);
  const reserved = first();
  second.reserve(reserved);
  assert.equal(second.has(reserved), true);
  assert.equal(second(), first());
  const ids = Array.from({ length: 10000 }, () => first());
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach(id => assert.match(id, /^[a-z][a-z0-9]{3}$/));
  const fixed = compileProject('object "o":\n  costume picture "picture.png" size 1 1 force id "1234"\nend');
  assert.deepEqual(fixed.errors, []);
  assert.equal(fixed.project!.objects[0]!.sprite!.pictures[0]!.id, '1234', 'explicit original IDs are preserved');
});
