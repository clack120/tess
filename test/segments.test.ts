import test from 'node:test';
import assert from 'node:assert/strict';
import { isSegment, quadIndices, writeQuads } from '../packages/tessvm/src/render/segment-geometry.ts';
import type { Stroke } from '../packages/tessvm/src/runtime/model.ts';

const line = (points: number[], extra: Partial<Stroke> = {}): Stroke => ({
  color: '#000000', thickness: 1, opacity: 0, points, fill: false, ...extra,
});

test('점이 둘인 선 획만 사각형으로 편다', () => {
  assert.equal(isSegment(line([0, 0, 1, 1])), true);
  assert.equal(isSegment(line([0, 0, 1, 1, 2, 2])), false);
  assert.equal(isSegment(line([0, 0, 1, 1], { fill: true })), false);
  assert.equal(isSegment(line([0, 0])), false);
});

test('가로 선은 굵기의 절반만큼 위아래로 벌어진다', () => {
  const positions = new Float32Array(8);
  const count = writeQuads([line([0, 0, 10, 0], { thickness: 2 })], 0, 1, 2, positions);
  assert.equal(count, 1);
  // Flip y because stage coordinates grow upward and PIXI grows downward.
  assert.deepEqual([...positions], [0, 1, 10, 1, 10, -1, 0, -1]);
});

test('세로 선도 같은 규칙으로 벌어진다', () => {
  const positions = new Float32Array(8);
  writeQuads([line([0, 0, 0, 10], { thickness: 4 })], 0, 1, 4, positions);
  assert.deepEqual([...positions], [2, 0, 2, -10, -2, -10, -2, -0]);
});

test('길이가 없는 획은 아무 곳도 덮지 않는다', () => {
  const positions = new Float32Array(8);
  writeQuads([line([3, 3, 3, 3], { thickness: 2 })], 0, 1, 2, positions);
  // Zero-length segments collapse to one point and cover no area.
  assert.deepEqual([...positions], [3, -3, 3, -3, 3, -3, 3, -3]);
});

test('점이 모자란 획은 건너뛰고 세지 않는다', () => {
  const positions = new Float32Array(16);
  const count = writeQuads(
    [line([0, 0]), line([0, 0, 2, 0], { thickness: 2 })],
    0,
    2,
    2,
    positions,
  );
  assert.equal(count, 1);
  assert.deepEqual([...positions.slice(0, 8)], [0, 1, 2, 1, 2, -1, 0, -1]);
});

test('사각형마다 삼각형 두 개가 같은 차례로 나온다', () => {
  assert.deepEqual([...quadIndices(2)], [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
});
