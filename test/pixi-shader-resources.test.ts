import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';

const require = createRequire(new URL('../packages/vm/package.json', import.meta.url));
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

test('shader precision detection accepts null results in every shipped Pixi entry', () => {
  const root = path.resolve(path.dirname(require.resolve('pixi.js')), '..');
  for (const file of [
    'lib/rendering/renderers/gl/shader/program/getMaxFragmentPrecision.js',
    'lib/rendering/renderers/gl/shader/program/getMaxFragmentPrecision.mjs',
    'dist/pixi.mjs',
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const start = source.indexOf('let maxFragmentPrecision;');
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, file);
    for (const [format, expected] of [[null, 'mediump'], [{ precision: 0 }, 'mediump'], [{ precision: 23 }, 'highp']] as const) {
      let queries = 0;
      const gl = {
        FRAGMENT_SHADER: 35632, HIGH_FLOAT: 36338,
        getShaderPrecisionFormat(shader: number, precision: number) {
          assert.equal(shader, this.FRAGMENT_SHADER);
          assert.equal(precision, this.HIGH_FLOAT);
          queries++;
          return format;
        },
      };
      const getTestContext = Object.assign(() => gl, { getTestContext: () => gl });
      const context = vm.createContext({ getTestContext });
      vm.runInContext(`${source.slice(start, end)}\nthis.detect = getMaxFragmentPrecision;`, context);
      assert.equal(context.detect(), expected, `${file}: ${JSON.stringify(format)}`);
      assert.equal(context.detect(), expected);
      assert.equal(queries, 1, 'precision detection stays cached');
    }
  }
});
