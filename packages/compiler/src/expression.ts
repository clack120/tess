// Indices are one-based, slices include both ends, and failed searches return zero.
import { KEY_CODES, keyCodeOf } from '@entropy/core';
import { didYouMean, orHint } from '@entropy/core';
import { requireMinMax, requirePowerRefiner, requireStoreFlag } from './runtime.ts';
import { requireStringHelper } from './string-functions.ts';
import { BUILTIN_FUNCTIONS, OPTION_KEYWORDS, STATE_VALUES, STORE_FLAG_ON } from '@entropy/core';
import { expansionBlock, expansionField } from '@entropy/core';
import type {
  BinaryNode, CallNode, Expr, IndexNode, Node, UnaryNode,
} from '@entropy/parser';
import type { Context } from './context.ts';
import type {
  CompiledFunction, EntryBlock, EntryParam, EntryVariable,
} from './types.ts';

interface TargetOptions {
  wall?: boolean;
  self?: boolean;
  all?: boolean;
  mouse?: boolean;
}

const BOOLEAN_TYPES = new Set([
  'True', 'False',
  'boolean_basic_operator', 'boolean_and_or', 'boolean_not',
  'is_clicked', 'is_object_clicked', 'is_press_some_key', 'reach_something',
  'is_type', 'is_boost_mode', 'is_current_device_type', 'is_touch_supported',
  'is_included_in_list',
]);

const COMPARE_OPERATORS: Record<string, string> = {
  '==': 'EQUAL', '!=': 'NOT_EQUAL',
  '>': 'GREATER', '<': 'LESS',
  '>=': 'GREATER_OR_EQUAL', '<=': 'LESS_OR_EQUAL',
};

const ARITHMETIC_OPERATORS: Record<string, string> = { '+': 'PLUS', '-': 'MINUS', '*': 'MULTI', '/': 'DIVIDE' };

const MATH_OPERATIONS: Record<string, string> = {
  sin: 'sin', cos: 'cos', tan: 'tan',
  asin: 'asin_radian', acos: 'acos_radian', atan: 'atan_radian',
  ln: 'ln', log10: 'log',
  floor: 'floor', ceil: 'ceil', round: 'round', abs: 'abs',
  factorial: 'factorial',
};

const OBJECT_COORDINATES: Record<string, string> = {
  x: 'x', y: 'y', angle: 'rotation', way: 'direction', size: 'size',
  costume: 'picture_name', costume_number: 'picture_index',
};

const STATE_BLOCKS: Record<string, string> = {
  mouse_down: 'is_clicked',
  clicked: 'is_object_clicked',
  boost_mode: 'is_boost_mode',
  touchable: 'is_touch_supported',
  user_id: 'get_user_name',
  nickname: 'get_nickname',
  timer: 'get_project_timer_value',
  answer: 'get_canvas_input_value',
};

const PROPERTY_COORDINATES: Record<string, string> = {
  x: 'x', y: 'y', angle: 'rotation', way: 'direction', size: 'size',
  costume: 'picture_name', costume_number: 'picture_index',
};

export function isBooleanBlock(node: EntryParam): boolean {
  if (!node || typeof node !== 'object') return false;
  const { type } = node as EntryBlock;
  if (expansionBlock(type)?.kind === 'boolean') return true;
  // Boolean parameter types vary by function, so match their prefix.
  return BOOLEAN_TYPES.has(type) || String(type).startsWith('booleanParam_');
}

// Entry reads conditions through getBooleanValue, so keep the original value.
export function compileBoolean(node: Expr | null | undefined, ctx: Context): EntryBlock | null {
  return compileAnyValue(node, ctx);
}

// Preserve boolean values; only boolean_value converts them to TRUE/FALSE text.
export function compileValue(node: Expr | null | undefined, ctx: Context): EntryBlock | null {
  return compileAnyValue(node, ctx);
}

export function compileAnyValue(node: Expr | null | undefined, ctx: Context): EntryBlock | null {
  if (!node) return null;
  switch (node.type) {
    case 'Number': return ctx.number(node.value);
    case 'String': return ctx.text(node.value);
    case 'Boolean': return ctx.block(node.value ? 'True' : 'False', [null]);
    case 'Color': return ctx.text(node.value);
    case 'Transparent': return ctx.text('transparent');
    case 'Identifier': return compileIdentifier(node, ctx);
    case 'Binary': return compileBinary(node, ctx);
    case 'Unary': return compileUnary(node, ctx);
    case 'Call': return compileCall(node, ctx);
    case 'Index': return compileIndex(node, ctx);
    case 'ListLiteral':
      return ctx.error(node, '리스트 리터럴은 list 선언에서만 쓸 수 있습니다.');
    default:
      return ctx.error(node, `표현식 '${node.type}' 은(는) 엔트리 블록으로 바꿀 수 없습니다.`);
  }
}

function compileIdentifier(node: Node & { name: string }, ctx: Context): EntryBlock | null {
  const { name } = node;

  const found = ctx.lookupVariable(name);
  if (found) {
    if (found.kind === 'ambiguousLocal') return ambiguousLocalError(node, found, ctx);
    if (found.kind === 'param') {
      const type = ctx.funcScope!.params.get(name)!;
      // Entry's boolean parameter blocks include an empty slot.
      return ctx.block(type, type.startsWith('booleanParam_') ? [null] : []);
    }
    if (found.kind === 'funcLocal') return ctx.block('get_func_variable', [found.id, null]);
    // Preserve stale variable blocks that refer to lists; Entry keeps the containers separate.
    if (found.entry.variableType === 'list') {
      ctx.warn(node, `리스트 '${name}' 을(를) 값으로 바로 썼습니다. 실행할 때 값을 찾지 못합니다 — ${name}[i] 처럼 항목을 지정하세요.`);
    }
    return ctx.block('get_variable', [found.entry.id, null]);
  }

  if (name === 'block_count') return ctx.block('get_block_count', ['all']);
  // The save manager sets its presence flag to 1; read it as a condition.
  if (name === 'can_save') {
    const flag = requireStoreFlag(ctx);
    return ctx.block('boolean_basic_operator', [
      ctx.block('get_variable', [flag.id, null]),
      'EQUAL',
      ctx.number(STORE_FLAG_ON),
    ]);
  }
  if (Object.hasOwn(STATE_BLOCKS, name)) {
    const slots: Record<string, number> = { get_nickname: 0, get_user_name: 0, get_project_timer_value: 2 };
    const count = slots[STATE_BLOCKS[name]!] ?? 1;
    return ctx.block(STATE_BLOCKS[name]!, new Array(count).fill(null));
  }
  if (name === 'device') {
    return ctx.error(node, "device 는 홀로 쓸 수 없습니다. device == \"mobile\" 처럼 비교해서 쓰세요.");
  }
  if (Object.hasOwn(PROPERTY_COORDINATES, name)) {
    return ctx.block('coordinate_object', [null, 'self', null, PROPERTY_COORDINATES[name]!]);
  }
  if (name === 'sound_volume') return ctx.block('get_sound_volume', [null]);
  if (name === 'sound_speed') return ctx.block('get_sound_speed', [null]);
  if (OPTION_KEYWORDS.has(name) || STATE_VALUES.has(name)) {
    return ctx.error(node, `'${name}' 은(는) 이 자리에서 값으로 쓸 수 없습니다.`);
  }
  return ctx.unresolvedName(node, name);
}

export function ambiguousLocalError(node: Node, found: { name: string; owners: string[] }, ctx: Context): null {
  return ctx.error(
    node,
    `'${found.name}' 은(는) ${found.owners.join(', ')} 가 저마다 가진 지역 변수라 어느 것인지 알 수 없습니다. `
    + '이 함수를 그 오브젝트 안에 선언하거나, 값을 매개변수로 전달하세요.',
  );
}

function compileBinary(node: BinaryNode, ctx: Context): EntryBlock | null {
  const { operator } = node;

  if (operator === 'and' || operator === 'or') {
    const left = compileBoolean(node.left, ctx);
    const right = compileBoolean(node.right, ctx);
    if (!left || !right) return null;
    return ctx.block('boolean_and_or', [left, operator === 'and' ? 'AND' : 'OR', right]);
  }

  if (COMPARE_OPERATORS[operator]) return compileComparison(node, ctx);

  if (ARITHMETIC_OPERATORS[operator]) {
    const left = compileValue(node.left, ctx);
    const right = compileValue(node.right, ctx);
    if (!left || !right) return null;
    return ctx.block('calc_basic', [left, ARITHMETIC_OPERATORS[operator]!, right]);
  }

  if (operator === '%' || operator === '//') {
    const left = compileValue(node.left, ctx);
    const right = compileValue(node.right, ctx);
    if (!left || !right) return null;
    const action = operator === '%' ? 'MOD' : 'QUOTIENT';
    return ctx.block('quotient_and_mod', [null, left, null, right, null, action]);
  }

  if (operator === '**') return compilePower(node, ctx);

  return ctx.error(node, `연산자 '${operator}' 를 엔트리 블록으로 바꿀 수 없습니다.`);
}

export function foldConstant(node: Expr | null | undefined): number | null {
  if (!node) return null;
  switch (node.type) {
    case 'Number': return node.value;
    case 'Unary': {
      if (node.operator !== '-') return null;
      const value = foldConstant(node.argument);
      return value === null ? null : -value;
    }
    case 'Binary': {
      const left = foldConstant(node.left);
      const right = foldConstant(node.right);
      if (left === null || right === null) return null;
      switch (node.operator) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return right === 0 ? null : left / right;
        case '%': return right === 0 ? null : left % right;
        case '//': return right === 0 ? null : Math.floor(left / right);
        case '**': return left ** right;
        default: return null;
      }
    }
    default: return null;
  }
}

const FRACTION_BITS = 20;

// Expand powers into blocks to avoid consuming frames in an Entry loop.
function compilePower(node: BinaryNode, ctx: Context): EntryBlock | null {
  const exponent = foldConstant(node.right);
  if (exponent === null) {
    return ctx.error(
      node,
      '거듭제곱의 지수는 숫자로 정해져 있어야 합니다. (엔트리에는 거듭제곱 블록이 없어서 컴파일할 때 펼쳐 넣습니다)',
    );
  }
  return buildPower(node.left, exponent, node, ctx);
}

// Power expansion repeats the base, so reject expressions with changing values.
export function buildPower(
  baseNode: Expr,
  exponent: number,
  node: Node,
  ctx: Context,
): EntryBlock | null {
  if (!Number.isFinite(exponent)) return ctx.error(node, '거듭제곱의 지수가 올바르지 않습니다.');
  if (exponent === 0) return ctx.number(1);

  if (exponent < 0) {
    const positive = buildPower(baseNode, -exponent, node, ctx);
    return positive && ctx.block('calc_basic', [ctx.number(1), 'DIVIDE', positive]);
  }

  let uses = 0;
  let failed = false;
  const base = () => {
    uses += 1;
    const compiled = compileValue(baseNode, ctx);
    if (!compiled) failed = true;
    // A placeholder lets tree building finish; the caller checks failed.
    return compiled ?? ctx.number(1);
  };
  const square = (value: EntryBlock) => ctx.block('calc_operation', [null, value, null, 'square']);
  const root = (value: EntryBlock) => ctx.block('calc_operation', [null, value, null, 'root']);
  const multiply = (left: EntryBlock, right: EntryBlock) => ctx.block('calc_basic', [left, 'MULTI', right]);

  const whole = Math.floor(exponent);
  const { bits, exact } = fractionBits(exponent - whole);
  const wholePart = integerPower(whole, base, square, multiply);
  const fractionPart = fractionPower(bits, 0, base, root, multiply);

  let result = wholePart && fractionPart ? multiply(wholePart, fractionPart) : wholePart ?? fractionPart;

  // Apply a Newton correction when the binary expansion leaves a remainder.
  if (result && !exact) {
    const refiner = requirePowerRefiner(ctx);
    result = ctx.block(`func_${refiner.id}`, [result, base(), ctx.number(exponent)]);
  }

  if (failed) return null;
  if (uses > 1 && containsRandom(baseNode)) {
    return ctx.error(
      node,
      '이 지수는 밑을 여러 번 써야 해서 random() 이 들어간 값에는 쓸 수 없습니다. 변수에 먼저 담아 두고 쓰세요.',
    );
  }

  return result ?? ctx.number(1);
}

// A zero exponent returns null, meaning a factor of one.
function integerPower(
  n: number,
  base: () => EntryBlock,
  square: (value: EntryBlock) => EntryBlock,
  multiply: (left: EntryBlock, right: EntryBlock) => EntryBlock,
): EntryBlock | null {
  if (n <= 0) return null;
  if (n === 1) return base();
  const half = integerPower(Math.floor(n / 2), base, square, multiply)!;
  const squared = square(half);
  return n % 2 === 1 ? multiply(squared, base()) : squared;
}

// An empty fractional expansion returns null, meaning a factor of one.
function fractionPower(
  bits: number[],
  index: number,
  base: () => EntryBlock,
  root: (value: EntryBlock) => EntryBlock,
  multiply: (left: EntryBlock, right: EntryBlock) => EntryBlock,
): EntryBlock | null {
  if (index >= bits.length) return null;
  const rest = fractionPower(bits, index + 1, base, root, multiply);
  let inner = rest;
  if (bits[index] === 1) inner = rest ? multiply(base(), rest) : base();
  return inner ? root(inner) : null;
}

function fractionBits(fraction: number): { bits: number[]; exact: boolean } {
  const bits: number[] = [];
  let rest = fraction;
  while (bits.length < FRACTION_BITS && rest > 0) {
    rest *= 2;
    if (rest >= 1) {
      bits.push(1);
      rest -= 1;
    } else {
      bits.push(0);
    }
  }
  while (bits.length > 0 && bits[bits.length - 1] === 0) bits.pop();
  return { bits, exact: rest === 0 };
}

function containsRandom(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(containsRandom);
  const call = node as { type?: string; callee?: string };
  if (call.type === 'Call' && (call.callee === 'random' || call.callee === 'random_color')) return true;
  return Object.entries(node).some(([key, value]) => key !== 'loc' && containsRandom(value));
}

function compileComparison(node: BinaryNode, ctx: Context): EntryBlock | null {
  const operator = COMPARE_OPERATORS[node.operator];

  const typeCheck = matchTypeCheck(node);
  if (typeCheck) {
    const value = compileValue(typeCheck.value, ctx);
    if (!value) return null;
    const kind = { number: 'number', string: 'en', boolean: 'en', list: 'en' }[typeCheck.kind];
    if (!kind) return ctx.error(node, `type() 비교값은 "number" 만 엔트리 블록으로 바꿀 수 있습니다.`);
    const check = ctx.block('is_type', [value, null, kind, null]);
    return node.operator === '==' ? check : ctx.block('boolean_not', [null, check, null]);
  }

  const deviceCheck = matchDeviceCheck(node);
  if (deviceCheck) {
    if (!['desktop', 'tablet', 'mobile'].includes(deviceCheck)) {
      return ctx.error(node, `device 는 "desktop", "tablet", "mobile" 하고만 비교할 수 있습니다.`);
    }
    const check = ctx.block('is_current_device_type', [deviceCheck]);
    return node.operator === '==' ? check : ctx.block('boolean_not', [null, check, null]);
  }

  const left = compileValue(node.left, ctx);
  const right = compileValue(node.right, ctx);
  if (!left || !right) return null;
  return ctx.block('boolean_basic_operator', [left, operator, right]);
}

function matchTypeCheck(node: BinaryNode): { value: Expr; kind: string } | null {
  if (node.operator !== '==' && node.operator !== '!=') return null;
  for (const [call, other] of [[node.left, node.right], [node.right, node.left]]) {
    if (call.type === 'Call' && call.callee === 'type' && other.type === 'String') {
      return { value: call.arguments[0], kind: other.value };
    }
  }
  return null;
}

function matchDeviceCheck(node: BinaryNode): string | null {
  if (node.operator !== '==' && node.operator !== '!=') return null;
  for (const [id, other] of [[node.left, node.right], [node.right, node.left]]) {
    if (id.type === 'Identifier' && id.name === 'device' && other.type === 'String') return other.value;
  }
  return null;
}

function compileUnary(node: UnaryNode, ctx: Context): EntryBlock | null {
  if (node.operator === 'not') {
    const value = compileBoolean(node.argument, ctx);
    return value && ctx.block('boolean_not', [null, value, null]);
  }
  if (node.argument.type === 'Number') return ctx.number(-node.argument.value);
  const value = compileValue(node.argument, ctx);
  return value && ctx.block('calc_basic', [ctx.number(0), 'MINUS', value]);
}

function compileIndex(node: IndexNode, ctx: Context): EntryBlock | null {
  const table = node.target.type === 'Identifier' && ctx.tableByName.get(node.target.name);
  if (table) {
    const first = compileValue(node.index, ctx);
    if (!first) return null;
    if (!node.column) return ctx.block('get_value_from_cell', [table.id, first, null]);
    const column = compileValue(node.column, ctx);
    return column === null ? null : ctx.block('get_value_from_table', [table.id, first, column, null]);
  }
  if (node.column) {
    const label = node.target.type === 'Identifier' ? node.target.name : '';
    return ctx.error(node, `'${label}' 은(는) 테이블이 아니라서 [행, 열] 로 읽을 수 없습니다.`);
  }

  const list = resolveList(node.target, ctx);
  const index = compileValue(node.index, ctx);
  if (!index) return null;

  if (list) return ctx.block('value_of_index_from_list', [null, list.id, null, index, null]);

  const target = compileValue(node.target, ctx);
  return target === null ? null : ctx.block('char_at', [null, target, null, index, null]);
}

export function compileCallArguments(
  fn: CompiledFunction,
  args: Expr[],
  ctx: Context,
): Array<EntryBlock | null> {
  return args.map((arg, index) => (fn.booleanParams?.has(fn.params[index]!)
    ? compileBoolean(arg, ctx)
    : compileValue(arg, ctx)));
}

export function checkFunctionArity(call: CallNode, fn: CompiledFunction, ctx: Context): boolean {
  if (call.arguments.length === fn.params.length) return true;
  ctx.error(call, `함수 '${call.callee}' 는 인자가 ${fn.params.length}개여야 합니다. (${call.arguments.length}개를 받았습니다) 사용법: ${call.callee}(${fn.params.join(', ')})`, {
    code: 'E0006',
    help: '선언된 매개변수마다 값을 하나씩 전달하세요. 생략 인자와 추가 인자는 지원하지 않습니다.',
    ...(fn.node ? { related: [ctx.diagnostic(fn.node, '함수를 선언한 위치입니다.')] } : {}),
  });
  return false;
}

export function unknownFunctionError(call: CallNode, ctx: Context): null {
  return ctx.error(call, `알 수 없는 함수 '${call.callee}' 입니다.`
    + didYouMean(call.callee, [...BUILTIN_FUNCTIONS, ...ctx.functionByName.keys()]), {
    code: 'E0005',
    help: ctx.lookupVariable(call.callee)
      ? `'${call.callee}' 은(는) 변수입니다. 값을 읽으려면 괄호를 빼세요. 문자열·리스트 항목은 ${call.callee}[위치] 로 읽습니다.`
      : '함수 이름의 철자를 확인하거나 function 이름(인자) do ... end 로 선언하세요.',
  });
}

// Sound duration uses a dropdown ID rather than a value block.
function resolveSoundValue(node: Expr, ctx: Context): string | null {
  if (node.type !== 'String') {
    return ctx.error(node, 'sound_duration() 은 소리 이름을 문자열로 적어야 합니다.');
  }
  const sound = ctx.object?.sounds.get(node.value);
  if (sound) return sound.id;
  // Keep explicitly forced Entry resource IDs unchanged.
  if (ctx.forcedResourceIds.has(node.value)) return node.value;
  // Global functions resolve shared or missing sound names at runtime.
  if (!ctx.object) {
    const found = ctx.lookupObjectResource('sounds', node.value);
    if (found?.kind === 'found') return found.asset.id;
    if (!found) ctx.notice(node, `'${node.value}' 소리가 어느 오브젝트에도 없습니다. 실행할 때 이름으로 찾습니다.`);
    return node.value;
  }
  // Entry resolves sound IDs, names, then indices at runtime.
  ctx.notice(node, `'${node.value}' 소리가 이 오브젝트에 없습니다. 실행할 때 이름으로 찾습니다.`
    + orHint(node.value, ctx.object?.sounds.keys() ?? [],
      `sound ${node.value} "파일명" 으로 먼저 등록하세요.`));
  return node.value;
}

export function resolveList(node: Expr | null | undefined, ctx: Context): EntryVariable | null {
  if (!node || node.type !== 'Identifier') return null;
  const found = ctx.lookupVariable(node.name);
  if (found?.kind === 'variable' && found.entry.variableType === 'list') return found.entry;
  return null;
}

const TABLE_CALCULATIONS: Record<string, string> = {
  sum: 'SUM', average: 'AVG', maximum: 'MAX', minimum: 'MIN',
  stdev: 'STDEV', median: 'MEDIAN',
};

function tableArgument(node: Expr, callee: string, ctx: Context) {
  const table = node.type === 'Identifier' && ctx.tableByName.get(node.name);
  return table || ctx.error(node, `${callee}() 의 첫 번째 인자는 테이블이어야 합니다.`
    + didYouMean(node.type === 'Identifier' ? node.name : '', ctx.tableByName.keys()));
}

// Dropdowns require literals; only value slots accept expressions.
function compileExpansion(node: CallNode, ctx: Context): EntryBlock | null {
  const { callee, arguments: args } = node;
  const { module, slots, ai } = expansionBlock(callee)!;
  if (args.length !== slots.length) {
    return ctx.error(node, `${callee}() 는 인자가 ${slots.length}개여야 합니다. (${args.length}개를 받았습니다)`);
  }

  const fields = args.map((argument) => argument.type === 'String'
    ? argument.value
    : argument.type === 'Number' ? String(argument.value) : '');
  const params = slots.map((slot, index): EntryParam => {
    const argument = args[index]!;
    if (slot === 'value') return compileValue(argument, ctx);
    if (argument.type === 'String') return expansionField(callee, index, argument.value, fields);
    if (argument.type === 'Number') return expansionField(callee, index, String(argument.value), fields);
    return ctx.error(argument, `${callee}() 의 ${index + 1}번째 칸은 목록에서 고르는 자리라 "..." 로 직접 적어야 합니다.`);
  });
  if (params.some((param) => param === null)) return null;

  (ai ? ctx.aiUtilizeBlocks : ctx.expansionBlocks).add(module);
  return ctx.block(callee, params);
}

function compileCall(node: CallNode, ctx: Context): EntryBlock | null {
  const { callee, arguments: args } = node;
  const arity = (count: number) => {
    if (args.length === count) return true;
    ctx.error(node, `${callee}() 는 인자가 ${count}개여야 합니다. (${args.length}개를 받았습니다)`);
    return false;
  };
  const value = (index: number) => compileValue(args[index], ctx);

  const fn = ctx.functionByName.get(callee);
  if (fn) {
    if (!fn.isValue) {
      // Entry also executes void functions in value slots, including their frame delays.
      ctx.notice(
        node,
        `함수 '${callee}' 는 값을 돌려주지 않습니다. 값 자리에서도 돌기는 하지만 자리에는 아무 값도 남지 않습니다.`,
      );
    }
    if (!checkFunctionArity(node, fn, ctx)) return null;
    const params = compileCallArguments(fn, args, ctx);
    if (params.some((p) => p === null)) return null;
    return ctx.block(`func_${fn.id}`, params);
  }

  if (Object.hasOwn(MATH_OPERATIONS, callee)) {
    if (!arity(1)) return null;
    const argument = value(0);
    return argument && ctx.block('calc_operation', [null, argument, null, MATH_OPERATIONS[callee]]);
  }

  switch (callee) {
    case 'trim': case 'trim_start': case 'trim_end': case 'repeat_text': case 'pad_start': case 'pad_end': {
      const pad = callee.startsWith('pad');
      if (pad) {
        if (args.length !== 2 && args.length !== 3) {
          return ctx.error(node, `${callee}() 는 인자가 2개 또는 3개여야 합니다. (${args.length}개를 받았습니다)\n호출 형태: ${callee}(문자열, 목표길이, 채울글자). 채울글자는 생략하면 공백입니다.`);
        }
      } else if (!arity(callee.startsWith('trim') ? 1 : 2)) return null;
      const params = args.map(argument => compileValue(argument, ctx));
      if (params.some(param => param === null)) return null;
      if (pad && params.length === 2) params.push(ctx.text(' '));
      const fn = requireStringHelper(callee, ctx);
      return ctx.block(`func_${fn.id}`, params as EntryParam[]);
    }

    case 'min': case 'max': {
      if (!arity(2)) return null;
      const first = value(0);
      const second = value(1);
      if (!first || !second) return null;
      const fn = requireMinMax(callee, ctx);
      return ctx.block(`func_${fn.id}`, [first, second]);
    }

    case 'starts_with': case 'ends_with': {
      if (!arity(2)) return null;
      const string = value(0);
      const target = value(1);
      if (!string || !target) return null;
      const text = (block: EntryBlock) => callee === 'ends_with'
        ? ctx.block('reverse_of_string', [null, block, null]) : block;
      const index = ctx.block('index_of_string', [null, text(string), null, text(target), null]);
      return ctx.block('boolean_basic_operator', [index, 'EQUAL', ctx.number(1)]);
    }

    case 'log2': {
      // Entry has no base-2 log block, so use ln(x) / ln(2).
      if (!arity(1)) return null;
      const argument = value(0);
      if (!argument) return null;
      return ctx.block('calc_basic', [
        ctx.block('calc_operation', [null, argument, null, 'ln']),
        'DIVIDE',
        ctx.block('calc_operation', [null, ctx.number(2), null, 'ln']),
      ]);
    }

    case 'random': {
      if (!arity(2)) return null;
      const from = value(0);
      const to = value(1);
      return from && to && ctx.block('calc_rand', [null, from, null, to, null]);
    }

    case 'root': {
      if (!arity(2)) return null;
      const degree = foldConstant(args[1]);
      if (degree === null || degree === 0) {
        return ctx.error(node, 'root(값, n) 의 n 은 0이 아닌 숫자로 정해져 있어야 합니다.');
      }
      return buildPower(args[0], 1 / degree, node, ctx);
    }

    case 'key_down': {
      if (!arity(1)) return null;
      const code = literalKeyCode(args[0], ctx, node);
      return code === null ? null : ctx.block('is_press_some_key', [code, null]);
    }

    case 'touching': {
      if (!arity(1)) return null;
      const target = resolveTarget(args[0], ctx, { wall: true });
      return target === null ? null : ctx.block('reach_something', [null, target, null]);
    }

    case 'type':
      return ctx.error(node, 'type() 은 == "number" 처럼 비교해서만 쓸 수 있습니다.');

    case 'distance': {
      if (!arity(1)) return null;
      const target = resolveTarget(args[0], ctx, { mouse: true });
      return target === null ? null : ctx.block('distance_something', [null, target, null]);
    }

    case 'x': case 'y': case 'angle': case 'way': case 'size':
    case 'costume': case 'costume_number': {
      if (!arity(1)) return null;
      const coordinate = OBJECT_COORDINATES[callee];
      if (args[0].type === 'String' && args[0].value === 'mouse') {
        if (callee !== 'x' && callee !== 'y') {
          return ctx.error(node, `마우스는 x(), y() 만 조회할 수 있습니다.`);
        }
        return ctx.block('coordinate_mouse', [null, coordinate, null]);
      }
      const target = resolveTarget(args[0], ctx, { self: true });
      return target === null ? null : ctx.block('coordinate_object', [null, target, null, coordinate]);
    }

    case 'text_content': {
      if (!arity(1)) return null;
      const target = resolveTarget(args[0], ctx, { self: true });
      return target === null ? null : ctx.block('text_read', [target, null]);
    }

    case 'block_count': {
      if (!arity(1)) return null;
      const target = resolveTarget(args[0], ctx, { self: true, all: true });
      return target === null ? null : ctx.block('get_block_count', [target]);
    }

    case 'sound_duration': {
      if (!arity(1)) return null;
      const sound = resolveSoundValue(args[0], ctx);
      return sound === null ? null : ctx.block('get_sound_duration', [null, sound, null]);
    }

    case 'boolean_value': {
      if (!arity(1)) return null;
      const argument = compileAnyValue(args[0], ctx);
      return argument && ctx.block('get_boolean_value', [argument]);
    }

    case 'length': {
      if (!arity(1)) return null;
      const list = resolveList(args[0], ctx);
      if (list) return ctx.block('length_of_list', [null, list.id, null]);
      const argument = value(0);
      return argument && ctx.block('length_of_string', [null, argument, null]);
    }

    case 'contains': {
      if (!arity(2)) return null;
      const list = resolveList(args[0], ctx);
      if (!list) return ctx.error(node, 'contains() 의 첫 번째 인자는 리스트여야 합니다.');
      const item = value(1);
      return item && ctx.block('is_included_in_list', [null, list.id, null, item, null]);
    }

    case 'slice': {
      // Entry substrings are one-based and include both ends.
      if (!arity(3)) return null;
      const string = value(0);
      const start = compileValue(args[1], ctx);
      const end = compileValue(args[2], ctx);
      return string && start && end && ctx.block('substring', [null, string, null, start, null, end, null]);
    }

    case 'count': {
      if (!arity(2)) return null;
      const string = value(0);
      const target = value(1);
      return string && target && ctx.block('count_match_string', [string, null, target, null]);
    }

    case 'join': {
      if (!arity(2)) return null;
      const first = value(0);
      const second = value(1);
      return first && second && ctx.block('combine_something', [null, first, null, second, null]);
    }

    case 'index_of': {
      // Entry searches are one-based and return zero when no match exists.
      if (!arity(2)) return null;
      const string = value(0);
      const target = value(1);
      return string && target && ctx.block('index_of_string', [null, string, null, target, null]);
    }

    case 'replace': {
      if (!arity(3)) return null;
      const string = value(0);
      const from = value(1);
      const to = value(2);
      return string && from && to
        && ctx.block('replace_string', [null, string, null, from, null, to, null]);
    }

    case 'reverse': {
      if (!arity(1)) return null;
      const argument = value(0);
      return argument && ctx.block('reverse_of_string', [null, argument, null]);
    }

    case 'uppercase': case 'lowercase': {
      if (!arity(1)) return null;
      const argument = value(0);
      const mode = callee === 'uppercase' ? 'toUpperCase' : 'toLowerCase';
      return argument && ctx.block('change_string_case', [null, argument, null, mode, null]);
    }

    case 'now': {
      if (!arity(1)) return null;
      const units: Record<string, string> = {
        year: 'YEAR', month: 'MONTH', day: 'DAY', hour: 'HOUR',
        minute: 'MINUTE', second: 'SECOND', weekday: 'DAY_OF_WEEK',
      };
      const unit = args[0].type === 'String' ? units[args[0].value] : undefined;
      if (!unit) {
        return ctx.error(node, 'now() 는 "year", "month", "day", "hour", "minute", "second", "weekday" 만 받습니다.');
      }
      return ctx.block('get_date', [null, unit, null]);
    }

    case 'to_hex': {
      if (!arity(3)) return null;
      const red = value(0);
      const green = value(1);
      const blue = value(2);
      return red && green && blue && ctx.block('change_rgb_to_hex', [red, green, blue]);
    }

    case 'from_hex': {
      if (!arity(2)) return null;
      const channels: Record<string, string> = { red: 'r', green: 'g', blue: 'b' };
      const channel = args[1].type === 'Identifier' ? channels[args[1].name] : null;
      if (!channel) return ctx.error(node, 'from_hex() 의 두 번째 인자는 red, green, blue 중 하나여야 합니다.');
      const color = value(0);
      return color && ctx.block('change_hex_to_rgb', [color, channel]);
    }

    case 'random_color':
      return ctx.error(node, 'random_color() 는 draw_color = random_color() 형태로만 쓸 수 있습니다.');

    case 'row_count':
    case 'column_count': {
      if (!arity(1)) return null;
      const table = tableArgument(args[0], callee, ctx);
      return table && ctx.block('get_table_count', [table.id, callee === 'row_count' ? 'ROW' : 'COL', null]);
    }

    case 'last_row': {
      if (!arity(2)) return null;
      const table = tableArgument(args[0], callee, ctx);
      const column = value(1);
      return table && column && ctx.block('get_value_from_last_row', [table.id, column, null]);
    }

    case 'correlation': {
      if (!arity(3)) return null;
      const table = tableArgument(args[0], callee, ctx);
      const [x, y] = [value(1), value(2)];
      return table && x && y && ctx.block('get_coefficient', [table.id, x, y, null]);
    }

    case 'lookup': {
      if (!arity(4)) return null;
      const table = tableArgument(args[0], callee, ctx);
      const [field, wanted, back] = [value(1), value(2), value(3)];
      return table && field && wanted && back
        && ctx.block('get_value_v_lookup', [table.id, field, wanted, back, null]);
    }

    default:
      if (expansionBlock(callee)) return compileExpansion(node, ctx);
      if (Object.hasOwn(TABLE_CALCULATIONS, callee)) {
        if (!arity(2)) return null;
        const table = tableArgument(args[0], callee, ctx);
        const column = value(1);
        return table && column
          && ctx.block('calc_values_from_table', [table.id, column, TABLE_CALCULATIONS[callee], null]);
      }
      return unknownFunctionError(node, ctx);
  }
}

function literalKeyCode(node: Expr, ctx: Context, at: Node): string | null {
  if (node.type !== 'String') return ctx.error(at, '키 이름은 "space" 처럼 문자열로 직접 적어야 합니다.');
  const code = keyCodeOf(node.value);
  return code ?? ctx.error(at, `알 수 없는 키 이름 "${node.value}" 입니다.`
    + didYouMean(node.value, Object.keys(KEY_CODES)));
}

const MISSING_OBJECT = /^_missing_object_(.+)$/;

export function resolveTarget(
  node: Expr | null | undefined,
  ctx: Context,
  options: TargetOptions = {},
): string | null {
  if (!node || node.type !== 'String') {
    return ctx.error(node ?? null, '오브젝트 이름은 "player" 처럼 문자열로 직접 적어야 합니다.');
  }
  const name = node.value;

  if (name === 'mouse') return 'mouse';
  if (options.wall && name.startsWith('wall')) return name;
  if (options.self && (name === 'self' || name === 'this')) return 'self';
  if (options.all && name === 'all') return 'all';

  const id = ctx.objectId(name);
  if (id) return id;
  // Restore missing object IDs so Entry preserves the unresolved target.
  const dangling = MISSING_OBJECT.exec(name);
  if (dangling) {
    ctx.notice(node, `'${dangling[1]}' 오브젝트가 작품에 없습니다. 엔트리처럼 아이디만 남깁니다.`);
    return dangling[1]!;
  }
  return ctx.error(node, `'${name}' 이라는 오브젝트가 없습니다.${didYouMean(name, ctx.objectByName.keys())}`);
}
