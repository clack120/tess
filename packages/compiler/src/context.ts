import { createIdFactory, seedFrom } from './ids.ts';
import type { IdFactory } from './ids.ts';
import { commentKey, makeComment } from './comments.ts';
import { lineIndex } from '@tess/parser';
import { BUILTIN_FUNCTIONS, OBJECT_PROPERTIES, STATE_VALUES, didYouMean } from '@tess/core';
import type { Expr, Node } from '@tess/parser';
import type {
  CompileCache, CompileDiagnostic, CompiledFunction, CompiledObject,
  CompileOptions, EntryBlock, EntryMessage, EntryParam, EntryScene, EntryTable,
  EntryVariable, FunctionScope, ResourceRef, SourceMap, VariableRef,
} from './types.ts';

type DiagnosticDetails = Pick<CompileDiagnostic, 'code' | 'help' | 'related'>;

export function makeBlock(
  id: string,
  type: string,
  params: EntryParam[] = [],
  statements: EntryBlock[][] = [],
): EntryBlock {
  return {
    id,
    x: 0,
    y: 0,
    type,
    params,
    statements,
    movable: null,
    deletable: 1,
    emphasized: false,
    readOnly: null,
    copyable: true,
    assemble: true,
    extensions: [],
  };
}

export class Context {
  // Cache line offsets per file because every block records a source position.
  #lineLookups = new Map<string, (offset: number) => { line: number; column: number }>();

  source: string;

  sources: Map<string, string> | null;

  options: CompileOptions;

  assetFiles: Array<{ source: string; target: string }>;

  comments: Map<string, string>;

  newId: IdFactory;

  errors: CompileDiagnostic[];

  warnings: CompileDiagnostic[];

  notices: CompileDiagnostic[];

  sourceMap: SourceMap;

  currentNode: Node | null;

  aiUtilizeBlocks: Set<string>;

  forcedResourceIds: Set<string>;

  scenes: EntryScene[];

  sceneByName: Map<string, EntryScene>;

  objects: CompiledObject[];

  objectByName: Map<string, CompiledObject>;

  variables: EntryVariable[];

  globals: Map<string, EntryVariable>;

  messages: EntryMessage[];

  messageByName: Map<string, EntryMessage>;

  tables: EntryTable[];

  tableByName: Map<string, EntryTable>;

  expansionBlocks: Set<string>;

  functions: CompiledFunction[];

  functionByName: Map<string, CompiledFunction>;

  runtimeFunctions: Map<string, CompiledFunction>;

  object: CompiledObject | null;

  locals: Map<string, EntryVariable>;

  funcScope: FunctionScope | null;
  loopUpdate: (() => EntryBlock) | null = null;

  constructor(source: string, options: CompileOptions = {}) {
    this.source = source;
    this.sources = options.sources ?? null;
    this.options = options;
    this.assetFiles = [];
    this.comments = options.comments ?? new Map();
    this.newId = createIdFactory(seedFrom(options.seed ?? source));
    this.errors = [];
    this.warnings = [];
    this.notices = [];

    // Map block IDs back to Tess source positions for runtime diagnostics.
    this.sourceMap = {};
    this.currentNode = null;

    this.aiUtilizeBlocks = new Set();
    // Track forced asset IDs separately so unrelated IDs cannot hide misspelled names.
    this.forcedResourceIds = new Set();

    this.scenes = [];
    this.sceneByName = new Map();
    this.objects = [];
    this.objectByName = new Map();
    this.variables = [];
    this.globals = new Map();
    this.messages = [];
    this.messageByName = new Map();
    this.tables = [];
    this.tableByName = new Map();
    this.expansionBlocks = new Set();
    this.functions = [];
    this.functionByName = new Map();
    this.runtimeFunctions = new Map();

    this.object = null;
    this.locals = new Map();
    this.funcScope = null;
  }

  error(node: Node | null | undefined, message: string, details: DiagnosticDetails = {}): null {
    this.#report(this.errors, node, message, details);
    return null;
  }

  warn(node: Node | null | undefined, message: string): null {
    this.#report(this.warnings, node, message);
    return null;
  }

  // Entry resolves these names at runtime; strict mode reports warnings instead.
  notice(node: Node | null | undefined, message: string): null {
    this.#report(this.notices, node, message);
    return null;
  }

  diagnostic(node: Node | null | undefined, message: string): CompileDiagnostic {
    const offset = node?.loc?.start ?? 0;
    const file = node?.loc?.file;
    const { line, column } = this.#positionIn(file, offset);
    return { line, column, file, offset, endOffset: node?.loc?.end, message };
  }

  #report(bucket: CompileDiagnostic[], node: Node | null | undefined, message: string, details: DiagnosticDetails = {}) {
    bucket.push({ ...this.diagnostic(node, message), ...details });
  }

  unresolvedName(node: Node, name: string, assignment = false): null {
    const declarations: Node[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const item = value as Node & { name?: string };
      if ((item.type === 'VarDecl' || item.type === 'For') && item.name === name) declarations.push(item);
      for (const [key, child] of Object.entries(value)) if (key !== 'loc') visit(child);
    };
    // Search only on failure: a correct build needs no extra declaration walk.
    if (this.funcScope) visit(this.functionByName.get(this.funcScope.name)?.node?.body);
    const functionName = !assignment && (this.functionByName.has(name) || BUILTIN_FUNCTIONS.has(name));
    const readOnly = assignment && STATE_VALUES.has(name);
    const help = declarations.length
      ? '이 지역 변수는 선언한 블록 안에서, 선언 뒤에만 쓸 수 있습니다. 바깥에서도 필요하면 선언을 바깥 블록으로 옮기세요.'
      : functionName
        ? `'${name}' 은(는) 함수입니다. ${name}(...) 처럼 괄호와 인자를 붙여 호출하세요.`
        : readOnly
          ? `'${name}' 은(는) 읽기 전용 상태 값입니다. 일반 변수처럼 대입할 수 없습니다.`
          : '새 변수는 var 이름 = 초기값 으로 먼저 선언하세요. 이미 선언했다면 이름의 철자와 대소문자를 확인하세요.';
    const message = readOnly ? `'${name}' 은(는) 읽기 전용이라 값을 대입할 수 없습니다.`
      : `선언되지 않은 이름 '${name}' ${assignment ? '에 값을 대입했습니다.' : '입니다.'}`;
    const suggestion = declarations.length || functionName || readOnly ? ''
      : didYouMean(name, [...this.knownNames(), ...STATE_VALUES, ...OBJECT_PROPERTIES]);
    return this.error(node, message + suggestion, {
      code: readOnly ? 'E0007' : 'E0004', help,
      ...(declarations.length ? { related: declarations.map(declaration => this.diagnostic(declaration, '같은 이름의 지역 변수를 선언한 위치입니다.')) } : {}),
    });
  }

  // Cache line offsets per file to keep block position lookups cheap.
  #positionIn(file: string | null | undefined, offset: number) {
    const key = file ?? '';
    let lookup = this.#lineLookups.get(key);
    if (lookup === undefined) {
      lookup = lineIndex((file && this.sources?.get(file)) ?? this.source);
      this.#lineLookups.set(key, lookup);
    }
    return lookup(offset);
  }

  block(type: string, params: EntryParam[] = [], statements: EntryBlock[][] = []): EntryBlock {
    const block = makeBlock(this.newId(), type, params, statements);
    this.#recordLocation(block);
    return block;
  }

  #recordLocation(block: EntryBlock) {
    const node = this.currentNode;
    if (!node?.loc) return;
    const file = node.loc.file ?? this.options.path ?? null;
    const start = this.#positionIn(file, node.loc.start);
    const end = this.#positionIn(file, node.loc.end ?? node.loc.start);
    this.sourceMap[block.id] = {
      file, line: start.line, column: start.column, endLine: end.line, endColumn: end.column,
    };
  }

  applyComment<T extends EntryBlock | null>(node: Node, block: T): T {
    if (!block) return block;
    const text = this.comments.get(commentKey(node));
    if (text) block.comment = makeComment(text);
    return block;
  }

  number(value: number | string): EntryBlock {
    return this.block('number', [String(value)]);
  }

  text(value: number | string): EntryBlock {
    return this.block('text', [String(value)]);
  }

  angle(value: number | string): EntryBlock {
    return this.block('angle', [String(value)]);
  }

  // Resolve names from block locals, parameters, object locals, then globals.
  lookupVariable(name: string): VariableRef | null {
    if (this.funcScope) {
      const local = this.funcScope.bindings.get(name);
      if (local) return { kind: 'funcLocal', name, id: local.id };
      if (this.funcScope.params.has(name)) return { kind: 'param', name };
      const owned = this.locals.get(name);
      if (owned) return { kind: 'variable', entry: owned };
      const scoped = this.globals.get(name);
      if (scoped) return { kind: 'variable', entry: scoped };
      // A global function can use an object local only when its name is unique.
      return this.lookupObjectLocal(name);
    }
    const local = this.locals.get(name);
    if (local) return { kind: 'variable', entry: local };
    const global = this.globals.get(name);
    return global ? { kind: 'variable', entry: global } : null;
  }

  // Shared local names are ambiguous outside an object.
  lookupObjectLocal(name: string): VariableRef | null {
    const owners = this.objects.filter((object) => object.locals?.has(name));
    if (owners.length === 0) return null;
    if (owners.length > 1) {
      return { kind: 'ambiguousLocal', name, owners: owners.map((object) => object.name) };
    }
    return { kind: 'variable', entry: owners[0]!.locals.get(name)!, owner: owners[0] };
  }

  // A global function can name a resource only when one object owns that name.
  lookupObjectResource(kind: 'pictures' | 'sounds', name: string): ResourceRef | null {
    const owners = this.objects.filter((object) => object[kind].has(name));
    if (owners.length === 0) return null;
    if (owners.length > 1) return { kind: 'ambiguous', owners: owners.map((object) => object.name) };
    return { kind: 'found', asset: owners[0]![kind].get(name)! };
  }

  objectId(name: string): string | null {
    return this.objectByName.get(name)?.id ?? null;
  }

  knownNames(): string[] {
    const names = [...this.globals.keys(), ...this.locals.keys()];
    if (this.funcScope) {
      names.push(...this.funcScope.params.keys(), ...this.funcScope.bindings.keys());
      // A global function can name an object's local, so include those as suggestions.
      for (const object of this.objects) names.push(...(object.locals?.keys() ?? []));
    }
    return names;
  }

  messageId(name: string): string {
    let message = this.messageByName.get(name);
    if (!message) {
      message = { id: this.newId(), name };
      this.messages.push(message);
      this.messageByName.set(name, message);
    }
    return message.id;
  }
}
