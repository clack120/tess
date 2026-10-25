import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLocalRuntime } from '@entropy/player';
import { findProjectEntry, readTar } from './tar.ts';
import { decompileProject } from './index.ts';
import type { DecompileOptions, DecompileResult } from './types.ts';

// Default Entry assets are bundled with the engine rather than the project archive.
const BUILTIN_ASSET = /(?:^|\/)bower_components\/[^/]+\/(images\/[^?#]+)$/;

function findRuntimeDir(): string | null {
  return findLocalRuntime() ?? findLocalRuntime(path.dirname(fileURLToPath(import.meta.url)));
}

export function builtinAssets(): (fileurl: string) => Uint8Array | null {
  let dir: string | null | undefined;
  return (fileurl) => {
    const match = BUILTIN_ASSET.exec(fileurl ?? '');
    if (!match) return null;
    if (dir === undefined) dir = findRuntimeDir();
    if (!dir) return null;
    // Reject asset paths that leave the installed Entry package.
    if (match[1]!.split('/').includes('..')) return null;
    const file = path.join(dir, match[1]!);
    return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  };
}

export async function decompileEnt(
  bytes: Buffer,
  options: DecompileOptions = {},
): Promise<DecompileResult> {
  const entries = await readTar(bytes);
  const projectEntry = findProjectEntry(entries);
  if (!projectEntry) {
    throw new Error('project.json 을 찾지 못했습니다 — .ent(엔트리 작품) 파일이 맞는지 확인하세요.');
  }
  const project = JSON.parse(new TextDecoder('utf-8').decode(projectEntry.data));
  return decompileProject(project, entries, { builtinAssets: builtinAssets(), ...options });
}
