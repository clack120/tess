const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface IdFactory {
  (): string;
  reserve(id: string): void;
  has(id: string): boolean;
}

export function createIdFactory(seed = 0): IdFactory {
  let state = (seed || 0x9e3779b9) >>> 0;
  const used = new Set<string>();

  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const next = (() => {
    for (;;) {
      // Entry finds assets by ID before index, so numeric IDs would hide positions.
      let id = LETTERS[Math.floor(random() * LETTERS.length)]!;
      for (let i = 1; i < 4; i += 1) id += ALPHABET[Math.floor(random() * ALPHABET.length)];
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  }) as IdFactory;

  next.reserve = (id: string) => { used.add(id); };
  next.has = (id: string) => used.has(id);
  return next;
}
