import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, ENTRY_PROJECT_JSON_LIMIT } from '@entropy/compiler';
import { codeFrame } from '../packages/parser/src/parser/frame.ts';

const work = (body: string, declarations = '') => `${declarations}
scene "s":
  object "o":
    when start do
      ${body}
    end
  end
end`;

test('empty native value functions explain repeated evaluation and a concrete fix', () => {
  const empty = compileProject('function f(n):\n return n\nend');
  const warning = empty.warnings.find(item => item.code === 'W0009')!;
  assert.match(warning.detail!, /return n/);
  assert.match(warning.help!, /3번.*return 앞에 stop/);
  const explicit = compileProject('function f(n):\n stop\n return n\nend');
  assert.deepEqual(explicit.errors, []);
  assert.ok(explicit.warnings.every(item => item.code !== 'W0009'));
});

test('logic diagnostics explain Entry zero-string truthiness without changing evaluation', () => {
  for (const zero of ['0', '"0"', '"00"']) {
    const result = compileProject(work(`say ${zero} and true`));
    const warning = result.warnings.find(item => item.code === 'W0010')!;
    assert.match(warning.message, /참.*if\/not.*거짓/);
    assert.match(warning.help!, /not \(not/);
  }
  const explicit = compileProject(work('say not (not (0)) and true'));
  assert.ok(explicit.warnings.every(item => item.code !== 'W0010'));
});

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
    'object.etp': 'when start do\n  say missing\nend',
  };
  const result = compileProject('scene "s":\n  useobject "object.etp"\nend', {
    path: 'main.etp',
    readFile: file => files[file.split('/').pop()!]!,
  });
  const error = result.errors.find(item => item.message.includes("'missing'"))!;
  assert.match(error.file!, /object\.etp$/);
  assert.match(error.detail!, /say missing/);
  assert.doesNotMatch(error.detail!, /useobject/);

  const missing = compileProject('use "absent.etp"', { path: 'main.etp' });
  assert.match(missing.errors[0]!.detail!, /use "absent\.etp"/);
});

test('code frames align tabs and Korean text and underline only the failing range', () => {
  const frame = codeFrame('\tvar 한글 = missing', 1, 11, '', 18);
  assert.match(frame, /\| \t {11}\^{7}$/m);
  assert.match(codeFrame('say x\r\nend', 1, 5, '', 200), /\| {5}\^$/m);
  assert.match(codeFrame('say x', 1, 6, ''), /\| {6}\^$/m);
});

test('code frames keep a distant error visible without printing an entire packed data line', () => {
  const source = 'x'.repeat(100_000) + ' missing ' + 'y'.repeat(100_000);
  const frame = codeFrame(source, 1, 100_002, '', 100_009);
  assert.match(frame, /… .*missing.* …/);
  assert.match(frame, /\^{7}/);
  assert.ok(frame.length < 500);
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
    assert.equal(error.code, 'E0006');
    assert.match(error.related![0]!.detail!, /function f\(a, b\)/);
  }
});

test('name diagnostics retain state suggestions and distinguish missing calls from variables', () => {
  const typo = compileProject(work('say timre')).errors.find(error => error.code === 'E0004')!;
  assert.match(typo.message, /혹시 'timer'/);
  for (const name of ['abs', 'f']) {
    const bare = compileProject(work(`say ${name}`, 'function f() do\n  return 1\nend'));
    assert.match(bare.errors.find(error => error.code === 'E0004')!.help!, /함수.*괄호/);
  }
  for (const expression of ['say score()', 'score()']) {
    const call = compileProject(work(expression, 'var score = 0'));
    assert.match(call.errors.find(error => error.code === 'E0005')!.help!, /변수.*괄호를 빼/);
  }
  const unknown = compileProject(work('helpr()', 'function helper() do\n  say 1\nend'));
  assert.match(unknown.errors.find(error => error.code === 'E0005')!.message, /혹시 'helper'/);
  const readOnly = compileProject(work('timer = 3'));
  assert.match(readOnly.errors.find(error => error.code === 'E0007')!.help!, /읽기 전용/);
});

test('out-of-scope and used-before-declaration errors link local declarations in their own file', () => {
  for (const body of [
    'if true:\n    var hidden = 1\n  end\n  return hidden',
    'hidden = 2\n  var hidden = 1\n  return hidden',
    'for hidden from 1 to 2:\n    say hidden\n  end\n  return hidden',
  ]) {
    const result = compileProject('use "functions.etp"', {
      path: 'main.etp', readFile: () => `function f() do\n  ${body}\nend`,
    });
    const error = result.errors.find(error => error.code === 'E0004')!;
    assert.match(error.help!, /블록/);
    assert.equal(error.related!.length, 1);
    assert.match(error.related![0]!.file!, /functions\.etp$/);
    assert.match(error.related![0]!.detail!, /var hidden = 1|for hidden from 1/);
    assert.ok(result.warnings.every(warning => warning.offset !== error.offset), 'one diagnostic per unresolved name');
  }
});

test('arity notes point to an included declaration for statement and value calls', () => {
  for (const statement of ['say f()', 'f()']) {
    const result = compileProject(`use "functions.etp"\n${work(statement)}`, {
      path: 'main.etp', readFile: () => 'function f(n) do\n  say n\nend',
    });
    const error = result.errors.find(error => error.code === 'E0006')!;
    assert.match(error.file!, /main\.etp$/);
    assert.match(error.related![0]!.file!, /functions\.etp$/);
    assert.match(error.related![0]!.detail!, /function f\(n\)/);
  }
});

test('duplicate declarations identify the first declaration even in another source file', () => {
  const result = compileProject('var score = 0\nuse "shared.etp"', {
    path: 'main.etp', readFile: () => 'var score = 1',
  });
  const error = result.errors.find(item => item.code === 'E0001')!;
  assert.match(error.file!, /shared\.etp$/);
  assert.match(error.detail!, /var score = 1/);
  assert.equal(error.related!.length, 1);
  assert.match(error.related![0]!.file!, /main\.etp$/);
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

test('literal string bounds warnings show valid positions without replacing native reads', () => {
  for (const expression of ['"abc"[0]', '"abc"[-1]', '"abc"[4]', '""[1]', '"🙂"[3]',
    'slice("abc", 0, 2)', 'slice("abc", 1, 4)']) {
    const result = compileProject(work(`say ${expression}`));
    assert.deepEqual(result.errors, [], expression);
    const warning = result.warnings.find(item => item.code === 'W0003')!;
    assert.match(warning.message, /작품 전체가 멈춥니다/, expression);
    assert.match(warning.help!, /1부터|빈 문자열/);
    assert.match(warning.related![0]!.message, /글자 수/);
    assert.match(warning.related![0]!.detail!, /say /);
    assert.match(result.project!.objects[0]!.script, /char_at|substring/);
  }
  for (const expression of ['"abc"[1]', '"abc"[3]', '"abc"[1.5]', '"🙂"[2]', 'slice("abc", 3, 1)']) {
    const result = compileProject(work(`say ${expression}`));
    assert.ok(result.warnings.every(item => item.code !== 'W0003'), expression);
  }
  const shadow = compileProject(work('say slice("abc", 0, 99)',
    'function slice(text, start, finish) do\n  return text\nend'));
  assert.ok(shadow.warnings.every(item => item.code !== 'W0003'), 'user function semantics are unknown');
});

test('recursive call cycles warn about EntryJS stack risk with linked call sites', () => {
  const direct = compileProject(`function walk(n) do
  if n > 0:
    walk(n - 1)
  end
end
${work('walk(2000)')}`);
  const warning = direct.warnings.find(item => item.code === 'W0004')!;
  assert.match(warning.message, /재귀 호출.*작품 전체가 멈출/);
  assert.match(warning.help!, /JavaScript.*브라우저.*기기.*함수 구조/);
  assert.match(warning.detail!, /walk\(n - 1\)/);

  const mutual = compileProject(`function left(n) do
  right(n)
end
function right(n) do
  left(n)
end
${work('left(1)')}`);
  const cycle = mutual.warnings.filter(item => item.code === 'W0004');
  assert.equal(cycle.length, 1);
  assert.match(cycle[0]!.message, /left|right/);
  assert.ok((cycle[0]!.related?.length ?? 0) >= 1);

  const plain = compileProject(`function leaf(n) do
  say n
end
${work('leaf(1)')}`);
  assert.ok(plain.warnings.every(item => item.code !== 'W0004'));
});

test('recursion analysis handles and summarizes a long function cycle without overflowing itself', () => {
  const count = 4_000;
  const functions = Array.from({ length: count }, (_, index) => `function f${index}():\n  ${
    index + 1 < count ? `f${index + 1}()` : 'f0()'
  }\nend`).join('\n');
  const result = compileProject(`${functions}\n${work('f0()')}`);
  assert.equal(result.project?.functions.length, count);
  const warning = result.warnings.find(item => item.code === 'W0004')!;
  assert.match(warning.message, /외 3,?994개/);
  assert.ok(warning.message.length < 500, '순환 전체를 메시지에 펼치지 않는다');
});

test('Entry runtime limits and first-scene behavior have targeted diagnostics', () => {
  assert.equal(ENTRY_PROJECT_JSON_LIMIT, 16_737_823, 'use one byte below the measured save boundary');
  const firstScene = compileProject(`scene "first":
  object "o":
    when scene start do
      say 1
    end
  end
  object "p":
    when scene start do
      say 2
    end
  end
end`);
  const sceneWarnings = firstScene.warnings.filter(item => item.code === 'W0005');
  assert.equal(sceneWarnings.length, 1);
  const sceneWarning = sceneWarnings[0]!;
  assert.match(sceneWarning.message, /처음 시작할 때 실행되지/);
  assert.match(sceneWarning.message, /2개/);
  assert.match(sceneWarning.help!, /when start do/);
  assert.equal(sceneWarning.related?.length, 1);

  const values = Array.from({ length: 5001 }, (_, index) => index).join(', ');
  const list = compileProject(`list too_many = [${values}]`);
  const limit = list.errors.find(item => item.code === 'E0008')!;
  assert.match(limit.message, /5,001.*5,000/);
  assert.match(limit.help!, /여러 리스트/);
  assert.ok(list.project, 'loose mode still returns a project');
  assert.ok(list.project!.variables.every(variable => variable.name !== 'too_many'), 'the oversized list is not emitted');

  const manyVariables = compileProject(Array.from({ length: 500 }, (_, index) => `var v${index} = ${index}`).join('\n'));
  const lookup = manyVariables.notices.find(item => item.code === 'N0002')!;
  const emittedVariables = manyVariables.project!.variables.filter(variable => variable.variableType !== 'list').length;
  assert.match(lookup.message, new RegExp(`변수 ${emittedVariables}개.*선형 검색`));
  assert.match(lookup.help!, /실제 작품을 프로파일.*무작정 정렬/);
});
