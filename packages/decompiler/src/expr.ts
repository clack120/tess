import { KEY_CODES, STORE_FLAG_ON, STORE_FLAG_VARIABLE } from '@tess/core';
import { tessNumber, tessString, tessLiteral, ownsResource, isExactNumber } from './ident.ts';
import { isBooleanBlock } from '../../compiler/src/expression.ts';
import { expansionBlock } from '@tess/core';
import type { DecompileContext, RawBlock, ResourceInfo } from './types.ts';

// Preserve condition values; an empty Entry slot reads as false.
export function conditionOf(block: any, ctx: DecompileContext): string {
  return block === null || block === undefined ? 'false' : exprOf(block, ctx);
}

export function isJudgement(block: any): boolean {
  return isBooleanBlock(block);
}

const REVERSE_COMPARE: Record<string, string> = {
  EQUAL: '==', NOT_EQUAL: '!=', GREATER: '>', LESS: '<', GREATER_OR_EQUAL: '>=', LESS_OR_EQUAL: '<=',
};
const REVERSE_ARITHMETIC: Record<string, string> = { PLUS: '+', MINUS: '-', MULTI: '*', DIVIDE: '/' };
const TABLE_CALCULATION_NAMES: Record<string, string> = {
  SUM: 'sum', AVG: 'average', MAX: 'maximum', MIN: 'minimum',
  STDEV: 'stdev', MEDIAN: 'median',
};
const REVERSE_MATH: Record<string, string> = {
  sin: 'sin', cos: 'cos', tan: 'tan', asin_radian: 'asin', acos_radian: 'acos', atan_radian: 'atan',
  ln: 'ln', log: 'log10', floor: 'floor', ceil: 'ceil', round: 'round', abs: 'abs',
  factorial: 'factorial',
  // Entry strips calc_operation suffixes, so asin and asin_radian behave alike.
  asin: 'asin', acos: 'acos', atan: 'atan',
};
// The save manager sets its presence flag to 1.
function isStoreFlagTest(block: RawBlock, ctx: DecompileContext): boolean {
  const params = block.params ?? [];
  if (params[1] !== 'EQUAL') return false;
  const read = params[0] as RawBlock | undefined;
  if (read?.type !== 'get_variable') return false;
  const variable = ctx.varsById.get(String(read.params?.[0] ?? ''));
  if (variable?.source.name !== STORE_FLAG_VARIABLE) return false;
  const value = params[2] as RawBlock | undefined;
  const literal = value?.type === 'number' || value?.type === 'text'
    ? value.params?.[0]
    : value;
  return Number(literal) === STORE_FLAG_ON;
}

const REVERSE_PROPERTY_COORD: Record<string, string> = {
  x: 'x', y: 'y', rotation: 'angle', direction: 'way', size: 'size',
  picture_name: 'costume', picture_index: 'costume_number',
};
const REVERSE_OBJECT_COORD: Record<string, string> = { x: 'x', y: 'y', rotation: 'angle', direction: 'way', size: 'size' };
const REVERSE_DATE_UNITS: Record<string, string> = {
  YEAR: 'year', MONTH: 'month', DAY: 'day', HOUR: 'hour', MINUTE: 'minute', SECOND: 'second', DAY_OF_WEEK: 'weekday',
};
const REVERSE_HEX_CHANNEL: Record<string, string> = { r: 'red', g: 'green', b: 'blue' };
const REVERSE_STATE: Record<string, string> = {
  is_clicked: 'mouse_down', is_object_clicked: 'clicked', is_boost_mode: 'boost_mode',
  is_touch_supported: 'touchable', get_user_name: 'user_id', get_nickname: 'nickname',
  get_project_timer_value: 'timer', get_canvas_input_value: 'answer',
};

const REVERSE_KEY_CODE: Record<string, string> = {};
for (const [name, code] of Object.entries(KEY_CODES)) {
  if (!(String(code) in REVERSE_KEY_CODE)) REVERSE_KEY_CODE[String(code)] = name;
}

const EMPTY = '0';

export function colorLiteral(raw: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (raw === 'transparent') return 'transparent';
  return tessString(raw);
}

// Keep missing object IDs in placeholder names so compilation can restore the unresolved target.
export function targetName(ctx: DecompileContext, raw: unknown): string {
  if (raw === 'self' || raw === 'mouse') return raw;
  if (typeof raw === 'string' && raw.startsWith('wall')) return raw;
  const object = ctx.objectsById.get(raw as string);
  if (object) return object.identifier;
  ctx.warnings.add(
    `'${String(raw)}' 을(를) 가리키는 블록이 있지만 그 오브젝트가 작품에 없습니다 — 아이디를 그대로 남겼습니다.`,
  );
  return `_missing_object_${String(raw)}`;
}

// Keep resource IDs in global functions because the calling object is unknown.
function resourceRef(
  ctx: DecompileContext,
  id: string,
  byId: Map<string, ResourceInfo>,
  nameOf: (id: string) => string,
): string {
  if (ctx.inFunction && byId.has(id) && !ownsResource(ctx, byId.get(id))) return tessString(id);
  return tessString(nameOf(id));
}

const BARE_NAME = /^[\p{L}_][\p{L}0-9_]*$/u;

// Indexing reads characters only when the name does not refer to a list or table.
function indexableName(text: string, ctx: DecompileContext): boolean {
  if (!BARE_NAME.test(text)) return false;
  for (const info of ctx.varsById.values()) if (info.isList && info.identifier === text) return false;
  for (const info of ctx.tablesById.values()) if (info.identifier === text) return false;
  return true;
}

function isParamBlock(type: string): boolean {
  return type.startsWith('stringParam_') || type.startsWith('booleanParam_');
}

const SOUND_PLAY_BLOCKS = new Set([
  'sound_something_with_block',
  'sound_something_wait_with_block',
  'sound_something_second_with_block',
  'sound_something_second_wait_with_block',
  'sound_from_to',
  'sound_from_to_and_wait',
]);

// Sound probes become 1 because tessvm loads all sounds before starting.
function soundProbe(ctx: DecompileContext, block: RawBlock | undefined): string | null {
  if (!block?.type || !SOUND_PLAY_BLOCKS.has(block.type)) return null;
  ctx.notices.add(
    `값 자리의 '${block.type}' 은(는) 소리가 다 준비됐는지 보는 자리라 1 로 옮겼습니다.`,
  );
  return '1';
}

// Entry returns 0 for a local ID absent from the running function.
function funcLocal(ctx: DecompileContext, id: string): string | null {
  const name = ctx.funcLocalName(id);
  if (name === null) {
    ctx.notices.add(
      `'${id}' 은(는) 다른 함수의 지역변수입니다. 엔트리도 이 자리를 0 으로 읽으므로 그렇게 옮겼습니다.`,
    );
  }
  return name;
}

function placeholder(ctx: DecompileContext, block: RawBlock | undefined): string {
  const probe = soundProbe(ctx, block);
  if (probe !== null) return probe;
  const type = block?.type ?? '(빈 슬롯)';
  ctx.warnings.add(`값 블록 '${type}' 은(는) 아직 옮길 수 없습니다.`);
  return `"[decompile: ${type}]"`;
}

export function exprOf(block: any, ctx: DecompileContext): string {
  if (block === null || block === undefined) return EMPTY;
  if (typeof block === 'string') return tessString(block);
  if (typeof block === 'number') return tessNumber(block);
  if (typeof block !== 'object' || !block.type) return EMPTY;

  const p = block.params ?? [];
  const at = (i: number) => p[i];

  switch (block.type) {
    // Preserve literal text such as leading zeros instead of converting it to a number.
    case 'number': case 'text': {
      const raw = String(at(0) ?? '');
      if (raw === 'transparent') return 'transparent';
      if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
      return isExactNumber(raw) ? raw : tessString(raw);
    }
    case 'angle': return tessNumber(Number(at(0)) || 0);

    case 'get_variable': return ctx.varName(at(0));
    case 'get_func_variable': return funcLocal(ctx, at(0)) ?? '0';

    case 'coordinate_object': {
      const target = at(1);
      const coordinate = REVERSE_PROPERTY_COORD[at(3)] ?? REVERSE_OBJECT_COORD[at(3)];
      if (!coordinate) return placeholder(ctx, block);
      if (target === 'self' || target === null) return coordinate;
      return `${coordinate}(${tessString(targetName(ctx, target))})`;
    }
    case 'get_x_coordinate': return 'x';
    case 'get_y_coordinate': return 'y';
    case 'calc_mod': return `(${exprOf(at(0), ctx)} % ${exprOf(at(2), ctx)})`;
    case 'calc_share': return `(${exprOf(at(0), ctx)} // ${exprOf(at(2), ctx)})`;
    // Legacy arithmetic reads both operands as numbers, so + never concatenates.
    case 'calc_plus': return `(${exprOf(at(0), ctx)} + ${exprOf(at(2), ctx)})`;
    case 'calc_minus': return `(${exprOf(at(0), ctx)} - ${exprOf(at(2), ctx)})`;
    case 'calc_times': return `(${exprOf(at(0), ctx)} * ${exprOf(at(2), ctx)})`;
    case 'calc_divide': return `(${exprOf(at(0), ctx)} / ${exprOf(at(2), ctx)})`;
    case 'boolean_equal': return `(${exprOf(at(0), ctx)} == ${exprOf(at(2), ctx)})`;
    case 'boolean_bigger': return `(${exprOf(at(0), ctx)} > ${exprOf(at(2), ctx)})`;
    case 'boolean_smaller': return `(${exprOf(at(0), ctx)} < ${exprOf(at(2), ctx)})`;
    // Entry resolves FIRST, LAST, and RANDOM in list index slots.
    case 'options_for_list': return tessString(String(at(0) ?? 'FIRST'));

    case 'coordinate_mouse': {
      const coordinate = REVERSE_OBJECT_COORD[at(1)];
      return coordinate ? `${coordinate}(${tessString('mouse')})` : placeholder(ctx, block);
    }

    case 'calc_basic': {
      const op = REVERSE_ARITHMETIC[at(1)];
      if (!op) return placeholder(ctx, block);
      return `(${exprOf(at(0), ctx)} ${op} ${exprOf(at(2), ctx)})`;
    }
    case 'quotient_and_mod': {
      const op = at(5) === 'MOD' ? '%' : '//';
      return `(${exprOf(at(1), ctx)} ${op} ${exprOf(at(3), ctx)})`;
    }
    case 'calc_rand': return `random(${exprOf(at(1), ctx)}, ${exprOf(at(3), ctx)})`;
    case 'calc_operation': {
      const op = at(3);
      if (op === 'square') return `(${exprOf(at(1), ctx)} ** 2)`;
      if (op === 'root') return `(${exprOf(at(1), ctx)} ** 0.5)`;
      // Use decimal subtraction for fractional parts; modulo introduces binary rounding errors.
      if (op === 'unnatural') {
        const value = `abs(${exprOf(at(1), ctx)})`;
        return `(${value} - floor(${value}))`;
      }
      // Entry treats unknown rounding operators as round.
      const fn = REVERSE_MATH[op as string] ?? 'round';
      return `${fn}(${exprOf(at(1), ctx)})`;
    }

    case 'boolean_basic_operator': {
      const op = REVERSE_COMPARE[at(1)];
      if (!op) return placeholder(ctx, block);
      if (isStoreFlagTest(block, ctx)) return 'can_save';
      return `(${exprOf(at(0), ctx)} ${op} ${exprOf(at(2), ctx)})`;
    }
    case 'boolean_and_or': {
      // Entry applies Boolean here, so an empty side is false.
      const side = (i: number) => at(i) == null ? 'false' : exprOf(at(i), ctx);
      return `(${side(0)} ${at(1) === 'AND' ? 'and' : 'or'} ${side(2)})`;
    }
    case 'boolean_and': return `(${conditionOf(at(0), ctx)} and ${conditionOf(at(2), ctx)})`;
    case 'boolean_or': return `(${conditionOf(at(0), ctx)} or ${conditionOf(at(2), ctx)})`;
    case 'boolean_not': return `not (${conditionOf(at(1), ctx)})`;
    case 'True': return 'true';
    case 'False': return 'false';
    // Keep judgement expressions directly because Tess value slots accept them.
    case 'get_boolean_value': return `boolean_value(${conditionOf(at(0), ctx)})`;
    case 'is_clicked': case 'is_object_clicked': case 'is_boost_mode':
    case 'is_touch_supported': case 'get_user_name': case 'get_nickname':
    case 'get_project_timer_value': case 'get_canvas_input_value':
      return REVERSE_STATE[block.type];
    case 'get_sound_volume': return 'sound_volume';
    case 'get_sound_speed': return 'sound_speed';
    case 'get_block_count': {
      const target = at(0);
      if (!target || target === 'all') return 'block_count';
      return `block_count(${tessString(targetName(ctx, target))})`;
    }
    case 'is_press_some_key': {
      // Keep unnamed key codes as numbers.
      const code = String(at(0) ?? '').trim();
      const key = REVERSE_KEY_CODE[code] ?? (/^[0-9]{1,3}$/.test(code) ? code : null);
      return key ? `key_down(${tessString(key)})` : placeholder(ctx, block);
    }
    case 'reach_something': return `touching(${tessString(targetName(ctx, at(1)))})`;
    case 'distance_something': return `distance(${tessString(targetName(ctx, at(1)))})`;
    case 'is_current_device_type': return `(device == ${tessString(at(0))})`;
    case 'is_type': {
      const kind = at(2) === 'number' ? 'number' : 'string';
      return `(type(${exprOf(at(0), ctx)}) == ${tessString(kind)})`;
    }

    case 'value_of_index_from_list': {
      const list = ctx.varName(at(1));
      return `${list}[${exprOf(at(3), ctx)}]`;
    }
    case 'char_at': {
      const index = exprOf(at(3), ctx);
      const target = exprOf(at(1), ctx);
      if (indexableName(target, ctx)) return `${target}[${index}]`;
      const literalIndex = at(3) === null || at(3) === undefined
        || ['number', 'text'].includes((at(3) as RawBlock | undefined)?.type ?? '');
      if (!literalIndex) {
        ctx.warnings.add(
          `'${target}' 의 글자 하나를 읽는 자리는 slice 로 옮겼습니다 — 자리 번호가 두 번 계산되니, `
          + '그 안에 무작위 수처럼 부를 때마다 달라지는 값이 있으면 결과가 달라집니다.',
        );
      }
      return `slice(${target}, ${index}, ${index})`;
    }
    case 'length_of_list': return `length(${ctx.varName(at(1))})`;
    case 'length_of_string': return `length(${exprOf(at(1), ctx)})`;
    case 'is_included_in_list': return `contains(${ctx.varName(at(1))}, ${exprOf(at(3), ctx)})`;
    case 'combine_something': return `join(${exprOf(at(1), ctx)}, ${exprOf(at(3), ctx)})`;
    case 'substring': return `slice(${exprOf(at(1), ctx)}, ${exprOf(at(3), ctx)}, ${exprOf(at(5), ctx)})`;
    case 'count_match_string': return `count(${exprOf(at(0), ctx)}, ${exprOf(at(2), ctx)})`;
    case 'index_of_string': return `index_of(${exprOf(at(1), ctx)}, ${exprOf(at(3), ctx)})`;
    case 'replace_string': return `replace(${exprOf(at(1), ctx)}, ${exprOf(at(3), ctx)}, ${exprOf(at(5), ctx)})`;
    case 'reverse_of_string': return `reverse(${exprOf(at(1), ctx)})`;
    case 'change_string_case': return `${at(3) === 'toUpperCase' ? 'uppercase' : 'lowercase'}(${exprOf(at(1), ctx)})`;
    case 'get_date': {
      const unit = REVERSE_DATE_UNITS[at(1)];
      return unit ? `now(${tessString(unit)})` : placeholder(ctx, block);
    }
    case 'change_rgb_to_hex': return `to_hex(${exprOf(at(0), ctx)}, ${exprOf(at(1), ctx)}, ${exprOf(at(2), ctx)})`;
    case 'change_hex_to_rgb': {
      const channel = REVERSE_HEX_CHANNEL[at(1)];
      return channel ? `from_hex(${exprOf(at(0), ctx)}, ${channel})` : placeholder(ctx, block);
    }
    case 'text_read': return `text_content(${tessString(targetName(ctx, at(0)))})`;

    case 'get_table_count':
      return `${String(at(1)) === 'COL' ? 'column_count' : 'row_count'}(${ctx.tableName(at(0))})`;
    case 'get_value_from_table':
      return `${ctx.tableName(at(0))}[${exprOf(at(1), ctx)}, ${exprOf(at(2), ctx)}]`;
    case 'get_value_from_cell':
      return `${ctx.tableName(at(0))}[${exprOf(at(1), ctx)}]`;
    // Entry stores one-based column numbers even when the dropdown displays names.
    case 'get_table_fields':
      return tessLiteral(at(0));
    case 'get_value_from_last_row':
      return `last_row(${ctx.tableName(at(0))}, ${exprOf(at(1), ctx)})`;
    case 'calc_values_from_table': {
      const calc = TABLE_CALCULATION_NAMES[String(at(2))];
      if (!calc) return placeholder(ctx, block);
      return `${calc}(${ctx.tableName(at(0))}, ${exprOf(at(1), ctx)})`;
    }
    case 'get_coefficient':
      return `correlation(${ctx.tableName(at(0))}, ${exprOf(at(1), ctx)}, ${exprOf(at(2), ctx)})`;
    case 'get_value_v_lookup':
      return `lookup(${ctx.tableName(at(0))}, ${exprOf(at(1), ctx)}, `
        + `${exprOf(at(2), ctx)}, ${exprOf(at(3), ctx)})`;

    case 'get_pictures': return resourceRef(ctx, at(0), ctx.picturesById, ctx.pictureName);
    case 'get_sounds': return resourceRef(ctx, at(0), ctx.soundsById, ctx.soundName);
    case 'get_sound_duration':
      return `sound_duration(${resourceRef(ctx, at(1), ctx.soundsById, ctx.soundName)})`;
    // Both primitive color pickers hold a plain hex string.
    case 'color': case 'text_color': return colorLiteral(String(at(0) ?? ''));

    default: {
      const expansion = expansionBlock(block.type);
      if (expansion) {
        const args = expansion.slots.map((slot, i) => (slot === 'value'
          ? exprOf(at(i), ctx)
          : tessString(String(at(i) ?? ''))));
        return `${block.type}(${args.join(', ')})`;
      }

      const paramName = ctx.funcParamName?.(block.type);
      if (paramName) return paramName;
      // Entry treats another function's parameter as an empty slot.
      if (isParamBlock(block.type)) {
        ctx.notices.add(
          `'${block.type}' 은(는) 다른 함수의 매개변수입니다. 엔트리도 이 자리를 빈 값으로 읽으므로 그렇게 옮겼습니다.`,
        );
        return block.type.startsWith('booleanParam_') ? 'false' : EMPTY;
      }

      if (block.type.startsWith('func_')) {
        const fn = ctx.functionsById.get(block.type.slice('func_'.length));
        if (fn) {
          const args = p.filter((_: unknown, i: number) => i < fn.params.length)
            .map((param: unknown) => exprOf(param, ctx));
          return `${fn.name}(${args.join(', ')})`;
        }
      }
      return placeholder(ctx, block);
    }
  }
}
