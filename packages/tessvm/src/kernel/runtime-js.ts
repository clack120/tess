/**
 * @fileoverview 커널이 돌 때 쓰는 받침입니다.
 *
 * 작품의 숫자는 `Float64Array` 하나에 담깁니다. 산술은 `runtime/cast.ts` 의 것을 그대로 부르므로, 블록 실행기와 커널이
 * 같은 한 벌의 10진 규칙을 씁니다 — 두 벌이 어긋날 자리가 없습니다.
 *
 * 남는 것은 상자와 이름 찾기입니다. 블록 실행기는 값 하나를 읽을 때마다
 * `Variable` 을 찾고 `{data}` 를 벗기고 형을 가리지만, 여기서는 칸 번호가
 * 컴파일 때 정해져 있어 `cells[i]` 한 번입니다.
 */
import * as cast from '../runtime/cast.ts';
import { BAIL_SLOT } from './plan.ts';
import { scalarPlaces } from './values.ts';

/** What the generated javascript is handed as `R`. */
export interface KernelOps {
  ld(slot: number): number;
  st(slot: number, value: number): void;
  ld_item(base: number, length: number, index: number): number;
  st_item(base: number, length: number, index: number, value: number, string?: boolean): void;
  raw(slot: number): number | string;
  st_raw(slot: number, value: unknown): void;
  raw_item(base: number, length: number, index: number): number | string;
  st_item_raw(base: number, length: number, index: number, value: unknown): void;
  ld_tail(base: number, length: number, index: number): number;
  add_num(a: number, b: number, ta: number, tb: number): number;
  sub_num(a: number, b: number, ta: number, tb: number): number;
  mul_num(a: number, b: number, ta: number, tb: number): number;
  div_num(a: number, b: number): number;
  math_op(value: number, op: number): number;
  quotient(left: number, right: number, remainder: boolean): number;
  to_num(value: unknown): number;
  truthy(value: unknown): boolean;
  js_bool(value: unknown): boolean;
  plus(a: unknown, b: unknown): number | string;
  compare(a: unknown, b: unknown, operator: string): boolean;
  increment_points(value: unknown): number;
  both(a: boolean, b: boolean, isAnd: boolean): boolean;
  bail(): void;
  float_point(value: number): number;
}

/** `calc_operation` operators in the order `plan.ts` numbers them. */
const MATH_OPS = [
  'square', 'factorial', 'root', 'log', 'ln', 'asin', 'acos', 'atan',
  'sin', 'cos', 'tan', 'unnatural', 'abs', 'floor', 'ceil', 'round',
];

const SQRT3 = Math.sqrt(3);
const HALF_SQRT2 = Math.SQRT1_2;

/** The whole turns entry answers from a table rather than from the library. */
const TRIG: Record<string, Record<number, number>> = {
  sin: {
    0: 0, 30: 0.5, 45: HALF_SQRT2, 60: SQRT3 / 2, 90: 1, 120: SQRT3 / 2,
    135: HALF_SQRT2, 150: 0.5, 180: 0, 210: -0.5, 225: -HALF_SQRT2,
    240: -SQRT3 / 2, 270: -1, 300: -SQRT3 / 2, 315: -HALF_SQRT2, 330: -0.5, 360: 0,
  },
  cos: {
    0: 1, 30: SQRT3 / 2, 45: HALF_SQRT2, 60: 0.5, 90: 0, 120: -0.5, 135: -HALF_SQRT2,
    150: -SQRT3 / 2, 180: -1, 210: -SQRT3 / 2, 225: -HALF_SQRT2, 240: -0.5, 270: 0,
    300: 0.5, 315: HALF_SQRT2, 330: SQRT3 / 2, 360: 1,
  },
  tan: {
    0: 0, 30: SQRT3 / 3, 45: 1, 60: SQRT3, 90: Infinity, 120: -SQRT3, 135: -1,
    150: -SQRT3 / 3, 180: 0, 210: SQRT3 / 3, 225: 1, 240: SQRT3, 270: -Infinity,
    300: -SQRT3, 315: -1, 330: -SQRT3 / 3, 360: 0,
  },
};

function preciseTrig(degrees: number, operator: 'sin' | 'cos' | 'tan'): number {
  const angle = degrees % 360;
  const table = TRIG[operator]!;
  if (Object.prototype.hasOwnProperty.call(table, angle)) {
    return table[angle]!;
  }
  return Math[operator]((angle * Math.PI) / 180);
}

function factorial(n: number): number {
  let result = 1;
  for (let at = 2; at <= n; at += 1) {
    result *= at;
  }
  return result;
}

/**
 * Which list items a run stored into: a flag per cell, and the lowest and
 * highest flagged one so clearing and scanning stay inside what was touched.
 * Plain variables are not marked; a store there stays one assignment.
 */
export interface KernelMarks {
  flags: Uint8Array;
  strings: Uint8Array;
  span: Int32Array;
}

function floatPoint(value: unknown): number {
  const source = String(value);
  const dot = source.indexOf('.');
  return dot === -1 ? 0 : Math.min(source.length - dot - 1, 20);
}

/** Builds the helper set the generated javascript reads its world through. */
export function kernelOps(cells: Float64Array, marks: KernelMarks): KernelOps {
  const { flags, strings, span } = marks;
  const item = (base: number, length: number, index: number): number =>
    index !== Math.trunc(index) || index < 1 || index > length
      ? 0
      : cells[base + index - 1]!;
  const storeItem = (base: number, length: number, index: number, value: number, string = false) => {
    if (index === Math.trunc(index) && index >= 1 && index <= length) {
      const cell = base + index - 1;
      cells[cell] = value;
      strings[cell] = string ? 1 : 0;
      if (flags[cell] === 0) {
        flags[cell] = 1;
        if (cell < span[0]!) span[0] = cell;
        if (cell > span[1]!) span[1] = cell;
      }
    }
  };
  return {
    ld: (slot) => cells[slot]!,
    st: (slot, value) => {
      cells[slot] = value;
    },
    ld_item: item,
    st_item: storeItem,
    raw: (slot) => {
      const value = cells[slot]!, places = cells[slot + 1]!;
      return places >= 0 ? value.toFixed(places) : places === -2 ? String(value) : value;
    },
    st_raw: (slot, value) => {
      const places = scalarPlaces(value);
      if (places === null) { cells[BAIL_SLOT] = 1; return; }
      cells[slot] = Number(value);
      cells[slot + 1] = places;
    },
    raw_item: (base, length, index) => {
      const value = item(base, length, index);
      return index === Math.trunc(index) && index >= 1 && index <= length && strings[base + index - 1] ? String(value) : value;
    },
    st_item_raw: (base, length, index, value) => {
      if (typeof value === 'number') storeItem(base, length, index, value);
      else if (typeof value === 'string' && cast.isNumber(value) && String(Number(value)) === value) {
        storeItem(base, length, index, Number(value), true);
      } else cells[BAIL_SLOT] = 1;
    },
    ld_tail: item,
    add_num: cast.addNumWith,
    sub_num: cast.subNumWith,
    mul_num: cast.mulNumWith,
    div_num: cast.divNum,
    math_op: (value, op) => {
      switch (MATH_OPS[op]) {
        case 'square': return value * value;
        case 'factorial': return factorial(value);
        case 'root': return Math.sqrt(value);
        case 'log': return Math.log(value) / Math.LN10;
        case 'ln': return Math.log(value);
        case 'asin': return (Math.asin(value) * 180) / Math.PI;
        case 'acos': return (Math.acos(value) * 180) / Math.PI;
        case 'atan': return (Math.atan(value) * 180) / Math.PI;
        case 'sin': return preciseTrig(value, 'sin');
        case 'cos': return preciseTrig(value, 'cos');
        case 'tan': return preciseTrig(value, 'tan');
        case 'unnatural': {
          const fraction = cast.subNum(value, Math.floor(value));
          return value < 0 && fraction !== 0 ? 1 - fraction : fraction;
        }
        case 'abs': return Math.abs(value);
        case 'floor': return Math.floor(value);
        case 'ceil': return Math.ceil(value);
        default: return Math.round(value);
      }
    },
    quotient: (left, right, remainder) => {
      const share = Math.floor(left / right);
      return remainder ? left - right * share : share;
    },
    to_num: cast.num,
    truthy: (value) => cast.bool(value),
    js_bool: (value) => Boolean(value),
    both: (a, b, isAnd) => (isAnd ? a && b : a || b),
    plus: cast.calcPlus,
    compare: (a, b, operator) => {
      switch (operator) {
        case 'EQUAL': return cast.cmpEqual(a, b);
        case 'NOT_EQUAL': return cast.cmpNotEqual(a, b);
        case 'GREATER': return cast.cmpGreater(a, b);
        case 'LESS': return cast.cmpLess(a, b);
        case 'GREATER_OR_EQUAL': return cast.cmpGreaterEqual(a, b);
        default: return cast.cmpLessEqual(a, b);
      }
    },
    increment_points: (value) => {
      if (!cast.isNumber(value)) { cells[BAIL_SLOT] = 1; return 0; }
      return floatPoint(cast.parseNumber(value));
    },
    bail: () => {
      cells[BAIL_SLOT] = 1;
    },
    float_point: floatPoint,
  };
}
