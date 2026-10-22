/**
 * Turns TypeScript source into JavaScript for a browser or a sandbox: Bun's
 * transpiler under Bun, `stripTypeScriptTypes` under Node.
 */
type Transpiler = { transformSync(source: string): string };
type BunGlobal = { Transpiler: new (options: { loader: 'ts' }) => Transpiler };

let transpiler: Transpiler | null = null;

export function stripTypes(source: string): string {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  if (bun) {
    transpiler ??= new bun.Transpiler({ loader: 'ts' });
    return transpiler.transformSync(source);
  }
  const { stripTypeScriptTypes } = process.getBuiltinModule('node:module') as {
    stripTypeScriptTypes(source: string, options: { mode: 'strip' }): string;
  };
  return stripTypeScriptTypes(source, { mode: 'strip' });
}
