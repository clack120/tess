import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@tess/parser';

test('declaration assignments parse as statements', () => {
  const source = `function f():
  var local = 0
  at = 1
  list items = []
  visible += 1
end`;
  assert.ok(parse(source, { validate: false }).ok);
});
