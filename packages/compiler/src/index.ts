import { Context } from './context.ts';
import { EMPTY_HOST, dirname } from './host.ts';
import { loadProgram, createCompileCache } from './include.ts';
import { buildCommentMap } from './comments.ts';
import { makeAsset } from './assets.ts';
import { diagnoseEntryRisks } from './entry-risks.ts';
import { verifyEntryProject } from './verify.ts';
import { compileStatements, compileStatement } from './statement.ts';
import { compileValue } from './expression.ts';
import { KEY_CODES, STORE_PREFIX, keyCodeOf } from '@entropy/core';
import { didYouMean } from '@entropy/core';
import { codeFrame, validate } from '@entropy/parser';
import { isAutoParamName } from '@entropy/core';
import type {
  AssignNode, CostumeNode, EventNode, FunctionDeclNode, Expr, ListDeclNode, Node, ObjectNode,
  ProgramNode, ReturnNode, SceneMember, SoundNode, Stmt, TableChartNode, TableDeclNode,
  TopLevelItem, VarDeclNode,
} from '@entropy/parser';
import type {
  CompiledFunction, CompiledObject, CompileDiagnostic, CompileOptions,
  CompileResult, EntryBlock, EntryEntity, EntryObject, EntryParam, EntryProject,
  EntryScene, EntryTable, EntryVariable, PhaseTiming,
} from './types.ts';

type AnyNode = Record<string, unknown>;

export { createCompileCache };

const DEFAULT_SCENE_NAME = '장면 1';
// Entry's font-family is Nanum Gothic; the Korean label has no matching font face.
const DEFAULT_FONT = 'Nanum Gothic';
// Entry has no saved brush defaults, so apply them in an initial start script.
const BRUSH_DEFAULT_PROPERTIES = ['draw_color', 'fill_color', 'draw_width', 'draw_alpha'];

// Loose mode keeps valid statements; strict mode returns no project on errors.
export function compileProject(source: string, options: CompileOptions = {}): CompileResult {
  const filePath = options.path ?? '<input>';
  const timer = createTimer(options.onPhase);
  const host = options.host ?? EMPTY_HOST;
  const loaded = loadProgram({
    source, path: filePath, readFile: options.readFile, cache: options.cache, host,
  });
  const withFrames = (items: CompileDiagnostic[]): CompileDiagnostic[] => items.map(item => {
    const text = loaded.sources.get(item.file ?? filePath) ?? source;
    const length = Math.max(1, (item.endOffset ?? item.offset + 1) - item.offset);
    return {
      ...item,
      detail: item.detail ?? codeFrame(text, item.line, item.column, '', item.column + length),
      ...(item.related ? { related: withFrames(item.related) } : {}),
    };
  });
  timer.mark('불러오기 · 파싱');
  if (!loaded.ast) {
    return {
      ok: false,
      project: null,
      errors: withFrames(loaded.errors),
      warnings: withFrames(loaded.warnings),
      notices: [],
      assets: [],
      timings: timer.timings,
    };
  }

  const semantic = validate(loaded.ast, source, loaded.sources);
  timer.mark('의미 검증');
  const comments = options.comments ?? buildCommentMap(loaded.ast, loaded.sources);
  timer.mark('주석 모으기');
  const ctx = new Context(source, {
    ...options,
    sources: loaded.sources,
    comments,
    host,
    assetDirs: options.assetDirs ?? [dirname(host.resolve('.', filePath))],
  });
  // Include failures must be reported even when the top-level file parses successfully.
  for (const list of [loaded.errors, semantic.errors]) for (const item of list) ctx.errors.push(item);
  for (const list of [loaded.warnings, semantic.warnings]) for (const item of list) ctx.warnings.push(item);

  const program = loaded.ast;
  collectScenes(program, ctx);
  collectGlobals(program, ctx);
  collectObjects(program, ctx);
  collectFunctions(program, ctx);
  collectMessages(program, ctx);
  diagnoseEntryRisks(ctx);
  timer.mark('심볼 · 리소스 수집');

  compileFunctions(ctx);
  compileObjects(ctx);
  timer.mark('스크립트 컴파일');

  const project = assemble(program, ctx, options);
  const projectBytes = new TextEncoder().encode(JSON.stringify(project)).length;
  if (projectBytes > 10 * 1024 * 1024) {
    ctx.warn(program, `project.json 크기가 ${(projectBytes / 1024 / 1024).toFixed(1)}MB라 Entry 업로드 기준 10MB를 넘습니다.`, {
      code: 'W0008',
      help: '큰 리스트와 반복 생성된 블록을 줄이거나 작품을 나누세요. .ent 압축 크기가 작아도 project.json 원문 크기는 별도 제한을 받습니다.',
    });
  }
  const verificationProblems = verifyEntryProject(project, { references: false });
  for (const problem of verificationProblems) {
    ctx.error(program, `엔트리에서 안전하게 열 수 없는 작품이 만들어졌습니다: ${problem}`, {
      code: 'E9001',
      help: '소스 문제가 아니라 컴파일러의 Entry 블록 스키마 검증 실패입니다. 이 진단과 소스를 함께 버그로 신고하세요.',
    });
  }
  timer.mark('작품 조립');

  const ok = ctx.errors.length === 0;
  const strict = options.strict === true;
  const warnings = strict ? [...ctx.warnings, ...ctx.notices] : ctx.warnings;
  return {
    ok,
    project: verificationProblems.length === 0 && (ok || !strict) ? project : null,
    errors: withFrames(ctx.errors),
    warnings: withFrames(withoutDuplicates(warnings, ctx.errors)),
    notices: strict ? [] : withFrames(withoutDuplicates(ctx.notices, ctx.errors)),
    assets: ctx.assetFiles,
    sourceMap: ctx.sourceMap,
    timings: timer.timings,
  };
}

const spotOf = (item: CompileDiagnostic) => `${item.file ?? ''}:${item.offset}`;

// Suppress validation warnings when compilation already reports the same source error.
function withoutDuplicates(warnings: CompileDiagnostic[], errors: CompileDiagnostic[]): CompileDiagnostic[] {
  if (errors.length === 0) return warnings;
  const spots = new Set(errors.map(spotOf));
  return warnings.filter((warning) => !spots.has(spotOf(warning)));
}

function createTimer(onPhase?: (phase: PhaseTiming) => void) {
  const timings: PhaseTiming[] = [];
  let last = performance.now();
  return {
    timings,
    mark(label: string) {
      const now = performance.now();
      const phase = { label, ms: now - last };
      timings.push(phase);
      onPhase?.(phase);
      last = now;
    },
  };
}

function collectScenes(program: ProgramNode, ctx: Context) {
  for (const item of program.body) {
    if (item.type !== 'Scene') continue;
    if (ctx.sceneByName.has(item.name)) {
      ctx.error(item, `'${item.name}' 장면이 이미 있습니다.`);
      continue;
    }
    const scene = { id: ctx.newId(), name: sceneDisplayName(item, ctx) ?? item.name };
    ctx.scenes.push(scene);
    ctx.sceneByName.set(item.name, scene);
  }

  const hasLooseObject = program.body.some((item) => item.type === 'Object');
  if (ctx.scenes.length === 0 || (hasLooseObject && ctx.scenes.length === 0)) {
    const scene = { id: ctx.newId(), name: DEFAULT_SCENE_NAME };
    ctx.scenes.unshift(scene);
    ctx.sceneByName.set(scene.name, scene);
  }
}

function sceneDisplayName(item: { body: SceneMember[] }, ctx: Context): string | null {
  let value: Expr | null = null;
  for (const member of item.body) {
    if (member.type === 'Property' && member.name === 'name') value = member.value;
  }
  if (value === null) return null;
  if (value.type !== 'String') {
    ctx.error(value, `장면 이름(name)에는 문자열만 쓸 수 있습니다.`);
    return null;
  }
  return value.value;
}

function collectGlobals(program: ProgramNode, ctx: Context) {
  for (const item of program.body) {
    if (item.type === 'VarDecl' || item.type === 'ListDecl') {
      if (ctx.globals.has(item.name)) continue;
      const entry = makeVariable(item, ctx, null);
      if (entry) {
        ctx.variables.push(entry);
        ctx.globals.set(item.name, entry);
      }
    }
    if (item.type === 'TableDecl') collectTable(item, ctx);
  }
}

const CHART_KINDS = new Set(['bar', 'line', 'pie', 'scatter']);

// Entry chart columns start at zero; Entropy columns start at one.
function chartSpec(
  chart: TableChartNode,
  node: TableDeclNode,
  columns: number,
  ctx: Context,
): { type: string; title: string; xIndex: number; yIndex: number; categoryIndexes: number[] } | null {
  if (!CHART_KINDS.has(chart.kind)) {
    return ctx.error(node, `'${chart.kind}' 차트는 없습니다. ${[...CHART_KINDS].join(' · ')} 중에서 고르세요.`);
  }
  const column = (value: Expr | null): number | null => {
    if (!value) return -1;
    const constant = constantOf(value, ctx);
    if (constant === null) return null;
    const index = Number(constant);
    if (!Number.isInteger(index) || index < 1 || index > columns) {
      ctx.error(node, `테이블 '${node.name}' 에는 ${index}번째 열이 없습니다. (열은 ${columns}개입니다)`);
      return null;
    }
    return index - 1;
  };

  const xIndex = column(chart.x);
  const yIndex = column(chart.y);
  if (xIndex === null || yIndex === null) return null;
  const categoryIndexes = [];
  for (const value of chart.series) {
    const index = column(value);
    if (index === null) return null;
    categoryIndexes.push(index);
  }
  return { type: chart.kind, title: chart.title ?? '', xIndex, yIndex, categoryIndexes };
}

function collectTable(node: TableDeclNode, ctx: Context): EntryTable | null {
  if (ctx.tableByName.has(node.name)) {
    return ctx.error(node, `'${node.name}' 테이블이 이미 있습니다.`);
  }
  const cells = (row: Expr[]) => {
    const values = row.map((cell) => constantOf(cell, ctx));
    return values.some((value) => value === null) ? null : values.map((value) => String(value));
  };

  const fields = cells(node.columns);
  if (!fields) return null;
  const data = [];
  for (const row of node.rows) {
    const values = cells(row);
    if (!values) return null;
    if (values.length !== fields.length) {
      return ctx.error(node, `테이블 '${node.name}' 의 줄은 열 개수(${fields.length})와 같아야 합니다. 이 줄은 ${values.length}개입니다.`);
    }
    data.push(values);
  }

  const charts = [];
  for (const chart of node.charts ?? []) {
    const built = chartSpec(chart, node, fields.length, ctx);
    if (!built) return null;
    charts.push(built);
  }

  const entry = {
    id: ctx.newId(),
    name: node.displayName ?? node.name,
    object: null,
    fields,
    data,
    chart: charts,
  };
  ctx.tables.push(entry);
  ctx.tableByName.set(node.name, entry);
  return entry;
}

function makeVariable(
  node: VarDeclNode | ListDeclNode,
  ctx: Context,
  objectId: string | null,
): EntryVariable | null {
  // Entry offers cloud and real-time storage on global variables only.
  if (node.scope && objectId) {
    ctx.error(node, `'${node.scope}' 는 오브젝트 안의 변수·리스트에는 쓸 수 없습니다. 전역 선언에만 붙일 수 있습니다.`);
  }
  // The save manager recognizes stored globals by their @ prefix.
  const entryName = node.displayName ?? node.name;
  const base: EntryVariable = {
    name: node.scope === 'store' ? `${STORE_PREFIX}${entryName}` : entryName,
    id: ctx.newId(),
    visible: node.shown,
    value: 0,
    variableType: 'variable',
    isCloud: node.scope === 'shared',
    isRealTime: node.scope === 'realtime',
    cloudDate: false,
    object: objectId,
    x: node.at ? Number(constantOf(node.at.x, ctx) ?? 0) : 0,
    y: node.at ? Number(constantOf(node.at.y, ctx) ?? 0) : 0,
  };

  if (node.type === 'ListDecl') {
    const elements = node.value.type === 'ListLiteral' ? node.value.elements : [];
    if (elements.length > 5000) {
      return ctx.error(node, `리스트 '${entryName}' 의 초기 항목이 ${elements.length.toLocaleString('en-US')}개라 Entry 한도 5,000개를 넘습니다.`, {
        code: 'E0008',
        help: '데이터를 여러 리스트로 나누거나, 필요한 범위만 저장하세요. Entry는 로드할 때 초과 항목을 잘라 데이터가 사라질 수 있습니다.',
      });
    }
    if (elements.length >= 4500) {
      ctx.notice(node, `리스트 '${entryName}' 이(가) ${elements.length.toLocaleString('en-US')}개로 Entry 한도 5,000개에 가깝습니다.`, {
        code: 'N0001',
        help: '실행 중 항목을 더 넣는다면 고정 크기 슬롯을 재사용하거나, 추가 전에 길이를 검사하세요.',
      });
    }
    const items = elements.map((element) => constantOf(element, ctx));
    if (items.some((item) => item === null)) return null;
    return {
      ...base,
      value: 0,
      variableType: 'list',
      array: (items as Array<string | number>).map((data) => ({ data })),
      // Entry list boxes are at least 100 pixels wide and tall.
      width: node.size ? Math.max(100, Number(constantOf(node.size.width, ctx) ?? 100)) : 100,
      height: node.size ? Math.max(100, Number(constantOf(node.size.height, ctx) ?? 120)) : 120,
    };
  }

  const value = constantOf(node.value, ctx);
  if (value === null) return null;
  if (!node.range) {
    return { ...base, value };
  }
  // Slider bounds must be known when the project is built.
  const min = constantOf(node.range.min, ctx);
  const max = constantOf(node.range.max, ctx);
  if (min === null || max === null) return null;
  if (isNaN(Number(min)) || isNaN(Number(max))) {
    ctx.error(node, '슬라이더의 최솟값과 최댓값은 숫자여야 합니다.');
    return null;
  }
  return {
    ...base,
    value,
    variableType: 'slide',
    minValue: Number(min),
    maxValue: Number(max),
  };
}

function constantOf(node: Expr, ctx: Context): string | number | boolean | null {
  switch (node.type) {
    case 'Number': return node.value;
    case 'String': return node.value;
    case 'Boolean': return node.value;
    case 'Color': return node.value;
    case 'Transparent': return 'transparent';
    case 'Unary':
      if (node.operator === '-' && node.argument.type === 'Number') return -node.argument.value;
      break;
    default: break;
  }
  return ctx.error(node, '변수·리스트의 초기값은 상수여야 합니다. 계산이 필요하면 when start 안에서 대입하세요.');
}

function collectObjects(program: ProgramNode, ctx: Context) {
  const register = (node: ObjectNode, scene: EntryScene) => {
    if (ctx.objectByName.has(node.name)) {
      ctx.error(node, `'${node.name}' 오브젝트가 이미 있습니다.`);
      return;
    }
    const object = {
      id: ctx.newId(),
      key: node.name,
      name: node.name,
      kind: node.kind,
      scene,
      node,
      pictures: new Map(),
      sounds: new Map(),
      locals: new Map(),
      defaultPicture: null,
      properties: new Map(),
      boxSize: null,
      center: null,
      script: [],
    };
    ctx.objects.push(object);
    ctx.objectByName.set(node.name, object);
  };

  for (const item of program.body) {
    if (item.type === 'Object') register(item, ctx.scenes[0]!);
    if (item.type === 'Scene') {
      const scene = ctx.sceneByName.get(item.name);
      for (const member of item.body) {
        if (member.type === 'Object') register(member, scene!);
      }
    }
  }

  for (const object of ctx.objects) collectObjectMembers(object, ctx);
}

// Reserve forced resource IDs so generated IDs cannot collide with them.
function resourceId(member: CostumeNode | SoundNode, ctx: Context): string | null {
  if (!member.forceId) return ctx.newId();
  if (ctx.newId.has(member.forceId)) {
    return ctx.error(member, `force id "${member.forceId}" 는 이미 다른 모양·소리·오브젝트가 쓰고 있습니다.`);
  }
  ctx.newId.reserve(member.forceId);
  ctx.forcedResourceIds.add(member.forceId);
  return member.forceId;
}

function collectObjectMembers(object: CompiledObject, ctx: Context) {
  ctx.object = object;

  for (const member of object.node.body) {
    switch (member.type) {
      case 'Costume': {
        const asset = makeAsset('image', {
          id: resourceId(member, ctx) ?? ctx.newId(), file: member.file, name: member.displayName ?? member.id,
          width: member.width, height: member.height,
        }, ctx, member);
        object.pictures.set(member.id, asset);
        if (member.isDefault || !object.defaultPicture) object.defaultPicture = asset;
        break;
      }
      case 'Sound': {
        const asset = makeAsset('sound', {
          id: resourceId(member, ctx) ?? ctx.newId(),
          file: member.file,
          name: member.displayName ?? member.id,
          duration: member.duration,
        }, ctx, member);
        object.sounds.set(member.id, asset);
        break;
      }
      case 'Property':
        object.properties.set(member.name, member.value);
        break;
      case 'BoxSize':
        object.boxSize = member;
        break;
      case 'Center':
        object.center = member;
        break;
      case 'VarDecl': case 'ListDecl': {
        if (object.locals.has(member.name)) break;
        const entry = makeVariable(member, ctx, object.id);
        if (entry) {
          ctx.variables.push(entry);
          object.locals.set(member.name, entry);
        }
        break;
      }
      default: break;
    }
  }

  // Keep both resource spellings because Entry resolves the stored name at runtime.
  for (const member of object.node.body) {
    if (member.type !== 'Costume' && member.type !== 'Sound') continue;
    if (!member.displayName || member.displayName === member.id) continue;
    const shelf = member.type === 'Costume' ? object.pictures : object.sounds;
    if (!shelf.has(member.displayName)) shelf.set(member.displayName, shelf.get(member.id)!);
  }

  // Event-local declarations belong to the object.
  for (const member of object.node.body) {
    if (member.type === 'Event') collectHandlerVariables(member.body, object, ctx);
  }
  ctx.object = null;
}

function collectHandlerVariables(statements: Stmt[], object: CompiledObject, ctx: Context) {
  for (const statement of statements) {
    if (statement.type === 'Switch') for (const clause of statement.cases) collectHandlerVariables(clause.body, object, ctx);
    if (statement.type === 'VarDecl' || statement.type === 'ListDecl') {
      if (!object.locals.has(statement.name) && !ctx.globals.has(statement.name)) {
        const entry = makeVariable(
          statement.type === 'VarDecl'
            ? { ...statement, value: { type: 'Number', value: 0, loc: statement.loc } }
            : statement,
          ctx,
          object.id,
        );
        if (entry) {
          ctx.variables.push(entry);
          object.locals.set(statement.name, entry);
        }
      }
    }
    const fields = statement as unknown as AnyNode;
    for (const key of ['consequent', 'alternate', 'body']) {
      const block = fields[key];
      if (Array.isArray(block)) collectHandlerVariables(block as Stmt[], object, ctx);
    }
  }
}

function collectFunctions(program: ProgramNode, ctx: Context) {
  const register = (node: FunctionDeclNode, owner: string | null) => {
    if (ctx.functionByName.has(node.name)) {
      ctx.error(node, `'${node.name}' 함수가 이미 있습니다. 엔트리 함수는 작품 전체에서 이름이 하나여야 합니다.`);
      return;
    }
    const returns = findReturns(node.body);

    const booleanParams = new Set(node.booleanParams ?? []);
    const fn = {
      id: ctx.newId(),
      name: node.name,
      node,
      owner,
      params: node.params,
      booleanParams,
      paramTypes: new Map(node.params.map((param) => [
        param,
        `${booleanParams.has(param) ? 'booleanParam' : 'stringParam'}_${ctx.newId()}`,
      ])),
      isValue: returns.some(node => node.value !== null),
      localVariables: [],
    };
    ctx.functions.push(fn);
    ctx.functionByName.set(node.name, fn);
  };

  for (const item of program.body) {
    if (item.type === 'FunctionDecl') register(item, null);
    if (item.type === 'Object') {
      for (const member of item.body) if (member.type === 'FunctionDecl') register(member, item.name);
    }
    if (item.type === 'Scene') {
      for (const object of item.body) {
        if (object.type !== 'Object') continue;
        for (const member of object.body) if (member.type === 'FunctionDecl') register(member, object.name);
      }
    }
  }
}

function findReturns(statements: Stmt[], found: ReturnNode[] = []): ReturnNode[] {
  for (const statement of statements) {
    if (statement.type === 'Switch') for (const clause of statement.cases) findReturns(clause.body, found);
    if (statement.type === 'Return') found.push(statement);
    const fields = statement as unknown as AnyNode;
    for (const key of ['consequent', 'alternate', 'body']) {
      const block = fields[key];
      if (Array.isArray(block)) findReturns(block as Stmt[], found);
    }
  }
  return found;
}

function collectMessages(node: unknown, ctx: Context) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => collectMessages(child, ctx));
    return;
  }
  const item = node as AnyNode;
  if (item.type === 'Send' && (item.signal as AnyNode | undefined)?.type === 'String') {
    ctx.messageId((item.signal as { value: string }).value);
  }
  if (item.type === 'Event' && item.event === 'signal') ctx.messageId(item.signal as string);
  for (const [key, value] of Object.entries(item)) {
    if (key !== 'loc') collectMessages(value, ctx);
  }
}

function compileFunctions(ctx: Context) {
  for (const fn of ctx.functions) {
    if (fn.generated) continue;
    ctx.object = (fn.owner ? ctx.objectByName.get(fn.owner) : null) ?? null;
    ctx.locals = ctx.object?.locals ?? new Map();
    ctx.funcScope = {
      id: fn.id,
      name: fn.name,
      params: fn.paramTypes,
      localVars: new Map(),
      bindings: new Map(),
      declarations: new Map(),
    };

    const declared = fn.node!;
    // Entry clones function locals for every call. Store simple top-level initializers there
    // instead of emitting a duplicate assignment, which also keeps decompile/recompile stable.
    for (const statement of declared.body) {
      if (statement.type !== 'VarDecl') continue;
      const value = functionLocalInitialValue(statement.value);
      if (value === null) continue;
      ctx.funcScope.declarations.set(statement, {
        id: `${ctx.funcScope.id}_${ctx.newId()}`,
        displayName: statement.displayName ?? statement.name,
        value,
      });
    }
    const tail = declared.body[declared.body.length - 1] as ReturnNode | undefined;
    const simpleReturn = tail?.type === 'Return' && tail.value !== null && findReturns(declared.body).length === 1;
    if (fn.isValue && !simpleReturn) {
      const id = ctx.newId();
      ctx.funcScope.returnId = id;
      // Entry's function-local reads turn empty strings and false into 0.
      ctx.variables.push({ id, name: `[Entropy] ${fn.name} return`, value: 0, visible: false,
        variableType: 'variable', isCloud: false, isRealTime: false, cloudDate: false,
        object: null, x: 0, y: 0 });
    }
    const body = simpleReturn ? declared.body.slice(0, -1) : declared.body;
    const statements = compileStatements(body, ctx, false);
    const returnId = ctx.funcScope.returnId;
    if (returnId) statements.push(ctx.block('set_variable', [returnId, ctx.number(0), null]));
    const returnValue = returnId ? ctx.block('get_variable', [returnId, null])
      : fn.isValue && tail ? compileValue(tail.value, ctx) : null;

    const field = buildFunctionFields(fn, ctx);
    const params = fn.isValue ? [field, null, null, returnValue] : [field, null];
    const create = ctx.block(fn.isValue ? 'function_create_value' : 'function_create', params, [statements]);
    create.x = 50;
    create.y = 30;

    fn.localVariables = [...ctx.funcScope.localVars].map(
      ([, local]) => ({ id: local.id, name: local.displayName, value: local.value ?? 0 }),
    );
    fn.content = [[create]];
    fn.type = fn.isValue ? 'value' : 'normal';

    ctx.funcScope = null;
    ctx.locals = new Map();
    ctx.object = null;
  }
}

function functionLocalInitialValue(value: Expr): string | number | null {
  switch (value.type) {
    case 'Number': case 'String': case 'Color': return value.value;
    case 'Transparent': return 'transparent';
    case 'Unary': return value.operator === '-' && value.argument.type === 'Number'
      ? -value.argument.value
      : null;
    default: return null;
  }
}

// Omit labels for automatic parameter names to match Entry's function header.
function buildFunctionFields(fn: CompiledFunction, ctx: Context): EntryBlock {
  let next: EntryParam = null;
  for (let i = fn.params.length - 1; i >= 0; i -= 1) {
    const name = fn.params[i]!;
    next = fn.booleanParams?.has(name)
      ? ctx.block('function_field_boolean', [ctx.block(fn.paramTypes.get(name)!, [null]), next])
      : ctx.block('function_field_string', [ctx.block(fn.paramTypes.get(name)!, []), next]);
    if (!isAutoParamName(name, i)) next = ctx.block('function_field_label', [name, next]);
  }
  return ctx.block('function_field_label', [fn.name, next]);
}

function compileObjects(ctx: Context) {
  for (const object of ctx.objects) {
    ctx.object = object;
    ctx.locals = object.locals;
    ctx.funcScope = null;

    let row = 0;
    const defaults = compileBrushDefaults(object, ctx);
    if (defaults) {
      defaults[0].x = 50;
      defaults[0].y = 30;
      row += 1;
      object.script.push(defaults);
    }
    for (const member of object.node.body) {
      if (member.type !== 'Event') continue;
      const thread = compileEvent(member, ctx);
      if (!thread) continue;
      ctx.applyComment(member, thread[0]);
      thread[0].x = 50;
      thread[0].y = 30 + row * 260;
      row += 1;
      object.script.push(thread);
    }
    ctx.object = null;
    ctx.locals = new Map();
  }
}

function compileEvent(event: EventNode, ctx: Context): EntryBlock[] | null {
  const body = () => compileStatements(event.body, ctx);

  switch (event.event) {
    case 'start': return [ctx.block('when_run_button_click', [null]), ...body()];
    case 'scene_start': return [ctx.block('when_scene_start', [null]), ...body()];
    case 'click': return [ctx.block('when_object_click', [null]), ...body()];
    case 'click_up': return [ctx.block('when_object_click_canceled', [null]), ...body()];
    case 'stage_click': return [ctx.block('mouse_clicked', [null]), ...body()];
    case 'stage_click_up': return [ctx.block('mouse_click_cancled', [null]), ...body()];
    case 'cloned': return [ctx.block('when_clone_start', [null]), ...body()];

    case 'signal':
      return [ctx.block('when_message_cast', [null, ctx.messageId(event.signal!)]), ...body()];

    case 'key': {
      const code = keyCodeOf(event.key);
      if (!code) return ctx.error(event, `알 수 없는 키 이름 "${event.key}" 입니다.${didYouMean(event.key!, Object.keys(KEY_CODES))}`);
      return [ctx.block('when_some_key_pressed', [null, code]), ...body()];
    }

    case 'key_up': {
      // Entry has no key-release event, so poll for a press followed by a release.
      const code = keyCodeOf(event.key);
      if (!code) return ctx.error(event, `알 수 없는 키 이름 "${event.key}" 입니다.${didYouMean(event.key!, Object.keys(KEY_CODES))}`);
      const pressed = () => ctx.block('is_press_some_key', [code, null]);
      const loop = ctx.block('repeat_inf', [null, null], [[
        ctx.block('wait_until_true', [pressed(), null]),
        ctx.block('wait_until_true', [ctx.block('boolean_not', [null, pressed(), null]), null]),
        ...body(),
      ]]);
      return [ctx.block('when_run_button_click', [null]), loop];
    }

    default:
      ctx.error(event, `'${event.event}' 이벤트는 엔트리 블록으로 바꿀 수 없습니다.`);
      return null;
  }
}

// Apply declared brush defaults before the object's other start scripts.
function compileBrushDefaults(object: CompiledObject, ctx: Context): EntryBlock[] | null {
  const present = BRUSH_DEFAULT_PROPERTIES.filter((name) => object.properties.has(name));
  if (present.length === 0) return null;

  const blocks = [ctx.block('when_run_button_click', [null])];
  for (const name of present) {
    const value = object.properties.get(name)!;
    const assign: AssignNode = {
      type: 'Assign',
      operator: '=',
      target: { type: 'Identifier', name, loc: value.loc! },
      value,
      loc: value.loc!,
    };
    for (const block of compileStatement(assign, ctx)) blocks.push(block);
  }
  return blocks;
}

function assemble(program: ProgramNode, ctx: Context, options: CompileOptions): EntryProject {
  const projectDecl = program.body.find((item) => item.type === 'Project');
  const fields = new Map((projectDecl?.fields ?? []).map((field) => [field.field, field.value]));

  const textField = (name: string) => {
    const value = fields.get(name);
    return value?.type === 'String' ? value.value : undefined;
  };
  const numberField = (name: string) => {
    const value = fields.get(name);
    return value?.type === 'Number' ? value.value : undefined;
  };

  const objects = ctx.objects.map((object) => buildObject(object, ctx));
  addSystemVariables(ctx);

  const project: EntryProject = {
    objects,
    scenes: ctx.scenes.map(({ id, name }) => ({ id, name })),
    variables: ctx.variables,
    messages: ctx.messages,
    functions: ctx.functions.map((fn) => ({
      id: fn.id,
      type: fn.type ?? 'normal',
      localVariables: fn.localVariables ?? [],
      useLocalVariables: (fn.localVariables ?? []).length > 0,
      content: JSON.stringify(fn.content ?? []),
    })),
    tables: ctx.tables,
    speed: numberField('fps') ?? 60,
    interface: { menuWidth: 280, canvasWidth: 480, object: objects[0]?.id ?? null },
    expansionBlocks: [...ctx.expansionBlocks],
    // Entry initializes AI modules only when project.aiUtilizeBlocks lists them.
    aiUtilizeBlocks: [...ctx.aiUtilizeBlocks],
    hardwareLiteBlocks: [],
    externalModules: [],
    externalModulesLite: [],
    name: options.name ?? textField('title') ?? 'Entropy 작품',
    isPracticalCourse: false,
  };

  const description = textField('description');
  if (description) project.description = description;
  return project;
}

function buildObject(object: CompiledObject, ctx: Context): EntryObject {
  const properties = object.properties;
  const number = <T extends number | null>(name: string, fallback: T): number | T => {
    const value = properties.get(name);
    if (value === undefined) return fallback;
    if (value.type === 'Number') return value.value;
    if (value.type === 'Unary' && value.operator === '-' && value.argument.type === 'Number') {
      return -value.argument.value;
    }
    ctx.error(value, `속성 '${name}' 에는 숫자만 쓸 수 있습니다.`);
    return fallback;
  };
  const string = (name: string, fallback: string) => {
    const value = properties.get(name);
    if (value === undefined) return fallback;
    if (value.type === 'String') return value.value;
    if (value.type === 'Color') return value.value;
    if (value.type === 'Transparent') return 'transparent';
    if (value.type === 'Keyword' || value.type === 'Identifier') return value.name;
    ctx.error(value, `속성 '${name}' 에는 문자열만 쓸 수 있습니다.`);
    return fallback;
  };
  const boolean = (name: string, fallback: boolean) => {
    const value = properties.get(name);
    if (value === undefined) return fallback;
    if (value.type === 'Boolean') return value.value;
    ctx.error(value, `속성 '${name}' 에는 true 또는 false 만 쓸 수 있습니다.`);
    return fallback;
  };

  const isText = object.kind === 'text';
  const picture = object.defaultPicture;
  const size = number('size', null);
  const scaleX = number('scale_x', size ?? 100) / 100;
  const scaleY = number('scale_y', size ?? 100) / 100;

  const entity: EntryEntity = {
    x: number('x', 0),
    y: number('y', 0),
    regX: 0,
    regY: 0,
    scaleX,
    scaleY,
    rotation: number('angle', 0),
    direction: number('way', 90),
    width: 100,
    height: 100,
    font: 'undefinedpx ',
    visible: boolean('visible', true),
  };

  if (!isText) {
    const width = picture?.dimension?.width ?? 100;
    const height = picture?.dimension?.height ?? 100;
    // Keep costume registration points because they determine the object's stage position.
    Object.assign(entity, {
      regX: object.center?.x ?? width / 2,
      regY: object.center?.y ?? height / 2,
      width,
      height,
    });
  }

  const result: EntryObject = {
    id: object.id,
    name: string('name', object.key),
    script: JSON.stringify(object.script),
    objectType: isText ? 'textBox' : 'sprite',
    rotateMethod: string('rotation', 'free'),
    scene: object.scene.id,
    sprite: {
      pictures: [...new Set(object.pictures.values())],
      sounds: [...new Set(object.sounds.values())],
    },
    lock: boolean('lock', false),
    entity,
  };

  if (isText) {
    const text = string('text_content', '');
    const fontSize = number('font_size', 20);
    const family = string('font', DEFAULT_FONT);
    const bold = boolean('text_bold', false);
    const italic = boolean('text_italic', false);
    const aligns: Record<string, number> = { center: 0, left: 1, right: 2 };
    const align = aligns[string('text_align', 'center')] ?? 0;

    Object.assign(entity, {
      font: [bold && 'bold', italic && 'italic', `${fontSize}px`, family].filter(Boolean).join(' '),
      colour: string('font_color', '#000000'),
      text,
      textAlign: align,
      lineBreak: boolean('line_break', false),
      // Entry text boxes start with a white background.
      bgColor: string('bg_color', '#ffffff'),
      underLine: boolean('text_underline', false),
      strike: boolean('text_strikethrough', false),
      fontSize,
      // Text bounds are an estimate without font layout; explicit size overrides them.
      width: object.boxSize?.width ?? Math.max(text.length * fontSize * 0.85, fontSize),
      height: object.boxSize?.height ?? Math.round(fontSize * 1.1),
    });
    result.text = text;
  } else {
    result.selectedPictureId = picture?.id ?? null;
    if (!picture) ctx.warn(object.node, `오브젝트 '${object.key}' 에 모양(costume)이 없습니다.`);
  }

  return result;
}

// Entry stores the timer and answer alongside variables.
function addSystemVariables(ctx: Context) {
  ctx.variables.push({
    name: '초시계', id: ctx.newId(), visible: false, value: 0, variableType: 'timer',
    isCloud: false, isRealTime: false, cloudDate: false, object: null, x: 134, y: -70,
  });
  ctx.variables.push({
    name: '대답', id: ctx.newId(), visible: false, value: 0, variableType: 'answer',
    isCloud: false, isRealTime: false, cloudDate: false, object: null, x: 150, y: -100,
  });
}
