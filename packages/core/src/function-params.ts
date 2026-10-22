import { BUILTIN_NAMES } from './builtins.ts';

// Skip x and y in automatic names so parameters do not hide coordinates.
const LETTERS = [...'abcdefghijklmnopqrstuvwxyz']
  .filter((letter) => !BUILTIN_NAMES.has(letter))
  .join('');

export function autoParamName(index: number): string {
  return index < LETTERS.length ? LETTERS[index] : `a${index - LETTERS.length + 1}`;
}

export function isAutoParamName(name: string, index: number): boolean {
  return name === autoParamName(index);
}
