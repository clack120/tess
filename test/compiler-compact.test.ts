import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, verifyEntryProject, ENTRY_PROJECT_JSON_LIMIT } from '@entropy/compiler';

test('large compiler output trims block defaults and keeps every list item and statement', () => {
  const value = 'x'.repeat(3400);
  const source = `list data_ = [${Array.from({ length: 4800 }, () => JSON.stringify(value)).join(',')}]
object "o":
  costume p "p.png" size 1 1
  when start do
${'    say 1\n'.repeat(2000)}  end
end`;
  const result = compileProject(source, { strict: true });
  assert.deepEqual(result.errors, []);
  assert.ok(result.project);
  const items = result.project.variables.find((v) => v.name === 'data_')!.array!;
  assert.equal(items.length, 4800);
  assert.ok(items.every((item) => item.data === value));
  const script = JSON.parse(result.project.objects[0]!.script);
  assert.equal(script[0].length, 2001);
  assert.ok(script[0][1].id);
  assert.equal(script[0][1].movable, undefined);
  assert.equal(script[0][1].type, 'dialog');
  assert.equal(script[0][1].params[0].params[0], '1');
  assert.deepEqual(verifyEntryProject(result.project), []);
  const bytes = new TextEncoder().encode(JSON.stringify(result.project)).byteLength;
  assert.equal(result.warnings.some((warning) => warning.code === 'W0008'), bytes > ENTRY_PROJECT_JSON_LIMIT);
});
