export interface RawBlock {
  type?: string;
  params?: any[];
  statements?: RawBlock[][];
  [key: string]: any;
}

export type RawEntity = Record<string, any>;

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

export interface CollectedAsset {
  path: string;
  data: Uint8Array;
}

export interface VarInfo {
  identifier: string;
  isList: boolean;
  objectId: string | null;
  source: RawEntity;
  store?: boolean;
}

export interface ResourceInfo {
  identifier: string;
  source: RawEntity;
  owner: RawEntity;
  relativePath?: string | null;
  blankImage?: boolean;
}

export interface SceneInfo {
  identifier: string;
  displayName: string;
}

export interface ObjectInfo {
  identifier: string;
  displayName: string;
  kind: string;
  sceneId: string;
}

export interface TableInfo {
  identifier: string;
  source: RawEntity;
}

export interface FunctionLocal {
  name: string;
  // Preserve display names with as when they differ from Entropy identifiers.
  entryName: string;
  value: string | number;
}

export interface FunctionInfo {
  // Function IDs scope parameter block types.
  id: string;
  name: string;
  params: string[];
  locals: FunctionLocal[];
  displayLabel: string;
  saveKind?: 'save' | 'async';
}

export type FunctionField =
  | { kind: 'label'; text: string }
  | { kind: 'param'; blockType: string | null; boolean: boolean };

export interface OwnedFunction {
  id: string;
  entry: FunctionInfo;
  createBlock: RawBlock;
}

export interface DecompileOptions {
  sizes?: boolean;
  keepSvg?: boolean;
  // Include saved monitor positions; otherwise Entry lays them out automatically.
  positions?: boolean;
  // Inline objects when the caller has nowhere to write fragment files.
  inline?: boolean;
  // Keep original URLs when no bundled-asset reader is available.
  builtinAssets?(fileurl: string): Uint8Array | null;
  strict?: boolean;
  // Omit large row data from text and restore it with restoreTableRows.
  tableRows?: boolean;
}

export interface DecompileContext {
  warnings: Set<string>;
  // Entry resolves these names at runtime without losing source code.
  notices: Set<string>;
  allSizes: boolean;
  positions: boolean;
  keepSvg: boolean;
  varsById: Map<string, VarInfo>;
  globalVars: VarInfo[];
  localVarsByObject: Map<string, VarInfo[]>;
  messagesById: Map<string, string>;
  tablesById: Map<string, TableInfo>;
  objectsById: Map<string, ObjectInfo>;
  scenesById: Map<string, SceneInfo>;
  functionsById: Map<string, FunctionInfo>;
  picturesById: Map<string, ResourceInfo>;
  soundsById: Map<string, ResourceInfo>;
  collectedAssets: CollectedAsset[];
  multiScene: boolean;
  forcedIds: Set<string>;
  functionOwnerById: Map<string, string>;
  functionsByOwner: Map<string, OwnedFunction[]>;
  inFunction: boolean;
  functionOwnerId: string | null;
  // Legacy size blocks need the object's saved scale, expressed as a percentage.
  objectScale: { x: number; y: number } | null;
  // Drop sprite text-box operations because Entry ignores them.
  spriteScripts: boolean;
  scaleById: Map<string, { x: number; y: number }>;
  loopDepth: number;
  inline: boolean;
  // Scope local IDs per function because merged projects can reuse them across functions.
  funcLocalsById: Map<string, Map<string, string>>;
  // Scope parameter block types per function for the same reason.
  funcParamsByBlockType: Map<string, Map<string, string>>;
  functionId: string | null;
  varName(id: string): string;
  funcLocalName(id: string): string | null;
  funcParamName(blockType: string): string | null;
  pictureName(id: string): string;
  soundName(id: string): string;
  messageName(id: string): string;
  tableName(id: string): string;
}

export interface DecompileResult {
  source: string;
  warnings: string[];
  // Strict mode merges these notices into warnings.
  notices: string[];
  assets: CollectedAsset[];
  name: string;
  // Omitted rows follow table order in the source.
  tableRows?: string[][][];
}
