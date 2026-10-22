// Fall back to Chevrotain for fragments and errors so diagnostics stay consistent.
import type { ProgramNode } from '../ast.ts';
import { plainTree, programFromTree } from './convert.ts';

export interface TreeSitterFiles {
  // Defaults to web-tree-sitter.wasm beside the runtime module.
  runtime?: string | URL | Uint8Array;
  // Defaults to the repository's tree-sitter-tess.wasm.
  language?: string | URL | Uint8Array;
}

interface Loaded {
  parser: import('web-tree-sitter').Parser;
  language: import('web-tree-sitter').Language;
}

interface Shared {
  loaded: Loaded | null;
  loading: Promise<boolean> | null;
}

// Share initialization because Parser.init replaces the WASM module used by existing parsers.
const shared: Shared = ((globalThis as { [key: symbol]: Shared })[Symbol.for('@tess/parser/tree-sitter')] ??= {
  loaded: null,
  loading: null,
});

// Keep Chevrotain available if loading tree-sitter fails.
export function initTreeSitter(files: TreeSitterFiles = {}): Promise<boolean> {
  shared.loading ??= load(files).then(
    (result) => {
      shared.loaded = result;
      return true;
    },
    () => {
      shared.loading = null;
      return false;
    },
  );
  return shared.loading;
}

async function load(files: TreeSitterFiles): Promise<Loaded> {
  const { Parser, Language } = await import('web-tree-sitter');
  const runtime = files.runtime;
  await Parser.init(
    runtime instanceof Uint8Array
      ? { wasmBinary: runtime }
      : runtime !== undefined
        ? { locateFile: () => String(runtime) }
        : {},
  );
  const language = await Language.load(files.language ?? defaultLanguageFile());
  const parser = new Parser();
  parser.setLanguage(language);
  return { parser, language };
}

function defaultLanguageFile(): string | URL {
  const url = new URL('../../tree-sitter/tree-sitter-tess.wasm', import.meta.url);
  return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url;
}

export function treeSitterReady(): boolean {
  return shared.loaded !== null;
}

export function parseProgramWithTree(source: string): ProgramNode | null {
  const { loaded } = shared;
  if (!loaded) return null;
  const tree = loaded.parser.parse(source);
  if (!tree) return null;
  try {
    if (tree.rootNode.hasError) return null;
    // Delete cursors explicitly; their finalizers can free the wrong shared cursor and corrupt the heap.
    const cursor = tree.walk();
    try {
      return programFromTree(plainTree(cursor, loaded.language), source);
    } finally {
      cursor.delete();
    }
  } catch {
    // Let Chevrotain handle trees the converter does not recognize.
    return null;
  } finally {
    tree.delete();
  }
}
