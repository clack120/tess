import type { Diagnostic, Expr, FunctionDeclNode, ObjectNode, ParseRoot, VarDeclNode } from '@entropy/parser';
import type { CompilerHost } from './host.ts';

export type EntryParam = EntryBlock | string | number | boolean | null;

// Statements hold the nested block lists of C-shaped blocks.
export interface EntryBlock {
  id: string;
  x: number;
  y: number;
  type: string;
  params: EntryParam[];
  statements: EntryBlock[][];
  movable: number | null;
  deletable: number;
  emphasized: boolean;
  readOnly: number | null;
  copyable: boolean;
  assemble: boolean;
  extensions: unknown[];
  comment?: EntryComment;
}

export interface EntryComment {
  x: number;
  y: number;
  width: number;
  height: number;
  value: string;
  readOnly: boolean;
  visible: boolean;
  display: boolean;
  movable: boolean;
  isOpened: boolean;
  deletable: number;
  type: string;
}

export interface EntryScene {
  id: string;
  name: string;
}

export interface EntryMessage {
  id: string;
  name: string;
}

export type VariableType = 'variable' | 'list' | 'slide' | 'timer' | 'answer';

export interface EntryVariable {
  id: string;
  name: string;
  visible: boolean;
  value: string | number | boolean;
  variableType: VariableType;
  isCloud: boolean;
  isRealTime: boolean;
  cloudDate: boolean;
  object: string | null;
  x: number;
  y: number;
  array?: Array<{ data: string | number | boolean }>;
  width?: number;
  height?: number;
  // Slider bounds apply only to slide variables.
  minValue?: number;
  maxValue?: number;
}

export interface EntryTable {
  id: string;
  name: string;
  object: string | null;
  fields: string[];
  data: string[][];
  chart: unknown[];
}

export interface FuncLocalVariable {
  id: string;
  name: string;
  value: string | number;
}

export interface EntryFunction {
  id: string;
  type: string;
  localVariables: FuncLocalVariable[];
  useLocalVariables: boolean;
  content: string;
}

export interface EntryPicture {
  id: string;
  name: string;
  filename: string;
  fileurl: string;
  // Raster copy saved beside a vector costume.
  pngurl?: string;
  imageType?: string;
  dimension?: { width: number; height: number };
  ext?: string;
}

export interface EntrySound {
  id: string;
  name: string;
  filename: string;
  fileurl: string;
  duration?: number;
  ext?: string;
}

export type EntryAsset = EntryPicture & EntrySound;

export interface EntryEntity {
  x: number;
  y: number;
  regX: number;
  regY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  direction: number;
  width: number;
  height: number;
  font: string;
  visible: boolean;
  // Text boxes only.
  colour?: string;
  text?: string;
  textAlign?: number;
  lineBreak?: boolean;
  bgColor?: string;
  underLine?: boolean;
  strike?: boolean;
  fontSize?: number;
}

export interface EntryObject {
  id: string;
  name: string;
  script: string;
  objectType: 'sprite' | 'textBox';
  rotateMethod: string;
  scene: string;
  sprite: { pictures: EntryPicture[]; sounds: EntrySound[] };
  lock: boolean;
  entity: EntryEntity;
  text?: string;
  selectedPictureId?: string | null;
}

export interface EntryProject {
  objects: EntryObject[];
  scenes: EntryScene[];
  variables: EntryVariable[];
  messages: EntryMessage[];
  functions: EntryFunction[];
  tables: EntryTable[];
  speed: number;
  interface: { menuWidth: number; canvasWidth: number; object: string | null };
  expansionBlocks: string[];
  aiUtilizeBlocks: string[];
  hardwareLiteBlocks: unknown[];
  externalModules: unknown[];
  externalModulesLite: unknown[];
  name: string;
  isPracticalCourse: boolean;
  description?: string;
}

export type CompileDiagnostic = Diagnostic;

export interface SourceSpan {
  file: string | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export type SourceMap = Record<string, SourceSpan>;

export interface AssetFile {
  source: string;
  target: string;
}

export interface PhaseTiming {
  label: string;
  ms: number;
}

export interface CompiledObject {
  id: string;
  key: string;
  name: string;
  kind: string;
  scene: EntryScene;
  node: ObjectNode;
  pictures: Map<string, EntryPicture>;
  sounds: Map<string, EntrySound>;
  locals: Map<string, EntryVariable>;
  defaultPicture: EntryPicture | null;
  properties: Map<string, Expr>;
  boxSize: { width: number; height: number } | null;
  center: { x: number; y: number } | null;
  script: EntryBlock[][];
}

export interface CompiledFunction {
  id: string;
  name: string;
  // Generated declarations have no source node.
  node?: FunctionDeclNode;
  owner?: string | null;
  params: string[];
  booleanParams?: Set<string>;
  paramTypes: Map<string, string>;
  isValue: boolean;
  localVariables: FuncLocalVariable[];
  generated?: boolean;
  type?: string;
  content?: EntryBlock[][];
}

export type VariableRef =
  | { kind: 'param'; name: string }
  | { kind: 'funcLocal'; name: string; id: string }
  | { kind: 'variable'; entry: EntryVariable; owner?: CompiledObject }
  | { kind: 'ambiguousLocal'; name: string; owners: string[] };

export type ResourceRef =
  | { kind: 'found'; asset: EntryPicture | EntrySound }
  | { kind: 'ambiguous'; owners: string[] };

export interface FunctionScope {
  id: string;
  name: string;
  params: Map<string, string>;
  // Include locals allocated by nested blocks, keyed by ID.
  localVars: Map<string, { id: string; displayName: string; value?: string | number }>;
  bindings: Map<string, { id: string; displayName: string; value?: string | number }>;
  declarations: Map<VarDeclNode, { id: string; displayName: string; value: string | number }>;
  returnId?: string;
}

export interface CompileOptions {
  path?: string;
  assetDirs?: string[];
  name?: string;
  readFile?: (file: string) => string;
  // Strict mode rejects errors and promotes notices; loose mode keeps valid statements.
  strict?: boolean;
  cache?: CompileCache;
  seed?: string;
  sources?: Map<string, string> | null;
  comments?: Map<string, string>;
  onPhase?: (phase: PhaseTiming) => void;
  // No file access is available unless a host is supplied.
  host?: CompilerHost;
}

export interface CompileCache {
  asts: Map<string, { text: string; ast: ParseRoot }>;
  reused: number;
  parsed: number;
}

export interface CompileResult {
  ok: boolean;
  project: EntryProject | null;
  errors: CompileDiagnostic[];
  warnings: CompileDiagnostic[];
  // Runtime-resolved names become warnings in strict mode.
  notices: CompileDiagnostic[];
  assets: AssetFile[];
  sourceMap?: SourceMap;
  timings: PhaseTiming[];
}
