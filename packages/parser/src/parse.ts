import { parseSource, checkSource } from './parser/index.ts';
import type { StartRule } from './parser/index.ts';
import { lineAndColumn, lineIndex, validate } from './validate.ts';
import type { Diagnostic, ParseResult, ParseRoot, ProgramNode } from './ast.ts';

export interface ParseOptions {
  validate?: boolean;
  startRule?: StartRule;
}

export class EntropyParseError extends Error {
  errors: Diagnostic[];

  warnings: Diagnostic[];

  constructor(message: string, errors: Diagnostic[], warnings: Diagnostic[]) {
    super(message);
    this.name = 'EntropyParseError';
    this.errors = errors;
    this.warnings = warnings;
  }
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const { validate: runValidation = true, startRule } = options;
  const result = parseSource(source, { startRule });

  if (!result.ok) {
    const locate = lineIndex(source);
    const errors = result.errors.map((error) => ({
      ...locate(error.offset),
      offset: error.offset,
      message: error.message,
      detail: error.detail,
    }));
    return {
      ok: false, ast: null, errors, warnings: [],
    };
  }

  const ast = result.ast!;
  // Validation checks whole programs; fragments have no top-level body to walk.
  if (!runValidation || Array.isArray(ast) || ast.type !== 'Program') {
    return {
      ok: true, ast, errors: [], warnings: [],
    };
  }

  const { errors, warnings } = validate(ast as ProgramNode, source);
  return {
    ok: errors.length === 0, ast, errors, warnings,
  };
}

export function parseOrThrow(source: string, options: ParseOptions = {}): ParseRoot {
  const result = parse(source, options);
  if (!result.ok) {
    const first = result.errors[0]!;
    throw new EntropyParseError(
      first.detail ?? `${first.line}:${first.column} ${first.message}`,
      result.errors,
      result.warnings,
    );
  }
  return result.ast!;
}

export function check(source: string, startRule?: StartRule): boolean {
  return checkSource(source, startRule);
}

export { validate, lineAndColumn };
