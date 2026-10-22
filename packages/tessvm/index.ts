export { Vm, DEFAULT_FPS, MAX_CLONES, GUEST } from './src/runtime/engine.ts';
export { formatVmError } from './src/runtime/diagnostics.ts';
export type { RuntimeValue } from './src/runtime/diagnostics.ts';
export type {
  AudioEngine,
  EntryProjectLike,
  EntryUser,
  Renderer,
  VariableStore,
  VmError,
  VmOptions,
} from './src/runtime/engine.ts';
export { Codegen } from './src/compile/codegen.ts';
export type { CompiledProgram, CompileInput, RawBlock } from './src/compile/codegen.ts';
export {
  Entity,
  Target,
  Thread,
  Variable,
  DEFAULT_STAGE_HEIGHT,
  DEFAULT_STAGE_WIDTH,
  WORLD_SCALE,
  parseFont,
  setStageSize,
  stage,
} from './src/runtime/model.ts';
export type { StageMetrics } from './src/runtime/model.ts';
export * as cast from './src/runtime/cast.ts';
export { CollisionSystem, entityBounds, wallRect } from './src/collision/detect.ts';
export { MaskStore, maskFromPixels, solidMask } from './src/collision/mask.ts';
export type { AlphaMask, MaskLoader } from './src/collision/mask.ts';
export { Table, columnIndex, cellToRowCol } from './src/runtime/table.ts';
export { CURSORS, EXTRA_VARIABLES, Extras, SCROLL_MESSAGE } from './src/runtime/extras.ts';
export type { ExtrasHost, ExtrasUse } from './src/runtime/extras.ts';
export { loadProject, assetDirsFor } from './src/node/load.ts';
export type { LoadedProject, LoadOptions } from './src/node/load.ts';
export { serveVm, DEFAULT_PORT } from './src/node/server.ts';
export { crc32, zipFiles } from './src/node/zip.ts';
export type { ZipFile } from './src/node/zip.ts';
export { exportHtml, exportZip } from './src/node/export.ts';
export type { ExportOptions, ExportResult } from './src/node/export.ts';
export { makeVmRuntime } from './src/web/debug.ts';
export type { EnvChoices } from './src/web/debug.ts';
export type { ServeOptions, RunningServer } from './src/node/server.ts';
export { SilentAudioEngine } from './src/audio/silent.ts';
export { planKernel } from './src/kernel/plan.ts';
export type { KernelPlan, KernelSlot } from './src/kernel/plan.ts';
export type { KernelHandle } from './src/kernel/bridge.ts';
