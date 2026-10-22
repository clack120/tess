import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@tess/compiler';
import { codeFrame } from '../packages/parser/src/parser/frame.ts';

const work = (body: string, declarations = '') => `${declarations}
scene "s":
  object "o":
    when start do
      ${body}
    end
  end
end`;

test('compile diagnostics show the failing source for errors, warnings and notices', () => {
  const result = compileProject(work('say scor\n      costume = "absent"', 'var score = 0'));
  const error = result.errors.find(item => item.message.includes("'scor'"))!;
  assert.match(error.detail!, /say scor\n\s*\|\s*\^{4}/);
  assert.match(error.message, /혹시 'score'/);
  assert.match(result.warnings[0]!.detail!, /object "o":/);
  assert.match(result.notices[0]!.detail!, /costume = "absent"/);
});

test('included diagnostics use the included source, including missing use targets', () => {
  const files: Record<string, string> = {
    'object.tess': 'when start do\n  say missing\nend',
  };
  const result = compileProject('scene "s":\n  useobject "object.tess"\nend', {
    path: 'main.tess',
    readFile: file => files[file.split('/').pop()!]!,
  });
  const error = result.errors.find(item => item.message.includes("'missing'"))!;
  assert.match(error.file!, /object\.tess$/);
  assert.match(error.detail!, /say missing/);
  assert.doesNotMatch(error.detail!, /useobject/);

  const missing = compileProject('use "absent.tess"', { path: 'main.tess' });
  assert.match(missing.errors[0]!.detail!, /use "absent\.tess"/);
});

test('code frames align tabs and Korean text and underline only the failing range', () => {
  const frame = codeFrame('\tvar 한글 = missing', 1, 11, '', 18);
  assert.match(frame, /\| \t {11}\^{7}$/m);
  assert.match(codeFrame('say x\r\nend', 1, 5, '', 200), /\| {5}\^$/m);
  assert.match(codeFrame('say x', 1, 6, ''), /\| {6}\^$/m);
});

test('user function arity diagnostics include expected and actual counts and a signature', () => {
  for (const [declaration, body] of [
    ['function f(a, b) do\n  return a + b\nend', 'say f(1)'],
    ['function f(a, b) do\n  say a + b\nend', 'f(1)'],
  ]) {
    const result = compileProject(work(body, declaration));
    const error = result.errors.find(item => item.message.includes('인자가'))!;
    assert.match(error.message, /2개여야.*1개를 받았습니다/);
    assert.match(error.message, /f\(a, b\)/);
    assert.match(error.detail!, /f\(1\)/);
  }
});

test('duplicate declarations identify the first declaration even in another source file', () => {
  const result = compileProject('var score = 0\nuse "shared.tess"', {
    path: 'main.tess', readFile: () => 'var score = 1',
  });
  const error = result.errors.find(item => item.code === 'E0001')!;
  assert.match(error.file!, /shared\.tess$/);
  assert.match(error.detail!, /var score = 1/);
  assert.equal(error.related!.length, 1);
  assert.match(error.related![0]!.file!, /main\.tess$/);
  assert.match(error.related![0]!.detail!, /var score = 0/);
  assert.match(error.help!, /대입/);
});

test('eager logic warns about guarded reads and calls without changing Entry evaluation', () => {
  for (const expression of ['n > 0 and text[n] == "a"', 'n < 1 or slice(text, n, n) == "a"', 'false and f()']) {
    const result = compileProject(work(`if ${expression}:\n        say 1\n      end`,
      'var n = 0\nvar text = "a"\nfunction f() do\n  return true\nend'));
    assert.deepEqual(result.errors, []);
    const warning = result.warnings.find(item => item.code === 'W0001')!;
    assert.match(warning.message, /오른쪽 식도 평가/);
    assert.match(warning.help!, /중첩|if\/else/);
    assert.match(warning.detail!, /\^/);
    assert.match(result.project!.objects[0]!.script, /boolean_and_or/);
  }
  const simple = compileProject(work('if n > 0 and n < 10:\n        say 1\n      end', 'var n = 1'));
  assert.ok(simple.warnings.every(item => item.code !== 'W0001'));
});
