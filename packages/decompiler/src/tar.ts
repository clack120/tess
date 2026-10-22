import { Parser } from 'tar';
import type { TarEntry } from './types.ts';

export function readTar(bytes: Buffer): Promise<TarEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: TarEntry[] = [];
    const parser = new Parser({
      onReadEntry: (entry) => {
        if (entry.type !== 'File') {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => entries.push({ name: entry.path, data: Buffer.concat(chunks) }));
        entry.on('error', reject);
      },
    });
    parser.on('error', reject);
    parser.on('end', () => resolve(entries));
    parser.end(bytes);
  });
}
