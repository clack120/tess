import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProject } from '@tess/compiler';
import type { EntryProject } from '@tess/compiler';
import {
  MAX_TEXTURE_SIDE,
  MIN_SVG_SIDE,
  SVG_PIXEL_BUDGET,
  svgBudgetScale,
  svgSharpness,
  textSharpness,
} from '../packages/tessvm/src/render/sharpness.ts';
import { sizedVector } from '../packages/tessvm/src/render/renderer.ts';
import { fillParts, nonzeroParts } from '../packages/tessvm/src/render/fill.ts';
import {
  CollisionSystem,
  MaskStore,
  Table,
  Vm,
  cast,
  entityBounds,
  maskFromPixels,
  parseFont,
  setStageSize,
  stage,
} from '@tess/vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('stop and restart restore table cells, field names and shape', () => {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load({ scenes: [{ id: 's', name: 's' }], objects: [], variables: [], functions: [], messages: [],
    tables: [{ id: 't', name: 't', fields: ['field'], origin: [[1]], data: [[99]] }],
  } as unknown as never);
  vm.start();
  const table = vm.tables[0]!;
  table.replaceValue(1, 1, 9);
  table.replaceValue(0, 1, 'changed');
  table.appendRow();
  table.appendCol();
  const revision = table.revision;
  vm.pause();
  vm.start();
  assert.equal(table.getValue(1, 1), 9, 'resuming a pause preserves table edits');
  vm.stop();
  assert.deepEqual(table.fields, ['field']);
  assert.deepEqual(table.rows, [[1]]);
  assert.ok(table.revision > revision);
  vm.start();
  table.replaceValue(1, 1, 7);
  vm.reset();
  assert.deepEqual(table.rows, [[1]], 'restored rows do not alias the snapshot');
});

test('clones inherit pen settings with an independent new drawing path', () => {
  const vm = runVm(wrap('draw_color = #0000ff\ndraw_width = 7\ndraw_alpha = 30\nstart draw\nforward 5\nclone'));
  vm.tick();
  const target = vm.targets[0]!;
  const parent = target.entity;
  const clone = target.clones[0]!;
  assert.ok(parent.brush && clone.brush);
  assert.notEqual(clone.brush, parent.brush);
  assert.equal(clone.brush.color, '#0000ff');
  assert.equal(clone.brush.thickness, 7);
  assert.equal(clone.brush.opacity, parent.brush.opacity);
  assert.equal(clone.brush.stop, false);
  assert.ok(clone.brush.started > parent.brush.started);
  assert.deepEqual(clone.brush.strokes, []);
  assert.deepEqual(clone.brush.path, [clone.x, clone.y]);
  clone.brush.color = '#ff0000';
  clone.brush.path.push(99, 99);
  assert.equal(parent.brush.color, '#0000ff');
  assert.notDeepEqual(clone.brush.path, parent.brush.path);
  parent.brush.stop = true;
  const stopped = target.addClone(parent);
  assert.equal(stopped.brush!.stop, true);
});

function runVm(source: string): Vm {
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(result.project as unknown as never);
  vm.start();
  return vm;
}

test('directional movement evaluates its angle before its distance, including yielded calls', () => {
  for (const wait of ['', 'wait 0']) for (const kernel of [false, true]) {
    const compiled = compileProject(`var order = ""
var amount = 2
function heading() do
  order = order + "A"
  amount = 10
  ${wait}
  return 90
end
function distance() do
  order = order + "D"
  return amount
end
object "actor":
  when start do
    forward distance() at heading()
    forward distance() at heading()
  end
end`);
    assert.deepEqual(compiled.errors, []);
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(compiled.project as never); vm.start();
    for (let frame = 0; frame < 10; frame++) vm.tick();
    assert.deepEqual(vm.errors, []);
    assert.equal(vm.variables.find((item) => item.name === 'order')!.value, 'ADAD');
    assert.equal(vm.targets[0]!.entity.x, 20);
    assert.equal(vm.targets[0]!.entity.y, 0);
  }
});

test('failed directional movement inputs preserve Entry evaluation order and error context', () => {
  for (const failure of ['angle', 'distance', 'conversion']) for (const kernel of [false, true]) {
    const compiled = compileProject(`var order = ""
var after = 0
var raw = 0
function heading() do
  order = order + "A"
  return ${failure === 'angle' ? '"ABC"[4]' : failure === 'conversion' ? 'raw' : 90}
end
function distance() do
  order = order + "D"
  return ${failure === 'distance' ? '"ABC"[4]' : 10}
end
object "actor":
  when start do
    forward distance() at heading()
    after = 1
  end
end`);
    assert.deepEqual(compiled.errors, []);
    const vm = new Vm({ renderer: null, audio: null, kernel });
    vm.load(compiled.project as never);
    vm.onError = () => vm.stop(); vm.start();
    if (failure === 'conversion') vm.variables.find((item) => item.name === 'raw')!
      .setValue({ valueOf: null, toString: null } as never);
    vm.tick();
    assert.equal(vm.errors.length, 1);
    assert.equal(vm.errors[0]!.blockType, failure === 'conversion' ? 'move_to_angle' : 'char_at');
    if (failure !== 'conversion') assert.deepEqual(vm.errors[0]!.inputs!.index, { type: 'number', value: 4 });
    assert.ok(vm.errors[0]!.stack); assert.ok(vm.errors[0]!.snapshot);
    assert.equal(vm.variables.find((item) => item.name === 'order')!.value, failure === 'angle' ? 'A' : 'AD');
    assert.equal(vm.variables.find((item) => item.name === 'after')!.value, 0);
    assert.equal(vm.targets[0]!.entity.x, 0);
    assert.equal(vm.targets[0]!.entity.y, 0);
  }
});

test('text append and size changes read current state after evaluating their input', () => {
  for (const wait of ['', 'wait 0']) for (const kernel of [false, true]) {
    for (const [body, change, result] of [
      ['append input()', 'text_content = "changed"', 'changedX'],
      ['prepend input()', 'text_content = "changed"', 'Xchanged'],
      ['size += input()', 'size = 200', 205],
    ] as const) {
      const size = typeof result === 'number';
      const compiled = compileProject(`var calls = 0
function input() do
  calls += 1
  ${change}
  ${wait}
  return ${size ? 5 : '"X"'}
end
text "label":
  text_content = "old"
  size = 100
  when start do
    ${body}
  end
end`);
      assert.deepEqual(compiled.errors, []);
      const vm = new Vm({ renderer: null, audio: null, kernel });
      vm.load(compiled.project as never); vm.start();
      for (let frame = 0; frame < 5; frame++) vm.tick();
      assert.deepEqual(vm.errors, []);
      const entity = vm.targets[0]!.entity;
      assert.equal(size ? entity.getSize() : entity.getText(), result, `${body}, ${wait}, kernel=${kernel}`);
      assert.equal(vm.variables.find((item) => item.name === 'calls')!.value, '1');
    }
  }
});

test('out-of-range char_at and substring stop the script as entry does', () => {
  for (const [body, message] of [
    ['a = s[4]', '글자 위치 4 이(가) 범위를 벗어났습니다 (글자 수 3)'],
    ['a = s[0]', '글자 위치 0 이(가) 범위를 벗어났습니다 (글자 수 3)'],
    ['a = slice(s, 0, 2)', '글자 범위 0~2 이(가) 범위를 벗어났습니다 (글자 수 3)'],
    ['a = slice(s, 2, 4)', '글자 범위 2~4 이(가) 범위를 벗어났습니다 (글자 수 3)'],
  ]) {
    const vm = runVm(`var s = "ABC"
var a = 0
var after = 0
object "o":
  when start do
    ${body}
    after = 1
  end
end`);
    vm.tick();
    assert.deepEqual(vm.errors.map((error) => error.message), [message], body);
    assert.equal(valueOf(vm, 'after'), 0, `${body}: the blocks after it do not run`);
  }
  const vm = runVm(`var s = "ABC"
var a = 0
var b = 0
object "o":
  when start do
    a = s[3]
    b = slice(s, 3, 1)
  end
end`);
  vm.tick();
  assert.deepEqual(vm.errors, []);
  assert.deepEqual([vm.variables.find((v) => v.name === 'a')!.getValue(), vm.variables.find((v) => v.name === 'b')!.getValue()], ['C', 'ABC']);
});

test('a runtime error says which scene, object and function calls it happened in', () => {
  const source = `var s = "ABC"
var a = 0
function pick(i):
  return s[i]
end
function outer(i):
  return pick((i + 3))
end
scene "메인":
  object "쉘":
    when start do
      clone
      a = s[9]
    end
    when cloned do
      a = outer(2)
    end
  end
end`;
  for (const kernel of [false, true]) {
    const result = compileProject(source, { path: 'test.tess' });
    const vm = new Vm({ renderer: null, audio: null, kernel } as never);
    vm.load(result.project as unknown as never);
    vm.start();
    vm.tick();
    vm.tick();
    assert.deepEqual(vm.errors.map((error) => error.where), [
      "장면 '메인' · 오브젝트 '쉘'",
      "장면 '메인' · 오브젝트 '쉘' (복제본) · 함수 outer i ( ) → pick i ( )",
    ]);
  }
});

test('blocks saved without params, as playentry sends them, still compile and run', () => {
  const result = compileProject(`var out = 0
function seven():
  return 7
end
object "o":
  when start do
    out = seven()
  end
end`, { path: 'test.tess' });
  const project = result.project as any;
  const strip = (node: any): void => {
    if (Array.isArray(node)) node.forEach(strip);
    else if (node && typeof node === 'object') {
      if (typeof node.type === 'string' && node.type.startsWith('func_') && Array.isArray(node.params) && !node.params.length) delete node.params;
      Object.values(node).forEach(strip);
    }
  };
  for (const object of project.objects) {
    const script = JSON.parse(object.script);
    strip(script);
    object.script = JSON.stringify(script);
  }
  assert.match(project.objects[0].script, /"type":"func_[^"]+"(?!,"params")/);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as never);
  vm.start();
  vm.tick();
  assert.equal(valueOf(vm, 'out'), 7);
});

test('function labels inherited from Object.prototype execute their own bodies', () => {
  for (const name of ['ordinary', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const vm = runVm(`var out = 0
function ${name}():
  return 7
end
object "o":
  when start do
    out = ${name}()
  end
end`);
    vm.tick();
    assert.equal(valueOf(vm, 'out'), 7, name);
    assert.deepEqual(vm.errors, []);
  }
});

// Convert stored numeric text for value-only comparisons.
function valueOf(vm: Vm, name: string): number {
  const variable = vm.variables.find((item) => item.name === name);
  assert.ok(variable, `변수 ${name} 을 찾지 못했습니다`);
  return Number(variable.getValue());
}

const wrap = (body: string, extra = '') => `${extra}
scene "s":
  object "o":
    when start do
${body
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
    end
  end
end`;

test('숫자 변환은 parseFloat 뒤 0 으로 떨어진다', () => {
  assert.equal(cast.num('12abc'), 12);
  assert.equal(cast.num('abc'), 0);
  assert.equal(cast.num(''), 0);
  assert.equal(cast.num('  3.5 '), 3.5);
});

test('판단 값은 숫자로 읽히면 그 진리값, 아니면 참이다', () => {
  assert.equal(cast.bool('0'), false);
  assert.equal(cast.bool('0.00'), false);
  assert.equal(cast.bool('hello'), true);
  assert.equal(cast.bool(undefined), false);
});

test('사칙연산은 엔트리처럼 10진으로 계산한다', () => {
  assert.equal(cast.addNum(0.1, 0.2), 0.3);
  assert.equal(cast.subNum(0.3, 0.1), 0.2);
  assert.equal(cast.mulNum(1.1, 1.1), 1.21);
  assert.equal(cast.addNum(1, 2), 3);
  assert.equal(cast.divNum(1, 4), 0.25);
});

// Decimal grids finer than the spacing between doubles must leave results unchanged.
test('10진 반올림은 배정밀도가 담아내는 자리까지만 움직인다', () => {
  const sin30 = Math.sin(Math.PI / 6);
  assert.equal(cast.mulNum(sin30, 30), sin30 * 30);
  assert.equal(cast.mulNum(0.1, 0.2), 0.02);
  assert.equal(cast.addNum(100.1, 0.02), 100.12);
  assert.equal(cast.subNum(1e21, 0.5), 1e21 - 0.5);
  assert.equal(cast.mulNum(1 / 3, 1 / 3), (1 / 3) * (1 / 3));
  assert.ok(Number.isNaN(cast.addNum(NaN, 0.1)));
  assert.equal(cast.mulNum(Infinity, 0.1), Infinity);
});

test('숫자 판별은 지수 표기를 받아들이고 앞의 점과 불완전한 지수는 거부한다', () => {
  for (const yes of ['0', '-0', '12', '-12', '12.', '12.5', '-0.75', '1e5', '1E+5', '-1.2e-3', '1.e2', '01e0', '1e309']) {
    assert.equal(cast.isNumber(yes), true, yes);
  }
  for (const no of ['', '-', '.', '.5', '-.5', '+1', ' 1', '1 ', '1.2.3', 'abc', '1a', '1e', '1e+', '1.e-', 'e2', '1e2.0', '1e2e3', '1e 2', 'Infinity']) {
    assert.equal(cast.isNumber(no), false, no);
  }
  assert.equal(cast.isNumber(12), true);
  assert.equal(cast.isNumber(null), false);
});

// Entry converts NaN to zero at the next number slot, but raw variable assignment retains it.
test('NaN 은 값 칸을 지날 때 0 이 된다', () => {
  const vm = runVm(
    wrap('a = (z / z)\nb = ((z / z) * 1000)\nc = ((z / z) + 5)', 'var z = 0\nvar a = 0\nvar b = 0\nvar c = 0'),
  );
  vm.tick();
  assert.equal(String(vm.variables.find((v) => v.name === 'a')!.getValue()), 'NaN');
  assert.equal(valueOf(vm, 'b'), 0);
  assert.equal(valueOf(vm, 'c'), 5);
});

test('더하기는 숫자가 아닌 쪽이 있으면 이어 붙인다', () => {
  assert.equal(cast.calcPlus('가', '나'), '가나');
  assert.equal(cast.calcPlus('2', '3'), 5);
  assert.equal(cast.calcPlus('2', '가'), '2가');
});

test('같다 는 엄격 비교, 같지 않다 는 느슨한 비교다', () => {
  assert.equal(cast.cmpEqual('10', 10), true);
  assert.equal(cast.cmpEqual('가', '가'), true);
  assert.equal(cast.cmpNotEqual('10', 10), false);
  assert.equal(cast.cmpGreater('10', '9'), true);
});

test('나머지는 나누는 수의 부호를 따른다', () => {
  assert.equal(cast.mod(-1, 360), 359);
  assert.equal(cast.mod(370, 360), 10);
});

test('반복은 한 바퀴마다 프레임을 넘긴다', () => {
  const vm = runVm(wrap('repeat 3:\n  count += 1\nend\ndone = 1', 'var count = 0\nvar done = 0'));
  vm.tick();
  assert.equal(valueOf(vm, 'count'), 1);
  assert.equal(valueOf(vm, 'done'), 0);
  vm.tick();
  assert.equal(valueOf(vm, 'count'), 2);
  vm.tick();
  assert.equal(valueOf(vm, 'count'), 3);
  vm.tick();
  assert.equal(valueOf(vm, 'count'), 3);
  assert.equal(valueOf(vm, 'done'), 1);
});

test('조건문은 프레임을 넘기지 않는다', () => {
  const vm = runVm(wrap('if 1 > 0:\n  a += 1\nend\na += 1', 'var a = 0'));
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 2);
});

test('무한 반복은 프레임마다 한 바퀴씩 돈다', () => {
  const vm = runVm(wrap('forever:\n  a += 1\nend', 'var a = 0'));
  for (let i = 1; i <= 5; i += 1) {
    vm.tick();
    assert.equal(valueOf(vm, 'a'), i);
  }
});

test('continue 는 한 바퀴를 접고 다음 프레임으로 넘긴다', () => {
  const vm = runVm(wrap('repeat 3:\n  n += 1\n  continue\n  m += 1\nend\ndone = 1', 'var n = 0\nvar m = 0\nvar done = 0'));
  vm.tick();
  assert.equal(valueOf(vm, 'n'), 1);
  assert.equal(valueOf(vm, 'm'), 0);
  vm.tick();
  vm.tick();
  assert.equal(valueOf(vm, 'n'), 3);
  assert.equal(valueOf(vm, 'done'), 0);
  vm.tick();
  assert.equal(valueOf(vm, 'done'), 1);
});

test('skip 은 프레임을 넘기지 않고 바로 다음 바퀴로 간다', () => {
  const vm = runVm(wrap('repeat 3:\n  n += 1\n  skip\n  m += 1\nend\ndone = 1', 'var n = 0\nvar m = 0\nvar done = 0'));
  vm.tick();
  assert.equal(valueOf(vm, 'n'), 3);
  assert.equal(valueOf(vm, 'm'), 0);
  assert.equal(valueOf(vm, 'done'), 1);
});

test('기다리기는 시간이 찰 때까지 붙잡는다', () => {
  const vm = runVm(wrap('wait 0.1\na = 1', 'var a = 0'));
  for (let i = 0; i < 5; i += 1) {
    vm.tick();
  }
  assert.equal(valueOf(vm, 'a'), 0);
  for (let i = 0; i < 3; i += 1) {
    vm.tick();
  }
  assert.equal(valueOf(vm, 'a'), 1);
});

test('반복 중단은 그 프레임 안에서 반복을 빠져나온다', () => {
  const vm = runVm(wrap('repeat 10:\n  a += 1\n  break\nend\nb = 1', 'var a = 0\nvar b = 0'));
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 1);
  assert.equal(valueOf(vm, 'b'), 1);
});

test('함수 호출은 값을 돌려주고 지역 변수는 호출마다 새로 만든다', () => {
  const vm = runVm(
    'function 두배(n):\n  var t = 0\n  t = n + n\n  return t\nend\n\n' +
      wrap('a = 두배(21)\nb = 두배(1)', 'var a = 0\nvar b = 0'),
  );
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 42);
  assert.equal(valueOf(vm, 'b'), 2);
});

test('함수 안에서 멈춰도 값 함수는 반환식을 계산한다', () => {
  const vm = runVm(
    'function 앞(a, b):\n  var t = 0\n  t = a\n  if (b == 1):\n    stop\n  end\n  t = 99\n  return t\nend\n\n' +
      wrap('a = 앞(7, 1)\nb = 앞(7, 0)', 'var a = 0\nvar b = 0'),
  );
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 7);
  assert.equal(valueOf(vm, 'b'), 99);
});

test('값 함수가 멈춰도 호출한 쪽은 이어서 실행된다', () => {
  const vm = runVm(
    'function 앞():\n  stop\n  return 5\nend\n\n' +
      wrap('a = 앞()\nb = 1', 'var a = 0\nvar b = 0'),
  );
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 5);
  assert.equal(valueOf(vm, 'b'), 1);
});

test('신호 보내기는 그 프레임이 끝난 뒤에 받는 쪽을 깨운다', () => {
  // Ordinary messages start receivers after the sender's current frame finishes.
  const vm = runVm(`
var a = 0
scene "sc":
  object "sender":
    when start do
      send "s"
      a += 1
    end
  end
  object "receiver":
    when signal "s" do
      a += 10
    end
  end
end`);
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 1);
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 11);
});

test('신호를 보낸 뒤 같은 장면을 다시 시작해도 받는 쪽은 살아남는다', () => {
  // Scene restart cannot cancel a message that has not been delivered yet.
  const vm = runVm(`
var a = 0
scene "sc":
  object "sender":
    when start do
      send "s"
      jump "sc"
    end
  end
  object "receiver":
    when signal "s" do
      a += 1
      wait 0
      a += 10
    end
  end
end`);
  for (let i = 0; i < 6; i += 1) {
    vm.tick();
  }
  assert.equal(valueOf(vm, 'a'), 11);
});

test('신호 보내고 기다리기는 그 자리에서 받는 쪽을 깨운다', () => {
  // Send-and-wait starts receivers immediately in the sending frame.
  const vm = runVm(`
var a = 0
scene "sc":
  object "sender":
    when start do
      call "s"
      a += 100
    end
  end
  object "receiver":
    when signal "s" do
      a += 1
    end
  end
end`);
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 1);
});

test('복제본은 자기 몫의 오브젝트 지역 변수를 가진다', () => {
  const vm = runVm(`
scene "s":
  object "o":
    var 목숨 = 3
    when start do
      clone
      목숨 = 1
    end
    when cloned do
      목숨 = 9
    end
  end
end`);
  vm.tick();
  vm.tick();
  const target = vm.targets[0]!;
  assert.equal(target.clones.length, 1);
  const shared = vm.variables.find((item) => item.name === '목숨')!;
  assert.equal(Number(shared.getValue()), 1);
  assert.equal(Number(target.clones[0]!.localVars?.[vm.variables.indexOf(shared)]?.getValue()), 9);
});

test('스스로 지우는 복제본들은 한 프레임에 모두 사라진다', () => {
  const vm = runVm(`var 지워 = 0

scene "s":
  object "o":
    when start do
      repeat 6:
        clone
      end
    end
    when cloned do
      forever:
        if (지워 == 1):
          del clone
        end
      end
    end
  end
end`);
  const target = vm.targets[0]!;
  for (let i = 0; i < 10; i += 1) {
    vm.tick();
  }
  assert.equal(target.clones.length, 6);

  // Removing threads in place can skip later clone scripts in the same frame.
  vm.variables.find((item) => item.name === '지워')!.setValue(1);
  vm.tick();
  assert.equal(target.clones.length, 0);
});

test("'stop other' 로 앞선 스크립트가 멈춰도 뒤의 복제본은 그 프레임을 돈다", () => {
  // Stopping the earlier entity must not shift a later clone past the active iteration.
  const vm = runVm(`var 돎 = 0

scene "s":
  object "o":
    when start do
      forever:
        wait 0.001
      end
    end
    when start do
      clone
      forever:
        stop other
      end
    end
    when cloned do
      forever:
        돎 += 1
      end
    end
  end
end`);
  vm.tick();
  assert.equal(valueOf(vm, '돎'), 1);
  vm.tick();
  assert.equal(valueOf(vm, '돎'), 2);
});

test('글자 효과 블록은 엔트리가 쓰는 이름 그대로 걸린다', () => {
  const vm = runVm(`scene "s":
  text "t":
    text_content = "가나다"
    when start do
      text_bold = true
      text_italic = true
      text_underline = true
      text_strikethrough = true
    end
  end
end`);
  vm.tick();
  const entity = vm.targets[0]!.entity;
  assert.equal(entity.fontBold, true);
  assert.equal(entity.fontItalic, true);
  assert.equal(entity.underLine, true);
  assert.equal(entity.strike, true);
});

test('글자 효과 끄기도 걸린다', () => {
  const vm = runVm(`scene "s":
  text "t":
    text_content = "가나다"
    text_bold = true
    when start do
      text_bold = false
    end
  end
end`);
  vm.tick();
  assert.equal(vm.targets[0]!.entity.fontBold, false);
});

test('범위를 준 변수는 슬라이드 변수가 되고 값이 그 사이에 머문다', () => {
  const vm = runVm(wrap('a = depth', 'var depth = 2 from 0 to 4\nvar a = 0'));
  const depth = vm.variables.find((item) => item.name === 'depth')!;
  assert.equal(depth.kind, 'slide');
  assert.equal(depth.minValue, 0);
  assert.equal(depth.maxValue, 4);
  depth.setValue(9);
  assert.equal(depth.getValue(), 4);
  depth.setValue(-3);
  assert.equal(depth.getValue(), 0);
  depth.setValue(3);
  vm.tick();
  assert.equal(valueOf(vm, 'a'), 3);
});

test('범위가 없는 변수는 그대로 보통 변수다', () => {
  const vm = runVm(wrap('a = 0', 'var depth = 2\nvar a = 0'));
  const depth = vm.variables.find((item) => item.name === 'depth')!;
  assert.equal(depth.kind, 'variable');
  depth.setValue(9);
  assert.equal(depth.getValue(), 9);
});

test('붓과 채우기 층은 작품이 먼저 집어 든 순서대로 쌓인다', () => {
  // Pen layers follow first-use order, so later fills must not be buried under earlier strokes.
  const first = runVm(wrap('start draw\nstart fill'));
  first.tick();
  const one = first.targets[0]!.entity;
  assert.ok(one.brush && one.paint, '두 펜이 모두 생겼다');
  assert.ok(one.brush!.started < one.paint!.started, '붓이 먼저, 채우기가 나중이다');

  const second = runVm(wrap('start fill\nstart draw'));
  second.tick();
  const two = second.targets[0]!.entity;
  assert.ok(two.paint!.started < two.brush!.started, '반대로 쓰면 반대로 쌓인다');
});

test('붓은 점마다가 아니라 프레임마다 한 번만 다시 그린다', () => {
  // Check deferred pen drawing in source because PixiRenderer needs a browser.
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/renderer.ts'),
    'utf-8',
  );
  const penChanged = source.slice(source.indexOf('  penChanged(entity: Entity): void {'));
  const body = penChanged.slice(0, penChanged.indexOf('\n  }'));
  assert.match(body, /this\.penDirty\.add\(entity\);/, 'penChanged 는 표시만 한다');
  assert.doesNotMatch(body, /drawPenGroup|penGroup\(/, 'penChanged 에서 다시 그리지 않는다');

  const flush = source.slice(source.indexOf('  flush(): void {'));
  assert.match(
    flush.slice(0, flush.indexOf('\n  }')),
    /for \(const entity of this\.penDirty\)[\s\S]*this\.redrawPen\(entity\)/,
    'flush 가 프레임마다 한 번 몰아서 그린다',
  );

  const redraw = source.slice(source.indexOf('  private redrawPen(entity: Entity): void {'));
  assert.match(
    redraw.slice(0, redraw.indexOf('\n  }')),
    /for \(const which of penOrderOf\(entity\)\)/,
    'redrawPen 은 먼저 집어 든 펜부터 돈다',
  );
});

test('도장은 모양의 제 크기로 찍힌다 — 텍스처가 구워진 크기가 아니라', () => {
  // Vector stamp scale must combine texture scale with entity scale.
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/renderer.ts'),
    'utf-8',
  );
  const stamp = source.slice(source.indexOf('  stamp(entity: Entity): void {'));
  const body = stamp.slice(0, stamp.indexOf('\n  }'));
  assert.match(body, /perPixelX \* mark\.scaleX/, '도장은 두 배율을 곱한다');
  assert.doesNotMatch(body, /scale\.set\(mark\.scaleX/, '오브젝트 배율만으로 덮어쓰지 않는다');
});

test('변수 상자는 자리를 정하지 않았어도 무대 안에 놓인다', () => {
  // Count variable and list monitors separately so later boxes do not fall below the stage.
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/overlay.ts'),
    'utf-8',
  );
  const home = source.slice(source.indexOf('  private homeOf(variable: Variable)'));
  const body = home.slice(0, home.indexOf('\n  }'));
  assert.match(body, /family\.indexOf\(variable\)/, '자기 종류 안에서의 자리로 센다');
  assert.match(body, /index \* 24 \+ 20 - 135/, '엔트리와 같은 간격으로 쌓는다');
});

test('리터럴 연산은 컴파일할 때 접어 둔다', () => {
  const result = compileProject(wrap('forward 10'), { path: 'test.tess' });
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(result.project as unknown as never);
  const source = vm.compiledSource(result.project as unknown as never);
  assert.match(source, /O\.moveDirection\(e, 10\)/);
});

test('모르는 블록은 실행을 멈추지 않고 보고만 한다', () => {
  const project = {
    objects: [
      {
        id: 'obj1',
        name: 'o',
        objectType: 'sprite',
        scene: 'sc1',
        rotateMethod: 'free',
        sprite: { pictures: [], sounds: [] },
        entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, width: 10, height: 10, visible: true },
        script: JSON.stringify([
          [
            { id: 'h', type: 'when_run_button_click', params: [null], statements: [] },
            { id: 'x', type: 'get_cur_weather', params: [], statements: [] },
          ],
        ]),
      },
    ],
    scenes: [{ id: 'sc1', name: 's' }],
    variables: [],
    messages: [],
    functions: [],
  };
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as unknown as never);
  vm.start();
  vm.tick();
  assert.equal(vm.errors.length, 0);
  assert.ok(vm.unknownBlocks.has('get_cur_weather'));
});

function rawProject(blocks: unknown[], variables: unknown[] = []) {
  return {
    objects: [
      {
        id: 'obj1',
        name: 'o',
        objectType: 'sprite',
        scene: 'sc1',
        rotateMethod: 'free',
        sprite: { pictures: [], sounds: [] },
        entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, width: 10, height: 10, visible: true },
        script: JSON.stringify([
          [{ id: 'h', type: 'when_run_button_click', params: [null], statements: [] }, ...blocks],
        ]),
      },
    ],
    scenes: [{ id: 'sc1', name: 's' }],
    variables,
    messages: [],
    functions: [],
  };
}

const setVar = (id: string, value: unknown) => ({
  id: 's' + id,
  type: 'set_variable',
  params: [id, value, null],
  statements: [],
});
const bool = (value: boolean) => ({ type: value ? 'True' : 'False', params: [], statements: [] });

test('팔레트에서 내려간 boolean_and · boolean_or 도 엔트리처럼 읽는다', () => {
  const variables = [
    { id: 'v1', name: 'and', variableType: 'variable', value: 0, array: [] },
    { id: 'v2', name: 'or', variableType: 'variable', value: 0, array: [] },
  ];
  const project = rawProject(
    [
      setVar('v1', { type: 'boolean_and', params: [bool(true), null, bool(false)], statements: [] }),
      setVar('v2', { type: 'boolean_or', params: [bool(true), null, bool(false)], statements: [] }),
    ],
    variables,
  );
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as unknown as never);
  vm.start();
  vm.tick();
  assert.equal(vm.unknownBlocks.size, 0);
  assert.equal(String(vm.variables.find((v) => v.name === 'and')!.value), 'false');
  assert.equal(String(vm.variables.find((v) => v.name === 'or')!.value), 'true');
});

test('색 고르개 블록은 고른 색을 값으로 돌려준다', () => {
  const project = rawProject([
    { id: 'c', type: 'text_change_font_color', params: [{ type: 'text_color', params: ['#ffaa00'], statements: [] }, null], statements: [] },
    { id: 'p', type: 'set_color', params: [{ type: 'color', params: ['#dede00'], statements: [] }, null], statements: [] },
  ]);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as unknown as never);
  const source = vm.compiledSource(project as unknown as never);
  assert.equal(vm.unknownBlocks.size, 0);
  assert.match(source, /O\.textColor\(e, "#ffaa00"\)/);
  assert.match(source, /O\.setPenColor\(e, "#dede00"\)/);
});

test('프레임 안에서 난 예외는 실행을 멈추고 알린다 — 화면만 멈추지 않는다', () => {
  const result = compileProject(wrap('forward 10'), { path: 'test.tess' });
  assert.ok(result.project);
  const reported: string[] = [];
  const renderer = {
    attach() {}, addEntity() {}, removeEntity() {}, setScene() {}, syncDialog() {}, eraseAll() {},
    flush() { throw new Error('webgl 컨텍스트를 잃었습니다'); },
  };
  const vm = new Vm({ renderer: renderer as never, audio: null });
  vm.load(result.project as unknown as never);
  vm.onError = (error) => reported.push(error.message);
  vm.start();
  vm.advance(16);
  vm.advance(32);
  assert.equal(vm.state, 'stop');
  // Report once and stop the work instead of throwing again every frame.
  assert.deepEqual(reported, ['webgl 컨텍스트를 잃었습니다']);
  assert.equal(vm.errors.length, 1);
});

test('글상자·벡터 모양의 텍스처는 webgl 상한(4096px)을 넘지 않는다', () => {
  // Retina fullscreen can request more pixels than a texture allows.
  const full = 8;
  const wide = textSharpness(full, 4, 900);
  assert.ok(wide * 900 <= 4096, `글상자 텍스처가 ${wide * 900}px 입니다`);

  const big = svgSharpness(full, 1600, 1200);
  assert.ok(big * 1600 <= 4096, `벡터 텍스처가 ${big * 1600}px 입니다`);
  assert.ok(big * 1600 * (big * 1200) <= 2048 * 2048 + 1, '벡터 텍스처의 넓이 상한');
});

test('읽을 수 없는 색은 엔트리와 같이 검정으로 떨어진다 (오류가 아니다)', () => {
  // Entry expands short hex and returns black for other invalid colors.
  assert.equal(cast.hexColor('#ff8000'), '#ff8000');
  assert.equal(cast.hexColor('ff8000'), '#ff8000');
  assert.equal(cast.hexColor('#f80'), '#ff8800');
  assert.equal(cast.hexColor('#검정'), '#000000');
  assert.equal(cast.hexColor('#dfdfe'), '#000000');
  assert.equal(cast.hexColor('#ffffff100'), '#000000');
  assert.equal(cast.hexColor(''), '#000000');
  assert.equal(cast.hexColor(undefined), '#000000');
  assert.deepEqual(cast.hexToRgb('#ff8000'), { r: 255, g: 128, b: 0 });
  assert.deepEqual(cast.hexToRgb('#검정'), { r: 0, g: 0, b: 0 });
});

test('읽을 수 없는 색을 붓·글상자에 넣어도 작품이 멈추지 않는다', () => {
  const vm = runVm(`scene "s":
  text "판":
    text_content = "x"
    when start do
      font_color = join("#", "검정")
      bg_color = join("#", "dfdfe")
    end
  end
  object "붓":
    when start do
      draw_color = join("#", "검정")
      fill_color = join("#", "dfdfe")
    end
  end
end`);
  for (let i = 0; i < 5; i += 1) vm.tick();
  assert.deepEqual(vm.errors, []);
  assert.equal(vm.state, 'run');

  const brush = vm.targets.find((target) => target.name === '붓')!.entity;
  assert.equal(brush.brush?.color, '#000000');
  assert.equal(brush.paint?.color, '#000000');
  // Text boxes keep the original color text; rendering validates it later.
  const board = vm.targets.find((target) => target.name === '판')!.entity;
  assert.equal(board.colour, '#검정');
});

const SHARED_SOURCE = `shared list 명예 = []
realtime list 실시간 = []
list 보통 = []
shared var 최고 = 0
realtime var 접속 = 0

scene "s":
  object "o":
    when start do
      in 명예 add 1
      in 실시간 add 2
      in 보통 add 3
      최고 = 7
      접속 = 8
    end
  end
end`;

function fakeStore() {
  const box = new Map<string, unknown>();
  return {
    box,
    read: (key: string) => box.get(key) as never,
    write: (key: string, value: unknown) => box.set(key, JSON.parse(JSON.stringify(value))),
  };
}

function loadShared(store: ReturnType<typeof fakeStore>): Vm {
  const result = compileProject(SHARED_SOURCE, { path: 'shared.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const vm = new Vm({ renderer: null, audio: null, store });
  vm.load(result.project as unknown as never);
  return vm;
}

const listOf = (vm: Vm, name: string) =>
  vm.variables.find((item) => item.name === name)!.array.map((item) => item.data);

test('공유 · 실시간 리스트와 변수는 다시 시작해도 값을 잃지 않는다', () => {
  const store = fakeStore();
  const vm = loadShared(store);
  vm.start();
  for (let i = 0; i < 10; i += 1) vm.tick(16);
  vm.stop();

  assert.deepEqual(listOf(vm, '명예'), ['1']);
  assert.deepEqual(listOf(vm, '보통'), ['3']);

  vm.start();
  for (let i = 0; i < 10; i += 1) vm.tick(16);
  vm.stop();
  assert.deepEqual(listOf(vm, '명예'), ['1', '1']);
  assert.deepEqual(listOf(vm, '실시간'), ['2', '2']);
  assert.deepEqual(listOf(vm, '보통'), ['3']);
  assert.equal(valueOf(vm, '최고'), 7);
});

test('공유 · 실시간 변수만 저장소에 남고, 다시 불러오면 그 값으로 시작한다', () => {
  const store = fakeStore();
  const first = loadShared(store);
  first.start();
  for (let i = 0; i < 10; i += 1) first.tick(16);
  first.stop();

  const stored = new Set(store.box.keys());
  const idOf = (name: string) => first.variables.find((item) => item.name === name)!.id;
  assert.ok(stored.has(idOf('명예')), '공유 리스트는 저장된다');
  assert.ok(stored.has(idOf('실시간')), '실시간 리스트는 저장된다');
  assert.ok(stored.has(idOf('최고')), '공유 변수는 저장된다');
  assert.ok(!stored.has(idOf('보통')), '보통 리스트는 저장하지 않는다');

  const second = loadShared(store);
  assert.deepEqual(listOf(second, '명예'), ['1']);
  assert.deepEqual(listOf(second, '보통'), []);
  assert.equal(valueOf(second, '최고'), 7);
});

test('저장소가 없어도 공유 · 실시간 값은 실행기가 살아 있는 동안 이어진다', () => {
  const result = compileProject(SHARED_SOURCE, { path: 'shared.tess' });
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(result.project as unknown as never);
  vm.start();
  for (let i = 0; i < 10; i += 1) vm.tick(16);
  vm.stop();
  vm.start();
  for (let i = 0; i < 10; i += 1) vm.tick(16);
  assert.deepEqual(listOf(vm, '명예'), ['1', '1']);
  assert.deepEqual(listOf(vm, '보통'), ['3']);
});

test('벡터가 많은 작품은 텍스처 예산에 맞춰 함께 낮춰 굽는다', () => {
  const one = svgSharpness(3, 960, 540);
  assert.equal(svgBudgetScale(960 * 540 * one * one), 1);
  assert.equal(svgSharpness(3, 960, 540, 1), one);

  const many = 100 * 960 * 540 * one * one;
  const budget = svgBudgetScale(many);
  assert.ok(budget < 1, `예산 배율이 ${budget} 입니다`);
  assert.ok(svgSharpness(3, 960, 540, budget) < one);

  // Budget scaling never drops below the equivalent raster's scale.
  assert.equal(svgSharpness(3, 960, 540, 0.001), 1);

  let scale = 1;
  for (let pass = 0; pass < 8; pass += 1) {
    const sharp = svgSharpness(3, 960, 540, scale);
    const pixels = 100 * 960 * 540 * sharp * sharp;
    const tighter = svgBudgetScale(pixels);
    if (tighter === 1) break;
    scale *= tighter;
  }
  const settled = svgSharpness(3, 960, 540, scale);
  assert.ok(
    100 * 960 * 540 * settled * settled <= SVG_PIXEL_BUDGET * 1.2,
    '예산을 크게 넘지 않는다',
  );
});

test('화질은 화면이 요구하는 만큼 따라 올라가고, 하한 아래로는 내려가지 않는다', () => {
  // Default rendering uses a 4/3 stage scale and renderer resolution of 1.
  assert.equal(textSharpness(4 / 3, 1, 100), 2, '작게 그려도 하한 2배');
  // Without a minimum-side constraint, low-resolution vectors use the minimum scale.
  assert.equal(svgSharpness(4 / 3, 400, 400), 3);
  assert.equal(textSharpness(3, 1, 100), 3);
  assert.equal(textSharpness(3, 2, 100), 6);
  assert.equal(svgSharpness(6, 200, 200), 6);
  assert.equal(textSharpness(6, 1, 100), 6);
});

// Give tiny icons a minimum texture side so moderate enlargement stays sharp.
test('작게 저장된 벡터는 긴 변이 하한을 채울 만큼 촘촘히 굽는다', () => {
  for (const [width, height] of [[20, 20], [100, 100], [60, 30]] as const) {
    const sharp = svgSharpness(4 / 3, width, height);
    const longest = Math.max(width, height) * sharp;
    assert.ok(longest >= MIN_SVG_SIDE, `${width}x${height} → ${longest}px`);
  }
  assert.equal(svgSharpness(4 / 3, 480, 270), 3);
  // Apply the shared budget to minimum-side sizes too.
  assert.ok(svgSharpness(4 / 3, 20, 20, 0.1) < svgSharpness(4 / 3, 20, 20));
});

// Accept both inline function bodies and bodies nested in saved definition slots.
function functionProject(content: unknown[][]) {
  return {
    objects: [
      {
        id: 'obj1', name: 'o', objectType: 'sprite', scene: 'sc1', rotateMethod: 'free',
        sprite: { pictures: [], sounds: [] },
        entity: { x: 0, y: 0, scaleX: 1, scaleY: 1, width: 10, height: 10, visible: true },
        script: JSON.stringify([[
          { id: 'h', type: 'when_run_button_click', params: [null], statements: [] },
          { id: 'c', type: 'func_fn1', params: [null], statements: [] },
        ]]),
      },
    ],
    scenes: [{ id: 'sc1', name: 's' }],
    variables: [{ id: 'v1', name: '지은것', variableType: 'variable', value: 0, array: [] }],
    messages: [],
    functions: [{ id: 'fn1', content: JSON.stringify(content) }],
  };
}

const defineHat = {
  id: 'd', type: 'function_create',
  params: [{ id: 'l', type: 'function_field_label', params: ['짓기', null] }, null],
};
const bodyBlock = {
  id: 'b', type: 'set_variable',
  params: ['v1', { id: 'n', type: 'text', params: ['42'] }, null],
};

test('함수 본문은 정의 블록 다음에 이어 붙은 것도 읽는다 (playentry 작품 형태)', () => {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(functionProject([[defineHat, bodyBlock]]) as unknown as never);
  vm.start();
  vm.tick();
  assert.equal(vm.unknownBlocks.size, 0);
  assert.equal(String(vm.variables.find((v) => v.name === '지은것')!.value), '42');
});

test('함수 본문은 정의 블록 안에 든 것도 읽는다 (.ent 로 저장한 형태)', () => {
  const nested = { ...defineHat, statements: [[bodyBlock]] };
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(functionProject([[nested]]) as unknown as never);
  vm.start();
  vm.tick();
  assert.equal(String(vm.variables.find((v) => v.name === '지은것')!.value), '42');
});

function squareMask(size: number) {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 3; i < pixels.length; i += 4) {
    pixels[i] = 255;
  }
  return maskFromPixels(pixels, size, size);
}

function halfMask(size: number) {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      pixels[(y * size + x) * 4 + 3] = x < size / 2 ? 255 : 0;
    }
  }
  return maskFromPixels(pixels, size, size);
}

function collisionVm(maskFor: (id: string) => ReturnType<typeof squareMask>) {
  const source = `
scene "s":
  object "a":
    costume 기본 "a.png" size 20 20
    x = 0
    y = 0
  end
  object "b":
    costume 기본 "b.png" size 20 20
    x = 0
    y = 0
  end
end`;
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(result.project as unknown as never);
  const masks = new MaskStore(() => null);
  for (const target of vm.targets) {
    for (const picture of target.pictures) {
      masks.put(picture.id, maskFor(picture.id));
    }
  }
  return { vm, collision: new CollisionSystem(masks) };
}

test('포인터가 무대에 올라온 적이 없으면 가운데 오브젝트도 마우스에 닿지 않는다', () => {
  const source = `
scene "s":
  object "a":
    costume 기본 "a.png" size 20 20
    x = 0
    y = 0
  end
end`;
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(result.project as unknown as never);
  for (const target of vm.targets) {
    for (const picture of target.pictures) (vm as any).masks.put(picture.id, squareMask(20));
  }
  const entity = vm.targets[0]!.entity;
  vm.collision.beginFrame();
  // Before pointer entry, use the canvas's top-left corner rather than the stage center.
  assert.equal((vm as any).ops.touching(entity, 'mouse'), false);
  vm.pointerSeen = true;
  vm.collision.beginFrame();
  assert.equal((vm as any).ops.touching(entity, 'mouse'), true, '무대 가운데(0, 0)에 올라오면 닿는다');
});

test('겹치는 사각형은 닿은 것으로, 떨어지면 아닌 것으로 본다', () => {
  const { vm, collision } = collisionVm(() => squareMask(20));
  const [a, b] = vm.targets.map((target) => target.entity);
  collision.beginFrame();
  assert.equal(collision.touchingEntity(a!, b!, 0.2), true);
  b!.setX(100);
  collision.beginFrame();
  assert.equal(collision.touchingEntity(a!, b!, 0.2), false);
});

test('투명한 부분만 겹치면 닿지 않은 것이다', () => {
  const { vm, collision } = collisionVm(() => halfMask(20));
  const [a, b] = vm.targets.map((target) => target.entity);
  a!.setX(0);
  b!.setX(-10);
  collision.beginFrame();
  assert.equal(collision.touchingEntity(a!, b!, 0.2), false);
  b!.setX(2);
  collision.beginFrame();
  assert.equal(collision.touchingEntity(a!, b!, 0.2), true);
});

test('무대 밖으로 나가면 벽에 닿는다', () => {
  const { vm, collision } = collisionVm(() => squareMask(20));
  const a = vm.targets[0]!.entity;
  collision.beginFrame();
  assert.equal(collision.touchingWall(a, 'wall', 0.2), false);
  a.setX(238);
  collision.beginFrame();
  assert.equal(collision.touchingWall(a, 'wall_right', 0.2), true);
  assert.equal(collision.touchingWall(a, 'wall_left', 0.2), false);
});

test('경계 상자는 무대 픽셀 좌표로 나온다', () => {
  const { vm } = collisionVm(() => squareMask(20));
  const a = vm.targets[0]!.entity;
  const box = { x: 0, y: 0, width: 0, height: 0 };
  entityBounds(a, box);
  // A 20 by 20 costume spans 26.67 collision pixels at Entry's 4/3 stage scale.
  assert.ok(Math.abs(box.width - (20 * 4) / 3) < 1e-6);
  assert.ok(Math.abs(box.x - (stage.worldWidth / 2 - (20 * 4) / 3 / 2)) < 1e-6);
});

test('글상자의 경계 상자와 마우스 충돌은 정렬(textAlign)에 따라 이동한다', () => {
  const source = `scene "s":
  text "t":
    text_content = "테스트"
    size 100 40
    x = 0
    y = 0
  end
end`;
  const { project } = compileProject(source, { path: 'test.tess' });
  assert.ok(project);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as unknown as never);
  const entity = vm.targets[0]!.entity;
  const collision = new CollisionSystem(new MaskStore(() => null));
  const box = { x: 0, y: 0, width: 0, height: 0 };

  entity.textAlign = 0;
  entityBounds(entity, box);
  const centerX = stage.worldWidth / 2;
  const centerY = stage.worldHeight / 2;
  const scaledW = 100 * stage.scale;
  const scaledH = 40 * stage.scale;
  assert.ok(Math.abs(box.x - (centerX - scaledW / 2)) < 1e-6);
  assert.ok(Math.abs(box.width - scaledW) < 1e-6);
  assert.equal(collision.touchingMouse(entity, centerX, centerY), true);
  assert.equal(collision.touchingMouse(entity, centerX + scaledW / 2 + 5, centerY), false);

  entity.textAlign = 1;
  entityBounds(entity, box);
  assert.ok(Math.abs(box.x - centerX) < 1e-6);
  assert.ok(Math.abs(box.width - scaledW) < 1e-6);
  assert.equal(collision.touchingMouse(entity, centerX - 10, centerY), false);
  assert.equal(collision.touchingMouse(entity, centerX + 10, centerY), true);

  entity.textAlign = 2;
  entityBounds(entity, box);
  assert.ok(Math.abs(box.x - (centerX - scaledW)) < 1e-6);
  assert.ok(Math.abs(box.width - scaledW) < 1e-6);
  assert.equal(collision.touchingMouse(entity, centerX + 10, centerY), false);
  assert.equal(collision.touchingMouse(entity, centerX - 10, centerY), true);

  entity.lineBreak = true;
  entity.textAlign = 1;
  entityBounds(entity, box);
  assert.ok(Math.abs(box.x - (centerX - scaledW / 2)) < 1e-6);
});

test('무대 크기를 바꾸면 벽과 좌표계가 같이 움직인다', () => {
  const { vm, collision } = collisionVm(() => squareMask(20));
  const a = vm.targets[0]!.entity;
  a.setX(238);
  collision.beginFrame();
  assert.equal(collision.touchingWall(a, 'wall_right', 0.2), true);
  try {
    setStageSize(960, 540);
    collision.beginFrame();
    assert.equal(collision.touchingWall(a, 'wall_right', 0.2), false);
    a.setX(478);
    collision.beginFrame();
    assert.equal(collision.touchingWall(a, 'wall_right', 0.2), true);
  } finally {
    setStageSize(480, 270);
  }
});

test('작품이 정한 speed 가 곧 프레임 속도다', () => {
  const result = compileProject('project:\n  fps 29\nend\n\n' + wrap('a = 1', 'var a = 0'), {
    path: 'test.tess',
  });
  assert.ok(result.project);
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(result.project as unknown as never);
  assert.equal(vm.frameRate, 29);

  const override = new Vm({ renderer: null, audio: null, fps: 120 });
  override.load(result.project as unknown as never);
  assert.equal(override.frameRate, 120);
});

test('초시계는 시작하기 전까지 0 이고, 멈춘 채 초기화하면 꺼진다', () => {
  const vm = runVm(wrap('wait 0.1'));
  vm.resetTimer();
  for (let i = 0; i < 10; i += 1) {
    vm.tick();
  }
  assert.equal(vm.timerValue(), 0);

  vm.startTimer();
  for (let i = 0; i < 30; i += 1) {
    vm.tick();
  }
  assert.ok(Math.abs(vm.timerValue() - 30 / vm.frameRate) < 1e-6);

  vm.pauseTimer();
  const held = vm.timerValue();
  for (let i = 0; i < 30; i += 1) {
    vm.tick();
  }
  assert.equal(vm.timerValue(), held);

  vm.resetTimer();
  vm.tick();
  assert.equal(vm.timerValue(), 0);
  vm.resetTimer();
  for (let i = 0; i < 10; i += 1) {
    vm.tick();
  }
  assert.equal(vm.timerValue(), 0);
});

test('돌고 있는 초시계를 초기화하면 0 부터 다시 센다', () => {
  const vm = runVm(wrap('wait 10'));
  vm.startTimer();
  for (let i = 0; i < 30; i += 1) {
    vm.tick();
  }
  vm.resetTimer();
  for (let i = 0; i < 15; i += 1) {
    vm.tick();
  }
  assert.ok(Math.abs(vm.timerValue() - 15 / vm.frameRate) < 1e-6);
});

test('붓의 투명도는 선과 채우기에 함께 걸린다', () => {
  const vm = runVm(wrap([
    'draw_alpha = 70',
    'go -50 0',
    'start draw',
    'go 50 0',
    'stop draw',
    'start fill',
    'go 50 30',
    'go -50 30',
    'stop fill',
  ].join('\n')));
  vm.tick();

  const entity = vm.targets[0]!.entity;
  assert.equal(entity.brush!.opacity, 70);
  assert.equal(entity.paint!.opacity, 70);
  assert.ok(entity.brush!.strokes.some((stroke) => stroke.opacity === 70 && !stroke.fill));
  assert.ok(entity.paint!.strokes.some((stroke) => stroke.opacity === 70 && stroke.fill));
});

test('붓의 투명도 바꾸기도 선과 채우기를 함께 옮긴다', () => {
  const vm = runVm(wrap('draw_alpha = 20\ndraw_alpha += 30'));
  vm.tick();

  const entity = vm.targets[0]!.entity;
  assert.equal(entity.brush!.opacity, 50);
  assert.equal(entity.paint!.opacity, 50);
});

// Text changes update width only; font changes may update both dimensions.
test('글상자 폭은 글을 쓰는 그 순간 다시 재어지고, 높이는 그대로다', () => {
  const result = compileProject(
    `scene "s":
  text "t":
    text_content = "짧게"
    when start do
      write "아주 아주 긴 글자입니다"
    end
  end
end`,
    { path: 'test.tess' },
  );
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const vm = new Vm({ renderer: null, audio: null });
  // Ask the renderer to measure immediately without yielding a frame.
  const measured: string[] = [];
  vm.renderer = {
    addEntity() {},
    removeEntity() {},
    flush() {},
    measureTextBox(entity) {
      measured.push(entity.text);
      return { width: entity.text.length * 10, height: 999 };
    },
  };
  vm.load(result.project as unknown as never);
  vm.start();
  vm.tick();
  const entity = vm.targets[0]!.entity;
  assert.equal(entity.text, '아주 아주 긴 글자입니다');
  assert.equal(entity.width, '아주 아주 긴 글자입니다'.length * 10);
  assert.notEqual(entity.height, 999, '재어진 높이를 가져가지 않습니다');
  assert.ok(measured.includes('아주 아주 긴 글자입니다'));
});

test('글꼴 문자열은 굵기·기울임·소수점 크기를 모두 읽는다', () => {
  assert.deepEqual(parseFont('20px DungGeunMo'), {
    size: 20,
    family: 'DungGeunMo',
    bold: false,
    italic: false,
  });
  assert.deepEqual(parseFont('bold 16.5441px Nanum Gothic'), {
    size: 16.5441,
    family: 'Nanum Gothic',
    bold: true,
    italic: false,
  });
  assert.deepEqual(parseFont('bold italic 12px Nanum Pen Script'), {
    size: 12,
    family: 'Nanum Pen Script',
    bold: true,
    italic: true,
  });
});

// Invalid saved font sizes use the canvas fallback, including its smaller measured height.
test('읽을 수 없는 글꼴 크기는 캔버스 기본 글꼴이 된다', () => {
  assert.deepEqual(parseFont('NaNpx Nanum Gothic'), {
    size: 10,
    family: 'sans-serif',
    bold: false,
    italic: false,
  });
  assert.deepEqual(parseFont('bold italic NaNpx D2 Coding'), {
    size: 10,
    family: 'sans-serif',
    bold: false,
    italic: false,
  });
  assert.deepEqual(parseFont(''), {
    size: 20,
    family: 'Nanum Gothic',
    bold: false,
    italic: false,
  });
});

// Use decimal subtraction because digit-sensitive code distinguishes 0.1 from its binary remainder.
test('소수 부분은 빼기로 구하면 10진으로 딱 떨어진다', () => {
  const vm = runVm(
    wrap(`
      정확한 = (abs(49.1) - floor(abs(49.1)))
      나머지로 = (abs(49.1) % 1)
    `, 'var 정확한 = 0\nvar 나머지로 = 0'),
  );
  vm.tick();
  const value = (name: string) => String(vm.variables.find((item) => item.name === name)!.getValue());
  assert.equal(value('정확한'), '0.1');
  // Entry modulo keeps binary arithmetic: l - r * floor(l / r).
  assert.equal(value('나머지로'), String(49.1 - 1 * Math.floor(49.1 / 1)));
});

test('예제 작품이 오류 없이 돌아간다', () => {
  for (const file of ['examples/tour.tess', 'examples/all_blocks.tess', 'examples/cat_run.tess']) {
    const source = readIfExists(file);
    if (!source) {
      continue;
    }
    const result = compileProject(source, { path: file, assetDirs: ['examples'] });
    assert.ok(result.project, `${file} 컴파일 실패`);
    const vm = new Vm({ renderer: null, audio: null });
    vm.load(result.project as unknown as EntryProject as never);
    vm.start();
    for (let i = 0; i < 300; i += 1) {
      vm.tick();
    }
    assert.equal(vm.errors.length, 0, `${file}: ${vm.errors[0]?.message ?? ''}`);
  }
});

function readIfExists(file: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:fs').readFileSync(file, 'utf-8') as string;
  } catch {
    return null;
  }
}

test('모양은 아이디·이름 다음에 1부터 세는 번호로 찾는다', () => {
  const source = `
scene "s":
  object "o":
    costume 첫번째 "a.png" size 10 10
    costume 두번째 "b.png" size 10 10
    costume 세번째 "c.png" size 10 10
  end
end`;
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(result.project as unknown as never);
  const target = vm.targets[0]!;

  assert.equal(target.getPicture('두번째')?.name, '두번째');
  assert.equal(target.getPicture(target.pictures[2]!.id)?.name, '세번째');
  assert.equal(target.getPicture('2')?.name, '두번째');
  assert.equal(target.getPicture(3)?.name, '세번째');
  // Missing costumes must stay absent instead of selecting the first image.
  assert.equal(target.getPicture('없는이름'), null);
  assert.equal(target.getPicture('9'), null);
  assert.equal(target.getPicture('0'), null);

  assert.equal(target.getNextPicture('2')?.name, '세번째');
  assert.equal(target.getNextPicture('3')?.name, '첫번째');
  assert.equal(target.getPrevPicture('1')?.name, '세번째');
});

test('아이디 블록은 로그인한 사람의 아이디를 그대로 돌려준다', () => {
  const source = `
var 아이디_값 as "아이디 값" = 0
var 닉_값 as "닉 값" = 0

scene "s":
  object "o":
    when start do
      아이디_값 = user_id
      닉_값 = nickname
    end
  end
end`;
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');

  const read = (options: Record<string, unknown>) => {
    const vm = new Vm({ renderer: null, audio: null, ...options });
    vm.load(result.project as unknown as never);
    vm.start();
    vm.tick();
    const value = (name: string) =>
      String(vm.variables.find((item) => item.name === name)?.getValue());
    return { id: value('아이디 값'), nickname: value('닉 값') };
  };

  assert.deepEqual(read({}), { id: ' ', nickname: ' ' }, '로그인하지 않은 자리');
  assert.deepEqual(
    read({ user: { id: 'ddtt786', nickname: '치로' } }),
    { id: 'ddtt786', nickname: '치로' },
  );
});

function fakeTranslator(answer: string | null = null) {
  const asked: Array<{ text: string; source: string; target: string }> = [];
  return {
    asked,
    translate(text: string, source: string, target: string) {
      asked.push({ text, source, target });
      return Promise.resolve(answer ?? `${text}(${source}->${target})`);
    },
    detect(_text: string) {
      return Promise.resolve('en');
    },
  };
}

// Let promises settle between frames while translation waits.
async function runTranslating(source: string, translator: unknown): Promise<Vm> {
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const machine = new Vm({ renderer: null, audio: null, translator: translator as never });
  machine.load(result.project as unknown as never);
  machine.start();
  for (let i = 0; i < 6; i += 1) {
    machine.tick();
    await Promise.resolve();
    await Promise.resolve();
  }
  return machine;
}

const translated = (machine: Vm) => String(machine.variables.find((v) => v.name === '결과')!.getValue());

test('번역 블록은 엔트리 서비스가 준 글을 그대로 쓴다', async () => {
  const translator = fakeTranslator();
  const machine = await runTranslating(
    wrap('결과 = get_translated_string("ko", "안녕", "en")', 'var 결과 = ""'),
    translator,
  );
  assert.equal(translated(machine), '안녕(ko->en)');
  assert.deepEqual(translator.asked, [{ text: '안녕', source: 'ko', target: 'en' }]);
});

test('출발어와 도착어가 같으면 부르지 않는다', async () => {
  const translator = fakeTranslator();
  const machine = await runTranslating(
    wrap('결과 = get_translated_string("ko", "안녕", "ko")', 'var 결과 = ""'),
    translator,
  );
  assert.equal(translated(machine), '안녕');
  assert.deepEqual(translator.asked, []);
});

test('빈 문장과 3000 자를 넘는 문장은 엔트리처럼 이유를 돌려준다', async () => {
  const empty = await runTranslating(
    wrap('결과 = get_translated_string("ko", "", "en")', 'var 결과 = ""'),
    fakeTranslator(),
  );
  assert.equal(translated(empty), '문장이 없습니다');

  const tooLong = '가'.repeat(3001);
  const long = await runTranslating(
    wrap(`결과 = get_translated_string("ko", "${tooLong}", "en")`, 'var 결과 = ""'),
    fakeTranslator(),
  );
  assert.equal(translated(long), '3000자까지만 입력할 수 있습니다.');
});

test('번역할 곳이 없으면 엔트리의 기본 답을 돌려준다', async () => {
  const machine = await runTranslating(
    wrap('결과 = get_translated_string("ko", "안녕", "en")', 'var 결과 = ""'),
    null,
  );
  assert.equal(translated(machine), '알 수 없는 문장입니다.');
});

test('언어 감지는 엔트리가 쓰는 이름으로 답한다', async () => {
  const machine = await runTranslating(
    wrap('결과 = check_language("hello")', 'var 결과 = ""'),
    fakeTranslator(),
  );
  assert.equal(translated(machine), '영어');
});

test('번역을 기다리는 동안에도 다른 스크립트는 돈다', async () => {
  let release: (value: string) => void = () => {};
  const held = new Promise<string>((resolve) => { release = resolve; });
  const machine = await runTranslating(
    `var 결과 = ""
var 센횟수 = 0
scene "s":
  object "o":
    when start do
      결과 = get_translated_string("ko", "안녕", "en")
    end
    when start do
      forever:
        센횟수 = (센횟수 + 1)
      end
    end
  end
end`,
    { translate: () => held, detect: () => Promise.resolve('en') },
  );
  const counted = Number(machine.variables.find((v) => v.name === '센횟수')!.getValue());
  assert.ok(counted > 1, `다른 스크립트가 멈춰 섰습니다: ${counted}`);
  assert.equal(translated(machine), '', '아직 답이 오지 않았습니다');
  release('안녕하세요');
  for (let i = 0; i < 3; i += 1) {
    machine.tick();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(translated(machine), '안녕하세요');
});

// Simulate only flat display order, with clones inserted directly below their source.
function fakeStage() {
  const order: Array<{ id: string }> = [];
  return {
    order,
    addEntity(entity: never, source?: never) {
      const at = source ? order.indexOf(source) + 1 : order.length;
      order.splice(at, 0, entity);
    },
    removeEntity(entity: never) {
      const at = order.indexOf(entity);
      if (at >= 0) order.splice(at, 1);
    },
    moveEntity(entity: never, location: string) {
      const at = order.indexOf(entity);
      if (at < 0) return;
      order.splice(at, 1);
      if (location === 'FRONT') order.unshift(entity);
      else if (location === 'BACK') order.push(entity);
      else order.splice(location === 'FORWARD' ? Math.max(0, at - 1) : at + 1, 0, entity);
    },
    drawOrder: () => [...order],
    flush() {},
    measureTextBox: () => ({ width: 100, height: 40 }),
  };
}

const COVERED = `scene "s":
  text "가림막":
    text_content = "가림막"
    when start do
      say "가림막이 받았다"
    end
  end
  text "복제될것":
    text_content = "복제될것"
    when start do
      clone
    end
    when cloned do
      order first
      wait clicked
      say "안녕!"
    end
  end
end`;

// Click lookup must follow changed display order rather than the project's declaration order.
test('맨 앞으로 보낸 복제본이 클릭을 가져간다', () => {
  const result = compileProject(COVERED, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const view = fakeStage();
  const machine = new Vm({ renderer: view as never, audio: null });
  machine.load(result.project as unknown as never);
  machine.start();
  machine.tick();

  const target = machine.targets.find((item) => item.name === '복제될것')!;
  const clone = target.clones[0];
  assert.ok(clone, '복제본이 만들어져야 합니다');
  assert.equal(view.order[0], clone as never, '복제본이 맨 앞으로 옵니다');

  const hit = machine.entityAtPoint(stage.worldWidth / 2, stage.worldHeight / 2);
  assert.equal(hit, clone, '클릭은 맨 앞의 복제본에게 갑니다');

  machine.clickedEntityId = hit!.id;
  machine.tick();
  assert.equal(clone.dialog?.message, '안녕!');
});

test('순서를 바꾸지 않으면 먼저 선언한 오브젝트가 클릭을 가져간다', () => {
  const result = compileProject(COVERED.replace('      order first\n', ''), { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const view = fakeStage();
  const machine = new Vm({ renderer: view as never, audio: null });
  machine.load(result.project as unknown as never);
  machine.start();
  machine.tick();

  const cover = machine.targets.find((item) => item.name === '가림막')!;
  const hit = machine.entityAtPoint(stage.worldWidth / 2, stage.worldHeight / 2);
  assert.equal(hit, cover.entity, '앞에 선 것은 여전히 가림막입니다');
});

test('렌더러가 없으면 선언한 순서로 찾는다', () => {
  const machine = runVm(COVERED.replace('      order first\n', ''));
  machine.tick();
  const cover = machine.targets.find((item) => item.name === '가림막')!;
  assert.equal(
    machine.entityAtPoint(stage.worldWidth / 2, stage.worldHeight / 2),
    cover.entity,
  );
});

// Check clone bubble cleanup through removeEntity because PixiRenderer needs a browser.
test('복제본을 지우면 그 말풍선도 함께 지운다', () => {
  const renderer = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/renderer.ts'),
    'utf-8',
  );
  const remove = renderer.slice(renderer.indexOf('  removeEntity(entity: Entity): void {'));
  const body = remove.slice(0, remove.indexOf('\n  }'));
  assert.match(body, /this\.overlay\?\.forget\(entity\)/, 'removeEntity 가 오버레이에 알린다');
  assert.ok(
    body.indexOf('this.overlay?.forget(entity)') < body.indexOf('if (!view)'),
    '그릴 것이 이미 없는 복제본도 말풍선은 지워야 하므로 먼저 알린다',
  );

  const overlay = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/overlay.ts'),
    'utf-8',
  );
  const forget = overlay.slice(overlay.indexOf('  forget(entity: Entity): void {'));
  const forgetBody = forget.slice(0, forget.indexOf('\n  }'));
  assert.match(forgetBody, /view\.root\.destroy\(/, '말풍선을 실제로 없앤다');
  assert.match(forgetBody, /this\.dialogs\.delete\(entity\)/, '들고 있던 자리도 비운다');
});

// Repeated speech moves its bubble to the front even when the text is unchanged.
test('다시 말하면 그 말풍선이 맨 앞으로 온다', () => {
  const overlay = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/overlay.ts'),
    'utf-8',
  );
  const set = overlay.slice(overlay.indexOf('  setDialog(entity: Entity): void {'));
  const body = set.slice(0, set.indexOf('\n  }'));
  const existing = body.slice(body.indexOf('    if (existing) {'));
  assert.match(
    existing,
    /^ {6}this\.raise\(existing\.root\);$/m,
    '글이 그대로여도 올려야 하므로 바뀐 경우 안이 아니라 밖에서 올린다',
  );

  const raise = overlay.slice(overlay.indexOf('  private raise(root: Container): void {'));
  assert.match(
    raise.slice(0, raise.indexOf('\n  }')),
    /setChildIndex\(root, last\)/,
    'raise 는 말풍선을 마지막(맨 앞) 자리로 옮긴다',
  );
});

// Use the same pixel and display-order rules for the cursor as for clicks.
const CLICKABLE = `scene "s":
  text "버튼":
    text_content = "버튼"
    when click do
      say "눌렸다"
    end
  end
end`;

const middle = (): [number, number] => [stage.worldWidth / 2, stage.worldHeight / 2];

test('클릭을 받는 오브젝트 위에서는 손가락 커서를 알린다', () => {
  const machine = runVm(CLICKABLE);
  machine.tick();
  assert.equal(machine.clickableAt(...middle()), true);
});

test('클릭을 뗐을 때만 받는 오브젝트 위에서도 알린다', () => {
  const machine = runVm(CLICKABLE.replace('when click do', 'when click up do'));
  machine.tick();
  assert.equal(machine.clickableAt(...middle()), true);
});

test('클릭을 받지 않는 오브젝트 위에서는 알리지 않는다', () => {
  const machine = runVm(CLICKABLE.replace(/when click do\n      say "눌렸다"\n    end/, ''));
  machine.tick();
  assert.equal(machine.clickableAt(...middle()), false);
});

test('멈춘 작품에서는 알리지 않는다', () => {
  const machine = runVm(CLICKABLE);
  machine.tick();
  machine.stop();
  assert.equal(machine.clickableAt(...middle()), false);
});

test('빈 자리에서는 알리지 않는다', () => {
  const machine = runVm(CLICKABLE);
  machine.tick();
  assert.equal(machine.clickableAt(0, 0), false, '무대 왼쪽 위 구석에는 아무것도 없습니다');
});

test('클릭을 받지 않는 오브젝트가 가리고 있으면 알리지 않는다', () => {
  const source = `scene "s":
  text "가림막":
    text_content = "가림막"
  end
  text "버튼":
    text_content = "버튼"
    when click do
      say "눌렸다"
    end
  end
end`;
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const view = fakeStage();
  const machine = new Vm({ renderer: view as never, audio: null });
  machine.load(result.project as unknown as never);
  machine.start();
  machine.tick();
  assert.equal(machine.clickableAt(...middle()), false, '앞에 선 가림막이 클릭을 가져갑니다');

  const button = machine.targets.find((item) => item.name === '버튼')!;
  view.moveEntity(button.entity as never, 'FRONT');
  assert.equal(machine.clickableAt(...middle()), true);
});

const TABLE_WORK = `table 점수표 as "점수 표":
  columns "이름", "점수"
  row "철수", 90
  row "영희", 85
end

scene "s":
  object "o":
    when start do
      BODY
    end
  end
end`;

function tableStage() {
  const shown: Array<string | null> = [];
  return {
    shown,
    addEntity() {},
    removeEntity() {},
    flush() {},
    showTable(table: { name: string } | null, chart: number | null = null) {
      shown.push(table ? `${table.name}${chart === null ? '' : `/차트${chart}`}` : null);
    },
  };
}

function runWithTable(body: string) {
  const result = compileProject(TABLE_WORK.replace('BODY', body), { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const view = tableStage();
  const machine = new Vm({ renderer: view as never, audio: null });
  machine.load(result.project as unknown as never);
  machine.start();
  return { machine, view };
}

test('테이블 창 열기는 그 표를 띄운다', () => {
  const { machine, view } = runWithTable('show 점수표');
  machine.tick();
  assert.deepEqual(view.shown.slice(-1), ['점수 표']);
});

// Opening timed table windows must not hold the script.
test('초를 준 표 창은 스크립트를 붙잡지 않고 그 시간 뒤에 닫힌다', () => {
  const { machine, view } = runWithTable('show 점수표 for 1\n      결과 = 1');
  machine.tick();
  assert.deepEqual(view.shown.slice(-1), ['점수 표'], '창이 열렸습니다');

  for (let i = 0; i < 50; i += 1) machine.tick();
  assert.equal(view.shown.filter((name) => name === null).length, 1, '아직 닫히지 않았습니다');
  for (let i = 0; i < 20; i += 1) machine.tick();
  assert.deepEqual(view.shown.slice(-1), [null], '시간이 차면 닫힙니다');
});

test('작품을 처음부터 시작하면 열려 있던 표 창은 닫힌다', () => {
  const { machine, view } = runWithTable('show 점수표');
  machine.tick();
  assert.deepEqual(view.shown.slice(-1), ['점수 표']);
  machine.stop();
  machine.start();
  assert.deepEqual(view.shown.slice(-1), [null]);
});

// Restore origin because saved data may be empty even when original rows remain.
test('표는 처음 값(origin)을 읽는다', () => {
  const table = Table.from({
    id: 't', name: '표', fields: ['A', 'B'],
    data: [],
    origin: [[0, 1], [2, 3]],
  } as never);
  assert.deepEqual(table.fields, ['A', 'B']);
  assert.equal(table.getValue(1, 1), 0, 'A1');
  assert.equal(table.getValue(2, 2), 3, 'B2');

  const keyed = Table.from({
    id: 't', name: '표', fields: ['A'],
    data: [{ key: 'r1', value: [7] }],
  } as never);
  assert.equal(keyed.getValue(1, 1), 7);
});

// Check Entry's two slider grip lines in source because Overlay needs a browser.
test('슬라이더 손잡이는 바탕과 쥠자리 두 색으로 그린다', () => {
  const overlay = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/overlay.ts'),
    'utf-8',
  );
  assert.match(overlay, /const SLIDE_KNOB_COLOR = '#4f80ff';/, '엔트리 그림의 바탕색');
  assert.match(overlay, /const SLIDE_GRIP_COLOR = '#3759b2';/, '엔트리 그림의 쥠자리색');
  const knob = overlay.slice(overlay.indexOf('const knobLeft ='));
  const body = knob.slice(0, knob.indexOf('view.slider.knob.position'));
  assert.match(body, /fill\(\{ color: SLIDE_KNOB_COLOR \}\)/);
  assert.match(body, /for \(const gripX of SLIDE_GRIP_X\)/, '쥠자리 두 줄을 그린다');
  assert.match(body, /fill\(\{ color: SLIDE_GRIP_COLOR \}\)/);
});

// Only slider monitors have a minimum width of 90; ordinary boxes fit their contents.
test('변수 상자는 이름과 값이 차지하는 만큼만 넓다', () => {
  const overlay = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/overlay.ts'),
    'utf-8',
  );
  const plain = overlay.slice(overlay.indexOf('  private drawValueMonitor('));
  const plainBody = plain.slice(0, plain.indexOf('\n  }'));
  assert.match(plainBody, /roundRect\(0, -14, nameWidth \+ valueWidth \+ 35, 24, 4\)/);
  assert.doesNotMatch(plainBody, /MONITOR_MIN_WIDTH/, '보통 상자에는 최소 너비가 없습니다');

  const slide = overlay.slice(overlay.indexOf('  private drawSlideMonitor('));
  assert.match(
    slide.slice(0, slide.indexOf('\n  }')),
    /Math\.max\(nameWidth \+ valueWidth \+ 35, MONITOR_MIN_WIDTH\)/,
    '슬라이더 상자는 최소 너비를 지킵니다',
  );
});

test('오브젝트 변수 상자는 오브젝트 이름을 앞에 붙인다', () => {
  const overlay = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/overlay.ts'),
    'utf-8',
  );
  const named = overlay.slice(overlay.indexOf('  private monitorName('));
  const body = named.slice(0, named.indexOf('\n  }'));
  assert.match(body, /owner \? `\$\{owner\}:\$\{variable\.name\}` : variable\.name/);
  assert.equal(overlay.split('this.monitorName(variable)').length - 1, 3);
});

test('목록 상자에는 크기 조절 손잡이가 있다', () => {
  const overlay = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/overlay.ts'),
    'utf-8',
  );
  assert.match(overlay, /const LIST_HANDLE_SIZE = 14 \* 0\.7;/, '엔트리 그림과 같은 크기');
  assert.match(overlay, /listHandleAt\(x: number, y: number\): Variable \| null/);
  assert.match(overlay, /export const LIST_MIN_SIZE = 100;/, 'setWidth·setHeight 의 하한');

  const boot = fs.readFileSync(path.join(root, 'packages/tessvm/src/web/boot.ts'), 'utf-8');
  assert.match(boot, /listHandleAt\(vm\.mouseX, -vm\.mouseY\)/, '손잡이를 누르면 잡는다');
  assert.match(boot, /Math\.max\(LIST_MIN_SIZE, point\.x - resizing\.fromX\)/, '끌면 커진다');
});

// Convert one-based Tess chart numbers to zero-based Entry indices.
test('차트 창은 고른 번호의 차트를 띄운다', () => {
  const source = `table 판매:
  columns "분기", "서울"
  row "1분기", 120
  chart bar "막대" x 1 series 2
  chart pie "원" x 1 y 2
end

scene "s":
  object "o":
    when start do
      show 판매 chart 2
    end
  end
end`;
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const view = tableStage();
  const machine = new Vm({ renderer: view as never, audio: null });
  machine.load(result.project as unknown as never);
  machine.start();
  machine.tick();
  assert.deepEqual(view.shown.slice(-1), ['판매/차트1'], '두 번째 차트는 엔트리의 1번입니다');

  const table = machine.tables[0]!;
  assert.deepEqual(
    table.charts.map((chart) => [chart.type, chart.xIndex, chart.yIndex, chart.categoryIndexes]),
    [['bar', 0, -1, [1]], ['pie', 0, 1, []]],
  );
});

// Chart rendering is checked separately; verify only the page-to-view wiring here.
test('차트 창은 캔버스가 아니라 HTML 로 띄운다', () => {
  const overlay = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/overlay.ts'),
    'utf-8',
  );
  assert.match(
    overlay,
    /this\.openTable = chart === null \? table : null;/,
    '차트 번호가 붙은 창은 캔버스가 그리지 않습니다',
  );
  const boot = fs.readFileSync(path.join(root, 'packages/tessvm/src/web/boot.ts'), 'utf-8');
  assert.match(boot, /mountChartWindow\(frame, \(\) => vm\.openTable\(null\)\)/, '창을 무대 옆에 올린다');
  assert.match(boot, /chartWindow\.show\(table, chart\)/);
  assert.match(boot, /chartWindow\.hide\(\)/);
  for (const file of ['packages/tessvm/src/node/page.ts', 'packages/extension/src/page/player.ts']) {
    assert.match(
      fs.readFileSync(path.join(root, file), 'utf-8'),
      /CHART_WINDOW_STYLE/,
      file,
    );
  }
});

// Entry catches function stack overflow inside the call and lets the caller continue.
test('끝없는 재귀는 엔트리처럼 오류로 멈춘다', () => {
  const vm = runVm(
    wrap(
      `깊이 = 0
      재귀()
      끝났다 = 1`,
      `var 깊이 = 0
var 끝났다 = 0

function 재귀():
  깊이 = 깊이 + 1
  재귀()
end`,
    ),
  );
  vm.tick();
  assert.deepEqual(vm.errors.map((error) => error.message), ['함수 호출이 너무 깊습니다 (끝나지 않는 재귀)']);
  assert.match(vm.errors[0]!.where!, /함수 재귀 ×1000001$/, "the call that passed the limit counts too");
  assert.equal(valueOf(vm, '끝났다'), 0, '부르던 자리도 이어지지 않습니다');
  assert.equal(valueOf(vm, '깊이'), 1000000, '한계(100만)까지 자바스크립트 스택과 상관없이 들어갑니다');
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/compile/codegen.ts'),
    'utf-8',
  );
  assert.match(source, /const CALL_DEPTH_LIMIT = \d+;/, '한계는 이름 붙은 상수입니다');
});

test('재귀 한계는 호출이 끝나면 돌아온다', () => {
  const vm = runVm(
    wrap(
      `한번()
      한번()
      한번()`,
      `var 횟수 = 0

function 한번():
  횟수 = 횟수 + 1
end`,
    ),
  );
  vm.tick();
  assert.equal(valueOf(vm, '횟수'), 3, '깊이는 함수가 끝날 때마다 되돌아옵니다');
});

const EXTRA_WORK = `var TESSVM as "$TESSVM" = 0
var CLIPBOARD as "$CLIPBOARD" = ""
var CURSOR as "$CURSOR" = ""
var LOCK as "$MOUSE_LOCK" = 0
var DX as "$DELTA_X" = 0
var DY as "$DELTA_Y" = 0
var SX as "$SCROLL_X" = 0
var SY as "$SCROLL_Y" = 0
var 스크롤 = 0

scene "s":
  object "o":
    when start do
      wait 10
    end

    when signal "$SCROLL" do
      스크롤 = 스크롤 + 1
    end
  end
end`;

function extrasVm(): { vm: Vm; calls: string[][] } {
  const vm = runVm(EXTRA_WORK);
  const calls: string[][] = [];
  vm.extras.host = {
    copy: (text) => calls.push(['copy', text]),
    cursor: (value) => calls.push(['cursor', value]),
    lock: (on) => calls.push(['lock', String(on)]),
    release: () => calls.push(['release']),
  };
  return { vm, calls };
}

const extraValue = (vm: Vm, name: string) =>
  vm.variables.find((variable) => variable.name === name)?.getValue();

test('$TESSVM 은 작품이 한 블록도 돌기 전에 1 이다', () => {
  const vm = runVm(EXTRA_WORK);
  assert.equal(extraValue(vm, '$TESSVM'), 1);
  vm.stop();
  vm.reset();
  assert.equal(extraValue(vm, '$TESSVM'), 1, '멈춰도 되돌아가지 않습니다');
});

test('$TESSVM 이 없는 작품은 아무것도 쓰지 않는다', () => {
  const vm = runVm(wrap('wait 1'));
  assert.deepEqual(vm.extras.uses, {
    clipboard: false,
    cursor: false,
    mouseLock: false,
    scroll: false,
  });
});

test('$CLIPBOARD 에 쓰면 복사를 맡기고, 같은 값을 다시 써도 다시 맡긴다', () => {
  const { vm, calls } = extrasVm();
  const clipboard = vm.variables.find((variable) => variable.name === '$CLIPBOARD')!;
  clipboard.setValue('가나다');
  vm.tick();
  clipboard.setValue('가나다');
  vm.tick();
  assert.deepEqual(calls, [['copy', '가나다'], ['copy', '가나다']]);
});

test('붙여넣은 값은 $CLIPBOARD 로 들어오고 다시 복사되지 않는다', () => {
  const { vm, calls } = extrasVm();
  vm.extras.pasted('붙여넣기');
  vm.tick();
  assert.equal(extraValue(vm, '$CLIPBOARD'), '붙여넣기');
  assert.deepEqual(calls, [], '들어온 값을 되돌려 복사하지 않습니다');
});

test('$CURSOR 는 css 가 아는 이름만 넘긴다', () => {
  const { vm, calls } = extrasVm();
  const cursor = vm.variables.find((variable) => variable.name === '$CURSOR')!;
  cursor.setValue('Pointer');
  vm.tick();
  cursor.setValue('url(http://x/y.png)');
  vm.tick();
  assert.deepEqual(calls, [['cursor', 'pointer'], ['cursor', '']]);
});

test('엔트리 이름 길이에 맞춘 $M_LOCK 도 같은 자리로 읽는다', () => {
  // Short aliases keep extension names usable inside Entry's ten-character name limit.
  const vm = runVm(EXTRA_WORK.replace('"$MOUSE_LOCK"', '"$M_LOCK"'));
  const calls: string[][] = [];
  vm.extras.host = {
    copy: () => undefined,
    cursor: () => undefined,
    lock: (on) => calls.push(['lock', String(on)]),
    release: () => undefined,
  };
  assert.equal(vm.extras.uses.mouseLock, true);
  vm.variables.find((variable) => variable.name === '$M_LOCK')!.setValue(1);
  vm.tick();
  assert.deepEqual(calls, [['lock', 'true']]);
  vm.extras.lockChanged(false);
  assert.equal(extraValue(vm, '$M_LOCK'), 0, '돌려주는 자리도 같은 이름입니다');
});

test('$MOUSE_LOCK 은 페이지에 맡기고, 놓친 것은 다시 0 이 된다', () => {
  const { vm, calls } = extrasVm();
  const lock = vm.variables.find((variable) => variable.name === '$MOUSE_LOCK')!;
  lock.setValue(1);
  vm.tick();
  assert.deepEqual(calls, [['lock', 'true']]);
  vm.extras.lockChanged(true);
  vm.extras.moved(7, -3);
  vm.tick();
  assert.equal(extraValue(vm, '$DELTA_X'), 7);
  assert.equal(extraValue(vm, '$DELTA_Y'), -3);
  vm.tick();
  assert.equal(extraValue(vm, '$DELTA_X'), 0, '움직이지 않은 프레임은 0 입니다');
  // Escape releases pointer lock without counting as another work request.
  vm.extras.lockChanged(false);
  vm.tick();
  assert.equal(extraValue(vm, '$MOUSE_LOCK'), 0);
  assert.deepEqual(calls, [['lock', 'true']]);
});

test('스크롤은 한 프레임에 신호 하나와 그 프레임의 합을 준다', () => {
  const { vm } = extrasVm();
  vm.extras.scrolled(0, -1);
  vm.extras.scrolled(0, -0.5);
  vm.tick();
  assert.equal(extraValue(vm, '$SCROLL_Y'), -1.5);
  vm.tick();
  assert.equal(valueOf(vm, '스크롤'), 1, '신호는 한 번만 올라갑니다');
});

test('작품이 멈추면 페이지가 빌려준 것을 돌려받는다', () => {
  const { vm, calls } = extrasVm();
  vm.stop();
  assert.deepEqual(calls, [['release']]);
});

// Stop-project resets the player; stop-all-scripts leaves it running.
test('stop project 는 실행기를 멈추고 처음 상태로 되돌린다', () => {
  const vm = runVm(
    wrap(
      `점수 = 7
      stop project
      점수 = 9`,
      'var 점수 = 0',
    ),
  );
  vm.tick();
  assert.equal(vm.state, 'stop');
  assert.equal(valueOf(vm, '점수'), 0, '멈추면 변수는 저장된 값으로 돌아갑니다');
});

test('확장 플레이어에는 우클릭 메뉴가 있다', () => {
  const player = fs.readFileSync(
    path.join(root, 'packages/extension/src/page/player.ts'),
    'utf-8',
  );
  assert.match(player, /addEventListener\("contextmenu"/);
  for (const label of ['정지', '일시정지', '이전 장면', '다음 장면']) {
    assert.ok(player.includes(`"${label}"`), label);
  }
  const css = fs.readFileSync(path.join(root, 'packages/extension/src/player.css'), 'utf-8');
  assert.match(css, /\.tessvm-menu button \{/, '메뉴 단추 모양은 페이지의 button 초기화를 이깁니다');
});

// Permission dialogs need their own readable size instead of shrinking with the stage.
test('허용 창 크기는 무대 폭을 따라가지 않는다', () => {
  const style = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/web/extras.ts'),
    'utf-8',
  );
  const block = style.slice(
    style.indexOf('EXTRAS_DIALOG_STYLE'),
    style.indexOf('interface Request'),
  );
  assert.equal(block.includes('--tessvm-stage-width'), false, '무대 폭을 읽지 않습니다');
  assert.match(block, /padding: 9px 16px;/, '단추는 고정 픽셀입니다');
});

// Frameless inner loops must not multiply the outer loop's frame cost.
test('프레임을 쓰지 않는 반복은 바깥 반복의 한 바퀴를 늦추지 않는다', () => {
  const vm = runVm(`
var 높이 = 0
var 남은 = 0

function 한번에_다_그리기():
  남은 = 16
  forever:
    남은 -= 1
    if (남은 < 1):
      break
    end
    skip
  end
end

scene "s":
  object "o":
    when start do
      forever:
        한번에_다_그리기()
        높이 += 1
      end
    end
  end
end`);
  for (let frame = 1; frame <= 5; frame += 1) {
    vm.tick();
    assert.equal(valueOf(vm, '높이'), frame, `${frame} 프레임이면 ${frame} 바퀴입니다`);
  }
});

function fillCovers(parts: number[][], x: number, y: number): boolean {
  for (const quad of parts) {
    let negative = false;
    let positive = false;
    for (let at = 0; at < 4; at += 1) {
      const ax = quad[at * 2]!;
      const ay = quad[at * 2 + 1]!;
      const bx = quad[((at + 1) % 4) * 2]!;
      const by = quad[((at + 1) % 4) * 2 + 1]!;
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (cross < -1e-9) negative = true;
      if (cross > 1e-9) positive = true;
    }
    if (!(negative && positive)) return true;
  }
  return false;
}

// Canvas uses nonzero winding for intersecting paths; PIXI's outline triangulation differs.
test('스스로 가로지르는 채우기 경로는 nonzero 로 풀린다', () => {
  const cell = 24;
  const size = 8;
  const points: number[] = [];
  let x = 0;
  let y = 0;
  const mark = () => points.push(x, y);
  mark();
  for (let round = 0; round < size / 2; round += 1) {
    x += cell * size; mark();
    y -= cell; mark();
    x -= cell * size; mark();
    y -= cell; mark();
  }
  for (let round = 0; round < size / 2; round += 1) {
    y += cell * size; mark();
    x += cell; mark();
    y -= cell * size; mark();
    x += cell; mark();
  }
  y += cell * size; mark();

  const parts = nonzeroParts(points);
  assert.ok(parts, '사다리꼴로 풀려야 합니다');
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const covered = fillCovers(parts, (col + 0.5) * cell, -(row + 0.5) * cell);
      assert.equal(covered, (row + col) % 2 === 0, `${row}행 ${col}열`);
    }
  }
});

test('가로지르지 않는 채우기 경로는 모양이 그대로다', () => {
  const parts = nonzeroParts([0, 0, 10, 0, 10, 10, 0, 10]);
  assert.ok(parts);
  assert.equal(parts.length, 1);
  for (const [x, y] of [[5, 5], [1, 9], [9, 1]] as const) {
    assert.equal(fillCovers(parts, x, y), true, `(${x},${y}) 는 안입니다`);
  }
  for (const [x, y] of [[-1, 5], [11, 5], [5, 12]] as const) {
    assert.equal(fillCovers(parts, x, y), false, `(${x},${y}) 는 바깥입니다`);
  }
});

// Both bow-tie wings have nonzero winding and must be filled.
test('꼬인 사각형은 두 날개가 모두 칠해진다', () => {
  const parts = nonzeroParts([0, 0, 20, 20, 20, 0, 0, 20]);
  assert.ok(parts);
  assert.equal(fillCovers(parts, 4, 10), true, '왼쪽 날개');
  assert.equal(fillCovers(parts, 16, 10), true, '오른쪽 날개');
  assert.equal(fillCovers(parts, 10, 3), false, '가운데 위아래는 바깥');
  assert.equal(fillCovers(parts, 10, 17), false, '가운데 위아래는 바깥');
});

// Boost changes Entry's fill rule as well as its reported boolean value.
test('부스트 모드는 채우기를 칠하는 방식까지 고른다', () => {
  const cell = 24;
  const size = 4;
  const points: number[] = [];
  let x = 0;
  let y = 0;
  const mark = () => points.push(x, y);
  mark();
  for (let round = 0; round < size / 2; round += 1) {
    x += cell * size; mark();
    y -= cell; mark();
    x -= cell * size; mark();
    y -= cell; mark();
  }
  for (let round = 0; round < size / 2; round += 1) {
    y += cell * size; mark();
    x += cell; mark();
    y -= cell * size; mark();
    x += cell; mark();
  }
  y += cell * size; mark();

  assert.equal(fillParts(points, true), null, '부스트 모드는 PIXI 에 그대로 넘깁니다');
  const canvas = fillParts(points, false);
  assert.ok(canvas, '부스트를 끄면 nonzero 로 풀어서 넘깁니다');
  assert.deepEqual(canvas, nonzeroParts(points));
});

// Canvas centers the first line; boost centers the whole text block.
test('글상자의 세로 정렬과 폭도 부스트 모드를 따라간다', () => {
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/renderer.ts'),
    'utf-8',
  );
  const block = source.slice(
    source.indexOf('private syncTextBox'),
    source.indexOf('private textResolution'),
  );
  assert.match(block, /this\.options\.boost === false/, '세로 정렬이 부스트를 봅니다');
  assert.match(block, /text\.anchor\.set\(anchorX, 0\.5\)/, '부스트 모드는 가운데 정렬입니다');
  const measure = source.slice(
    source.indexOf('measureTextBox(entity: Entity)'),
    source.indexOf('private measureWhole'),
  );
  assert.match(measure, /this\.options\.boost === false/, '폭도 부스트를 봅니다');
});

// Notify the renderer when VM boost changes so drawing rules update too.
test('돌아가는 중에 부스트를 바꾸면 렌더러도 다시 그린다', () => {
  const told: boolean[] = [];
  const vm = new Vm({
    renderer: {
      addEntity() {},
      removeEntity() {},
      flush() {},
      setBoost(on: boolean) {
        told.push(on);
      },
    } as never,
    audio: null,
  });

  assert.equal(vm.boost, true, '기본은 켬입니다');
  vm.boost = false;
  assert.equal(vm.boost, false);
  assert.deepEqual(told, [false], '렌더러에게 한 번 알립니다');

  vm.boost = false;
  assert.deepEqual(told, [false], '같은 값이면 다시 그리지 않습니다');

  vm.boost = true;
  assert.deepEqual(told, [false, true]);
});

// Include drawn costume scale when choosing vector texture sharpness.
test('벡터 모양의 굽는 배율은 실제로 그리는 크기를 따라간다', () => {
  // Keep minimum-side and maximum-pixel limits inactive to isolate scale behavior.
  const plain = svgSharpness(3, 400, 400);
  const bigger = svgSharpness(3, 400, 400, 1, 1.5);
  assert.ok(bigger > plain, `${bigger} > ${plain}`);
  assert.equal(bigger, plain * 1.5);

  assert.equal(svgSharpness(3, 400, 400, 1, 0.25), plain);

  const huge = svgSharpness(3, 2048, 2048, 1, 4);
  assert.ok(huge <= MAX_TEXTURE_SIDE / 2048, String(huge));
});

// Follow screen sharpness rather than a fixed SVG scale ceiling.
test('벡터 화질은 화면이 요구하는 만큼 따라 올라간다', () => {
  for (const display of [4, 6, 8]) {
    assert.equal(svgSharpness(display, 278, 109), display, `displayScale ${display}`);
  }
  const huge = svgSharpness(8, 960, 540);
  assert.ok(960 * huge <= MAX_TEXTURE_SIDE && 960 * huge * 540 * huge <= 2048 * 2048 * 1.01, String(huge));
  assert.equal(svgSharpness(1, 480, 480), 3);
});

// Set SVG dimensions before image loading so the browser rasterizes at the requested size.
test('벡터는 목표 픽셀 크기를 박은 사본으로 굽는다', () => {
  const plain = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 278 109"><path d="M0 0"/></svg>';
  const sized = sizedVector(plain, 834, 327);
  assert.match(sized, /^data:image\/svg\+xml;charset=utf-8,/, 'PIXI 가 svg 로 알아보는 주소');
  const markup = decodeURIComponent(sized.slice(sized.indexOf(',') + 1));
  assert.match(markup, /<svg[^>]*\swidth="834"/);
  assert.match(markup, /<svg[^>]*\sheight="327"/);
  assert.match(markup, /viewBox="0 0 278 109"/, 'viewBox 는 그대로 — 그림은 달라지지 않습니다');
  assert.match(markup, /<path d="M0 0"\/>/, '본문도 그대로입니다');

  const had = sizedVector('<svg width="10" height="4" viewBox="0 0 10 4"></svg>', 100, 40);
  const second = decodeURIComponent(had.slice(had.indexOf(',') + 1));
  assert.match(second, /width="100"/);
  assert.doesNotMatch(second, /width="10"(?!0)/);

  // Fall back to the original URL when no root SVG element exists.
  assert.equal(sizedVector('그림이 아님', 10, 10), '');
});

// Filter resolution must follow the renderer or effects blur high-resolution sprites.
test('효과 필터는 캔버스 배율을 그대로 따라간다', () => {
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/renderer.ts'),
    'utf-8',
  );
  const block = source.slice(
    source.indexOf('private applyEffects'),
    source.indexOf('private syncTextBox'),
  );
  assert.match(block, /new ColorMatrixFilter\(\{[^}]*resolution: 'inherit'/, '배율을 물려받습니다');
  assert.match(block, /antialias: 'inherit'/, '앤티에일리어싱도 물려받습니다');
});

// Cache finished stroke splits because redrawing growing groups otherwise repeats quadratic work.
test('끝난 획은 프레임마다 다시 자르지 않는다', () => {
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/renderer.ts'),
    'utf-8',
  );
  const block = source.slice(
    source.indexOf('private drawPenRun'),
    source.indexOf('private stopObject'),
  );
  assert.match(block, /this\.fillCache\.get\(piece\)/, '잘라 둔 것을 먼저 찾습니다');
  assert.match(block, /this\.fillCache\.set\(piece,/, '새로 자른 것은 붙들어 둡니다');
  assert.match(block, /known\.boost === boost/, '부스트가 바뀌면 다시 자릅니다');
  assert.match(block, /traceFlipped\(piece\.points\)/);

  const boostBlock = source.slice(source.indexOf('setBoost(on: boolean)'), source.indexOf('setScene(sceneId'));
  assert.match(boostBlock, /this\.fillCache = new WeakMap\(\)/, '부스트가 바뀌면 버립니다');
});

// Reuse unchanged fill objects because PIXI checks their identity and rebakes text on replacement.
test('글상자 색은 달라질 때만 PIXI 에 넣는다', () => {
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/renderer.ts'),
    'utf-8',
  );
  const block = source.slice(
    source.indexOf('private syncTextBox'),
    source.indexOf('private textResolution'),
  );
  assert.match(block, /if \(view\.colour !== entity\.colour\) \{/, '색이 달라질 때만 넣습니다');
  const fills = block.match(/style\.fill = \{/g) ?? [];
  assert.equal(fills.length, 1, '넣는 자리는 그 안 한 군데뿐입니다');
  assert.match(block, /view\.colour = entity\.colour;/, '넣은 색을 적어 둡니다');
});

// Reference-count shared rasterizations so another runner or stamp cannot lose its texture.
test('구운 벡터 모양은 마지막으로 쥔 쪽이 놓을 때만 내린다', () => {
  const source = fs.readFileSync(
    path.join(root, 'packages/tessvm/src/render/renderer.ts'),
    'utf-8',
  );
  // Unload textures only through the reference-counted release helper.
  const unloads = source.match(/Assets\.unload\(/g) ?? [];
  assert.equal(unloads.length, 1, '내리는 자리는 한 군데입니다');
  const release = source.slice(
    source.indexOf('function releaseBaked'),
    source.indexOf('function usableColor'),
  );
  assert.match(release, /if \(held > 1\)/, '남이 쥐고 있으면 수만 줄입니다');
  assert.match(release, /Assets\.unload\(src\)/, '마지막 하나일 때만 내립니다');

  // Acquire references on initial rasterization, rerasterization, and stamping.
  const holds = source.match(/holdBaked\(/g) ?? [];
  assert.equal(holds.length, 3, '쥐는 자리는 세 군데입니다');
  assert.match(source, /private keepBaked\(id: string, baked: Baked\): void \{/);
  assert.match(source, /sprite\.__baked = baked\.src;/, '도장은 쥔 것을 적어 둡니다');

  // Release stamps through dropStamp on every removal path.
  assert.doesNotMatch(source, /\bstamp\.destroy\(\)/, '도장을 바로 없애지 않습니다');
  const drops = source.match(/this\.dropStamp\(stamp\)/g) ?? [];
  assert.equal(drops.length, 4, '도장을 없애는 자리는 모두 그리로 갑니다');
});

test('tessvm - 시작 장면을 정하면 그 장면에서 실행을 시작한다', () => {
  const source = [
    'project:',
    '  title "장면"',
    'end',
    '',
    'scene "무대":',
    '  object "하나":',
    '    when start do',
    '      x = 10',
    '    end',
    '  end',
    'end',
    '',
    'scene "무대2":',
    '  object "둘":',
    '    when start do',
    '      x = 20',
    '    end',
    '  end',
    'end',
    '',
  ].join('\n');
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const project = result.project as unknown as EntryProject;
  const second = project.scenes[1]!;

  const first = new Vm({ renderer: null, audio: null });
  first.load(project as unknown as never);
  first.start();
  assert.equal(first.currentSceneId, project.scenes[0]!.id);

  const vm = new Vm({ renderer: null, audio: null });
  vm.load(project as unknown as never);
  vm.setStartScene(second.name);
  assert.equal(vm.currentSceneId, second.id);
  vm.start();
  assert.equal(vm.currentSceneId, second.id);
  vm.stop();
  vm.start();
  assert.equal(vm.currentSceneId, second.id);

  vm.stop();
  vm.setStartScene('없는 장면');
  vm.start();
  assert.equal(vm.currentSceneId, project.scenes[0]!.id);
});
