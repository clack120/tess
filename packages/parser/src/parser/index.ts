import { EOF } from 'chevrotain';
import type { CstNode, ILexingError, IRecognitionException, IToken } from 'chevrotain';
import { codeFrame } from './frame.ts';
import { tokenize } from './tokens.ts';
import { parser } from './parser.ts';
import { toAst } from './visitor.ts';
import { parseProgramWithTree } from '../tree/index.ts';
import type { ParseRoot } from '../ast.ts';

export type StartRule = 'Program' | 'SceneFragment' | 'ObjectFragment' | 'Statement' | 'Expr';

export interface ParseFailure {
  offset: number;
  message: string;
  detail: string | null;
}

const START_RULES: Record<string, string> = {
  Program: 'program',
  SceneFragment: 'sceneFragment',
  ObjectFragment: 'objectFragment',
  Statement: 'statement',
  Expr: 'expr',
};

function ruleFor(startRule: StartRule | undefined): string {
  const rule = START_RULES[startRule ?? 'Program'];
  if (!rule) throw new Error(`알 수 없는 시작 규칙입니다: ${startRule}`);
  return rule;
}

const offsetOf = (source: string, token: IToken | undefined) => (
  token && Number.isInteger(token.startOffset) && token.startOffset >= 0
    ? token.startOffset
    : source.length
);

function frame(source: string, offset: number, message: string): string {
  const upto = source.slice(0, offset);
  const line = upto.split('\n').length;
  const column = offset - (upto.lastIndexOf('\n') + 1) + 1;
  return codeFrame(source, line, column, message);
}

const failure = (source: string, offset: number, message: string): ParseFailure => ({
  offset,
  message,
  detail: frame(source, offset, message),
});

type LexOrParseError = (ILexingError & { token?: undefined }) | (IRecognitionException & { offset?: undefined });

function toFailure(source: string, error: LexOrParseError): ParseFailure {
  if (error.offset !== undefined) {
    const character = JSON.stringify(source[error.offset] ?? '');
    return failure(source, error.offset, `읽을 수 없는 글자입니다: ${character}`);
  }
  return failure(source, offsetOf(source, error.token), error.message);
}

export function parseSource(
  source: string,
  options: { startRule?: StartRule } = {},
): { ok: boolean; ast: ParseRoot | null; errors: ParseFailure[] } {
  const rule = ruleFor(options.startRule);
  if (rule === 'program') {
    const ast = parseProgramWithTree(source);
    if (ast) return { ok: true, ast, errors: [] };
  }
  const { tokens, errors: lexErrors } = tokenize(source);

  if (lexErrors.length > 0) {
    return { ok: false, ast: null, errors: lexErrors.map(error => toFailure(source, error)) };
  }

  parser.input = tokens;
  const cst = (parser as unknown as Record<string, () => CstNode>)[rule]!();

  if (parser.errors.length > 0) {
    return { ok: false, ast: null, errors: parser.errors.map(error => toFailure(source, error)) };
  }

  // Reject leftover tokens even if the selected rule matched a prefix.
  const next = (parser as unknown as { LA(n: number): IToken }).LA(1);
  if (next.tokenTypeIdx !== EOF.tokenTypeIdx) {
    const message = `입력의 끝이 와야 하는데 '${next.image}' 이(가) 있습니다.`;
    return { ok: false, ast: null, errors: [failure(source, offsetOf(source, next), message)] };
  }

  return { ok: true, ast: toAst(cst, source.length), errors: [] };
}

export function checkSource(source: string, startRule?: StartRule): boolean {
  return parseSource(source, { startRule }).ok;
}
