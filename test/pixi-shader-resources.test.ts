import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(new URL('../packages/tessvm/package.json', import.meta.url));
const { setProgramName, createIdFromString } = await import(require.resolve('pixi.js'));
const browser = await import(path.resolve(path.dirname(require.resolve('pixi.js')), '../dist/pixi.mjs'));

test('identical shaders keep the same source key across repeated renderer creation', () => {
  const keys = new Set();
  for (let i = 0; i < 1000; i++) {
    const vertex = setProgramName('void main() {}', { name: 'graphics' }, false);
    const fragment = setProgramName('void main() {}', { name: 'graphics' }, true);
    keys.add(createIdFromString(`${vertex}:${fragment}`, 'gl-program'));
  }
  assert.equal(keys.size, 1, 'renderer counters must not retain another full shader string for every restart');
  const browserKeys = new Set(Array.from({ length: 1000 }, () => browser.setProgramName('void main() {}', { name: 'graphics' }, false)));
  assert.equal(browserKeys.size, 1, 'the shipped browser bundle must use the same fix');
  const first = setProgramName('void main() { first(); }', { name: 'graphics' }, false);
  const second = setProgramName('void main() { second(); }', { name: 'graphics' }, false);
  assert.notEqual(createIdFromString(first, 'gl-program'), createIdFromString(second, 'gl-program'));
  assert.equal(setProgramName('#define SHADER_NAME custom\nvoid main() {}', { name: 'graphics' }),
    '#define SHADER_NAME custom\nvoid main() {}');
});
