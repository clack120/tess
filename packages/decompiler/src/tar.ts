import zlib from 'node:zlib';
import type { TarEntry } from './types.ts';

const BLOCK = 512;

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString('utf-8');
}

function octal(block: Buffer, start: number, length: number): number {
  const value = text(block, start, length).trim() || '0';
  if (!/^[0-7]+$/.test(value)) throw new Error(`TAR 헤더의 크기 값 '${value}' 이(가) 올바른 8진수가 아닙니다`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`TAR 헤더의 크기 값 '${value}' 이(가) 너무 큽니다`);
  return parsed;
}

// Read .ent archives, which Entry saves as gzip-compressed or plain ustar.
export async function readTar(bytes: Buffer): Promise<TarEntry[]> {
  const tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes;
  const entries: TarEntry[] = [];
  let longName: string | null = null;
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156] || 0x30);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length < size) throw new Error('TAR 파일이 중간에 끊겼습니다');
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    // GNU and pax headers carry names longer than the 100-byte field for the next entry.
    if (type === 'L') {
      longName = data.toString('utf-8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf-8'))?.[1] ?? longName;
      continue;
    }
    const prefix = text(block, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
    longName = null;
    // Keep views into the decompressed archive instead of copying every asset.
    // Large Entry works commonly contain hundreds of megabytes of media; callers
    // already retain all entries while decompiling or extracting them.
    if (type === '0' || type === '7') entries.push({ name, data });
  }
  return entries;
}

export function findProjectEntry(entries: TarEntry[]): TarEntry | undefined {
  return entries.find((entry) => entry.name === 'temp/project.json')
    ?? entries.find((entry) => entry.name.replaceAll('\\', '/').split('/').at(-1) === 'project.json');
}
