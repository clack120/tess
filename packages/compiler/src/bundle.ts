import fs from 'node:fs';
import { Header } from 'tar';
import { makeThumbnail } from './thumbnail.ts';
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

function header(name: string, size: number, mtime: Date): Buffer {
  const block = Buffer.alloc(BLOCK_SIZE);
  new Header({
    path: name, size, mtime, type: 'File', mode: 0o644, uid: 0, gid: 0,
  }).encode(block, 0);
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
  const entries: TarEntry[] = [{
    name: 'temp/project.json',
    data: Buffer.from(JSON.stringify(project), 'utf-8'),
  }];

  const packed = new Set<string>();
  const pending: Array<{ index: number; name: string; data: Buffer }> = [];
  for (const asset of assets) {
    if (packed.has(asset.target)) continue;
    packed.add(asset.target);
    const data = fs.readFileSync(asset.source);
    const index = entries.push({ name: asset.target, data }) - 1;

    // Entry's editor needs thumbnails beside the original images.
    const thumbName = asset.target.replace('/image/', '/thumb/');
    if (thumbName === asset.target || packed.has(thumbName)) continue;
    packed.add(thumbName);
    pending.push({ index, name: thumbName, data });
  }

  const thumbs = await Promise.all(pending.map(({ data }) => makeThumbnail(data)));

  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const thumb = thumbs[i];
    if (!thumb) continue; // Entry also skips thumbnails for SVG and other unsupported formats.
    entries.splice(pending[i]!.index + 1, 0, { name: pending[i]!.name, data: thumb });
  }
  return makeTar(entries);
}
