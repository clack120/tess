import { parse } from '@entropy/parser';
import { lineAndColumn } from '@entropy/parser';
import type {
  Node, ObjectMember, ObjectNode, ParseRoot, ProgramNode, SceneMember, StartRule,
  TopLevelItem, UseObjectNode,
} from '@entropy/parser';
import { EMPTY_HOST, basename, dirname, extname } from './host.ts';
import type { CompilerHost } from './host.ts';
import type { CompileCache, CompileDiagnostic } from './types.ts';

type IncludeContext = 'top' | 'scene' | 'object';

type Member = TopLevelItem | SceneMember | ObjectMember;

export interface LoadedProgram {
  ast: ProgramNode | null;
  errors: CompileDiagnostic[];
  warnings: CompileDiagnostic[];
  sources: Map<string, string>;
}

const START_RULES: Record<IncludeContext, StartRule | undefined> = {
  top: undefined, scene: 'SceneFragment', object: 'ObjectFragment',
};

export function createCompileCache(): CompileCache {
  return { asts: new Map(), reused: 0, parsed: 0 };
}

// Include the parse context in the cache key because the same file can fill different scopes.
function cacheKey(file: string, context: IncludeContext): string {
  return `${context}\n${file}`;
}

export function loadProgram({
  source, path: filePath = '<input>', readFile, cache = null, host = EMPTY_HOST,
}: {
  source: string;
  path?: string;
  readFile?: (target: string) => string;
  cache?: CompileCache | null;
  host?: CompilerHost;
}): LoadedProgram {
  const read = readFile ?? ((target: string) => {
    const text = host.readText(target);
    if (text === null) throw new Error(`불러올 파일이 없습니다: ${target}`);
    return text;
  });
  const errors: CompileDiagnostic[] = [];
  const warnings: CompileDiagnostic[] = [];
  const sources = new Map([[filePath, source]]);
  const visiting = new Set();

  const where = (item: Node, file: string) => ({
    ...position(item, sources.get(file) ?? ''),
    file,
  });

  const load = (text: string, file: string, context: IncludeContext): ParseRoot | null => {
    const key = cacheKey(file, context);
    const hit = cache?.asts.get(key);
    if (cache && hit && hit.text === text) {
      cache.reused += 1;
      return hit.ast;
    }

    const result = parse(text, { startRule: START_RULES[context], validate: false });
    if (cache) cache.parsed += 1;
    if (!result.ok) {
      // Cache only successful parses so errors are reported on every build.
      if (cache) cache.asts.delete(key);
      for (const error of result.errors) errors.push({ ...error, file });
      return null;
    }
    stampSource(result.ast, file);
    if (cache) cache.asts.set(key, { text, ast: result.ast! });
    return result.ast;
  };

  const expand = (items: Member[], file: string, context: IncludeContext): Member[] => {
    const output: Member[] = [];
    for (const item of items) {
      if (item.type === 'UseObject') {
        const wrapped = expandUseObject(item, file);
        if (wrapped) output.push(wrapped);
        continue;
      }
      if (item.type !== 'Use') {
        output.push(expandNested(item, file));
        continue;
      }
      const target = host.resolve(dirname(file), item.path);
      if (visiting.has(target)) {
        errors.push({ ...where(item, file), message: `use 가 순환합니다: ${item.path}` });
        continue;
      }
      let text;
      try {
        text = read(target);
      } catch {
        errors.push({ ...where(item, file), message: `불러올 파일이 없습니다: ${item.path}` });
        continue;
      }
      sources.set(target, text);
      visiting.add(target);
      const included = load(text, target, context);
      if (included) {
        const body = context === 'top'
          ? (included as ProgramNode).body
          : (included as Member[]);
        for (const item of expand(body, target, context)) output.push(item);
      }
      visiting.delete(target);
    }
    return output;
  };

  const expandUseObject = (item: UseObjectNode, file: string): ObjectNode | null => {
    const target = host.resolve(dirname(file), item.path);
    if (visiting.has(target)) {
      errors.push({ ...where(item, file), message: `use 가 순환합니다: ${item.path}` });
      return null;
    }
    let text;
    try {
      text = read(target);
    } catch {
      errors.push({ ...where(item, file), message: `불러올 파일이 없습니다: ${item.path}` });
      return null;
    }
    sources.set(target, text);
    visiting.add(target);
    try {
      const members = load(text, target, 'object');
      if (!members) return null;
      return {
        type: 'Object',
        kind: item.kind,
        name: basename(target, extname(target)),
        body: expand(members as ObjectMember[], target, 'object') as ObjectMember[],
        loc: item.loc,
      };
    } finally {
      // An object fragment stays active while its own use directives expand.
      visiting.delete(target);
    }
  };

  const expandNested = (item: Member, file: string): Member => {
    if (item.type === 'Scene') {
      return { ...item, body: expand(item.body, file, 'scene') as SceneMember[] };
    }
    if (item.type === 'Object') {
      return { ...item, body: expand(item.body, file, 'object') as ObjectMember[] };
    }
    return item;
  };

  const program = load(source, filePath, 'top') as ProgramNode | null;
  if (!program) return { ast: null, errors, warnings, sources };

  visiting.add(host.resolve('.', filePath));
  const body = expand(program.body, filePath, 'top') as TopLevelItem[];
  return { ast: { ...program, body }, errors, warnings, sources };
}

function position(node: Node, text: string) {
  const offset = node?.loc?.start ?? 0;
  return { ...lineAndColumn(text, offset), offset };
}

// Keep each included node's source file for diagnostics.
function stampSource(node: unknown, file: string) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => stampSource(child, file));
    return;
  }
  const { loc } = node as { loc?: { file?: string } };
  if (loc && !loc.file) loc.file = file;
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc') stampSource(value, file);
  }
}
