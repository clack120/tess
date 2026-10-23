// Match Entry's conversions and decimal arithmetic while keeping fast paths for ordinary doubles.

// Match Entry number slots: parseFloat, then zero if parsing fails.
export function num(value: unknown): number {
  // Skip string conversion for numbers, but retain Entry's zero fallback for NaN and negative zero.
  if (typeof value === 'number') {
    return value || 0;
  }
  const n = parseFloat(value as string);
  return n || 0;
}

export function str(value: unknown): string {
  return String(value);
}

// Numeric text keeps its numeric truthiness; other text is true.
export function bool(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  const n = Number(value);
  return isNaN(n) ? true : Boolean(n);
}

export function field(value: unknown): number {
  return Number(value);
}

const MINUS = 45;
const DOT = 46;
const ZERO = 48;
const NINE = 57;

// Match Entry's numeric syntax without a leading dot; scan directly to avoid regex overhead.
export function isNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  let at = value.charCodeAt(0) === MINUS ? 1 : 0;
  const start = at;
  while (at < length) {
    const code = value.charCodeAt(at);
    if (code < ZERO || code > NINE) {
      break;
    }
    at += 1;
  }
  if (at === start) {
    return false;
  }
  if (at === length) {
    return true;
  }
  if (value.charCodeAt(at) === DOT) {
    for (at += 1; at < length; at += 1) {
      const code = value.charCodeAt(at);
      if (code < ZERO || code > NINE) break;
    }
    if (at === length) return true;
  }
  const exponent = value.charCodeAt(at++);
  if (exponent !== 69 && exponent !== 101) return false;
  const sign = value.charCodeAt(at);
  if (sign === MINUS || sign === 43) at++;
  const exponentStart = at;
  for (; at < length; at += 1) {
    const code = value.charCodeAt(at);
    if (code < ZERO || code > NINE) {
      return false;
    }
  }
  return at > exponentStart;
}

// Use plain doubles once decimal rounding cannot recover additional precision.
const MAX_DECIMALS = 20;

const TENTHS: number[] = Array.from({ length: MAX_DECIMALS + 1 }, (_, at) => 10 ** -at);

// Stop counting decimals once snap would leave the value unchanged.
const DECIMAL_CAP = MAX_DECIMALS + 1;

const TENS: number[] = Array.from({ length: DECIMAL_CAP + 1 }, (_, at) => 10 ** at);

// Above this limit the decimal product no longer needs residual correction.
const EXACT_LIMIT = 2 ** 53;

// Dekker's double-splitting constant: 2 ** 27 + 1.
const SPLIT = 134217729;

// Test decimal round trips without strings; use a product residual below the exact-integer limit.
function readsBack(a: number, places: number): boolean {
  const ten = TENS[places]!;
  const scaled = a * ten;
  if (scaled >= EXACT_LIMIT) {
    return true;
  }
  const splitA = SPLIT * a;
  const highA = splitA - (splitA - a);
  const lowA = a - highA;
  const splitTen = SPLIT * ten;
  const highTen = splitTen - (splitTen - ten);
  const lowTen = ten - highTen;
  const error = ((highA * highTen - scaled) + highA * lowTen + lowA * highTen) + lowA * lowTen;
  let rounded = Math.floor(scaled);
  // Add the residual to frac - 0.5 so rounding cannot absorb it into frac.
  if (scaled - rounded - 0.5 + error >= 0) {
    rounded += 1;
  }
  return rounded / ten === a;
}

export function decimalsBelow(a: number, limit: number): number {
  // Find the shortest decimal tail by search because every longer tail also round-trips.
  let low = 1;
  let high = limit;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (readsBack(a, middle)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

// Beyond this tail, decimal grid spacing is finer than the gap between doubles.
function gridWall(a: number): number {
  let low = 0;
  let high = DECIMAL_CAP;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (a * TENS[middle]! >= EXACT_LIMIT) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return a * TENS[low]! >= EXACT_LIMIT ? low : DECIMAL_CAP + 1;
}

// Stop at the rounding limit because longer tails cannot change snap's result.
function tailOf(x: number, wall: number): number {
  if (Number.isInteger(x)) {
    return 0;
  }
  const a = x < 0 ? -x : x;
  const below = wall - 1;
  return readsBack(a, below) ? decimalsBelow(a, below) : DECIMAL_CAP;
}

// Count table decimal tails once so the kernel can reuse them on every read.
export function decimals(x: number): number {
  if (Number.isInteger(x)) {
    return 0;
  }
  return decimalsBelow(x < 0 ? -x : x, DECIMAL_CAP);
}

// Reuse known operand tails; -1 means the caller has not counted them.
function maxTail(result: number, a: number, b: number, ta = -1, tb = -1): number {
  const magnitude = result < 0 ? -result : result;
  const wall = gridWall(magnitude);
  if (wall <= 1) {
    return DECIMAL_CAP;
  }
  const left = ta >= 0 ? ta : tailOf(a, wall);
  if (left >= wall) {
    return DECIMAL_CAP;
  }
  const right = tb >= 0 ? tb : tailOf(b, wall);
  if (right >= wall) {
    return DECIMAL_CAP;
  }
  return left > right ? left : right;
}

// Stop summing decimal tails once snap cannot use any more precision.
function sumTail(result: number, a: number, b: number, ta = -1, tb = -1): number {
  const magnitude = result < 0 ? -result : result;
  const wall = gridWall(magnitude);
  if (wall <= 1) {
    return DECIMAL_CAP;
  }
  const left = ta >= 0 ? ta : tailOf(a, wall);
  if (left >= wall) {
    return DECIMAL_CAP;
  }
  const right = tb >= 0 ? tb : tailOf(b, wall);
  if (right >= wall || left + right >= wall) {
    return DECIMAL_CAP;
  }
  return left + right;
}

// Reuse compile-time decimal tails in the kernel; -1 requests runtime counting.
export function addNumWith(a: number, b: number, ta: number, tb: number): number {
  const r = a + b;
  if (Number.isInteger(a) && Number.isInteger(b)) {
    return r;
  }
  return snap(r, maxTail(r, a, b, ta, tb));
}

export function subNumWith(a: number, b: number, ta: number, tb: number): number {
  const r = a - b;
  if (Number.isInteger(a) && Number.isInteger(b)) {
    return r;
  }
  return snap(r, maxTail(r, a, b, ta, tb));
}

export function mulNumWith(a: number, b: number, ta: number, tb: number): number {
  const r = a * b;
  if (Number.isInteger(a) && Number.isInteger(b)) {
    return r;
  }
  return snap(r, sumTail(r, a, b, ta, tb));
}

// Leave room for decimal-table error when bounding the gap between neighboring doubles.
const SPACING = Number.EPSILON / 4;

// Snap sums and products to the operands' decimal grid to match BigNumber results.
function snap(result: number, places: number): number {
  if (places === 0 || places > MAX_DECIMALS || !isFinite(result)) {
    return result;
  }
  // Skip formatting when the decimal grid is finer than the spacing between doubles.
  if (Math.abs(result) * SPACING >= TENTHS[places]!) {
    return result;
  }
  return Number(result.toFixed(places));
}

// Match Entry's decimal addition so 0.1 + 0.2 is 0.3.
export function addNum(a: number, b: number): number {
  const r = a + b;
  if (Number.isInteger(a) && Number.isInteger(b)) {
    return r;
  }
  return snap(r, maxTail(r, a, b));
}

export function subNum(a: number, b: number): number {
  const r = a - b;
  if (Number.isInteger(a) && Number.isInteger(b)) {
    return r;
  }
  return snap(r, maxTail(r, a, b));
}

export function mulNum(a: number, b: number): number {
  const r = a * b;
  if (Number.isInteger(a) && Number.isInteger(b)) {
    return r;
  }
  return snap(r, sumTail(r, a, b));
}

// BigNumber divides to 20 decimal places with half-up rounding before converting to a number.
export function divNum(a: number, b: number): number {
  const r = a / b;
  if (r === 0 || !isFinite(r) || Math.abs(r) >= 1e-3) {
    return r;
  }
  return Number(r.toFixed(MAX_DECIMALS));
}

// PLUS concatenates unless both raw operands are numbers.
export function calcPlus(left: unknown, right: unknown): number | string {
  const leftValue: unknown = isNumber(left) ? num(left) : left;
  const rightValue: unknown = isNumber(right) ? num(right) : right;
  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    return addNum(leftValue, rightValue);
  }
  return (leftValue as string) + (rightValue as string);
}

// Compare as numbers when Entry recognizes numeric text.
function comparable(value: unknown): unknown {
  if (typeof value === 'string' && value.length) {
    const n = Number(value);
    if (!isNaN(n)) {
      return n;
    }
  }
  return value;
}

export function cmpEqual(a: unknown, b: unknown): boolean {
  return comparable(a) === comparable(b);
}

// Entry uses loose inequality here while equality stays strict.
export function cmpNotEqual(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line eqeqeq
  return comparable(a) != comparable(b);
}

export function cmpGreater(a: unknown, b: unknown): boolean {
  return (comparable(a) as number) > (comparable(b) as number);
}

export function cmpLess(a: unknown, b: unknown): boolean {
  return (comparable(a) as number) < (comparable(b) as number);
}

export function cmpGreaterEqual(a: unknown, b: unknown): boolean {
  return (comparable(a) as number) >= (comparable(b) as number);
}

export function cmpLessEqual(a: unknown, b: unknown): boolean {
  return (comparable(a) as number) <= (comparable(b) as number);
}

// Evaluate both and/or operands before combining them.
export function andOf(a: unknown, b: unknown): boolean {
  return Boolean(a) && Boolean(b);
}

export function orOf(a: unknown, b: unknown): boolean {
  return Boolean(a) || Boolean(b);
}

export function clamp(value: number, min: number, max: number): number {
  if (value > max) {
    return max;
  }
  if (value < min) {
    return min;
  }
  return value;
}

// Entry's decimal modulo keeps the divisor's sign.
export function mod(value: number, divisor: number): number {
  const r = ((value % divisor) + divisor) % divisor;
  if (Number.isInteger(value) && Number.isInteger(divisor)) {
    return r;
  }
  return snap(r, maxTail(r, value, divisor));
}

// Keep leading-zero numeric text as text so names such as 007 survive.
export function parseNumber(value: unknown): number | string | false {
  if (typeof value === 'string') {
    if ((isNumber(value) && value[0] === '0') || (value[0] === '0' && value[1]?.toLowerCase() === 'x')) {
      return value;
    }
    if (isNumber(value)) {
      return Number(value);
    }
  } else if (typeof value === 'number' && isNumber(value)) {
    return value;
  }
  return false;
}

// Match Entry's reported size rounding with Number(value.toFixed(places)).
export function fixed(value: number, places: number): number {
  return Number(value.toFixed(places));
}

// Expand short hex and treat invalid colors as black, matching Entry.
export function hexToRgb(value: unknown): { r: number; g: number; b: number } {
  const text = String(value ?? '');
  let hex = text[0] === '#' ? text : `#${text}`;
  if (hex.length === 4) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    hex = '#000000';
  }
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${(((1 << 24) + (r << 16) + (g << 8) + b) >>> 0).toString(16).slice(1)}`;
}

export function hexColor(value: unknown): string {
  const { r, g, b } = hexToRgb(value);
  return rgbToHex(r, g, b);
}
