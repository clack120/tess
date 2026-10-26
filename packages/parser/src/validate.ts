import { didYouMean } from '@entropy/core';
import {
  BUILTIN_FUNCTIONS,
  OBJECT_PROPERTIES,
  OPTION_KEYWORDS,
  STATE_VALUES,
  TEXT_ONLY_PROPERTIES,
} from '@entropy/core';
import type {
  Diagnostic, EventNode, Expr, FunctionDeclNode, Identifier, CallNode, Node,
  ObjectMember, ObjectNode, ProgramNode, SceneMember, Stmt, TopLevelItem,
  ValidationResult,
} from './ast.ts';

interface WalkContext {
  isText: boolean;
  inFunction: boolean;
  loopDepth: number;
  scope: Set<string>;
  objectLocals: Set<string>;
  functions: Set<string>;
}

type AnyNode = Record<string, unknown>;

const LOOP_TYPES = new Set(['Repeat', 'For', 'While', 'Until', 'Forever']);

// Cache line starts and binary-search them to avoid rescanning the file for every block.
export function lineIndex(source: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset: number) => {
    const target = Math.min(Math.max(offset, 0), source.length);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= target) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: target - starts[low]! + 1 };
  };
}

export function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

export function validate(
  program: ProgramNode,
  source = '',
  sources: Map<string, string> | null = null,
): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const positions = new Map<string, ReturnType<typeof lineIndex>>();

  const report = (bucket: Diagnostic[], node: Node | null | undefined, message: string) => {
    // Included nodes need positions from their own source file.
    const file = node?.loc?.file;
    const text = (file && sources?.get(file)) ?? source;
    let locate = positions.get(text);
    if (!locate) {
      locate = lineIndex(text);
      positions.set(text, locate);
    }
    const { line, column } = locate(node?.loc?.start ?? 0);
    const diagnostic = { line, column, file, message, offset: node?.loc?.start ?? 0, endOffset: node?.loc?.end };
    bucket.push(diagnostic);
    return diagnostic as Diagnostic;
  };
  const error = (node: Node, message: string) => report(errors, node, message);
  const warn = (node: Node, message: string) => report(warnings, node, message);
  function checkDeclarations(body: Array<TopLevelItem | SceneMember | ObjectMember | Stmt>, params: string[] = []) {
    const names = new Map<string, Node | null>(params.map(name => [name, null]));
    for (const node of body) {
      if (node.type !== 'VarDecl' && node.type !== 'ListDecl' && node.type !== 'TableDecl') continue;
      if (names.has(node.name)) {
        const item = error(node, `'${node.name}' 은(는) 이 범위에 이미 선언되어 있습니다.`);
        item.code = 'E0001';
        item.help = '같은 범위에서는 다른 이름을 쓰세요. 값을 바꾸려면 var/list 없이 대입하세요.';
        const previous = names.get(node.name);
        if (previous) item.related = [report([], previous, '처음 선언한 위치입니다.')];
      } else names.set(node.name, node);
    }
  }
  checkDeclarations(program.body);

  const globals = declaredNames(program.body);
  const knownFunctions = new Set(collectFunctionNames(program.body));
  // A global function may refer to a uniquely named object local.
  const localOwners = collectLocalOwners(program.body, globals);
  // Skip name warnings when included files may supply declarations.
  const hasUse = containsUse(program);

  let projectCount = 0;

  for (const item of program.body) visitTopLevel(item);

  function visitTopLevel(item: TopLevelItem | SceneMember) {
    switch (item.type) {
      case 'Project':
        projectCount += 1;
        if (projectCount === 2) {
          error(item, 'project 블록은 작품 전체에 하나만 선언할 수 있습니다.');
        }
        break;
      case 'Scene':
        item.body.forEach(visitTopLevel);
        break;
      case 'Object':
        visitObject(item);
        break;
      case 'FunctionDecl':
        visitFunction(item, new Set());
        break;
      default:
        break;
    }
  }

  function visitObject(object: ObjectNode) {
    checkDeclarations(object.body);
    const isText = object.kind === 'text';
    const locals = declaredNames(object.body);
    const objectFunctions = new Set(collectFunctionNames(object.body));

    for (const member of object.body) {
      switch (member.type) {
        case 'Property':
          if (!isText && TEXT_ONLY_PROPERTIES.has(member.name)) {
            error(member, `'${member.name}' 은(는) 글상자(text) 전용 속성입니다. object 에서는 쓸 수 없습니다.`);
          }
          break;
        case 'Center':
          // Entry text boxes use a registration point of 0,0.
          if (isText) {
            error(member, `'center 가로 세로' 는 오브젝트(object) 전용입니다. 글상자는 중심점을 옮길 수 없습니다.`);
          }
          break;
        case 'FunctionDecl':
          visitFunction(member, locals);
          break;
        case 'Event':
          walkStatements(member.body, {
            isText,
            inFunction: false,
            loopDepth: 0,
            scope: new Set([...globals, ...locals]),
            objectLocals: locals,
            functions: new Set([...knownFunctions, ...objectFunctions]),
          });
          break;
        default:
          break;
      }
    }
  }

  function visitFunction(fn: FunctionDeclNode, objectLocals: Set<string>) {
    const params = new Set<string>();
    for (const name of fn.params) {
      if (params.has(name)) error(fn, `매개변수 '${name}' 이(가) 중복되었습니다. 매개변수마다 다른 이름을 쓰세요.`);
      params.add(name);
    }
    checkDeclarations(fn.body, fn.params);
    walkStatements(fn.body, {
      isText: true, // Functions can run on any object type, so skip text-box-only checks inside them.
      inFunction: true,
      loopDepth: 0,
      scope: new Set([...globals, ...fn.params]),
      objectLocals,
      functions: knownFunctions,
    });
  }

  function walkStatements(statements: Stmt[], ctx: WalkContext) {
    for (const statement of statements) walkStatement(statement, ctx);
  }

  function walkStatement(statement: Stmt, ctx: WalkContext) {
    if (statement.type === 'Switch') {
      walkExpressions(statement.value, ctx);
      const seen = new Map<string, Expr>();
      for (const clause of statement.cases) {
        for (const expression of clause.values) {
          const value = caseValue(expression);
          if (value === null) {
            const item = error(expression, 'case 에는 숫자·문자열·판단·색 리터럴만 쓸 수 있습니다.');
            item.code = 'E0003';
            item.help = '여러 값은 case 1, 2: 처럼 묶으세요. 계산한 값끼리 비교하려면 if/else를 쓰세요.';
            continue;
          }
          const normalized = typeof value === 'string' && value.length && !Number.isNaN(Number(value)) ? Number(value) : value;
          const key = `${typeof normalized}:${normalized}`;
          const previous = seen.get(key);
          if (previous) {
            const item = warn(expression, '앞의 case 와 같은 값이라 이 항목은 선택되지 않습니다.');
            item.code = 'W0002';
            item.related = [report([], previous, '먼저 일치하는 항목입니다. Entry 비교에서는 숫자 문자열도 숫자로 비교합니다.')];
          } else seen.set(key, expression);
        }
        if (ctx.inFunction) checkDeclarations(clause.body);
        walkStatements(clause.body, { ...ctx, scope: new Set(ctx.scope) });
      }
      if (statement.alternate) {
        if (ctx.inFunction) checkDeclarations(statement.alternate);
        walkStatements(statement.alternate, { ...ctx, scope: new Set(ctx.scope) });
      }
      return;
    }
    switch (statement.type) {
      case 'VarDecl':
      case 'ListDecl':
        if (ctx.inFunction && statement.order !== undefined) {
          error(statement, '함수 지역 변수에는 order 를 쓸 수 없습니다.');
        }
        walkExpressions(statement.value, ctx);
        ctx.scope.add(statement.name);
        return;

      case 'Return':
        if (!ctx.inFunction) {
          error(statement, 'return 은 function 블록 안에서만 쓸 수 있습니다.');
        }
        break;

      case 'Break':
      case 'Continue':
      case 'Skip':
        if (ctx.loopDepth === 0) {
          const word = { Break: 'break', Continue: 'continue', Skip: 'skip' }[statement.type];
          error(statement, `${word} 은(는) 반복문(repeat/while/until/forever) 안에서만 쓸 수 있습니다.`);
        }
        break;

      case 'TextWrite':
        if (!ctx.isText) {
          error(statement, `'${statement.mode}' 은(는) 글상자(text) 전용 명령입니다.`);
        }
        break;

      case 'Clear':
        if (statement.target === 'text' && !ctx.isText) {
          error(statement, "'clear text' 는 글상자(text) 전용 명령입니다.");
        }
        break;

      case 'Assign':
        if (
          !ctx.isText &&
          statement.target.type === 'Identifier' &&
          TEXT_ONLY_PROPERTIES.has(statement.target.name) &&
          !ctx.scope.has(statement.target.name)
        ) {
          error(statement, `'${statement.target.name}' 은(는) 글상자(text) 전용 속성입니다.`);
        }
        break;

      default:
        break;
    }

    // Hide chart closes the current table or chart; chart is not a variable name here.
    if (statement.type === 'Hide' && (statement.target as Identifier | null)?.name === 'chart'
      && !ctx.scope.has('chart')) {
      return;
    }

    const blocks = childBlocks(statement);
    let innerCtx = LOOP_TYPES.has(statement.type)
      ? { ...ctx, loopDepth: ctx.loopDepth + 1 }
      : ctx;
    if (statement.type === 'For') innerCtx = { ...innerCtx, scope: new Set([...ctx.scope, statement.name]) };

    const fields = statement as unknown as AnyNode;
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'loc' || key === 'type') continue;
      if (blocks.includes(key)) continue;
      walkExpressions(value, ctx);
    }
    for (const key of blocks) {
      const block = fields[key];
      if (Array.isArray(block)) {
        if (ctx.inFunction) checkDeclarations(block as Stmt[]);
        walkStatements(block as Stmt[], ctx.inFunction ? { ...innerCtx, scope: new Set(innerCtx.scope) } : innerCtx);
      }
    }
  }

  function walkExpressions(value: unknown, ctx: WalkContext) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v) => walkExpressions(v, ctx));
      return;
    }

    const node = value as AnyNode;
    if (node.type === 'Binary' && (node.operator === 'and' || node.operator === 'or') && mayRunOrFail(node.right)) {
      const item = warn(node.right as Node, `'${node.operator}' 는 왼쪽 결과와 관계없이 오른쪽 식도 평가합니다. 범위 검사 뒤의 접근이나 함수 호출도 실행됩니다.`);
      item.code = 'W0001';
      item.help = node.operator === 'and'
        ? '오른쪽 식을 보호하려면 if 조건을 두 단계로 나누어 중첩하세요.'
        : '왼쪽 조건이 거짓일 때만 실행하려면 if/else로 나누세요.';
    }
    if (node.type === 'Identifier') checkIdentifier(node as unknown as Identifier, ctx);
    if (node.type === 'Call') checkCall(node as unknown as CallNode, ctx);
    if (node.type === 'Index' && !node.column) checkStringBounds(node.target as Expr, node.index as Expr);
    if (node.type === 'Call' && node.callee === 'slice' && !ctx.functions.has('slice')) {
      const args = node.arguments as Expr[];
      if (args.length === 3) {
        checkStringBounds(args[0]!, args[1]!);
        checkStringBounds(args[0]!, args[2]!);
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'type') continue;
      walkExpressions(child, ctx);
    }
  }

  function checkStringBounds(text: Expr, index: Expr) {
    if (text.type !== 'String') return;
    const position = index.type === 'Number' ? index.value
      : index.type === 'Unary' && index.operator === '-' && index.argument.type === 'Number' ? -index.argument.value : null;
    if (position === null || !(position < 1 || position > text.value.length)) return;
    const item = warn(index, `글자 위치 ${position} 이(가) 문자열 범위를 벗어나 실행하면 작품 전체가 멈춥니다.`);
    item.code = 'W0003';
    item.help = text.value.length
      ? `글자 위치는 1부터 ${text.value.length}까지입니다. slice의 끝 위치도 포함되며, and/or 조건으로 감싸도 접근은 실행됩니다.`
      : '빈 문자열에는 읽을 글자가 없습니다. if로 문자열 길이를 확인한 뒤 접근하세요.';
    item.related = [report([], text, `이 문자열의 글자 수는 ${text.value.length}입니다. Entry는 이모지 등을 UTF-16 코드 단위로 셉니다.`)];
  }

  function checkIdentifier(identifier: Identifier, ctx: WalkContext) {
    const { name } = identifier;
    if (ctx.scope.has(name)) return;
    if (STATE_VALUES.has(name) || OPTION_KEYWORDS.has(name)) return;
    if (OBJECT_PROPERTIES.has(name) || TEXT_ONLY_PROPERTIES.has(name)) return;

    if (ctx.inFunction && ctx.objectLocals.has(name)) return;

    // Object-local references remain valid in global functions when their names are unique.
    if (ctx.inFunction && localOwners.has(name)) {
      const owners = localOwners.get(name)!;
      if (owners.length === 1) {
        warn(
          identifier,
          `'${name}' 은(는) ${owners[0]} 의 지역 변수입니다. 이 함수를 ${owners[0]} 안에 선언하는 편이 좋습니다.`,
        );
      } else {
        error(
          identifier,
          `'${name}' 은(는) ${owners.join(', ')} 가 저마다 가진 지역 변수라 어느 것인지 알 수 없습니다. `
          + '이 함수를 그 오브젝트 안에 선언하거나, 값을 매개변수로 전달하세요.',
        );
      }
      return;
    }

    if (!hasUse && !ctx.objectLocals.has(name)) {
      const known = [...ctx.scope, ...ctx.objectLocals, ...STATE_VALUES];
      warn(identifier, `선언되지 않은 이름 '${name}' 입니다.${didYouMean(name, known)}`);
    }
  }

  function checkCall(call: CallNode, ctx: WalkContext) {
    if (BUILTIN_FUNCTIONS.has(call.callee)) return;
    if (ctx.functions.has(call.callee)) return;
    if (!hasUse) {
      const known = [...BUILTIN_FUNCTIONS, ...ctx.functions];
      warn(call, `선언되지 않은 함수 '${call.callee}' 를 호출했습니다.${didYouMean(call.callee, known)}`);
    }
  }

  return { errors, warnings };
}

// Function calls and indexed reads can have side effects or stop the work.
function mayRunOrFail(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(mayRunOrFail);
  const node = value as AnyNode;
  if (node.type === 'Index') return true;
  if (node.type === 'Call' && (!BUILTIN_FUNCTIONS.has(node.callee as string) || node.callee === 'slice')) return true;
  return Object.entries(node).some(([key, child]) => key !== 'loc' && mayRunOrFail(child));
}

// Literal labels have no effects between saving a switch selector and choosing its branch.
export function caseValue(node: Expr): string | number | boolean | null {
  switch (node.type) {
    case 'Number': case 'String': case 'Boolean': case 'Color': return node.value;
    case 'Transparent': return 'transparent';
    case 'Unary': return node.operator === '-' && node.argument.type === 'Number' ? -node.argument.value : null;
    default: return null;
  }
}

function declaredNames(body: Array<ObjectMember | TopLevelItem | SceneMember>): Set<string> {
  const names = new Set<string>();
  for (const member of body) {
    if (member.type === 'VarDecl' || member.type === 'ListDecl' || member.type === 'TableDecl') {
      names.add(member.name);
    }
  }
  return names;
}

// Include event declarations in object locals, but exclude names declared globally.
function collectLocalOwners(
  body: Array<TopLevelItem | SceneMember>,
  globals: Set<string>,
  owners = new Map<string, string[]>(),
): Map<string, string[]> {
  for (const item of body) {
    if (item.type === 'Scene') collectLocalOwners(item.body, globals, owners);
    if (item.type !== 'Object') continue;
    for (const name of objectLocalNames(item)) {
      if (globals.has(name)) continue;
      if (!owners.has(name)) owners.set(name, []);
      if (!owners.get(name)!.includes(item.name)) owners.get(name)!.push(item.name);
    }
  }
  return owners;
}

function objectLocalNames(object: ObjectNode): Set<string> {
  const names = declaredNames(object.body);
  const walk = (statements: Stmt[]) => {
    for (const statement of statements) {
      if (statement.type === 'VarDecl' || statement.type === 'ListDecl') names.add(statement.name);
      if (statement.type === 'Switch') for (const clause of statement.cases) walk(clause.body);
      const fields = statement as unknown as AnyNode;
      for (const key of ['consequent', 'alternate', 'body']) {
        const block = fields[key];
        if (Array.isArray(block)) walk(block as Stmt[]);
      }
    }
  };
  for (const member of object.body) if (member.type === 'Event') walk((member as EventNode).body);
  return names;
}

function collectFunctionNames(body: Array<TopLevelItem | SceneMember | ObjectMember>): string[] {
  const names: string[] = [];
  for (const member of body) {
    if (member.type === 'FunctionDecl') names.push(member.name);
    if (member.type === 'Scene' || member.type === 'Object') {
      names.push(...collectFunctionNames(member.body));
    }
  }
  return names;
}

function childBlocks(statement: Stmt): string[] {
  switch (statement.type) {
    case 'If':
      return statement.alternate ? ['consequent', 'alternate'] : ['consequent'];
    case 'Repeat':
    case 'For':
    case 'While':
    case 'Until':
    case 'Forever':
      return ['body'];
    default:
      return [];
  }
}

function containsUse(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(containsUse);
  if ((node as AnyNode).type === 'Use') return true;
  return Object.entries(node).some(([key, value]) => key !== 'loc' && containsUse(value));
}
