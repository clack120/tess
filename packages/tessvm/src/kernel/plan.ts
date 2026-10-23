// Compile only frameless numeric call trees with safe data and no call cycles.
import {
  collectParams,
  findFunctionDefine,
  functionBody,
  parseScript,
  type FunctionEntry,
  type RawBlock,
} from '../compile/codegen.ts';
import type { Variable } from '../runtime/model.ts';
import { isNumber, parseNumber } from '../runtime/cast.ts';
import { scalarPlaces } from './values.ts';

// Slot zero signals that the bridge must discard the kernel run.
export const BAIL_SLOT = 0;

// Variable data starts at this Float64 offset.
const FIRST_SLOT = 1;

const JS = {
  pick: (cond: string, left: string, right: string) => `(${cond} ? ${left} : ${right})`,
  not: (value: string) => `(!(${value}))`,
  floor: (value: string) => `Math.floor(${value})`,
  ifOpen: (cond: string) => `if (${cond}) {`,
  end: ';',
  let: (name: string, value: string) => `const ${name} = ${value};`,
  local: (name: string, value: string) => `let ${name} = ${value};`,
  discard: (call: string) => `${call};`,
  open: (name: string, arity: number, id: string) => `// ${id.replace(/[\r\n\u2028\u2029]/g, ' ')}\nfunction ${name}(${
    Array.from({ length: arity }, (_, at) => `a${at}`).join(', ')
  }) {`,
  close: '}',
  entry: (name: string, arity: number, inner: string, id: string) => {
    const args = Array.from({ length: arity }, (_, at) => `a${at}`);
    return `// Entry point for ${id.replace(/[\r\n\u2028\u2029]/g, ' ')}.\nfunction ${name}(${args.join(', ')}) {\n` +
      `  st(${BAIL_SLOT}, 0);\n  return ${inner}(${args.join(', ')});\n}\n`;
  },
  module: (bodies: string[], roots: string[]) =>
    `"use strict";\nconst { ld, st, ld_item, st_item, ld_tail, add_num, sub_num, mul_num,\n` +
    `  div_num, math_op, quotient, to_num, truthy, js_bool, both, bail, float_point,\n` +
    `  raw, st_raw, raw_item, st_item_raw, plus, compare, increment_points, list_index } = R;\n` +
    `${bodies.join('\n')}\nreturn { ${roots.join(', ')} };\n`,
};

const CALLS = /\bk\d+\(/;

const WHOLE_OPS = new Set(['floor', 'ceil', 'round', 'factorial']);

const DECIMAL_CAP = 21;

const MATH_OPS = [
  'square', 'factorial', 'root', 'log', 'ln', 'asin', 'acos', 'atan',
  'sin', 'cos', 'tan', 'unnatural', 'abs', 'floor', 'ceil', 'round',
];

export interface KernelSlot {
  /** Index into the project's variable table. */
  variable: number;
  base: number;
  length: number;
  list: boolean;
  /**
   * A list the work fills with judgements rather than numbers. Entry stores the
   * `true`/`false` a judgement block hands over, and `String(true)` is not
   * `String(1)`, so those cross back as booleans.
   */
  judgement: boolean;
  /** Slot holding how many decimals the stored text carries, or -1 for none. */
  places: number;
  /**
   * Where the tails of a table the kernel only reads are kept, or -1. Counting
   * them again on every pass through a loop is what the decimal rules cost
   * most, and a table that is only read can be counted once on the way in.
   */
  tails: number;
  read: boolean;
  written: boolean;
}

export interface KernelPlan {
  /**
   * The functions in javascript over one shared array of numbers, free of the
   * boxing and the name lookups the block runner pays for.
   */
  javascript: string;
  slots: KernelSlot[];
  /** Function table index → the module export that takes it, and its arity. */
  roots: Map<number, { name: string; arity: number }>;
  /**
   * Root → positions in `slots` its call tree reads or writes, and the ones it
   * writes. A call copies only those, not every number the kernel holds.
   */
  access: Map<number, { touched: number[]; written: number[] }>;
  /** Deepest chain of kernel calls, for the caller's stack budget. */
  depth: number;
  /** f64 slots the shared region needs. */
  size: number;
  /** Why each rejected function stayed behind, for `tessvm check`. */
  rejected: Map<string, string>;
}

type Kind = 'num' | 'bool' | 'raw';

interface KValue {
  code: string;
  kind: Kind;
  /** A known result; its code may still have side effects and must run once. */
  constant?: string | number | boolean;
  /** Expression giving the value's tail, when one is at hand. */
  tailCode?: string;
  /**
   * Whether the value is already what `Entry.Scope.getNumberValue` would make
   * of it — no `NaN`, no `-0`. A literal is, and so is anything read straight
   * out of the shared region, which only ever holds numbers the work checked
   * on the way in. Everything else goes through `to_num`, the way every number
   * slot of a block does.
   */
  clean?: boolean;
  /**
   * Digits after the point in the value's shortest form, when the compiler
   * already knows them — a literal's. The kernel would otherwise search for
   * them again on every pass through the loop.
   */
  tail?: number;
}

interface Scan {
  ok: boolean;
  reason: string;
  calls: Set<number>;
  /** Whether the function ends with a value the caller can read. */
  valued: boolean;
}

function isBlock(value: unknown): value is RawBlock {
  return typeof value === 'object' && value !== null && typeof (value as RawBlock).type === 'string';
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return String(value);
  } catch {
    return '';
  }
}

function double(value: number): string {
  return String(value);
}

function literalText(param: unknown): string | null {
  if (isBlock(param)) {
    return param.type === 'number' || param.type === 'text' ? text(param.params[0] ?? '') : null;
  }
  if (param === null || param === undefined) {
    return null;
  }
  return text(param);
}

function literalValue(param: unknown): string | number | boolean | undefined {
  if (isBlock(param)) {
    if (param.type === 'True' || param.type === 'False') return param.type === 'True';
    if (param.type !== 'number' && param.type !== 'text') return undefined;
    param = param.params[0] ?? '';
  }
  if (param === null || param === undefined) return 0;
  return typeof param === 'number' || typeof param === 'string' || typeof param === 'boolean' ? param : undefined;
}

// The kernel can carry only finite numbers, even when Entry accepts their text.
function numeric(value: unknown): boolean {
  return isNumber(value) && Number.isFinite(Number(value));
}

// Read literals using their parent slot's conversion rules; raw, boolean, PLUS, and index rules differ.
type Slot = 'num' | 'raw' | 'cmp' | 'bool' | 'plainBool' | 'plus' | 'index';

const LIST_KEYWORDS = new Set(['FIRST', 'LAST', 'RANDOM']);

// Carry stored booleans as 1 or 0 and restore their boolean type when writing back.
export function judged(value: unknown): boolean {
  return typeof value === 'boolean';
}

export function canonical(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return numeric(value) && String(Number(value)) === value;
}

function tailOf(value: number): number {
  if (Number.isInteger(value)) {
    return 0;
  }
  const source = String(value);
  const exponent = source.indexOf('e');
  if (exponent < 0) {
    const dot = source.indexOf('.');
    return dot < 0 ? 0 : Math.min(source.length - dot - 1, DECIMAL_CAP);
  }
  const mantissa = source.slice(0, exponent);
  const dot = mantissa.indexOf('.');
  const fraction = dot < 0 ? 0 : mantissa.length - dot - 1;
  return Math.min(Math.max(0, fraction - Number(source.slice(exponent + 1))), DECIMAL_CAP);
}

function floatPoint(value: string | number): number {
  const source = String(value);
  const dot = source.indexOf('.');
  return dot === -1 ? 0 : Math.min(source.length - dot - 1, 20);
}

// Keep rejection reasons even when no function qualifies, so check can explain them.
export function planKernel(
  objects: Array<{ script: string | RawBlock[][] }>,
  functions: FunctionEntry[],
  variables: Variable[],
): KernelPlan {
  const varIndex = new Map<string, number>();
  variables.forEach((variable, index) => {
    varIndex.set(variable.id, index);
  });
  const funcIndex = new Map<string, number>();
  functions.forEach((fn, index) => {
    funcIndex.set(fn.id, index);
  });
  // Calls look up their target's definition, so parse each function body once per plan.
  const parsedContents = new Map<number, RawBlock[][]>();
  const contentOf = (index: number): RawBlock[][] => {
    let content = parsedContents.get(index);
    if (!content) parsedContents.set(index, content = parseScript(functions[index]!.content));
    return content;
  };

  const rejected = new Map<string, string>();
  const scans: Scan[] = [];
  const bodies: Array<string | null> = [];
  const reads = new Set<number>();
  const writes = new Set<number>();
  const changed = new Set<number>();
  // Learn which lists hold booleans before deciding whether their reads are safe.
  const judgements = new Set<number>();
  let learning = false;
  // Delay offsets until the first pass has collected all variables.
  let slotOf: (index: number) => KernelSlot | undefined = () => undefined;

  function usable(index: number): boolean {
    const variable = variables[index];
    if (!variable || variable.objectId || variable.isSlide || variable.isStored) {
      return false;
    }
    if (variable.isList) {
      // List values must survive numeric conversion without losing text formatting or boolean type.
      return variable.array.every((item) => canonical(item.data)) ||
        variable.array.every((item) => judged(item.data));
    }
    // Preserve each variable's decimal places so toFixed restores its original text.
    return numeric(variable.value);
  }

  function refer(param: unknown): number | null {
    const index = varIndex.get(text(param));
    if (index === undefined || !usable(index)) {
      return null;
    }
    return index;
  }

  class Fail extends Error {}

  function fail(why: string): never {
    throw new Fail(why);
  }

  let params = new Map<string, number>();
  let locals = new Map<string, string>();
  let calls = new Set<number>();

  function tailArgument(value: KValue): string {
    if (value.tail !== undefined) {
      return String(value.tail);
    }
    return value.tailCode ?? '-1';
  }

  function asNum(value: KValue): string {
    return value.kind === 'bool' ? JS.pick(value.code, '1.0', '0.0')
      : value.kind === 'raw' ? `to_num(${value.code})` : value.code;
  }

  function listIndex(param: unknown): string {
    const index = value(param, 'index');
    return index.kind === 'num' ? index.code : `list_index(${index.code})`;
  }

  function asBool(value: KValue): string {
    return value.kind === 'bool' ? value.code : `truthy(${value.code})`;
  }

  // Boolean conversion treats NaN as false.
  function asPlainBool(value: KValue): string {
    return value.kind === 'bool' ? value.code : `js_bool(${value.code})`;
  }

  function constant(input: unknown, slot: Slot): KValue {
    const raw = text(input);
    switch (slot) {
      case 'raw':
      case 'plainBool': {
        if (input === null || input === undefined) return { code: '0', kind: 'num', clean: true };
        if (typeof input === 'boolean') return { code: String(input), kind: 'bool' };
        if (!numeric(input)) fail(`literal ${JSON.stringify(raw)}`);
        return typeof input === 'number' ? { code: double(input), kind: 'num', clean: true, constant: input }
          : { code: JSON.stringify(raw), kind: 'raw', constant: raw, tail: tailOf(Number(raw)) };
      }
      case 'num': {
        const parsed = parseFloat(raw) || 0;
        return { code: double(parsed), kind: 'num', tail: tailOf(parsed), clean: true };
      }
      case 'bool': {
        const n = Number(raw);
        return { code: Number.isNaN(n) ? 'true' : String(Boolean(n)), kind: 'bool' };
      }
      case 'cmp':
      case 'index': {
        if (slot === 'index' && (LIST_KEYWORDS.has(raw) || !numeric(input))) {
          fail(`list index ${raw}`);
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          fail(`literal ${JSON.stringify(raw)}`);
        }
        return { code: double(n), kind: 'num', tail: tailOf(n), clean: true };
      }
      case 'plus': {
        // PLUS concatenates when either raw operand is not a number.
        if (!numeric(raw)) {
          fail(`literal ${JSON.stringify(raw)}`);
        }
        return { code: double(Number(raw)), kind: 'num', tail: tailOf(Number(raw)), clean: true };
      }
      default: {
        // Accept raw numbers only when printing them preserves the stored text.
        if (!numeric(raw) || String(Number(raw)) !== raw) {
          fail(`literal ${JSON.stringify(raw)}`);
        }
        return { code: double(Number(raw)), kind: 'num', tail: tailOf(Number(raw)), clean: true };
      }
    }
  }

  // Match Entry's parseFloat fallback so NaN and negative zero become zero at number slots.
  function value(param: unknown, slot: Slot = 'num'): KValue {
    const read = readValue(param, slot);
    if (slot !== 'num' || read.clean) {
      return read;
    }
    return { ...read, code: `to_num(${read.code})`, kind: 'num', clean: true };
  }

  function readValue(param: unknown, slot: Slot): KValue {
    if (!isBlock(param)) {
      return constant(param, slot);
    }
    const block = param;
    const p = block.params;
    switch (block.type) {
      case 'number':
      case 'text':
        return constant(p[0] ?? '', slot);
      case 'angle': {
        const angle = Number(p[0] ?? 0) || 0;
        return { code: double(angle), kind: 'num', tail: tailOf(angle), clean: true };
      }
      case 'True':
        return { code: 'true', kind: 'bool' };
      case 'False':
        return { code: 'false', kind: 'bool' };
      case 'calc_basic':
        return calcBasic(block);
      case 'calc_plus':
        return binary('PLUS', p[0], p[2]);
      case 'calc_minus':
        return binary('MINUS', p[0], p[2]);
      case 'calc_times':
        return binary('MULTI', p[0], p[2]);
      case 'calc_divide':
        return binary('DIVIDE', p[0], p[2]);
      case 'calc_operation': {
        const name = text(p[3] ?? '').split('_')[0] ?? '';
        const op = MATH_OPS.indexOf(name);
        return {
          code: `math_op(${asNum(value(p[1], 'num'))}, ${op === -1 ? MATH_OPS.length - 1 : op})`,
          kind: 'num',
          tail: WHOLE_OPS.has(name) || op === -1 ? 0 : undefined,
        };
      }
      case 'calc_mod':
        return { code: `(${asNum(value(p[0], 'num'))} % ${asNum(value(p[2], 'num'))})`, kind: 'num' };
      case 'calc_share':
        return {
          code: JS.floor(`${asNum(value(p[0], 'num'))} / ${asNum(value(p[2], 'num'))}`),
          kind: 'num',
          tail: 0,
        };
      case 'quotient_and_mod':
        return {
          code: `quotient(${asNum(value(p[1], 'num'))}, ${asNum(value(p[3], 'num'))}, ${
            text(p[5] ?? 'QUOTIENT') === 'QUOTIENT' ? 'false' : 'true'
          })`,
          kind: 'num',
          tail: text(p[5] ?? 'QUOTIENT') === 'QUOTIENT' ? 0 : undefined,
        };
      case 'boolean_basic_operator':
        return compare(text(p[1] ?? 'EQUAL'), p[0], p[2]);
      case 'boolean_equal':
        return compare('EQUAL', p[0], p[2]);
      case 'boolean_bigger':
        return compare('GREATER', p[0], p[2]);
      case 'boolean_smaller':
        return compare('LESS', p[0], p[2]);
      case 'boolean_and_or':
        return combine(text(p[1] ?? 'AND'), p[0], p[2]);
      case 'boolean_and':
        return combine('AND', p[0], p[2]);
      case 'boolean_or':
        return combine('OR', p[0], p[2]);
      case 'boolean_not':
        return { code: JS.not(asBool(value(p[1], 'bool'))), kind: 'bool' };
      case 'get_boolean_value':
        return { code: JS.pick(asBool(value(p[0], 'bool')), "'TRUE'", "'FALSE'"), kind: 'raw' };
      case 'get_variable': {
        const index = refer(p[0]);
        if (index === null || variables[index]!.isList) {
          fail(`variable ${text(p[0])}`);
        }
        reads.add(index);
        if (slot === 'raw' || slot === 'plainBool') {
          return { code: `raw(${slotOf(index)?.base ?? 0})`, kind: 'raw' };
        }
        const read = `ld(${slotOf(index)?.base ?? 0})`;
        return { code: slot === 'num' || slot === 'plus' ? `(${read} || 0)` : read, kind: 'num', clean: true };
      }
      case 'value_of_index_from_list': {
        const index = refer(p[1]);
        if (index === null || !variables[index]!.isList) {
          fail(`list ${text(p[1])}`);
        }
        reads.add(index);
        const at = slotOf(index);
        const where = listIndex(p[3]);
        const item = `ld_item(${at?.base ?? 0}, ${at?.length ?? 0}, ${where})`;
        if (!judgements.has(index)) {
          if (slot === 'raw' || slot === 'plainBool') {
            return { code: `raw_item(${at?.base ?? 0}, ${at?.length ?? 0}, ${where})`, kind: 'raw' };
          }
          // The index is read twice, so reject function calls and other side effects there.
          const tailCode = at && at.tails >= 0 && !CALLS.test(where)
            ? `ld_tail(${at.tails}, ${at.length}, ${where})`
            : undefined;
          return { code: slot === 'num' || slot === 'plus' ? `(${item} || 0)` : item, kind: 'num', tailCode, clean: true };
        }
        // Boolean list reads must stay boolean; Entry's number conversion would otherwise differ.
        if (slot !== 'bool' && slot !== 'raw' && slot !== 'plainBool') {
          fail(`list ${text(p[1])} holds judgements`);
        }
        return { code: `(${item} != 0.0)`, kind: 'bool' };
      }
      case 'length_of_list': {
        const index = refer(p[1]);
        if (index === null || !variables[index]!.isList) {
          fail(`list ${text(p[1])}`);
        }
        reads.add(index);
        return {
          code: double(slotOf(index)?.length ?? variables[index]!.array.length),
          kind: 'num',
          tail: 0,
          clean: true,
        };
      }
      case 'get_func_variable': {
        const name = locals.get(text(p[0]));
        if (!name) {
          fail('function local');
        }
        return { code: name, kind: 'raw' };
      }
      default: {
        if (block.type.startsWith('func_')) {
          const target = funcIndex.get(block.type.slice('func_'.length));
          const define = target === undefined ? undefined : findFunctionDefine(contentOf(target))?.[0];
          return { code: call(block, true), kind: 'raw', constant: define ? literalValue(define.params[3]) : undefined };
        }
        const at = params.get(block.type);
        if (at !== undefined) {
          return { code: `a${at}`, kind: 'raw' };
        }
        return fail(block.type);
      }
    }
  }

  function calcBasic(block: RawBlock): KValue {
    return binary(text(block.params[1] ?? 'PLUS'), block.params[0], block.params[2]);
  }

  // Use decimal arithmetic for numbers and Entry's PLUS rules for raw values.
  function binary(operator: string, left: unknown, right: unknown): KValue {
    const slot: Slot = operator === 'PLUS' ? 'plus' : 'num';
    const leftValue = value(left, slot);
    const rightValue = value(right, slot);
    const a = asNum(leftValue);
    const b = asNum(rightValue);
    const tails = `${tailArgument(leftValue)}, ${tailArgument(rightValue)}`;
    switch (operator) {
      case 'PLUS':
        if (leftValue.kind !== 'num' || rightValue.kind !== 'num') {
          return { code: `plus(${leftValue.code}, ${rightValue.code})`, kind: 'raw' };
        }
        return { code: `add_num(${a}, ${b}, ${tails})`, kind: 'num' };
      case 'MINUS':
        return { code: `sub_num(${a}, ${b}, ${tails})`, kind: 'num' };
      case 'MULTI':
        return { code: `mul_num(${a}, ${b}, ${tails})`, kind: 'num' };
      default:
        return { code: `div_num(${a}, ${b})`, kind: 'num' };
    }
  }

  function readsJudgement(param: unknown): boolean {
    if (!isBlock(param) || param.type !== 'value_of_index_from_list') {
      return false;
    }
    const index = varIndex.get(text(param.params[1]));
    return index !== undefined && judgements.has(index);
  }

  function compare(operator: string, left: unknown, right: unknown): KValue {
    // Reject raw comparisons of stored booleans because the numeric kernel loses their type.
    if (readsJudgement(left) || readsJudgement(right)) {
      fail('judgement compared');
    }
    const leftValue = value(left, 'cmp'), rightValue = value(right, 'cmp');
    if (leftValue.kind !== 'num' || rightValue.kind !== 'num') {
      return { code: `compare(${leftValue.code}, ${rightValue.code}, ${JSON.stringify(operator)})`, kind: 'bool' };
    }
    const a = leftValue.code;
    const b = rightValue.code;
    const table: Record<string, string> = {
      EQUAL: '==', NOT_EQUAL: '!=', GREATER: '>', LESS: '<',
      GREATER_OR_EQUAL: '>=', LESS_OR_EQUAL: '<=',
    };
    return { code: `(${a} ${table[operator] ?? '=='} ${b})`, kind: 'bool' };
  }

  // Entry evaluates both sides before combining them.
  function combine(operator: string, left: unknown, right: unknown): KValue {
    for (const side of [left, right]) {
      // Preserve literal truthiness because Boolean("0") differs from Boolean(0).
      if (!isBlock(side) || side.type === 'number' || side.type === 'text') {
        fail('literal in and/or');
      }
    }
    const a = asPlainBool(value(left, 'plainBool'));
    const b = asPlainBool(value(right, 'plainBool'));
    return { code: `both(${a}, ${b}, ${operator === 'AND' ? 'true' : 'false'})`, kind: 'bool' };
  }

  function call(block: RawBlock, asValue: boolean): string {
    const target = funcIndex.get(block.type.slice('func_'.length));
    if (target === undefined) {
      fail(block.type);
    }
    const define = findFunctionDefine(contentOf(target))?.[0];
    if (asValue && define?.type !== 'function_create_value') {
      fail(`${block.type} has no value`);
    }
    calls.add(target);
    // Keep call slots aligned with declaration indices.
    const args = collectParams(define?.params[0]).map((_, at) =>
      value(block.params[at], 'raw').code);
    return `k${target}(${args.join(', ')})`;
  }

  function statement(block: RawBlock, indent: string): string {
    const p = block.params;
    switch (block.type) {
      case 'set_variable': {
        const index = refer(p[0]);
        if (index === null || variables[index]!.isList) {
          fail(`variable ${text(p[0])}`);
        }
        writes.add(index);
        const slot = slotOf(index);
        const stored = value(p[1], 'raw');
        if (stored.constant !== undefined) {
          const places = scalarPlaces(stored.constant);
          if (places !== null) return `${indent}st(${slot?.base ?? 0}, (${stored.code}, ${double(Number(stored.constant))}));\n` +
            `${indent}st(${slot?.places ?? 0}, ${places});\n`;
        }
        if (isBlock(p[1]) && p[1].type === 'get_variable') {
          const source = slotOf(refer(p[1].params[0])!);
          return `${indent}st(${slot?.base ?? 0}, ld(${source?.base ?? 0}));\n` +
            `${indent}st(${slot?.places ?? 0}, ld(${source?.places ?? 0}));\n`;
        }
        if (stored.kind !== 'num') return `${indent}st_raw(${slot?.base ?? 0}, ${stored.code});\n`;
        return `${indent}st(${slot?.base ?? 0}, ${stored.code})${JS.end}\n` +
          `${indent}st(${slot?.places ?? 0}, -1.0)${JS.end}\n`;
      }
      case 'change_variable': {
        const index = refer(p[0]);
        if (index === null || variables[index]!.isList) {
          fail(`variable ${text(p[0])}`);
        }
        reads.add(index);
        writes.add(index);
        changed.add(index);
        const slot = slotOf(index);
        // Carry toFixed decimal places separately because they affect the next variable change.
        const raw = literalText(p[1]);
        const increment = value(p[1], 'raw');
        const literal = raw !== null && numeric(raw);
        const added = literal
          ? double(floatPoint(parseNumber(raw) as string | number))
          : increment.kind === 'num' ? `float_point(__v)` : `increment_points(__raw)`;
        return `${indent}{\n` +
          (literal ? '' : `${indent}  ${JS.let('__raw', increment.code)}\n`) +
          `${indent}  ${JS.let('__v', literal ? double(Number(raw)) : 'Number(__raw)')}\n` +
          `${indent}  ${JS.let('__c', `ld(${slot?.base ?? 0})`)}\n` +
          `${indent}  ${JS.let('__p', `ld(${slot?.places ?? 0})`)}\n` +
          `${indent}  ${JS.let('__was', JS.pick('__p < 0.0', 'float_point(__c)', '__p'))}\n` +
          `${indent}  ${JS.let('__now', added)}\n` +
          `${indent}  ${JS.ifOpen('!Number.isFinite(__v) || !Number.isFinite(__c)')} bail()${JS.end} }\n` +
          `${indent}  ${JS.let('__result', `add_num(__v, __c, ${increment.tail ?? -1}, -1)`)}\n` +
          `${indent}  ${JS.ifOpen('!Number.isFinite(__result)')} bail()${JS.end} }\n` +
          `${indent}  st(${slot?.base ?? 0}, __result)${JS.end}\n` +
          `${indent}  st(${slot?.places ?? 0}, Math.abs(__result) >= 1e21 ? -2 : ${JS.pick('__was > __now', '__was', '__now')})${JS.end}\n` +
          `${indent}}\n`;
      }
      case 'change_value_list_index': {
        const index = refer(p[0]);
        if (index === null || !variables[index]!.isList) {
          fail(`list ${text(p[0])}`);
        }
        writes.add(index);
        const at = slotOf(index);
        const stored = value(p[2], 'raw');
        if (learning) {
          if (stored.kind === 'bool') {
            judgements.add(index);
          }
        } else if ((stored.kind === 'bool') !== judgements.has(index)) {
          // Reject mixed number and boolean lists because their original types cannot be restored reliably.
          fail(`list ${text(p[0])} holds both`);
        }
        if (typeof stored.constant === 'string' && canonical(stored.constant)) {
          return `${indent}st_item(${at?.base ?? 0}, ${at?.length ?? 0}, ${listIndex(p[1])}, (${stored.code}, ${double(Number(stored.constant))}), true);\n`;
        }
        if (stored.kind === 'raw') {
          const where = listIndex(p[1]);
          if (isBlock(p[2]) && p[2].type === 'get_variable' && !CALLS.test(where)) {
            const source = slotOf(refer(p[2].params[0])!);
            // Require a pure index before inspecting the stored value type.
            return `${indent}if (ld(${source?.places ?? 0}) === -1) {\n` +
              `${indent}  st_item(${at?.base ?? 0}, ${at?.length ?? 0}, ${where}, ld(${source?.base ?? 0}));\n` +
              `${indent}} else {\n` +
              `${indent}  st_item_raw(${at?.base ?? 0}, ${at?.length ?? 0}, ${where}, ${stored.code});\n` +
              `${indent}}\n`;
          }
          return `${indent}st_item_raw(${at?.base ?? 0}, ${at?.length ?? 0}, ${where}, ${stored.code});\n`;
        }
        return `${indent}st_item(${at?.base ?? 0}, ${at?.length ?? 0}, ` +
          `${listIndex(p[1])}, ${asNum(stored)})${JS.end}\n`;
      }
      case 'set_func_variable': {
        const name = locals.get(text(p[0]));
        if (!name) {
          fail('function local');
        }
        return `${indent}${name} = ${value(p[1], 'raw').code}${JS.end}\n`;
      }
      case '_if':
        return `${indent}${JS.ifOpen(asBool(value(p[0], 'bool')))}\n` +
          stack(block.statements?.[0] ?? [], `${indent}  `) +
          `${indent}${JS.close}\n`;
      case 'if_else':
        return `${indent}${JS.ifOpen(asBool(value(p[0], 'bool')))}\n` +
          stack(block.statements?.[0] ?? [], `${indent}  `) +
          `${indent}${JS.close} else {\n` +
          stack(block.statements?.[1] ?? [], `${indent}  `) +
          `${indent}${JS.close}\n`;
      default:
        if (block.type.startsWith('func_')) {
          return `${indent}${JS.discard(call(block, false))}\n`;
        }
        return fail(block.type);
    }
  }

  function stack(blocks: RawBlock[], indent: string): string {
    let out = '';
    for (const block of blocks) {
      out += statement(block, indent);
    }
    return out || `${indent}${JS.end === ';' ? '' : '()'}\n`;
  }

  function emit(fn: FunctionEntry, index: number): { scan: Scan; body: string | null } {
    const content = contentOf(index);
    const stackBlocks = findFunctionDefine(content);
    const define = stackBlocks?.[0];
    const scan: Scan = { ok: false, reason: '', calls: new Set(), valued: false };
    if (!define) {
      scan.reason = 'no definition';
      return { scan, body: null };
    }
    params = new Map(collectParams(define.params[0]).map((name, at) => [name, at]));
    locals = new Map();
    calls = new Set();
    const declarations: string[] = [];
    for (const local of fn.localVariables ?? []) {
      if (!numeric(local.value ?? 0)) {
        scan.reason = `function local ${local.name}`;
        return { scan, body: null };
      }
      const name = `l${locals.size}`;
      locals.set(local.id, name);
      declarations.push(`  ${JS.local(name, JSON.stringify(local.value ?? 0))}\n`);
    }
    try {
      const body = stack(functionBody(stackBlocks!), '  ');
      const answer = define.type === 'function_create_value'
        ? value(define.params[3], 'raw').code
        : 'undefined';
      const tail = `  ${JS.end === ';' ? `return ${answer};` : answer}\n`;
      scan.ok = true;
      scan.calls = calls;
      scan.valued = define.type === 'function_create_value';
      return {
        scan,
        body: `${JS.open(`k${index}`, params.size, fn.id)}\n` +
          `${declarations.join('')}${body}${tail}${JS.close}\n`,
      };
    } catch (error) {
      scan.reason = error instanceof Fail ? error.message : String(error);
      return { scan, body: null };
    }
  }

  // Learn list shapes in a separate pass because reads may precede writes.
  learning = true;
  functions.forEach((fn, index) => {
    emit(fn, index);
  });
  learning = false;
  reads.clear();
  writes.clear();
  changed.clear();

  functions.forEach((fn, index) => {
    const result = emit(fn, index);
    scans[index] = result.scan;
    bodies[index] = result.body;
    if (!result.scan.ok) {
      rejected.set(fn.id, result.scan.reason);
    }
  });

  // Reject calls to unsupported functions and cycles with no fixed depth.
  let settled = false;
  while (!settled) {
    settled = true;
    scans.forEach((scan, index) => {
      if (!scan.ok) {
        return;
      }
      for (const target of scan.calls) {
        if (!scans[target]?.ok) {
          scan.ok = false;
          rejected.set(functions[index]!.id, `calls ${functions[target]?.id ?? target}`);
          settled = false;
          return;
        }
      }
    });
  }

  const depths = new Map<number, number>();
  function depthOf(index: number, seen: Set<number>): number {
    if (seen.has(index)) {
      return Infinity;
    }
    const known = depths.get(index);
    if (known !== undefined) {
      return known;
    }
    seen.add(index);
    let deepest = 0;
    for (const target of scans[index]!.calls) {
      deepest = Math.max(deepest, depthOf(target, seen));
    }
    seen.delete(index);
    const total = deepest + 1;
    depths.set(index, total);
    return total;
  }
  scans.forEach((scan, index) => {
    if (scan.ok && !Number.isFinite(depthOf(index, new Set()))) {
      scan.ok = false;
      rejected.set(functions[index]!.id, 'calls itself');
    }
  });

  if (!scans.some((scan) => scan.ok)) {
    return {
      javascript: '', slots: [], roots: new Map(), access: new Map(), depth: 0, size: FIRST_SLOT, rejected,
    };
  }

  // Lay out only accepted functions so rejected code does not constrain or copy unrelated data.
  const settledKeep = scans.map((scan) => scan.ok);
  changed.clear();
  const own = new Map<number, { reads: Set<number>; writes: Set<number> }>();
  functions.forEach((fn, index) => {
    if (settledKeep[index]) {
      reads.clear();
      writes.clear();
      emit(fn, index);
      own.set(index, { reads: new Set(reads), writes: new Set(writes) });
    }
  });
  reads.clear();
  writes.clear();
  for (const used of own.values()) {
    used.reads.forEach((variable) => reads.add(variable));
    used.writes.forEach((variable) => writes.add(variable));
  }

  const touched = new Set([...reads, ...writes]);
  const slots: KernelSlot[] = [];
  const byVariable = new Map<number, KernelSlot>();
  let next = FIRST_SLOT;
  for (const index of [...touched].sort((a, b) => a - b)) {
    const variable = variables[index]!;
    const length = variable.isList ? variable.array.length : 1;
    const tabled = variable.isList && reads.has(index) && !writes.has(index) &&
      !judgements.has(index);
    const slot: KernelSlot = {
      variable: index,
      base: next,
      length,
      list: variable.isList,
      judgement: judgements.has(index),
      places: variable.isList ? -1 : next + 1,
      tails: tabled ? next + length : -1,
      read: reads.has(index),
      written: writes.has(index),
    };
    next += variable.isList ? length * (tabled ? 2 : 1) : 2;
    slots.push(slot);
    byVariable.set(index, slot);
  }
  slotOf = (index) => byVariable.get(index);

  reads.clear();
  writes.clear();
  changed.clear();
  const keep = [...settledKeep];
  const emitted: string[] = [];
  functions.forEach((fn, index) => {
    if (!keep[index]) {
      return;
    }
    const result = emit(fn, index);
    if (!result.scan.ok || !result.body) {
      // Drop functions if the final layout unexpectedly makes emission fail.
      keep[index] = false;
      rejected.set(fn.id, result.scan.reason || 'layout');
      return;
    }
    emitted.push(result.body);
  });

  // Only external callers need entry points because internal calls do not cross the data bridge.
  const outside = new Set<number>();
  function noteCalls(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(noteCalls);
      return;
    }
    if (!isBlock(node)) {
      return;
    }
    if (node.type.startsWith('func_')) {
      const target = funcIndex.get(node.type.slice('func_'.length));
      if (target !== undefined) {
        outside.add(target);
      }
    }
    node.params?.forEach(noteCalls);
    node.statements?.forEach(noteCalls);
  }
  for (const object of objects) {
    noteCalls(parseScript(object.script));
  }
  functions.forEach((fn, index) => {
    if (!keep[index]) {
      noteCalls(contentOf(index));
    }
  });

  const roots = new Map<number, { name: string; arity: number }>();
  keep.forEach((ok, index) => {
    if (!ok || !outside.has(index)) {
      return;
    }
    const define = findFunctionDefine(contentOf(index))![0]!;
    roots.set(index, { name: `run${index}`, arity: collectParams(define.params[0]).length });
  });

  const slotAt = new Map(slots.map((slot, at) => [slot.variable, at]));
  const access = new Map<number, { touched: number[]; written: number[] }>();
  for (const index of roots.keys()) {
    const touched = new Set<number>();
    const written = new Set<number>();
    const reached = new Set<number>();
    const visit = (at: number): void => {
      if (reached.has(at)) return;
      reached.add(at);
      const used = own.get(at);
      used?.reads.forEach((variable) => touched.add(slotAt.get(variable)!));
      used?.writes.forEach((variable) => {
        touched.add(slotAt.get(variable)!);
        written.add(slotAt.get(variable)!);
      });
      scans[at]!.calls.forEach(visit);
    };
    visit(index);
    access.set(index, { touched: [...touched].sort((a, b) => a - b), written: [...written].sort((a, b) => a - b) });
  }

  const names = [...roots.values()].map((root) => root.name);
  const entries = [...roots.entries()].map(([index, root]) =>
    JS.entry(root.name, root.arity, `k${index}`, functions[index]!.id));

  const depth = Math.max(...[...roots.keys()].map((index) => depths.get(index) ?? 1));
  return {
    javascript: JS.module([...emitted, ...entries], names),
    slots,
    roots,
    access,
    depth,
    size: next,
    rejected,
  };
}
