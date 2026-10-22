export const KEY_CODES: Record<string, number> = {
  backspace: 8, tab: 9, enter: 13, shift: 16, ctrl: 17, alt: 18,
  esc: 27, escape: 27, space: 32,
  left: 37, up: 38, right: 39, down: 40,
  // Keep names for keys absent from Entry's dropdown; the browser still sends them.
  capslock: 20, pageup: 33, pagedown: 34, end: 35, home: 36,
  insert: 45, delete: 46,
};

for (let i = 1; i <= 12; i += 1) KEY_CODES[`f${i}`] = 111 + i;
for (let i = 0; i <= 9; i += 1) KEY_CODES[`numpad${i}`] = 96 + i;

for (let i = 0; i <= 9; i += 1) KEY_CODES[String(i)] = 48 + i;
for (let i = 0; i < 26; i += 1) KEY_CODES[String.fromCharCode(97 + i)] = 65 + i;

// Put backslash before its symbol so decompilation picks the readable name.
Object.assign(KEY_CODES, {
  ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '~': 192,
  '[': 219, backslash: 220, '\\': 220, ']': 221, "'": 222,
});

export function keyCodeOf(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  const code = KEY_CODES[key];
  if (code !== undefined) return String(code);
  // Keep unnamed key codes as numbers so existing works can round-trip.
  return /^[0-9]{1,3}$/.test(key) ? key : null;
}
