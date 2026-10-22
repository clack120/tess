import { BUILTIN_NAMES } from '@tess/core';
import { UNUSABLE_AS_NAME } from '@tess/parser';
import type { DecompileContext, ResourceInfo } from './types.ts';

const IDENT_START = /[\p{L}_]/u;
// Match the lexer: only ASCII digits belong in identifiers.
const IDENT_PART = /[\p{L}0-9_]/u;

export function safeIdentifier(raw: unknown, usedNames: Set<string>, fallback = 'item'): string {
  let cleaned = '';
  for (const ch of String(raw ?? '')) cleaned += IDENT_PART.test(ch) ? ch : '_';
  cleaned = cleaned.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned || !IDENT_START.test(cleaned[0]!)) cleaned = `${fallback}${cleaned ? `_${cleaned}` : ''}`;
  cleaned = cleaned.slice(0, 40) || fallback;
  // Avoid reserved and built-in names so renamed declarations do not hide other values.
  if (UNUSABLE_AS_NAME.has(cleaned) || BUILTIN_NAMES.has(cleaned)) cleaned = `${cleaned}_`;

  let candidate = cleaned;
  let n = 2;
  while (usedNames.has(candidate)) {
    candidate = `${cleaned}_${n}`;
    n += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

// Escape all four line endings because Entry names may contain Unicode line separators.
const LINE_BREAK = /[\n\r\u2028\u2029]/g;

const STRING_ESCAPE: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

export function tessString(value: unknown): string {
  const escaped = String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\t', '\\t')
    .replace(LINE_BREAK, (char) => STRING_ESCAPE[char]!);
  return `"${escaped}"`;
}

// Escape line breaks so project text cannot end a comment and become Tess code.
export function tessComment(text: unknown): string {
  return `# ${String(text).replace(LINE_BREAK, ' ')}`.trimEnd();
}

export function tessCommentLines(text: unknown): string[] {
  return String(text).split(LINE_BREAK).map((line) => tessComment(line));
}

// Keep the Entry name with as when the Tess identifier differs; runtime lookups need it.
export function displayNamePart(identifier: string, entryName: unknown): string {
  const name = String(entryName ?? '');
  return name && name !== identifier ? ` as ${tessString(name)}` : '';
}

// Tess numeric literals exclude exponent notation, leading plus signs, and leading zeros.
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

// Expand exponent notation into a decimal literal Tess can parse.
function expandExponent(text: string): string {
  const parts = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!parts) return text;
  const [, sign, whole, fraction = '', exponent] = parts;
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function tessNumber(value: unknown): string {
  if (!Number.isFinite(value)) return '0';
  return expandExponent(String(value));
}

// Use a number only when converting it back preserves every character.
export function isExactNumber(literal: string): boolean {
  const value = Number(literal);
  // NaN, Infinity, and exponent notation must stay strings because Tess has no matching literals.
  return literal !== '' && Number.isFinite(value)
    && String(value) === literal && PLAIN_DECIMAL.test(literal);
}

// Resource names are unambiguous inside a function owned by that object.
export function ownsResource(ctx: DecompileContext, info: ResourceInfo | undefined): boolean {
  return Boolean(ctx.functionOwnerId) && info?.owner?.id === ctx.functionOwnerId;
}

export function tessLiteral(value: unknown): string {
  if (typeof value === 'number') return tessNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value ?? '');
  if (isExactNumber(text)) return text;
  return tessString(text);
}

// Push items separately to avoid the engine's argument limit on large projects.
export function append<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}
