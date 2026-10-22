import { createToken, Lexer } from 'chevrotain';
import { colorLiteralLength } from '@tess/core';
import type { ILexingError, IToken, TokenType } from 'chevrotain';

const IDENT_START = '[\\p{L}_]';

const IDENT_PART = '[\\p{L}0-9_]';

function unicodePattern(source: string) {
  const sticky = new RegExp(source, 'yu');
  return (text: string, startOffset: number) => {
    sticky.lastIndex = startOffset;
    return sticky.exec(text);
  };
}

export const KEYWORDS = [
  'add', 'all', 'and', 'append', 'as', 'ask', 'async', 'at', 'back', 'bgm', 'bounce', 'break',
  'bubble', 'call', 'case', 'center', 'clear', 'click', 'clone', 'cloned', 'clones',
  'chart', 'column', 'columns', 'continue', 'costume', 'default', 'del', 'description', 'do', 'draw', 'effects', 'else',
  'end', 'false', 'fill', 'flip', 'for', 'force', 'forever', 'forward', 'fps',
  'free', 'from', 'front', 'first', 'function', 'go', 'hide', 'id', 'if', 'in',
  'insert', 'jump', 'key', 'kill', 'last', 'list', 'lock', 'look', 'me', 'move',
  'name', 'next', 'none', 'not', 'object', 'or', 'order', 'other', 'pitch',
  'play', 'prepend', 'prev', 'project', 'read', 'realtime', 'remove', 'repeat',
  'reset', 'restart', 'return', 'rotation', 'row', 'save', 'say', 'scene', 'send',
  'series', 'shared', 'signal', 'show',
  'size', 'skip', 'sound', 'speed', 'stage', 'stamp', 'start', 'steer', 'step', 'stop', 'store', 'switch',
  'table', 'text', 'them', 'then', 'think', 'this', 'timer', 'title', 'to', 'transparent',
  'true', 'tts', 'turn', 'until', 'up', 'use', 'useobject', 'usetext', 'var',
  'vertical', 'visible', 'voice', 'wait', 'when', 'while', 'write', 'x', 'y',
];

export const RESERVED = new Set([
  'and', 'or', 'not', 'true', 'false', 'end', 'then', 'do', 'in', 'wait',
]);

export const STANDALONE_STATEMENTS = new Set([
  'break', 'continue', 'skip', 'restart', 'stop', 'bounce', 'stamp', 'show', 'hide',
  'clone', 'kill',
]);

export const STATEMENT_KEYWORDS = new Set([
  'if', 'switch', 'repeat', 'for', 'while', 'until', 'forever', 'wait', 'return',
  'break', 'continue', 'skip', 'restart', 'stop', 'start', 'reset', 'clear',
  'send', 'call', 'clone', 'del', 'kill', 'jump', 'forward', 'bounce',
  'move', 'go', 'turn', 'steer', 'look', 'show', 'hide', 'next',
  'prev', 'say', 'think', 'flip', 'order', 'write', 'append',
  'prepend', 'stamp', 'play', 'read', 'tts', 'in', 'remove', 'ask',
  'var', 'list', 'save', 'store',
]);

export const UNUSABLE_AS_NAME = new Set([
  ...RESERVED,
  ...STANDALONE_STATEMENTS,
  ...STATEMENT_KEYWORDS,
]);

export const IdentLike = createToken({ name: 'IdentLike', pattern: Lexer.NA, label: '이름' });

export const Identifier = createToken({
  name: 'Identifier',
  pattern: unicodePattern(`${IDENT_START}${IDENT_PART}*`),
  line_breaks: false,
  label: '이름',
  categories: [IdentLike],
});

export const kw: Record<string, TokenType> = {};
for (const word of KEYWORDS) {
  kw[word] = createToken({
    name: `kw_${word}`,
    pattern: Lexer.NA,
    label: `'${word}'`,
    categories: RESERVED.has(word) ? [] : [IdentLike],
  });
}

const KEYWORD_TOKENS = new Map<string, TokenType>(KEYWORDS.map((word) => [word, kw[word]!]));

export const ColorLiteral = createToken({
  name: 'ColorLiteral',
  pattern: (text, offset) => {
    const length = colorLiteralLength(text, offset);
    return length ? ([text.slice(offset, offset + length)] as RegExpExecArray) : null;
  },
  line_breaks: false,
  label: '색상',
  start_chars_hint: ['#'],
});

export const NumberLiteral = createToken({
  name: 'NumberLiteral',
  pattern: /\d+\.\d+|\d+/,
  label: '숫자',
});

export const StringLiteral = createToken({
  name: 'StringLiteral',
  pattern: /"(?:\\[\s\S]|[^"\\\n\r\u2028\u2029])*"/,
  label: '\ubb38\uc790\uc5f4',
});

export const WhiteSpace = createToken({
  name: 'WhiteSpace',
  pattern: /\s+/,
  group: Lexer.SKIPPED,
  line_breaks: true,
});

export const Comment = createToken({
  name: 'Comment',
  pattern: /#[^\n\r\u2028\u2029]*/,
  group: Lexer.SKIPPED,
});

const operator = (name: string, literal: string) => (
  createToken({ name, pattern: literal, label: `'${literal}'` })
);

export const PowAssign = operator('PowAssign', '**=');
export const Pow = operator('Pow', '**');
export const PlusAssign = operator('PlusAssign', '+=');
export const MinusAssign = operator('MinusAssign', '-=');
export const StarAssign = operator('StarAssign', '*=');
export const SlashAssign = operator('SlashAssign', '/=');
export const PercentAssign = operator('PercentAssign', '%=');
export const Eq = operator('Eq', '==');
export const Ne = operator('Ne', '!=');
export const Le = operator('Le', '<=');
export const Ge = operator('Ge', '>=');
export const IntDiv = operator('IntDiv', '//');
export const Plus = operator('Plus', '+');
export const Minus = operator('Minus', '-');
export const Star = operator('Star', '*');
export const Slash = operator('Slash', '/');
export const Percent = operator('Percent', '%');
export const Lt = operator('Lt', '<');
export const Gt = operator('Gt', '>');
export const Assign = operator('Assign', '=');
export const LParen = operator('LParen', '(');
export const RParen = operator('RParen', ')');
export const LSquare = operator('LSquare', '[');
export const RSquare = operator('RSquare', ']');
export const Comma = operator('Comma', ',');
export const Colon = operator('Colon', ':');
export const Question = operator('Question', '?');

export const ASSIGN_OPERATORS = [
  PlusAssign, MinusAssign, PowAssign, StarAssign, SlashAssign, PercentAssign, Assign,
];

// Match tokens in this order; earlier patterns take precedence.
export const ALL_TOKENS = [
  WhiteSpace,
  ColorLiteral,
  Comment,
  StringLiteral,
  NumberLiteral,
  PowAssign, Pow, PlusAssign, MinusAssign, StarAssign, SlashAssign, PercentAssign,
  Eq, Ne, Le, Ge, IntDiv,
  Plus, Minus, Star, Slash, Percent, Lt, Gt, Assign,
  LParen, RParen, LSquare, RSquare, Comma, Colon, Question,
  Identifier,
  IdentLike,
  ...KEYWORDS.map((word) => kw[word]!),
];

const lexer = new Lexer(ALL_TOKENS, { positionTracking: 'full' });

function retag(tokens: IToken[]) {
  for (const token of tokens) {
    if (token.tokenTypeIdx !== Identifier.tokenTypeIdx) continue;
    const type = KEYWORD_TOKENS.get(token.image);
    if (!type) continue;
    token.tokenType = type;
    token.tokenTypeIdx = type.tokenTypeIdx!;
  }
  return tokens;
}

export function tokenize(source: string): { tokens: IToken[]; errors: ILexingError[] } {
  const result = lexer.tokenize(source);
  return { tokens: retag(result.tokens), errors: result.errors };
}

