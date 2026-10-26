import { BUILTIN_NAMES } from '@entropy/core';
import { UNUSABLE_AS_NAME } from '@entropy/parser';
import type { DecompileContext, ResourceInfo } from './types.ts';

const IDENT_START = /[\p{L}_]/u;
// Match the lexer: only ASCII digits belong in identifiers.
const IDENT_PART = /[\p{L}0-9_]/u;
const NEXT_SUFFIX = new WeakMap<Set<string>, Map<string, number>>();

export function lookup<T>(values: Record<string, T>, key: unknown): T | undefined {
  return (typeof key === 'string' || typeof key === 'number') && Object.hasOwn(values, key) ? values[key] : undefined;
}

export function safeIdentifier(raw: unknown, usedNames: Set<string>, fallback = 'item'): string {
  let cleaned = '';
  for (const ch of String(raw ?? '')) cleaned += IDENT_PART.test(ch) ? ch : '_';
  cleaned = cleaned.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned || !IDENT_START.test([...cleaned][0]!)) cleaned = `${fallback}${cleaned ? `_${cleaned}` : ''}`;
  cleaned = [...cleaned].slice(0, 40).join('') || fallback;
  // Avoid reserved and built-in names so renamed declarations do not hide other values.
  if (UNUSABLE_AS_NAME.has(cleaned) || BUILTIN_NAMES.has(cleaned)) cleaned = `${cleaned}_`;

  let candidate = cleaned;
  let suffixes = NEXT_SUFFIX.get(usedNames);
  if (!suffixes) NEXT_SUFFIX.set(usedNames, suffixes = new Map());
  let n = suffixes.get(cleaned) ?? 2;
  while (usedNames.has(candidate)) {
    candidate = `${cleaned}${cleaned.endsWith('_') ? '' : '_'}${n}`;
    n += 1;
  }
  suffixes.set(cleaned, n);
  usedNames.add(candidate);
  return candidate;
}

// Escape all four line endings because Entry names may contain Unicode line separators.
const LINE_BREAK = /[\n\r\u2028\u2029]/g;

export function entropyString(value: unknown): string {
  // JSON escapes lone surrogates so writing UTF-8 cannot replace them with U+FFFD.
  return JSON.stringify(String(value)).replace(/[\u2028\u2029]/g, ch => ch === '\u2028' ? '\\u2028' : '\\u2029');
}

// Escape line breaks so project text cannot end a comment and become Entropy code.
export function entropyComment(text: unknown): string {
  return `# ${String(text).replace(LINE_BREAK, ' ')}`.trimEnd();
}

export function entropyCommentLines(text: unknown): string[] {
  return String(text).split(LINE_BREAK).map((line) => entropyComment(line));
}

// Keep the Entry name with as when the Entropy identifier differs; runtime lookups need it.
export function displayNamePart(identifier: string, entryName: unknown): string {
  const name = String(entryName ?? '');
  return name && name !== identifier ? ` as ${entropyString(name)}` : '';
}

// Entropy numeric literals exclude exponent notation, leading plus signs, and leading zeros.
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

// Expand exponent notation into a decimal literal Entropy can parse.
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

export function entropyNumber(value: unknown): string {
  if (!Number.isFinite(value)) return '0';
  return expandExponent(String(value));
}

// Use a number only when converting it back preserves every character.
export function isExactNumber(literal: string): boolean {
  const value = Number(literal);
  // NaN, Infinity, and exponent notation must stay strings because Entropy has no matching literals.
  return literal !== '' && Number.isFinite(value)
    && String(value) === literal && PLAIN_DECIMAL.test(literal);
}

// Resource names are unambiguous inside a function owned by that object.
export function ownsResource(ctx: DecompileContext, info: ResourceInfo | undefined): boolean {
  return Boolean(ctx.functionOwnerId) && info?.owner?.id === ctx.functionOwnerId;
}

// Resource IDs can be shared by different objects.
export function resourceInfo(ctx: DecompileContext, id: string, byId: Map<string, ResourceInfo>): ResourceInfo | undefined {
  const owner = ctx.inFunction ? ctx.functionOwnerId : ctx.objectId;
  const resources = owner ? ctx.resourcesByObject.get(owner) : undefined;
  return (byId === ctx.picturesById ? resources?.pictures : resources?.sounds)?.get(id) ?? byId.get(id);
}

export function entropyLiteral(value: unknown): string {
  if (typeof value === 'number') return entropyNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value ?? '');
  return entropyString(text);
}

// Push items separately to avoid the engine's argument limit on large projects.
export function append<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}
