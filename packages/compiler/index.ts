import { compileProject as compile } from "./src/index.ts";
import { loadProgram as load } from "./src/include.ts";
import { NODE_HOST } from "./src/node-host.ts";
import type { CompileOptions, CompileResult } from "./src/types.ts";

// Use src/index.ts with a custom host outside Node.
export function compileProject(source: string, options: CompileOptions = {}): CompileResult {
  return compile(source, { host: NODE_HOST, ...options });
}

export function loadProgram(input: Parameters<typeof load>[0]) {
  return load({ host: NODE_HOST, ...input });
}

export { createCompileCache } from "./src/index.ts";
export { NODE_HOST } from "./src/node-host.ts";
export type { CompilerHost } from "./src/host.ts";
export { makeEntryBundle, makeTar } from "./src/bundle.ts";
export { verifyEntryProject } from "./src/verify.ts";
export { BLOCK_PARAM_COUNTS } from "./src/block-params.ts";
export { assetFilename, fileUrlFor, imageSize, makeAsset } from "./src/assets.ts";
export { audioDuration } from "./src/audio.ts";
export type * from "./src/types.ts";
