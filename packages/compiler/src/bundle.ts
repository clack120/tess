import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { AssetFile, EntryProject } from './types.ts';

interface TarEntry {
  name: string;
  data: Buffer;
}

const BLOCK_SIZE = 512;

function padding(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

const field = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`;

// Write a ustar header; names over 100 bytes go to the 155-byte prefix field.
function header(name: string, size: number, mtime: Date): Buffer {
  const block = Buffer.alloc(BLOCK_SIZE);
  let base = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 1);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (cut < 0 || Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`TAR 에 넣기에는 경로가 너무 깁니다: ${name}`);
    }
  }
  block.write(base, 0, 100, 'utf-8');
  block.write(field(0o644, 8), 100, 'ascii');
  block.write(field(0, 8), 108, 'ascii');
  block.write(field(0, 8), 116, 'ascii');
  block.write(field(size, 12), 124, 'ascii');
  block.write(field(Math.floor(mtime.getTime() / 1000), 12), 136, 'ascii');
  block.write('0', 156, 'ascii');
  block.write('ustar\0' + '00', 257, 'ascii');
  block.write(prefix, 345, 155, 'utf-8');
  // The checksum is computed with its own field filled with spaces.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

export function makeTar(entries: TarEntry[]): Buffer {
  const mtime = new Date();
  const chunks: Buffer[] = [];
  for (const { name, data } of entries) {
    chunks.push(header(name, data.length, mtime), data, padding(data.length));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2)); // TAR ends with two empty blocks.
  return Buffer.concat(chunks);
}

export async function makeEntryBundle(
  project: EntryProject,
  assets: AssetFile[] = [],
): Promise<Buffer> {
  const mtime = new Date();
  const projectData = Buffer.from(JSON.stringify(project), 'utf-8');
  const chunks: Buffer[] = [];

  async function* tarChunks(): AsyncGenerator<Buffer> {
    yield header('temp/project.json', projectData.length, mtime);
    yield projectData;
    yield padding(projectData.length);

    // Entry loads works without thumb/ copies, so only the original images are packed.
    const packed = new Set<string>();
    for (const asset of assets) {
      if (packed.has(asset.target)) continue;
      packed.add(asset.target);
      const size = fs.statSync(asset.source).size;
      yield header(asset.target, size, mtime);
      for await (const chunk of fs.createReadStream(asset.source)) yield chunk as Buffer;
      yield padding(size);
    }
    yield Buffer.alloc(BLOCK_SIZE * 2);
  }

  // Stream the TAR through gzip so large assets are never duplicated into one
  // uncompressed archive in memory. The returned compressed .ent is the only
  // complete bundle retained by this API.
  await pipeline(
    Readable.from(tarChunks()),
    zlib.createGzip({ level: 9 }),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
  );
  return Buffer.concat(chunks);
}
