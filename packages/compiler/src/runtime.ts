import {
  STORE_FLAG_VARIABLE,
  STORE_SAVE_ASYNC_FUNCTION,
  STORE_SAVE_FUNCTION,
} from '@entropy/core';
import type { Context } from './context.ts';
import type {
  CompiledFunction, EntryParam, EntryVariable, FuncLocalVariable,
} from './types.ts';

const MEASURE = 100000;
const AXES: Record<string, { setter: string; probe: string; label: string }> = {
  scale_x: { setter: 'WIDTH', probe: 'HEIGHT', label: '[Entropy] 가로 비율 정하기' },
  scale_y: { setter: 'HEIGHT', probe: 'WIDTH', label: '[Entropy] 세로 비율 정하기' },
};

// Select numeric parameters once without arithmetic that could overflow.
export function requireMinMax(kind: 'min' | 'max', ctx: Context): CompiledFunction {
  const cached = ctx.runtimeFunctions.get(kind);
  if (cached) return cached;
  const id = ctx.newId();
  const params = ['a', 'b'];
  const paramTypes = new Map(params.map(name => [name, `stringParam_${ctx.newId()}`]));
  const numeric = (name: string) => ctx.block('calc_basic', [ctx.block(paramTypes.get(name)!, []), 'MULTI', ctx.number(1)]);
  const local = `${id}_${ctx.newId()}`;
  const body = [
    ctx.block('set_func_variable', [local, numeric('a'), null]),
    ctx.block('_if', [ctx.block('boolean_basic_operator', [numeric('b'), kind === 'min' ? 'LESS' : 'GREATER', numeric('a')]), null],
      [[ctx.block('set_func_variable', [local, numeric('b'), null])]]),
  ];
  const field = ctx.block('function_field_label', [
    `[Entropy] ${kind}`,
    params.reduceRight<EntryParam>((next, name) => ctx.block('function_field_string', [ctx.block(paramTypes.get(name)!, []), next]), null),
  ]);
  const create = ctx.block('function_create_value', [field, null, null, ctx.block('get_func_variable', [local, null])], [body]);
  const fn: CompiledFunction = { id, name: `[Entropy] ${kind}`, params, paramTypes,
    isValue: true, generated: true, type: 'value',
    localVariables: [{ id: local, name: 'result', value: 0 }], content: [[create]] };
  ctx.functions.push(fn);
  ctx.runtimeFunctions.set(kind, fn);
  return fn;
}

export function requireScaleSetter(property: string, ctx: Context): CompiledFunction {
  const existing = ctx.runtimeFunctions.get(property);
  if (existing) return existing;

  const axis = AXES[property];
  const id = ctx.newId();
  const params = ['비율', '원래 배율'];
  const paramTypes = new Map(params.map((name) => [name, `stringParam_${ctx.newId()}`]));

  // Function locals keep measurements separate for each call and clone.
  const locals: Record<string, string> = {};
  const localVariables: FuncLocalVariable[] = ['현재 크기', '지금 축', '원래 크기', '원래 축'].map((name) => {
    const variable = { id: `${id}_${ctx.newId()}`, name, value: 0 };
    locals[name] = variable.id;
    return variable;
  });

  const size = () => ctx.block('coordinate_object', [null, 'self', null, 'size']);
  const local = (name: string) => ctx.block('get_func_variable', [locals[name]!, null]);
  const setLocal = (name: string, value: EntryParam) => ctx.block('set_func_variable', [locals[name]!, value, null]);
  const param = (name: string) => ctx.block(paramTypes.get(name)!, []);
  const number = (value: number) => ctx.number(value);
  const calc = (left: EntryParam, operator: string, right: EntryParam) => ctx.block('calc_basic', [left, operator, right]);
  const stretch = (dimension: string, value: EntryParam) => ctx.block('stretch_scale_size', [dimension, value, null]);

  // Axis measurement: 2 * base size * (stretched size - base size) * 0.00001.
  const measured = (baseline: string) => calc(
    calc(calc(number(2), 'MULTI', local(baseline)), 'MULTI', calc(size(), 'MINUS', local(baseline))),
    'MULTI',
    number(1 / MEASURE),
  );

  const body = [
    // Measure the axis that must stay unchanged.
    setLocal('현재 크기', size()),
    stretch(axis.probe, number(MEASURE)),
    setLocal('지금 축', measured('현재 크기')),

    // Reset the size and measure that axis at its original scale.
    ctx.block('reset_scale_size', [null]),
    setLocal('원래 크기', size()),
    stretch(axis.probe, number(MEASURE)),
    setLocal('원래 축', measured('원래 크기')),
    ctx.block('reset_scale_size', [null]),

    // Restore the unchanged axis because setting size scales both axes.
    ctx.block('set_scale_size', [
      calc(calc(size(), 'MULTI', local('지금 축')), 'DIVIDE', local('원래 축')),
      null,
    ]),

    // Adjust the target axis using the measured ratio.
    stretch(axis.setter, calc(
      size(),
      'MULTI',
      calc(
        calc(
          calc(param('비율'), 'MULTI', local('원래 축')),
          'DIVIDE',
          calc(calc(number(100), 'MULTI', param('원래 배율')), 'MULTI', local('지금 축')),
        ),
        'MINUS',
        number(1),
      ),
    )),
  ];

  const field = ctx.block('function_field_label', [
    axis.label,
    params.reduceRight<EntryParam>(
      (next, name) => ctx.block('function_field_string', [ctx.block(paramTypes.get(name)!, []), next]),
      null,
    ),
  ]);

  const create = ctx.block('function_create', [field, null], [body]);
  create.x = 50;
  create.y = 30;

  const fn = {
    id,
    name: axis.label,
    generated: true,
    type: 'normal',
    params,
    paramTypes,
    isValue: false,
    localVariables,
    content: [[create]],
  };
  ctx.functions.push(fn);
  ctx.runtimeFunctions.set(property, fn);
  return fn;
}


// Pass the power estimate to a helper so Newton correction does not duplicate its blocks.
export function requirePowerRefiner(ctx: Context): CompiledFunction {
  const existing = ctx.runtimeFunctions.get('power');
  if (existing) return existing;

  const id = ctx.newId();
  const params = ['어림값', '밑', '지수'];
  const paramTypes = new Map(params.map((name) => [name, `stringParam_${ctx.newId()}`]));
  const param = (name: string) => ctx.block(paramTypes.get(name)!, []);
  const calc = (left: EntryParam, operator: string, right: EntryParam) => ctx.block('calc_basic', [left, operator, right]);
  const ln = (value: EntryParam) => ctx.block('calc_operation', [null, value, null, 'ln']);

  // Newton correction: estimate * (1 + exponent * ln(base) - ln(estimate)).
  const refined = calc(
    param('어림값'),
    'MULTI',
    calc(
      calc(ctx.number(1), 'PLUS', calc(param('지수'), 'MULTI', ln(param('밑')))),
      'MINUS',
      ln(param('어림값')),
    ),
  );

  const field = ctx.block('function_field_label', [
    '[Entropy] 거듭제곱 다듬기',
    params.reduceRight<EntryParam>(
      (next, name) => ctx.block('function_field_string', [ctx.block(paramTypes.get(name)!, []), next]),
      null,
    ),
  ]);

  const create = ctx.block('function_create_value', [field, null, null, refined], [
    [ctx.block('stop_object', ['thisThread', null])],
  ]);
  create.x = 50;
  create.y = 30;

  const fn = {
    id,
    name: '[Entropy] 거듭제곱 다듬기',
    generated: true,
    type: 'value',
    params,
    paramTypes,
    isValue: true,
    localVariables: [],
    content: [[create]],
  };
  ctx.functions.push(fn);
  ctx.runtimeFunctions.set('power', fn);
  return fn;
}


// The save extension intercepts these empty functions; without it they do nothing.
export function requireSaveFunction(async: boolean, ctx: Context): CompiledFunction {
  const key = async ? 'save-async' : 'save';
  const cached = ctx.runtimeFunctions.get(key);
  if (cached) return cached;

  const name = async ? STORE_SAVE_ASYNC_FUNCTION : STORE_SAVE_FUNCTION;
  // Reuse save functions already present in decompiled projects.
  const declared = ctx.functions.find((fn) => fn.name === name);
  if (declared) {
    ctx.runtimeFunctions.set(key, declared);
    return declared;
  }

  const id = ctx.newId();
  const create = ctx.block('function_create', [
    ctx.block('function_field_label', [name, null]),
    null,
  ], [[]]);
  create.x = 50;
  create.y = 30;

  const fn: CompiledFunction = {
    id,
    name,
    generated: true,
    type: 'normal',
    params: [],
    paramTypes: new Map(),
    isValue: false,
    localVariables: [],
    content: [[create]],
  };
  ctx.functions.push(fn);
  ctx.runtimeFunctions.set(key, fn);
  return fn;
}

// The save manager changes this flag to 1; without it the saved value stays 0.
export function requireStoreFlag(ctx: Context): EntryVariable {
  const existing = ctx.variables.find(
    (variable) => variable.name === STORE_FLAG_VARIABLE && variable.object === null,
  );
  if (existing) return existing;
  const variable: EntryVariable = {
    name: STORE_FLAG_VARIABLE,
    id: ctx.newId(),
    visible: false,
    value: 0,
    variableType: 'variable',
    isCloud: false,
    isRealTime: false,
    cloudDate: false,
    object: null,
    x: 0,
    y: 0,
  };
  ctx.variables.push(variable);
  return variable;
}
