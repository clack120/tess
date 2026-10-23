// Compile Entropy inputs and load Entry archives without changing their blocks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileProject, type AssetFile, type CompileDiagnostic, type EntryProject, type SourceMap } from '@entropy/compiler';

export interface LoadOptions {
  assetDirs?: string[];
  name?: string;
  strict?: boolean;
  // Save a Entropy copy here without using it for execution.
  decompileTo?: string;
}

export interface LoadedProject {
  project: EntryProject;
  assets: AssetFile[];
  assetDirs: string[];
  sourceMap?: SourceMap;
  name: string;
  // Keep the original input path, including for Entry archives.
  sourcePath: string;
  errors: CompileDiagnostic[];
  warnings: CompileDiagnostic[];
  notices: CompileDiagnostic[];
  // Set only when a Entropy copy was requested.
  decompiledTo?: string;
  decompileWarnings?: string[];
}

export async function loadProject(file: string, options: LoadOptions = {}): Promise<LoadedProject> {
  const absolute = path.resolve(file);
  if (/\.ent$/i.test(absolute)) {
    return loadEnt(absolute, options);
  }
  return loadEntropy(absolute, options);
}

function loadEntropy(file: string, options: LoadOptions): LoadedProject {
  const source = fs.readFileSync(file, 'utf-8');
  const assetDirs = assetDirsFor(file, options.assetDirs);
  const result = compileProject(source, {
    path: file,
    assetDirs,
    name: options.name,
    strict: options.strict,
  });
  if (!result.project) {
    const first = result.errors[0];
    throw new Error(
      first ? `${path.basename(file)}:${first.line}:${first.column} ${first.message}` : '컴파일 실패',
    );
  }
  return {
    project: result.project,
    assets: result.assets,
    assetDirs,
    sourceMap: result.sourceMap,
    name: options.name ?? result.project.name ?? path.basename(file, path.extname(file)),
    sourcePath: file,
    errors: result.errors,
    warnings: result.warnings,
    notices: result.notices,
  };
}

async function loadEnt(file: string, options: LoadOptions): Promise<LoadedProject> {
  const { readTar, builtinAssets, decompileProject } = await import('@entropy/decompiler');
  const entries = await readTar(fs.readFileSync(file));
  const projectEntry = entries.find((entry) => entry.name === 'temp/project.json') ??
    entries.find((entry) => path.posix.basename(entry.name) === 'project.json');
  if (!projectEntry) throw new Error('project.json 을 찾지 못했습니다 — .ent 파일을 확인하세요.');
  const project = JSON.parse(Buffer.from(projectEntry.data).toString('utf8')) as EntryProject;
  if (!project || !Array.isArray(project.objects)) throw new Error('project.json 에 objects 배열이 없습니다.');
  const files = entries.filter((entry) => entry !== projectEntry);
  const urls = new Set(files.map((entry) => entry.name));
  const byName = new Map(files.map((entry) => [entry.name.replace(/^\.\//, ''), entry.data]));
  const builtin = builtinAssets();
  const assetDirs = assetDirsFor(file, options.assetDirs);
  const assets: AssetFile[] = [];
  for (const object of project.objects) {
    for (const resource of [...(object.sprite?.pictures ?? []), ...(object.sprite?.sounds ?? [])]) {
      for (const key of ['fileurl', 'pngurl'] as const) {
        const url = (resource as unknown as Record<string, unknown>)[key];
        if (typeof url !== 'string' || urls.has(url)) continue;
        const data = byName.get(url.replace(/^\.?\//, '')) ?? builtin(url);
        if (data) {
          files.push({ name: url, data }); urls.add(url);
        } else if (!/^[a-z][a-z\d+.-]*:/i.test(url)) {
          for (const dir of assetDirs) {
            const root = path.resolve(dir);
            const source = path.resolve(root, url.replace(/^\.?\//, ''));
            if (source.startsWith(root + path.sep) && fs.existsSync(source) && fs.statSync(source).isFile()) {
              assets.push({ source, target: url }); urls.add(url);
              break;
            }
          }
        }
      }
    }
  }
  for (const { name } of files) {
    if (name.split(/[\\/]/).includes('..') || name.includes('\0')) {
      throw new Error(`작품이 폴더 밖의 파일을 가리킵니다: ${name}`);
    }
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-assets-'));
  // Archive names stay as URLs and never become paths on disk.
  for (const [index, { name, data }] of files.entries()) {
    const ext = path.extname(name);
    const source = path.join(folder, `${index}${/^\.[a-z0-9]+$/i.test(ext) ? ext : '.bin'}`);
    fs.writeFileSync(source, data);
    assets.push({ source, target: name });
  }
  const loaded: LoadedProject = {
    project, assets, assetDirs: [...assetDirs, folder],
    name: options.name ?? project.name ?? path.basename(file, path.extname(file)),
    sourcePath: file, errors: [], warnings: [], notices: [],
  };
  if (options.decompileTo) {
    const decompiled = decompileProject(project, entries, { tableRows: false });
    const root = path.resolve(options.decompileTo);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'main.etp'), decompiled.source);
    for (const asset of decompiled.assets) {
      const target = path.resolve(root, asset.path);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`작품이 폴더 밖의 파일을 가리킵니다: ${asset.path}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, asset.data);
    }
    loaded.decompiledTo = options.decompileTo;
    loaded.decompileWarnings = decompiled.warnings;
  }
  return loaded;
}

// Search beside the input and in its assets folder after explicit paths.
export function assetDirsFor(file: string, extra: string[] = []): string[] {
  const dir = path.dirname(path.resolve(file));
  return [...extra, dir, path.join(dir, 'assets')];
}
