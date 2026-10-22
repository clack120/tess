export interface CompilerHost {
  resolve(base: string, target: string): string;
  isFile(file: string): boolean;
  readFile(file: string): Uint8Array | null;
  readText(file: string): string | null;
}

export const EMPTY_HOST: CompilerHost = {
  resolve: (base, target) => (base ? `${base.replace(/\/+$/, '')}/${target}` : target),
  isFile: () => false,
  readFile: () => null,
  readText: () => null,
};

export function basename(file: string, ext = ''): string {
  const name = file.split(/[\\/]/).pop() ?? '';
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
}

export function dirname(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return cut < 0 ? '.' : file.slice(0, cut) || '/';
}

// A leading dot does not count as a file extension.
export function extname(file: string): string {
  const name = basename(file);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}
