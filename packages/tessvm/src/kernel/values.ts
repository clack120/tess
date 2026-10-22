import { isNumber } from '../runtime/cast.ts';

/** -1: number; -2: canonical exponential string; >=0: fixed decimal string. */
export function scalarPlaces(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? -1 : null;
  if (typeof value !== 'string' || !isNumber(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (/[eE]/.test(value)) return String(number) === value ? -2 : null;
  const dot = value.indexOf('.');
  const places = Math.min(dot < 0 ? 0 : value.length - dot - 1, 20);
  return number.toFixed(places) === value ? places : null;
}
