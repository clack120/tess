import { decompileProject as decompile } from "./src/index.ts";
import { builtinAssets } from "./src/node.ts";
import type { DecompileOptions, DecompileResult, RawEntity, TarEntry } from "./src/types.ts";

// Use installed Entry assets; browsers call src/index.ts directly.
export function decompileProject(
  project: RawEntity,
  entries: TarEntry[],
  options: DecompileOptions = {},
): DecompileResult {
  return decompile(project, entries, { builtinAssets: builtinAssets(), ...options });
}

export { decompileEnt, builtinAssets } from "./src/node.ts";
export { restoreTableRows } from "./src/index.ts";
export { compareEntryProjects } from './src/audit.ts';
export type { ProjectAudit, ProjectDifference, ProjectAuditOptions } from './src/audit.ts';
export { findProjectEntry, readTar } from "./src/tar.ts";
export type * from "./src/types.ts";
