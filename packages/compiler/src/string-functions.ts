import type { Context } from './context.ts';
import type { CompiledFunction, EntryBlock, EntryParam, FuncLocalVariable } from './types.ts';

export type StringHelper = 'trim' | 'trim_start' | 'trim_end' | 'repeat_text' | 'pad_start' | 'pad_end';

const WHITESPACE = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

/** Build portable Entry helpers, keeping working state local to each call. */
export function requireStringHelper(kind: StringHelper, ctx: Context): CompiledFunction {
  const cached = ctx.runtimeFunctions.get(kind);
  if (cached) return cached;
  const trim = kind.startsWith('trim');
  const pad = kind.startsWith('pad');
  const id = ctx.newId();
  const params = trim ? ['text'] : pad ? ['text', 'count', 'fill'] : ['text', 'count'];
  const paramTypes = new Map(params.map(name => [name, `stringParam_${ctx.newId()}`]));
  const param = (name: string) => ctx.block(paramTypes.get(name)!, []);
  const localVariables: FuncLocalVariable[] = [];
  const localIds = new Map<string, string>();
  const localId = (name: string) => {
    let result = localIds.get(name);
    if (!result) {
      result = `${id}_${ctx.newId()}`;
      localIds.set(name, result);
      localVariables.push({ id: result, name, value: 0 });
    }
    return result;
  };
  const read = (name: string) => ctx.block('get_func_variable', [localId(name), null]);
  const write = (name: string, value: EntryParam) => ctx.block('set_func_variable', [localId(name), value, null]);
  const calc = (left: EntryParam, op: string, right: EntryParam) => ctx.block('calc_basic', [left, op, right]);
  const compare = (left: EntryParam, op: string, right: EntryParam) => ctx.block('boolean_basic_operator', [left, op, right]);
  const length = (value: EntryParam) => ctx.block('length_of_string', [null, value, null]);
  const combine = (a: EntryParam, b: EntryParam) => ctx.block('combine_something', [null, a, null, b, null]);
  const slice = (value: EntryParam, from: EntryParam, to: EntryParam) => ctx.block('substring', [null, value, null, from, null, to, null]);
  const math = (value: EntryParam, op: string) => ctx.block('calc_operation', [null, value, null, op]);
  const choose = (test: EntryParam, yes: EntryBlock[], no: EntryBlock[] = []) => ctx.block('if_else', [test, null, null], [yes, no]);
  const loop = (test: EntryParam, body: EntryBlock[]) => ctx.block('repeat_while_true', [test, 'while', null], [body]);
  const number = (value: number) => ctx.number(value);
  const text = () => combine(ctx.text(''), param('text'));
  const resultId = ctx.newId();
  ctx.variables.push({ id: resultId, name: `[Tess] ${kind} result`, value: '', visible: false,
    variableType: 'variable', isCloud: false, isRealTime: false, cloudDate: false, object: null, x: 0, y: 0 });
  // Only write the result after any yielding loop: other calls cannot overwrite working state.
  const finish = (value: EntryParam) => ctx.block('set_variable', [resultId, value, null]);
  const body: EntryBlock[] = [];
  if (trim) {
    body.push(write('start', number(1)), write('end', length(param('text'))));
    const scan = (edge: 'start' | 'end', step: number) => {
      const character = ctx.block('char_at', [null, param('text'), null, read(edge), null]);
      const position = ctx.block('index_of_string', [null, ctx.text(WHITESPACE), null, character, null]);
      return loop(compare(read('start'), 'LESS_OR_EQUAL', read('end')), [
        choose(compare(position, 'EQUAL', number(0)), [ctx.block('stop_repeat', [null])]),
        write(edge, calc(read(edge), 'PLUS', number(step))),
      ]);
    };
    if (kind !== 'trim_end') body.push(scan('start', 1));
    if (kind !== 'trim_start') body.push(scan('end', -1));
    body.push(choose(compare(read('start'), 'LESS_OR_EQUAL', read('end')),
      [finish(slice(param('text'), read('start'), read('end')))], [finish(ctx.text(''))]));
  } else {
    const piece = () => combine(ctx.text(''), param(pad ? 'fill' : 'text'));
    const needed = () => read('needed');
    body.push(write('needed', pad
      ? calc(math(param('count'), 'floor'), 'MINUS', length(param('text')))
      : math(param('count'), 'floor')));
    const doubled: EntryBlock[] = [
      write('piece', piece()), write('accumulator', ctx.text('@')),
      write('remaining', pad ? math(calc(needed(), 'DIVIDE', length(param('fill'))), 'ceil') : needed()),
      loop(compare(read('remaining'), 'GREATER', number(0)), [
        choose(compare(ctx.block('quotient_and_mod', [null, read('remaining'), null, number(2), null, 'MOD']), 'EQUAL', number(1)),
          [write('accumulator', combine(read('accumulator'), read('piece')))]),
        write('remaining', math(calc(read('remaining'), 'DIVIDE', number(2)), 'floor')),
        choose(compare(read('remaining'), 'GREATER', number(0)), [write('piece', combine(read('piece'), read('piece')))]),
      ]),
    ];
    const repeated = () => slice(read('accumulator'), number(2), pad ? calc(needed(), 'PLUS', number(1)) : length(read('accumulator')));
    doubled.push(finish(pad ? (kind === 'pad_start' ? combine(repeated(), text()) : combine(text(), repeated())) : repeated()));
    const test = ctx.block('boolean_and_or', [compare(needed(), 'GREATER', number(0)), 'AND', compare(length(piece()), 'GREATER', number(0))]);
    body.push(choose(test, doubled, [finish(pad ? text() : ctx.text(''))]));
  }
  const field = ctx.block('function_field_label', [
    `[Tess] ${kind}`,
    params.reduceRight<EntryParam>((next, name) => ctx.block('function_field_string', [ctx.block(paramTypes.get(name)!, []), next]), null),
  ]);
  const create = ctx.block('function_create_value', [field, null, null, ctx.block('get_variable', [resultId, null])], [body]);
  const fn: CompiledFunction = { id, name: `[Tess] ${kind}`, params, paramTypes, localVariables,
    isValue: true, generated: true, type: 'value', content: [[create]] };
  ctx.functions.push(fn);
  ctx.runtimeFunctions.set(kind, fn);
  return fn;
}
