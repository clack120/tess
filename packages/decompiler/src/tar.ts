import zlib from 'node:zlib';
import type { TarEntry } from './types.ts';

const BLOCK = 512;

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString('utf-8');
}

function octal(block: Buffer, start: number, length: number): number {
  return parseInt(text(block, start, length).trim() || '0', 8);
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
    if (type === '0' || type === '7') entries.push({ name, data: Buffer.from(data) });
  }
  return entries;
}
