import { imageSize } from '../../compiler/src/assets.ts';
import { append, safeIdentifier, entropyString, entropyNumber, entropyLiteral, entropyComment, displayNamePart } from './ident.ts';
import {
  autoParamName, KEY_CODES, parseEntryBlockData, STORE_PREFIX, STORE_SAVE_ASYNC_FUNCTION,
  STORE_SAVE_FUNCTION, tableRowCells, tableRows,
} from '@entropy/core';
import { blocksToLines, commentLines, indent, functionDeclarationLines, colorExpr } from './stmt.ts';
import type {
  DecompileContext, DecompileOptions, DecompileResult,
  FunctionField, FunctionLocal, RawBlock, RawEntity,
  ResourceInfo, TableInfo, TarEntry, VarInfo,
} from './types.ts';

const REVERSE_KEY_NAME: Record<string, string> = {};
for (const [name, code] of Object.entries(KEY_CODES)) {
  if (!(String(code) in REVERSE_KEY_NAME)) REVERSE_KEY_NAME[String(code)] = name;
}

// Preserve unnamed key codes as numbers so key scripts survive decompilation.
function keyName(code: unknown): string | null {
  const text = String(code ?? '').trim();
  return REVERSE_KEY_NAME[text] ?? (/^[0-9]{1,3}$/.test(text) ? text : null);
}

// The blank 1x1 image takes its actual size from project.json dimensions.
const BLANK_IMAGE = /(?:^|\/)images\/_1x1\.png$/;

// Entry's saved PNG preserves framing that its recentered SVG may lose.
function capturedPngFor(fileurl: string | undefined, entriesByPath: Map<string, Uint8Array>): string | null {
  if (!fileurl || !/\.svg$/i.test(fileurl)) return null;
  const png = `${fileurl.slice(0, -4)}.png`;
  return entriesByPath.has(png) ? png : null;
}

// Prefer SVG only when its size, canvas bounds, and content preserve the saved drawing.
function vectorIsBetter(
  svg: Uint8Array | undefined,
  dimension: { width?: number; height?: number } | undefined,
): boolean {
  const size = svgSize(svg);
  if (!size || !svg) return false;
  if (size.width > PAINT_CANVAS.width || size.height > PAINT_CANVAS.height) return false;
  // Allow one pixel of difference for rounding during save.
  if (!(Math.abs(size.width - (dimension?.width ?? NaN)) <= SIZE_SLACK)) return false;
  if (!(Math.abs(size.height - (dimension?.height ?? NaN)) <= SIZE_SLACK)) return false;
  // Scan the whole SVG because embedded raster images can appear far beyond its header.
  return !hasTag(svg, "image") && !hasTag(svg, "text");
}

// Match tag boundaries so textPath does not count as text.
function hasTag(bytes: Uint8Array, name: string): boolean {
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  for (let at = 0; at < bytes.length; at += 1) {
    if (bytes[at] !== 0x3c) continue;
    let match = true;
    for (let i = 0; i < lower.length; i += 1) {
      const byte = bytes[at + 1 + i];
      if (byte !== lower.charCodeAt(i) && byte !== upper.charCodeAt(i)) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const after = bytes[at + 1 + lower.length];
    if (after === undefined) continue;
    if (after === 0x3e || after <= 0x20) return true;
  }
  return false;
}

const PAINT_CANVAS = { width: 960, height: 540 };
// Allow this size difference when comparing vectors with saved dimensions.
const SIZE_SLACK = 1;

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

function headText(bytes: Uint8Array, limit: number): string {
  return decoder.decode(bytes.subarray(0, limit));
}

function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

function extnameOf(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function svgSize(svg: Uint8Array | undefined): { width: number; height: number } | null {
  if (!svg) return null;
  const head = headText(svg, 2048);
  const width = /\swidth\s*=\s*["']([\d.]+)/.exec(head);
  const height = /\sheight\s*=\s*["']([\d.]+)/.exec(head);
  if (width && height) return { width: Number(width[1]), height: Number(height[1]) };
  const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(head);
  return box ? { width: Number(box[1]), height: Number(box[2]) } : null;
}

function mapOf(
  outer: Map<string, Map<string, string>>,
  functionId: string,
): Map<string, string> {
  let inner = outer.get(functionId);
  if (!inner) {
    inner = new Map();
    outer.set(functionId, inner);
  }
  return inner;
}

function declaresLocal(ctx: DecompileContext, id: string): boolean {
  for (const locals of ctx.funcLocalsById.values()) {
    if (locals.has(id)) return true;
  }
  return false;
}

export function decompileProject(
  project: RawEntity,
  entries: TarEntry[],
  options: DecompileOptions = {},
): DecompileResult {
  try {
    return decompileProjectUnchecked(project, entries, options);
  } catch (error) {
    if (error instanceof RangeError && /call stack/i.test(error.message)) {
      throw new Error(
        'Entry 블록 구조가 너무 깊게 중첩되어 안전하게 .etp로 되돌릴 수 없습니다. '
        + '중첩된 값·조건·제어 블록을 함수나 여러 스크립트로 나눈 뒤 다시 시도하세요.',
      );
    }
    throw error;
  }
}

function decompileProjectUnchecked(
  project: RawEntity,
  entries: TarEntry[],
  options: DecompileOptions,
): DecompileResult {
  const ctx = buildContext(project, entries, options);

  const lines: string[] = [];
  for (const varInfo of ctx.globalVars) append(lines, declarationLine(varInfo, 0, ctx.positions));
  if (ctx.globalVars.length) lines.push('', '');

  const withRows = options.tableRows !== false;
  const heldRows: string[][][] = [];
  for (const [, info] of ctx.tablesById) {
    append(lines, tableLines(info, withRows));
    lines.push('');
    if (!withRows) heldRows.push(tableRows(info.source).map((row) => row.map((cell) => String(cell ?? ''))));
  }

  lines.push('project:');
  lines.push(`  title ${entropyString(project.name ?? 'Entropy 작품')}`);
  if (project.description) lines.push(`  description ${entropyString(project.description)}`);
  lines.push(`  fps ${entropyNumber(project.speed ?? 60)}`);
  lines.push('end');
  lines.push('');

  for (const scene of project.scenes) append(lines, sceneLines(scene, project, ctx));

  for (const fn of project.functions ?? []) {
    const entry = ctx.functionsById.get(fn.id);
    if (!entry) continue;
    if (ctx.functionOwnerById.has(fn.id)) continue;
    // Save manager stubs become save statements and need no declarations.
    if (entry.saveKind) continue;
    try {
      const content = parseEntryBlockData<RawBlock>(fn.content ?? []);
      const createBlock = functionCreateBlock(content);
      if (!createBlock) continue;
      append(lines, functionDeclarationLines(entry, createBlock, ctx));
      lines.push('');
    } catch (error) {
      ctx.warnings.add(`함수 '${entry.name}' 을(를) 읽지 못했습니다: ${(error as Error).message}`);
    }
  }


  const strict = options.strict === true;
  return {
    source: `${lines.join('\n').trimEnd()}\n`,
    warnings: strict ? [...ctx.warnings, ...ctx.notices] : [...ctx.warnings],
    notices: strict ? [] : [...ctx.notices],
    assets: ctx.collectedAssets,
    name: project.name ?? 'project',
    ...(withRows ? {} : { tableRows: heldRows }),
  };
}

// Restore omitted table rows in their original order.
export function restoreTableRows(project: { tables?: Array<{ data?: unknown }> }, rows: string[][][] | undefined): void {
  if (!rows) return;
  (project.tables ?? []).forEach((table, index) => {
    if (rows[index]) table.data = rows[index];
  });
}

const ID_HOLDING_BLOCKS = new Set(['text', 'number', 'get_pictures', 'get_sounds']);

function collectHardcodedIds(node: unknown, ctx: DecompileContext) {
  for (const id of resourceIdsIn(node, ctx)) ctx.forcedIds.add(id);
}

function resourceIdsIn(node: unknown, ctx: DecompileContext, found = new Set<string>()): Set<string> {
  const pending = [node];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const block = value as RawBlock;
    if (block.type !== undefined && ID_HOLDING_BLOCKS.has(block.type) && typeof block.params?.[0] === 'string') {
      const raw = block.params[0];
      if (ctx.picturesById.has(raw) || ctx.soundsById.has(raw)) found.add(raw);
    }
    pending.push(...(block.params ?? []), ...(block.statements ?? []));
  }
  return found;
}

interface VariableIds {
  variables: Set<string>;
  lists: Set<string>;
}

// Match Entry's VARIABLE and LIST parameter positions.
const VARIABLE_SLOTS = new Map([
  ['get_variable', 0], ['set_variable', 0], ['change_variable', 0],
  ['show_variable', 0], ['hide_variable', 0],
]);
const LIST_SLOTS = new Map([
  ['show_list', 0], ['hide_list', 0], ['change_value_list_index', 0],
  ['value_of_index_from_list', 1], ['length_of_list', 1], ['is_included_in_list', 1],
  ['add_value_to_list', 1], ['remove_value_from_list', 1], ['insert_value_to_list', 1],
]);

function variableIdsIn(
  node: unknown,
  found: VariableIds = { variables: new Set(), lists: new Set() },
): VariableIds {
  const pending = [node];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const block = value as RawBlock;
    const buckets: Array<[Map<string, number>, Set<string>]> = [
      [VARIABLE_SLOTS, found.variables], [LIST_SLOTS, found.lists],
    ];
    for (const [slots, bucket] of buckets) {
      const index = slots.get(block.type ?? '');
      if (index === undefined) continue;
      const id = block.params?.[index];
      if (typeof id === 'string' && id) bucket.add(id);
    }
    pending.push(...(block.params ?? []), ...(block.statements ?? []));
  }
  return found;
}

function touchedVariableNames(content: unknown, ctx: DecompileContext): Set<string> {
  const found = variableIdsIn(content);
  const names = new Set<string>();
  for (const id of [...found.variables, ...found.lists]) {
    const info = ctx.varsById.get(id);
    if (info) names.add(info.identifier);
  }
  return names;
}

// Declare placeholders for deleted variables so their remaining references still compile.
function reviveDanglingVariables(project: RawEntity, ctx: DecompileContext, usedNames: Set<string>) {
  const found: VariableIds = { variables: new Set(), lists: new Set() };
  const scan = (data: unknown) => {
    try { variableIdsIn(parseEntryBlockData<RawBlock>(data ?? []), found); } catch { }
  };
  for (const object of project.objects ?? []) scan(object.script);
  for (const fn of project.functions ?? []) scan(fn.content);

  const kinds: Array<[Set<string>, boolean]> = [[found.variables, false], [found.lists, true]];
  for (const [ids, isList] of kinds) {
    for (const id of ids) {
      if (ctx.varsById.has(id) || declaresLocal(ctx, id)) continue;
      const identifier = safeIdentifier(`_missing_${isList ? 'list' : 'var'}_${id}`, usedNames, 'missing');
      const source = isList ? { name: identifier, array: [] } : { name: identifier, value: 0 };
      const info = { identifier, isList, objectId: null, source };
      ctx.varsById.set(id, info);
      ctx.globalVars.push(info);
      ctx.warnings.add(`변수/리스트 id '${id}' 가 작품에 없어 '${identifier}' 로 새로 선언했습니다.`);
    }
  }
}

// Keep functions global unless every referenced resource belongs to one object.
function soleResourceOwner(content: unknown, ctx: DecompileContext): string | null {
  const owners = new Set<string>();
  for (const id of resourceIdsIn(content, ctx)) {
    const info = (ctx.picturesById.get(id) ?? ctx.soundsById.get(id))!;
    owners.add(info.owner.id);
    if (owners.size > 1) return null;
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

// Find the definition stack and normalize both inline and nested function bodies.
function functionCreateBlock(content: unknown): RawBlock | null {
  for (const thread of (content ?? []) as unknown[]) {
    if (!Array.isArray(thread)) continue;
    const block: RawBlock | null = thread[0] ?? null;
    if (block?.type !== 'function_create' && block?.type !== 'function_create_value') continue;
    if (block.statements?.[0]?.length) return block;
    return thread.length > 1 ? { ...block, statements: [thread.slice(1)] } : block;
  }
  return null;
}

// Function headers chain labels and value or boolean slots through params[1].
function readFunctionFields(create: RawBlock | null): FunctionField[] {
  const fields: FunctionField[] = [];
  let node = create?.params?.[0] as RawBlock | undefined;
  while (node && typeof node === 'object') {
    if (node.type === 'function_field_label') {
      fields.push({ kind: 'label', text: String(node.params?.[0] ?? '') });
    } else if (node.type === 'function_field_string' || node.type === 'function_field_boolean') {
      fields.push({
        kind: 'param',
        blockType: (node.params?.[0] as RawBlock | undefined)?.type ?? null,
        boolean: node.type === 'function_field_boolean',
      });
    } else {
      break;
    }
    node = node.params?.[1] as RawBlock | undefined;
  }
  return fields;
}

function buildContext(
  project: RawEntity,
  entries: TarEntry[],
  options: DecompileOptions = {},
): DecompileContext {
  const usedNames = new Set<string>(); // Share one namespace for variables and functions to prevent collisions.
  const entriesByPath = new Map(entries.map((e) => [e.name, e.data]));

  const ctx: DecompileContext = {
    warnings: new Set(),
    notices: new Set(),
    allSizes: options.sizes === true,
    positions: options.positions === true,
    keepSvg: options.keepSvg === true,
    varsById: new Map(),
    globalVars: [],
    localVarsByObject: new Map(),
    messagesById: new Map(),
    tablesById: new Map(),
    objectsById: new Map(),
    scenesById: new Map(),
    functionsById: new Map(),
    objectScale: null,
    spriteScripts: false,
    scaleById: new Map(),
    picturesById: new Map(),
    soundsById: new Map(),
    collectedAssets: [],
    assetDataByPath: new Map(),
    // Use scene subfolders only when the project has several scenes.
    multiScene: (project.scenes ?? []).length > 1,
    // Mark hardcoded resource IDs with force id so recompilation preserves them.
    forcedIds: new Set(),
    // Move functions into their resource-owning object so resources can be named.
    functionOwnerById: new Map(),
    functionsByOwner: new Map(),
    inFunction: false,
    functionOwnerId: null,
    loopDepth: 0,
    inline: options.inline === true,
    varName(id: string) {
      const info = ctx.varsById.get(id);
      if (info) return info.identifier;
      ctx.warnings.add(`변수/리스트 id '${id}' 를 찾지 못했습니다.`);
      return `_missing_var_${id}`;
    },
    // Only locals declared by the running function exist in Entry's executor.
    funcLocalName(id: string) {
      const name = ctx.funcLocalsById.get(ctx.functionId ?? '')?.get(id);
      if (name !== undefined) return name;
      if (!declaresLocal(ctx, id)) {
        ctx.warnings.add(`함수 지역변수 id '${id}' 를 찾지 못했습니다.`);
      }
      return null;
    },
    funcParamsByBlockType: new Map(),
    functionId: null,
    // Scope parameter lookup to the running function, matching Entry's paramMap.
    funcParamName(blockType: string) {
      return ctx.funcParamsByBlockType.get(ctx.functionId ?? '')?.get(blockType) ?? null;
    },
    pictureName(id: string) {
      const info = ctx.picturesById.get(id);
      if (info) return info.identifier;
      // Entry resolves resource IDs, names, then positions at runtime.
      ctx.notices.add(`모양 id '${id}' 가 작품에 없어 그대로 남겼습니다. 실행할 때 이름으로 찾습니다.`);
      return String(id);
    },
    soundName(id: string) {
      const info = ctx.soundsById.get(id);
      if (info) return info.identifier;
      ctx.notices.add(`소리 id '${id}' 가 작품에 없어 그대로 남겼습니다. 실행할 때 이름으로 찾습니다.`);
      return String(id);
    },
    messageName(id: string) {
      return ctx.messagesById.get(id) ?? String(id);
    },
    tableName(id: string) {
      return ctx.tablesById.get(id)?.identifier ?? String(id);
    },
    funcLocalsById: new Map(),
  };

  for (const message of project.messages ?? []) ctx.messagesById.set(message.id, message.name);

  for (const table of project.tables ?? []) {
    const identifier = safeIdentifier(table.name, usedNames, 'table');
    ctx.tablesById.set(table.id, { identifier, source: table });
  }

  for (const scene of project.scenes ?? []) {
    const identifier = safeIdentifier(scene.name, usedNames, 'scene');
    ctx.scenesById.set(scene.id, { identifier, displayName: scene.name });
  }

  for (const object of project.objects ?? []) {
    const identifier = safeIdentifier(object.name, usedNames, 'object');
    ctx.objectsById.set(object.id, {
      identifier, displayName: object.name, kind: object.objectType, sceneId: object.scene,
    });

    // Resource names are local to each object, so retain the owner when naming asset files.
    const localUsed = new Set<string>();
    for (const picture of object.sprite?.pictures ?? []) {
      const picId = safeIdentifier(picture.name, localUsed, 'costume');
      ctx.picturesById.set(picture.id, { identifier: picId, source: picture, owner: object });
    }
    for (const sound of object.sprite?.sounds ?? []) {
      const sndId = safeIdentifier(sound.name?.replace(/\.[a-z0-9]+$/i, ''), localUsed, 'sound');
      ctx.soundsById.set(sound.id, { identifier: sndId, source: sound, owner: object });
    }
  }

  for (const object of project.objects ?? []) {
    ctx.scaleById.set(String(object.id), savedScale(object));
  }

  for (const entry of project.variables ?? []) {
    if (entry.variableType === 'timer' || entry.variableType === 'answer') continue;
    const isList = entry.variableType === 'list';
    // Store restores the @ prefix when recompiling the stripped Entropy name.
    const store = !entry.object && String(entry.name ?? '').startsWith(STORE_PREFIX);
    const label = store ? String(entry.name).slice(STORE_PREFIX.length) : entry.name;
    const identifier = safeIdentifier(label, usedNames, isList ? 'list' : 'var');
    // Preserve locals from deleted objects as globals rather than dropping them.
    const owned = entry.object && ctx.objectsById.has(entry.object);
    if (entry.object && !owned) {
      ctx.warnings.add(`'${entry.name}' 은(는) 작품에 없는 오브젝트의 지역 변수라 전역으로 옮겼습니다.`);
    }
    const info = { identifier, isList, objectId: owned ? entry.object : null, source: entry, store };
    ctx.varsById.set(entry.id, info);
    if (owned) {
      if (!ctx.localVarsByObject.has(entry.object)) ctx.localVarsByObject.set(entry.object, []);
      ctx.localVarsByObject.get(entry.object)!.push(info);
    } else {
      ctx.globalVars.push(info);
    }
  }

  for (const fn of project.functions ?? []) {
    let fields: FunctionField[] = [];
    let content: unknown = [];
    try {
      content = parseEntryBlockData<RawBlock>(fn.content ?? []);
      fields = readFunctionFields(functionCreateBlock(content));
    } catch { /* Fall back to the function ID if its header cannot be read. */ }

    // Only the first label becomes the function name.
    const first = fields[0];
    const label = first?.kind === 'label' ? first.text : fn.id;
    const identifier = safeIdentifier(label, usedNames, 'func');

    const params: string[] = [];
    // Reserve referenced variable names so parameters cannot silently hide ID-based reads.
    const paramNames = touchedVariableNames(content, ctx);
    fields.forEach((field, index) => {
      if (field.kind !== 'param') return;
      const previous = index > 0 ? fields[index - 1] : null;
      const name = previous?.kind === 'label' && index > 1
        ? safeIdentifier(previous.text, paramNames, 'p')
        : safeIdentifier(autoParamName(params.length), paramNames, 'p');
      // Keep the ? suffix so boolean parameters compile back to boolean slots.
      params.push(field.boolean ? `${name}?` : name);
      if (field.blockType) {
        mapOf(ctx.funcParamsByBlockType, String(fn.id)).set(field.blockType, name);
      }
    });

    // Function locals must not hide parameters or variables used by the body.
    const localUsed = new Set(paramNames);
    for (const info of ctx.globalVars) localUsed.add(info.identifier);
    const locals: FunctionLocal[] = [];
    for (const local of (fn.localVariables ?? []) as RawEntity[]) {
      const name = safeIdentifier(local.name, localUsed, 'local');
      mapOf(ctx.funcLocalsById, String(fn.id)).set(local.id, name);
      locals.push({ name, entryName: String(local.name ?? ''), value: local.value });
    }

    // The save manager intercepts calls to this named function.
    const saveKind = label === STORE_SAVE_FUNCTION
      ? 'save'
      : label === STORE_SAVE_ASYNC_FUNCTION ? 'async' : undefined;
    ctx.functionsById.set(fn.id, {
      id: String(fn.id), name: identifier, params, locals, displayLabel: label, saveKind,
    });
  }

  reviveDanglingVariables(project, ctx, usedNames);

  // Keep global resource IDs; functions owned by one object can use resource names instead.
  for (const fn of project.functions ?? []) {
    let content = null;
    try { content = parseEntryBlockData<RawBlock>(fn.content ?? []); } catch { }
    if (!content) continue;

    const ownerId = soleResourceOwner(content, ctx);
    const entry = ctx.functionsById.get(fn.id);
    const createBlock = functionCreateBlock(content);
    if (ownerId && entry && createBlock) {
      ctx.functionOwnerById.set(fn.id, ownerId);
      if (!ctx.functionsByOwner.has(ownerId)) ctx.functionsByOwner.set(ownerId, []);
      ctx.functionsByOwner.get(ownerId)!.push({ id: fn.id, entry, createBlock });
      continue;
    }
    collectHardcodedIds(content, ctx);
  }

  // Include object and scene names in asset paths to avoid collisions between resources.
  const assetTargets = new Map<string, string | null>();
  const usedAssetPaths = new Set<string>();
  const nextAssetSuffix = new Map<string, number>();

  // Asset extensions come from project data; allow only letters and digits to prevent path escapes.
  const safeExt = (value: unknown, fallback: string): string => {
    const cleaned = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
    return cleaned ? `.${cleaned}` : fallback;
  };

  const uniqueAssetPath = (dir: string, name: string, ext: string) => {
    const base = `${dir}/${name}`;
    let candidate = `${base}${ext}`;
    let suffix = nextAssetSuffix.get(candidate) ?? 2;
    while (usedAssetPaths.has(candidate)) candidate = `${base}_${suffix++}${ext}`;
    nextAssetSuffix.set(`${base}${ext}`, suffix);
    usedAssetPaths.add(candidate);
    return candidate;
  };

  const registerAsset = (
    info: ResourceInfo,
    kind: string,
    ext: string,
    fileurl: string | undefined = info.source.fileurl,
  ): string | null => {
    if (!fileurl) return null;
    if (assetTargets.has(fileurl)) return assetTargets.get(fileurl)!;
    const data = entriesByPath.get(fileurl) ?? options.builtinAssets?.(fileurl) ?? null;
    if (!data) return null;

    const scene = ctx.scenesById.get(info.owner?.scene);
    const dir = ctx.multiScene && scene ? `assets/${kind}/${scene.identifier}` : `assets/${kind}`;
    const owner = ctx.objectsById.get(info.owner?.id);
    const name = owner ? `${owner.identifier}_${info.identifier}` : info.identifier;

    const relative = uniqueAssetPath(dir, name, ext);
    assetTargets.set(fileurl, relative);
    ctx.collectedAssets.push({ path: relative, data });
    ctx.assetDataByPath.set(relative, data);
    return relative;
  };

  for (const [, info] of ctx.picturesById) {
    const pic = info.source;
    const png = capturedPngFor(pic.fileurl, entriesByPath);
    // Keep both formats when the vector preserves framing; otherwise keep the saved raster.
    const vector =
      ctx.keepSvg ||
      (pic.imageType === 'svg' &&
        vectorIsBetter(entriesByPath.get(pic.fileurl ?? ''), pic.dimension));
    const useRaster = png !== null && !vector;
    const ext = useRaster
      ? '.png'
      : safeExt(pic.imageType || extnameOf(pic.fileurl || '').slice(1), '.png');
    info.relativePath = registerAsset(info, 'image', ext, useRaster ? png : pic.fileurl);
    // Keep only SVG when explicitly requested; otherwise include its raster copy too.
    if (!useRaster && !ctx.keepSvg && png && info.relativePath?.endsWith('.svg')) {
      const twin = `${info.relativePath.slice(0, -4)}.png`;
      const data = entriesByPath.get(png);
      if (data && !usedAssetPaths.has(twin)) {
        usedAssetPaths.add(twin);
        ctx.collectedAssets.push({ path: twin, data });
        ctx.assetDataByPath.set(twin, data);
      }
    }
    info.blankImage = BLANK_IMAGE.test(pic.fileurl ?? '');
  }
  for (const [, info] of ctx.soundsById) {
    const snd = info.source;
    const ext = safeExt(snd.ext || extnameOf(snd.fileurl || '').slice(1), '.mp3');
    info.relativePath = registerAsset(info, 'sound', ext);
  }

  return ctx;
}

// Convert zero-based Entry chart columns to one-based Entropy columns.
function chartLine(chart: RawEntity): string {
  const column = (value: unknown) => Number(value ?? -1) + 1;
  const parts = [`chart ${String(chart.type ?? 'bar')}`];
  if (chart.title) parts.push(entropyString(chart.title));
  if (column(chart.xIndex) > 0) parts.push(`x ${column(chart.xIndex)}`);
  if (column(chart.yIndex) > 0) parts.push(`y ${column(chart.yIndex)}`);
  const series = (chart.categoryIndexes ?? [])
    .map((index: unknown) => column(index))
    .filter((index: number) => index > 0);
  if (series.length) parts.push(`series ${series.join(', ')}`);
  return `  ${parts.join(' ')}`;
}

function tableLines(info: TableInfo, withRows = true): string[] {
  const table = info.source;
  const cells = (row: unknown[]) => row.map((cell) => entropyLiteral(cell)).join(', ');
  const lines = [`table ${info.identifier}${displayNamePart(info.identifier, table.name)}:`];
  lines.push(`  columns ${cells(tableRowCells(table.fields))}`);
  if (withRows) {
    for (const row of tableRows(table)) {
      lines.push(`  row ${cells(row)}`);
    }
  } else {
    lines.push(`  # [decompile] 행 ${tableRows(table).length}개는 소스 밖에서 실행기로 바로 넘깁니다`);
  }
  for (const chart of (table.chart ?? []) as RawEntity[]) {
    lines.push(chartLine(chart));
  }
  lines.push('end');
  return lines;
}

function declarationLine(info: VarInfo, indentLevel = 0, positions = false): string[] {
  const pad = '  '.repeat(indentLevel);
  const source = info.source;
  let scope = '';
  if (info.store) scope = 'store ';
  else if (source.isCloud) scope = 'shared ';
  else if (source.isRealTime) scope = 'realtime ';
  // Check the stripped name because store restores the @ prefix.
  const entryName = info.store ? String(source.name).slice(STORE_PREFIX.length) : source.name;
  const named = displayNamePart(info.identifier, entryName);
  const shown = source.visible ? ' visible' : '';
  const at = positions
    ? ` at ${entropyNumber(Number(source.x) || 0)} ${entropyNumber(Number(source.y) || 0)}`
    : '';
  if (info.isList) {
    const items = (source.array ?? []).map((item: { data: unknown }) => entropyLiteral(item.data));
    // Preserve resized boxes and omit the default 100 by 120 size.
    const width = Number(source.width ?? 100);
    const height = Number(source.height ?? 120);
    const size = width !== 100 || height !== 120 ? ` size ${entropyNumber(width)} ${entropyNumber(height)}` : '';
    return [`${pad}${scope}list ${info.identifier}${named} = [${items.join(', ')}]${shown}${at}${size}`];
  }
  const range = source.variableType === 'slide'
    ? ` from ${entropyNumber(Number(source.minValue) || 0)} to ${entropyNumber(Number(source.maxValue) || 0)}`
    : '';
  return [`${pad}${scope}var ${info.identifier}${named} = ${entropyLiteral(source.value)}${range}${shown}${at}`];
}

function sceneLines(scene: RawEntity, project: RawEntity, ctx: DecompileContext): string[] {
  const info = ctx.scenesById.get(scene.id)!;
  const lines = [`scene ${entropyString(info.identifier)}:`];
  if (info.identifier !== info.displayName) lines.push(`  name ${entropyString(info.displayName)}`);

  for (const object of project.objects ?? []) {
    if (object.scene !== scene.id) continue;
    append(lines, useObjectLine(object, ctx, info.identifier));
  }
  lines.push('end');
  lines.push('');
  return lines;
}

// Write editable object fragments without wrappers; useobject supplies the wrapper.
function useObjectLine(object: RawEntity, ctx: DecompileContext, sceneIdentifier: string): string[] {
  const info = ctx.objectsById.get(object.id)!;
  const isText = object.objectType === 'textBox';
  const fragment = objectFragmentLines(object, ctx, isText);
  // Inline output has no fragment files, so write each object inside its scene.
  if (ctx.inline) {
    const head = `  ${isText ? 'text' : 'object'} ${entropyString(info.identifier)}:`;
    return [head, ...indent(indent(fragment)), '  end'];
  }
  const dir = ctx.multiScene ? `objects/${sceneIdentifier}` : 'objects';
  const relativePath = `${dir}/${info.identifier}.etp`;
  const data = encodeText(`${fragment.join('\n').trimEnd()}\n`);
  ctx.collectedAssets.push({ path: relativePath, data });
  ctx.assetDataByPath.set(relativePath, data);
  return [`  ${isText ? 'usetext' : 'useobject'} ${entropyString(relativePath)}`];
}

function sameSize(ctx: DecompileContext, path: string, dimension: { width?: number; height?: number } | undefined): boolean {
  const data = ctx.assetDataByPath.get(path);
  const size = data ? imageSize(data) : null;
  return !!size && !!dimension && size.width === dimension.width && size.height === dimension.height;
}

function objectFragmentLines(object: RawEntity, ctx: DecompileContext, isText: boolean): string[] {
  const info = ctx.objectsById.get(object.id)!;
  const lines: string[] = [];

  if (info.identifier !== info.displayName) lines.push(`name ${entropyString(info.displayName)}`);

  for (const picture of object.sprite?.pictures ?? []) {
    const picInfo = ctx.picturesById.get(picture.id);
    if (!picInfo) continue;
    const isDefault = object.selectedPictureId === picture.id;
    // Write size when the file cannot reproduce the project's saved dimensions.
    const measurable = picInfo.relativePath && !picInfo.blankImage && !ctx.allSizes &&
      sameSize(ctx, picInfo.relativePath, picture.dimension);
    const sizePart = measurable
      ? ''
      : ` size ${entropyNumber(picture.dimension?.width ?? 100)} ${entropyNumber(picture.dimension?.height ?? 100)}`;
    const filePart = picInfo.relativePath ?? (picture.fileurl ?? `${picInfo.identifier}.png`);
    const namePart = displayNamePart(picInfo.identifier, picture.name);
    const forcePart = ctx.forcedIds.has(picture.id) ? ` force id ${entropyString(picture.id)}` : '';
    lines.push(`${isDefault ? 'default costume' : 'costume'} ${picInfo.identifier} ${entropyString(filePart)}${sizePart}${namePart}${forcePart}`);
  }
  for (const sound of object.sprite?.sounds ?? []) {
    const sndInfo = ctx.soundsById.get(sound.id);
    if (!sndInfo) continue;
    // Preserve Entry's sound duration because it controls loading and play-and-wait timing.
    const durationPart = ` for ${entropyNumber(Number.isFinite(sound.duration) ? sound.duration : 1)}`;
    const filePart = sndInfo.relativePath ?? (sound.fileurl ?? `${sndInfo.identifier}.mp3`);
    const namePart = displayNamePart(sndInfo.identifier, sound.name);
    const forcePart = ctx.forcedIds.has(sound.id) ? ` force id ${entropyString(sound.id)}` : '';
    lines.push(`sound ${sndInfo.identifier} ${entropyString(filePart)}${durationPart}${namePart}${forcePart}`);
  }

  append(lines, objectPropertyLines(object, isText, 0));

  if (object.rotateMethod && object.rotateMethod !== 'free') {
    lines.push(`rotation ${object.rotateMethod}`);
  }
  if (object.lock) lines.push('lock true');
  if (object.entity?.visible === false) lines.push('visible false');

  for (const varInfo of ctx.localVarsByObject.get(object.id) ?? []) {
    append(lines, declarationLine(varInfo, 0, ctx.positions));
  }
  if (lines.length) lines.push('', '');

  let threads: RawBlock[][] = [];
  try {
    threads = parseEntryBlockData<RawBlock>(object.script ?? []);
  } catch (error) {
    ctx.warnings.add(`오브젝트 '${info.displayName}' 의 스크립트를 읽지 못했습니다: ${(error as Error).message}`);
  }
  // Legacy size blocks use the object's saved scale.
  ctx.objectScale = ctx.scaleById.get(String(object.id)) ?? savedScale(object);
  ctx.spriteScripts = !isText;
  for (const thread of threads) append(lines, eventLines(thread, ctx, 0));
  ctx.spriteScripts = false;

  // Keep object-owned functions with their resources so force id is unnecessary.
  for (const owned of ctx.functionsByOwner.get(object.id) ?? []) {
    lines.push('');
    append(lines, functionDeclarationLines(owned.entry, owned.createBlock, ctx, object.id));
  }
  ctx.objectScale = null;

  return lines;
}

function savedScale(object: RawEntity): { x: number; y: number } {
  const entity = (object.entity ?? {}) as { scaleX?: unknown; scaleY?: unknown };
  const percent = (value: unknown) => {
    const scale = Number(value);
    return Number.isFinite(scale) ? scale * 100 : 100;
  };
  return { x: percent(entity.scaleX), y: percent(entity.scaleY) };
}

// Preserve moved registration points because they change the object's stage position.
function centerLine(object: RawEntity, pad: string): string[] {
  const entity = object.entity ?? {};
  if (!Number.isFinite(entity.regX) || !Number.isFinite(entity.regY)) return [];

  const pictures = (object.sprite?.pictures ?? []) as RawEntity[];
  const picture = pictures.find((p) => p.id === object.selectedPictureId) ?? pictures[0];
  const width = picture?.dimension?.width ?? 100;
  const height = picture?.dimension?.height ?? 100;
  if (entity.regX === width / 2 && entity.regY === height / 2) return [];

  return [`${pad}center ${entropyNumber(entity.regX)} ${entropyNumber(entity.regY)}`];
}

// Round percentages only when dividing by 100 restores the exact saved scale.
function scalePercent(ratio: number): number {
  const exact = ratio * 100;
  for (let digits = 0; digits <= 6; digits += 1) {
    const candidate = Number(exact.toFixed(digits));
    if (candidate / 100 === ratio) return candidate;
  }
  return Number(exact.toPrecision(12));
}

function objectPropertyLines(object: RawEntity, isText: boolean, indentLevel: number): string[] {
  const pad = '  '.repeat(indentLevel);
  const lines: string[] = [];
  const entity = object.entity ?? {};
  if (entity.x) lines.push(`${pad}x = ${entropyNumber(entity.x)}`);
  if (entity.y) lines.push(`${pad}y = ${entropyNumber(entity.y)}`);
  if (entity.rotation) lines.push(`${pad}angle = ${entropyNumber(entity.rotation)}`);
  if (entity.direction !== undefined && entity.direction !== 90) lines.push(`${pad}way = ${entropyNumber(entity.direction)}`);
  if (entity.scaleX !== undefined && entity.scaleX !== 1) lines.push(`${pad}scale_x = ${entropyNumber(scalePercent(entity.scaleX))}`);
  if (entity.scaleY !== undefined && entity.scaleY !== 1) lines.push(`${pad}scale_y = ${entropyNumber(scalePercent(entity.scaleY))}`);
  if (!isText) append(lines, centerLine(object, pad));

  if (isText) {
    if (object.text) lines.push(`${pad}text_content = ${entropyString(object.text)}`);
    const font = parseFont(entity.font);
    // If Entry could not read fontSize, recover the canvas fallback from the font string.
    const fontSize = entity.fontSize || font.size;
    if (fontSize) lines.push(`${pad}font_size = ${entropyNumber(fontSize)}`);
    // Preserve saved text bounds because estimating from character count loses wrapping.
    if (Number.isFinite(entity.width) && Number.isFinite(entity.height)) {
      lines.push(`${pad}size ${entropyNumber(entity.width)} ${entropyNumber(entity.height)}`);
    }

    if (font.family && font.family !== 'Nanum Gothic') lines.push(`${pad}font = ${entropyString(font.family)}`);
    if (font.bold) lines.push(`${pad}text_bold = true`);
    if (font.italic) lines.push(`${pad}text_italic = true`);
    if (entity.colour && entity.colour !== '#000000') lines.push(`${pad}font_color = ${colorExpr(entity.colour)}`);
    if (entity.bgColor && entity.bgColor !== '#ffffff') lines.push(`${pad}bg_color = ${colorExpr(entity.bgColor)}`);
    if (entity.underLine) lines.push(`${pad}text_underline = true`);
    if (entity.strike) lines.push(`${pad}text_strikethrough = true`);
    if (entity.lineBreak) lines.push(`${pad}line_break = true`);
    const aligns: Record<string, string> = { 0: 'center', 1: 'left', 2: 'right' };
    if (entity.textAlign && aligns[entity.textAlign] && entity.textAlign !== 0) {
      lines.push(`${pad}text_align = ${aligns[entity.textAlign]}`);
    }
  }
  return lines;
}

const CANVAS_DEFAULT_FONT = { size: 10, family: 'sans-serif' };

// Preserve the canvas fallback when an invalid font string cannot be rendered.
function parseFont(font: unknown) {
  const tokens = String(font ?? '').trim().split(/\s+/).filter(Boolean);
  let bold = false;
  let italic = false;
  while (tokens[0] === 'bold' || tokens[0] === 'italic') {
    if (tokens.shift() === 'bold') bold = true; else italic = true;
  }
  if (!tokens.length) return { bold, italic, family: '', size: null };
  const size = parseFloat(tokens.shift()!);
  if (Number.isNaN(size)) {
    return { bold: false, italic: false, ...CANVAS_DEFAULT_FONT };
  }
  return { bold, italic, family: tokens.join(' '), size };
}

function keepOnly(set: Set<string>, before: Set<string>): void {
  for (const item of [...set]) {
    if (!before.has(item)) set.delete(item);
  }
}

function eventLines(thread: RawBlock[] | undefined, ctx: DecompileContext, indentLevel: number): string[] {
  if (!thread?.length) return [];
  const [hat, ...rest] = thread;
  const pad = '  '.repeat(indentLevel);
  // Indent event bodies one level below their header, including in fragments.
  const indentBody = (lines: string[]) => Array.from({ length: indentLevel + 1 })
    .reduce<string[]>((acc) => indent(acc), lines);

  // Event notes belong to the hat block.
  const note = commentLines(hat).map((line) => `${pad}${line}`);

  const keyUp = matchKeyUpPattern(hat, rest);
  if (keyUp) {
    const body = indentBody(blocksToLines(keyUp.body, ctx));
    return [...note, `${pad}when key ${entropyString(keyUp.key)} up do`, ...body, `${pad}end`, ''];
  }

  const header = eventHeader(hat, ctx);
  if (header) {
    const body = indentBody(blocksToLines(rest, ctx));
    return [...note, `${pad}${header} do`, ...body, `${pad}end`, ''];
  }

  // Detached workspace comments are separate threads; attached notes belong to their block.
  if (hat?.type === 'comment') {
    const text = String((hat as { value?: unknown }).value ?? '').trimEnd();
    if (!text.trim()) return [];
    return [...text.split(/\r?\n/).map((line) => `${pad}# ${line}`.trimEnd()), ''];
  }

  // Keep detached stacks as comments and discard their new notices because Entry never runs them.
  const hadWarnings = new Set(ctx.warnings);
  const hadNotices = new Set(ctx.notices);
  const raw = blocksToLines(thread, ctx);
  keepOnly(ctx.warnings, hadWarnings);
  keepOnly(ctx.notices, hadNotices);
  const commented = raw.map((line: string) => (line.trim() ? `${pad}${entropyComment(line)}` : ''));
  return [
    `${pad}# [decompile] 아래는 엔트리 원본에서 어디에도 연결돼 있지 않던 블록입니다 (실행되지 않음):`,
    ...commented,
    '',
  ];
}

function eventHeader(hat: RawBlock | undefined, ctx: DecompileContext): string | null {
  const p = (hat?.params ?? []) as any[];
  switch (hat?.type) {
    case 'when_run_button_click': return 'when start';
    case 'when_scene_start': return 'when scene start';
    case 'when_object_click': return 'when click';
    case 'when_object_click_canceled': return 'when click up';
    case 'mouse_clicked': return 'when stage click';
    case 'mouse_click_cancled': return 'when stage click up';
    case 'when_clone_start': return 'when cloned';
    case 'when_message_cast': return `when signal ${entropyString(ctx.messageName(p[1]))}`;
    case 'when_some_key_pressed': {
      const name = keyName(p[1]);
      return name ? `when key ${entropyString(name)}` : null;
    }
    default: return null;
  }
}

function matchKeyUpPattern(hat: RawBlock | undefined, rest: RawBlock[]) {
  if (hat?.type !== 'when_run_button_click') return null;
  if (rest.length !== 1 || rest[0]?.type !== 'repeat_inf') return null;
  const body = rest[0]!.statements?.[0] ?? [];
  if (body.length < 2) return null;
  const [first, second, ...tail] = body as RawBlock[];
  if (first?.type !== 'wait_until_true' || second?.type !== 'wait_until_true') return null;
  const pressed = first.params?.[0] as RawBlock | undefined;
  const pressedCode = pressed?.type === 'is_press_some_key' ? pressed.params?.[0] : null;
  const notPressed = second.params?.[0] as RawBlock | undefined;
  const negated = notPressed?.params?.[1] as RawBlock | undefined;
  const releasedCode = notPressed?.type === 'boolean_not' && negated?.type === 'is_press_some_key'
    ? negated.params?.[0]
    : null;
  if (!pressedCode || pressedCode !== releasedCode) return null;
  const key = keyName(pressedCode);
  return key ? { key, body: tail } : null;
}
