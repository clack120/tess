import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '@tess/compiler';
import { Vm, planKernel } from '@tess/vm';
import type { KernelPlan } from '@tess/vm';

test('the JS kernel preserves untouched scalar text and falls back without partial writes', () => {
  const source = `
var text_value = "000123"
var flag = 0
var ret = 0
var calls = 0
function f():
  calls += 1
  if (flag == 1):
    text_value += 1
  end
  return 0
end
object "o":
  when start do
    forever:
      ret = f()
    end
  end
end`;
  for (const initial of ['000123', '9007199254740993', '-0', '123', '0.50']) {
    const work = project(source);
    const plain = new Vm({ renderer: null, audio: null });
    const optimized = new Vm({ renderer: null, audio: null, kernel: true });
    for (const vm of [plain, optimized]) {
      vm.load(structuredClone(work));
      vm.start();
      vm.variables.find((v) => v.name === 'text_value')!.setValue(initial);
      vm.tick();
    }
    assert.equal(snapshot(optimized), snapshot(plain), initial);
    if (['123', '0.50'].includes(initial)) assert.ok(optimized.kernel!.stats.runs > 0);
    else assert.ok(optimized.kernel!.stats.fallbacks > 0);
    for (const vm of [plain, optimized]) {
      vm.variables.find((v) => v.name === 'text_value')!.setValue('0.50');
      vm.variables.find((v) => v.name === 'flag')!.setValue(1);
      vm.tick();
    }
    assert.equal(snapshot(optimized), snapshot(plain), `${initial}: next call`);
  }
});

test('a root falling back or stepping aside leaves the other roots in the kernel', () => {
  const source = `
var text_value = "000123"
var total = 0
var ret = 0
list items = [1, 2]
function f():
  return (text_value + items[1])
end
function g():
  total += 1
  return 0
end
object "o":
  when start do
    forever:
      ret = f()
      ret = g()
    end
  end
end`;
  const work = project(source);
  const plain = new Vm({ renderer: null, audio: null });
  const optimized = new Vm({ renderer: null, audio: null, kernel: true });
  for (const vm of [plain, optimized]) {
    vm.load(structuredClone(work));
    vm.start();
    vm.variables.find((v) => v.name === 'text_value')!.setValue('abc');
    vm.tick();
  }
  const stats = optimized.kernel!.stats;
  assert.equal(optimized.kernel!.roots.size, 2);
  assert.ok(stats.fallbacks > 0, 'f falls back on text that is not a number');
  const runs = stats.runs;
  assert.ok(runs > 0, 'g still runs in the kernel');
  for (const vm of [plain, optimized]) {
    vm.variables.find((v) => v.name === 'text_value')!.setValue('5');
    const items = vm.variables.find((v) => v.name === 'items')!;
    items.array.push({ data: 3 });
    items.touch();
    vm.tick();
  }
  assert.equal(stats.dropped, 1, 'only f steps aside once its list changes length');
  assert.ok(stats.runs > runs, 'g keeps running in the kernel');
  assert.equal(snapshot(optimized), snapshot(plain));
});

function pair(source: string): [Vm, Vm] {
  const work = project(source);
  const plain = new Vm({ renderer: null, audio: null });
  const optimized = new Vm({ renderer: null, audio: null, kernel: true });
  for (const vm of [plain, optimized]) {
    vm.load(structuredClone(work));
    vm.start();
  }
  return [plain, optimized];
}

test('a kernel run writes back only the list items it stored', () => {
  const [plain, optimized] = pair(`
var ret = 0
list items = ["5", "6", "7"]
function f():
  items[1] = (items[1] + 1)
  return 0
end
object "o":
  when start do
    forever:
      ret = f()
    end
  end
end`);
  for (let i = 0; i < 3; i++) {
    plain.tick();
    optimized.tick();
  }
  assert.ok(optimized.kernel!.stats.runs > 0);
  assert.equal(snapshot(optimized), snapshot(plain));
  const kinds = (vm: Vm) => vm.variables.find((v) => v.name === 'items')!.array.map((item) => typeof item.data);
  assert.deepEqual(kinds(optimized), kinds(plain));
});

test('a list item written from outside crosses alone, not the whole list', () => {
  const items = Array.from({ length: 2000 }, (_, i) => i).join(', ');
  const [plain, optimized] = pair(`
var ret = 0
var n = 0
list items = [${items}]
function f():
  return (items[1] + items[2])
end
object "o":
  when start do
    forever:
      items[2] = n
      n += 1
      ret = f()
    end
  end
end`);
  plain.tick();
  optimized.tick();
  const stats = optimized.kernel!.stats;
  const before = stats.copied;
  for (let i = 0; i < 50; i++) {
    plain.tick();
    optimized.tick();
  }
  assert.ok(stats.runs > 0);
  assert.ok(stats.copied - before < 50 * 10, `copied ${stats.copied - before}`);
  assert.equal(snapshot(optimized), snapshot(plain));
});

test('a root that keeps falling back rests instead of trying every call', () => {
  const calls = Array.from({ length: 100 }, () => '      ret = f()').join('\n');
  const [plain, optimized] = pair(`
var ret = 0
var x = 0
function f():
  return (x + 1)
end
object "o":
  when start do
    forever:
${calls}
    end
  end
end`);
  for (const vm of [plain, optimized]) vm.variables.find((v) => v.name === 'x')!.setValue('abc');
  for (let i = 0; i < 20; i++) {
    plain.tick();
    optimized.tick();
  }
  assert.ok(optimized.kernel!.stats.fallbacks < 200, `fallbacks ${optimized.kernel!.stats.fallbacks}`);
  assert.equal(snapshot(optimized), snapshot(plain));
});

function project(source: string): never {
  const result = compileProject(source, { path: 'kernel.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  return result.project as unknown as never;
}

function planOf(source: string): KernelPlan {
  const vm = new Vm({ renderer: null, audio: null, kernel: true });
  vm.load(project(source));
  assert.ok(vm.kernelPlan, '계획이 없습니다');
  return vm.kernelPlan;
}

function runWork(source: string, ticks: number, withKernel: boolean): Vm {
  const built = project(source);
  const vm = new Vm({ renderer: null, audio: null, kernel: withKernel });
  vm.load(built);
  if (withKernel) {
    assert.ok(vm.kernel, '커널이 붙지 않았습니다');
  }
  vm.start();
  for (let at = 0; at < ticks; at += 1) {
    vm.tick();
  }
  return vm;
}

// Compare stored values and types, including numeric-looking strings.
function snapshot(vm: Vm): string {
  return JSON.stringify(vm.variables.map((variable) => ({ name: variable.name,
    value: variable.isList ? variable.array.map((item) => item.data) : variable.getValue(),
  })), (_key, value) => typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
    ? { number: Object.is(value, -0) ? '-0' : String(value) } : value);
}

function assertSameAsJavascript(source: string, ticks: number): Vm {
  const withKernel = runWork(source, ticks, true);
  const without = runWork(source, ticks, false);
  assert.equal(snapshot(withKernel), snapshot(without));
  return withKernel;
}

const NUMERIC = `
var ret = 0
var total = 0
var i = 0
list data = [1, 2, 3, 4, 5, 6, 7, 8]

function step():
  total += data[i]
  i += 1
  return 0
end

function four():
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  return 0
end

scene "s":
  object "o":
    when start do
      i = 1
      ret = four()
    end
  end
end`;

test('프레임을 넘기지 않는 숫자 함수는 커널이 가져간다', () => {
  const plan = planOf(NUMERIC);
  assert.ok(plan, '계획이 없습니다');
  assert.equal(plan.roots.size, 1);
  assert.equal(plan.rejected.size, 0);
});

test('그리기 블록이 섞인 함수는 커널이 두고 간다', () => {
  const plan = planOf(`
var ret = 0
var i = 0

function draw_step():
  i += 1
  go i i
  return 0
end

scene "s":
  object "o":
    when start do
      ret = draw_step()
    end
  end
end`);
  assert.equal(plan.roots.size, 0);
});

test('못 가는 함수를 부르는 함수도 못 간다', () => {
  const plan = planOf(`
var ret = 0
var i = 0

function leaf():
  go i i
  return 0
end

function branch():
  i += 1
  ret = leaf()
  return 0
end

function top():
  ret = branch()
  return 0
end

scene "s":
  object "o":
    when start do
      ret = top()
    end
  end
end`);
  assert.equal(plan.roots.size, 0);
});

test('자기를 부르는 함수는 깊이가 정해지지 않아 못 간다', () => {
  const plan = planOf(`
var ret = 0
var i = 0

function loop_forever():
  i += 1
  if i < 10:
    ret = loop_forever()
  end
  return 0
end

scene "s":
  object "o":
    when start do
      ret = loop_forever()
    end
  end
end`);
  assert.equal(plan.roots.size, 0);
});

test('숫자가 아닌 값이 든 리스트를 쓰는 함수는 못 간다', () => {
  const plan = planOf(`
var ret = 0
var i = 0
list names = ["ADAL", "ADAR"]

function pick():
  i += 1
  names[i] = names[1]
  return 0
end

scene "s":
  object "o":
    when start do
      ret = pick()
    end
  end
end`);
  assert.equal(plan.roots.size, 0);
});

test('반복 블록은 프레임을 넘기므로 커널이 두고 간다', () => {
  const plan = planOf(`
var ret = 0
var total = 0

function counted():
  repeat 5:
    total += 1
  end
  return 0
end

scene "s":
  object "o":
    when start do
      ret = counted()
    end
  end
end`);
  assert.equal(plan.roots.size, 0);
});

test('커널이 낸 값은 자바스크립트가 낸 값과 같다 (10진 산술)', () => {
  assertSameAsJavascript(`
var ret = 0
var sum = 0
var product = 1
var i = 0
list data = [0.1, 0.2, 0.005, 1.5, 2, 0.3333333333333333, 100, 0.0001]

function step():
  sum = sum + data[i]
  product = product * data[i]
  sum += 0.005
  i += 1
  return 0
end

function eight():
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  return 0
end

scene "s":
  object "o":
    when start do
      i = 1
      ret = eight()
    end
  end
end`, 4);
});

test('커널이 낸 값은 자바스크립트가 낸 값과 같다 (수학 블록)', () => {
  assertSameAsJavascript(`
var ret = 0
var i = 0
list angle = [0, 30, 45, 90, 135, 180, 270, 360, 12.5, -30]
list result = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

function step():
  result[i] = (((sin(angle[i]) + cos(angle[i])) + sqrt(abs(angle[i]))) + floor((angle[i] / 7)))
  i += 1
  return 0
end

function ten():
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  return 0
end

scene "s":
  object "o":
    when start do
      i = 1
      ret = ten()
    end
  end
end`, 3);
});

test('커널이 낸 값은 자바스크립트가 낸 값과 같다 (리스트 범위 밖·조건)', () => {
  assertSameAsJavascript(`
var ret = 0
var i = 0
var hits = 0
list data = [1, 2, 3]
list out = [0, 0, 0]

function step():
  # 범위 밖 번호는 엔트리에서 0 으로 읽히고, 쓰기는 아무 일도 하지 않는다.
  out[(i - 1)] = data[(i + 1)]
  if ((data[i] > 1) and (data[i] < 3)):
    hits += 1
  end
  i += 1
  return 0
end

function five():
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  return 0
end

scene "s":
  object "o":
    when start do
      i = 1
      ret = five()
    end
  end
end`, 3);
});

test('커널이 쓴 변수도 엔트리처럼 글자로 담긴다', () => {
  const vm = assertSameAsJavascript(`
var ret = 0
var clock = 0

function tick_once():
  clock += 0.005
  return 0
end

function four():
  ret = tick_once()
  ret = tick_once()
  ret = tick_once()
  ret = tick_once()
  return 0
end

scene "s":
  object "o":
    when start do
      ret = four()
    end
  end
end`, 3);
  // Variable changes retain toFixed text, so 0.02 can be stored as "0.020".
  const clock = vm.variables.find((variable) => variable.name === 'clock');
  assert.equal(clock?.getValue(), '0.020');
});

test('리스트 길이가 달라지면 커널은 물러나고 작품은 그대로 돈다', () => {
  const source = `
var ret = 0
var i = 0
var total = 0
list data = [1, 2, 3, 4]

function step():
  total += data[i]
  i += 1
  return 0
end

function four():
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  return 0
end

scene "s":
  object "o":
    when start do
      forever:
        i = 1
        ret = four()
      end
    end
  end
end`;
  const vm = runWork(source, 2, true);
  const before = vm.kernel!.stats.runs;
  assert.ok(before > 0, '커널이 한 번도 돌지 않았습니다');
  const data = vm.variables.find((variable) => variable.name === 'data')!;
  data.array.push({ data: 5 });
  data.touch();
  vm.variables.find((variable) => variable.name === 'i')!.setValue(1);
  vm.tick();
  vm.tick();
  assert.equal(vm.kernel!.stats.runs, before, '길이가 달라졌는데도 커널이 돌았습니다');
  assert.ok(vm.kernel!.stats.fallbacks > 0);
  assert.equal(vm.errors.length, 0);
});

const JUDGED = `
var ret = 0
var i = 0
list point = [4, -4, 40, -40]
list inside = [false, false, false, false]
var hits = 0

function step():
  inside[i] = ((point[i] > -10) and (point[i] < 10))
  if inside[i]:
    hits += 1
  end
  i += 1
  return 0
end

function four():
  ret = step()
  ret = step()
  ret = step()
  ret = step()
  return 0
end

scene "s":
  object "o":
    when start do
      forever:
        i = 1
        ret = four()
      end
    end
  end
end`;

test('판단을 담는 리스트도 커널이 가져간다', () => {
  const plan = planOf(JUDGED);
  assert.ok(plan.roots.size > 0);
});

test('판단 리스트는 엔트리처럼 불리언으로 남는다', () => {
  const vm = assertSameAsJavascript(JUDGED, 6);
  const inside = vm.variables.find((variable) => variable.name === 'inside')!;
  assert.deepEqual(inside.array.map((item) => item.data), [true, true, false, false]);
});

// Empty lists share offsets with later slots, so cache synchronization by variable rather than address.
test('빈 리스트 뒤에 오는 표도 제대로 건너온다', () => {
  const source = `
var ret = 0
var i = 0
var total = 0
list empty = []
list table = [2, 4, 8]

function step():
  total = ((total + table[i]) + length(empty))
  i += 1
  return 0
end

function three():
  ret = step()
  ret = step()
  ret = step()
  return 0
end

scene "s":
  object "o":
    when start do
      forever:
        i = 1
        total = 0
        ret = three()
      end
    end
  end
end`;
  const vm = assertSameAsJavascript(source, 4);
  assert.deepEqual(vm.errors, []);
  assert.equal(Number(vm.variables.find((v) => v.name === 'total')!.getValue()), 14);
});
