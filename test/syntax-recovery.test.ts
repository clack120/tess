import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@entropy/parser';
import { compileProject } from '@entropy/compiler';

test('independent syntax errors are reported together without compiling a partial AST', () => {
  const source = 'object "o":\n  when start do\n    say (1 + )\n    say (2 + )\n  end\nend';
  const result = parse(source);
  assert.equal(result.ok, false);
  assert.equal(result.ast, null);
  assert.deepEqual(result.errors.map(error => error.line), [3, 4]);
  for (const error of result.errors) assert.match(error.detail!, /\^/);
  const compiled = compileProject(source);
  assert.equal(compiled.project, null);
  assert.equal(compiled.errors.length, 2);
  assert.equal(parse('var good = 1').ok, true, 'recovery state must reset between calls');
});

test('independent unreadable characters are all reported at their own locations', () => {
  const result = parse('var a = 1;\nvar b = 2;');
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(error => error.line), [1, 2]);
  assert.ok(result.errors.every(error => error.message.includes('읽을 수 없는 글자')));
});
