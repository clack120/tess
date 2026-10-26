import { parseEntryBlockData } from '@entropy/core';
import type { RawBlock, RawEntity, TarEntry } from './types.ts';

export interface ProjectDifference {
  kind: 'data' | 'metadata' | 'code' | 'layout' | 'asset';
  path: string;
  before: string;
  after: string;
}

export interface ProjectAudit {
  counts: Record<ProjectDifference['kind'], number>;
  differences: ProjectDifference[];
  truncated: boolean;
  checkedAssets: number;
  unavailableAssets: number;
  excluded: string[];
}

export interface ProjectAuditOptions {
  beforeAssets?: TarEntry[];
  afterAssets?: TarEntry[];
  maxDifferences?: number;
}

const DEFAULT_BLOCK_FIELDS: Record<string, unknown> = {
  movable: null, deletable: 1, emphasized: false, readOnly: null,
  copyable: true, assemble: true,
};

const REFERENCE_SLOTS: Record<string, number[]> = {
  get_variable: [0], set_variable: [0], change_variable: [0], show_variable: [0], hide_variable: [0],
  get_func_variable: [0], set_func_variable: [0],
  show_list: [0], hide_list: [0], change_value_list_index: [0],
  value_of_index_from_list: [1], length_of_list: [1], is_included_in_list: [1],
  add_value_to_list: [1], remove_value_from_list: [1], insert_value_to_list: [1],
  message_cast: [0], message_cast_wait: [0], when_message_cast: [1], start_scene: [0],
  get_pictures: [0], get_sounds: [0], get_sound_duration: [1],
  create_clone: [0], locate: [0], see_angle_object: [0], text_read: [0],
  coordinate_object: [1], reach_something: [1], distance_something: [1], get_block_count: [0],
  get_table_count: [0], get_value_from_table: [0], get_value_from_cell: [0],
  get_value_from_last_row: [0], calc_values_from_table: [0], get_coefficient: [0], get_value_v_lookup: [0],
  append_row_to_table: [0], insert_row_to_table: [0], delete_row_from_table: [0],
  set_value_from_table: [0], set_value_from_cell: [0], save_current_table: [0],
  open_table: [0], open_table_wait: [0], open_table_chart: [0],
};

function named(items: RawEntity[], name: (item: RawEntity) => string) {
  const seen = new Map<string, number>();
  return items.map(item => {
    const label = name(item);
    const occurrence = (seen.get(label) ?? 0) + 1;
    seen.set(label, occurrence);
    return { item, label: `${label} (${occurrence})`, key: JSON.stringify([label, occurrence]) };
  });
}

function functionBlocks(fn: RawEntity): RawBlock[][] {
  try { return parseEntryBlockData<RawBlock>(fn.content ?? []); }
  catch { return []; }
}

function functionLabel(blocks: RawBlock[][], fallback: string): string {
  const create = blocks.find(thread => thread[0]?.type?.startsWith('function_create'))?.[0];
  const field = create?.params?.[0];
  return field?.type === 'function_field_label' ? String(field.params?.[0] ?? '') : fallback;
}

function omit(value: RawEntity, keys: string[]): RawEntity {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

// Only typed reference slots are renamed; identical strings in user data stay literal.
function code(data: unknown, refs: Map<string, string>): unknown {
  let parsed: unknown;
  try { parsed = parseEntryBlockData(data); } catch { return data; }
  const holder: RawEntity = {};
  const pending = [{ value: parsed, target: holder, key: 'value' }];
  while (pending.length) {
    const { value, target, key } = pending.pop()!;
    if (!value || typeof value !== 'object') { target[key] = value; continue; }
    const copy: RawEntity = Array.isArray(value) ? [] : Object.create(null);
    target[key] = copy;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) pending.push({ value: value[i], target: copy, key: String(i) });
      continue;
    }
    const block = value as RawBlock;
    for (const [field, original] of Object.entries(block)) {
      if (field === 'id' || (block.type && (field === 'x' || field === 'y'))) continue;
      if (block.type && Object.hasOwn(DEFAULT_BLOCK_FIELDS, field) && original === DEFAULT_BLOCK_FIELDS[field]) continue;
      if (block.type && ['params', 'statements', 'extensions'].includes(field) && Array.isArray(original) && !original.length) continue;
      let child = original;
      if (field === 'type' && typeof child === 'string') {
        child = child.startsWith('func_') ? `func:${refs.get(child.slice(5)) ?? child.slice(5)}` : refs.get(child) ?? child;
        if (child === 'text' || child === 'number') child = 'literal';
      }
      if (field === 'params' && Array.isArray(child)) {
        const slots = Object.hasOwn(REFERENCE_SLOTS, block.type ?? '') ? REFERENCE_SLOTS[block.type!] : undefined;
        child = child.map((param, index) => typeof param === 'string' && slots?.includes(index)
          ? refs.get(param) ?? param : param);
      }
      pending.push({ value: child, target: copy, key: field });
    }
  }
  return holder.value;
}

function snapshot(project: RawEntity) {
  const refs = new Map<string, string>();
  const index = (items: RawEntity[], kind: string, name: (item: RawEntity) => string) => {
    const list = named(items, name);
    for (const { item, label } of list) refs.set(item.id, `${kind}:${label}`);
    return list;
  };
  const scenes = index(project.scenes ?? [], 'scene', item => String(item.name));
  const objects = index(project.objects ?? [], 'object', item => `${refs.get(item.scene) ?? item.scene}/${item.name}`);
  const variables = index(project.variables ?? [], 'variable', item => `${refs.get(item.object) ?? item.object}/${item.variableType}/${item.name}`);
  const messages = index(project.messages ?? [], 'signal', item => String(item.name));
  const tables = index(project.tables ?? [], 'table', item => String(item.name));
  const parsedFunctions = new Map<RawEntity, RawBlock[][]>((project.functions ?? []).map((fn: RawEntity) => [fn, functionBlocks(fn)]));
  const functions = index(project.functions ?? [], 'function', fn => functionLabel(parsedFunctions.get(fn)!, String(fn.id)));
  const assets = new Map<string, RawEntity>();
  const objectRefs = new Map<RawEntity, Map<string, string>>();
  for (const { item: object, key } of objects) {
    const local = new Map<string, string>();
    for (const kind of ['pictures', 'sounds']) {
      for (const { item, key: name } of named(object.sprite?.[kind] ?? [], item => String(item.name))) {
        const identity = `objects[${key}].sprite.${kind}[${name}]`;
        local.set(item.id, identity);
        if (!refs.has(item.id)) refs.set(item.id, identity);
        assets.set(identity, item);
      }
    }
    objectRefs.set(object, local);
  }

  const remap = (id: unknown) => typeof id === 'string' ? refs.get(id) ?? id : id;
  const value = omit(project, ['objects', 'variables', 'functions', 'messages', 'tables', 'scenes']);
  if (project.interface) value.interface = { ...project.interface, object: remap(project.interface.object) };
  value.scenes = scenes.map(({ item }) => omit(item, ['id']));
  value.messages = messages.map(({ item }) => omit(item, ['id']));
  value.variableOrder = variables.filter(({ item }) => !['timer', 'answer'].includes(item.variableType)).map(({ key }) => key);
  value.variables = Object.fromEntries(variables.map(({ item, key }) => [key, { ...omit(item, ['id']), object: remap(item.object) }]));
  value.tables = Object.fromEntries(tables.map(({ item, key }) => [key, { ...omit(item, ['id']), object: remap(item.object) }]));
  value.objectOrder = Object.fromEntries(scenes.map(({ item, key }) => [key, objects.filter(({ item: obj }) => obj.scene === item.id).map(({ key }) => key)]));
  value.objects = Object.fromEntries(objects.map(({ item, key }) => {
    const local = new Map([...refs, ...objectRefs.get(item)!]);
    const sprite = { ...item.sprite };
    for (const kind of ['pictures', 'sounds']) {
      sprite[kind] = (sprite[kind] ?? []).map((asset: RawEntity) => omit(asset, ['id', 'fileurl', 'filename', 'pngurl']));
    }
    return [key, { ...omit(item, ['id']), scene: remap(item.scene),
      selectedPictureId: local.get(item.selectedPictureId) ?? item.selectedPictureId,
      sprite, script: code(item.script ?? [], local) }];
  }));
  value.functions = Object.fromEntries(functions.map(({ item, key }) => {
    const local = new Map(refs);
    const locals = named(item.localVariables ?? [], variable => String(variable.name));
    for (const { item: variable, key: name } of locals) local.set(variable.id, `local:${name}`);
    const blocks = parsedFunctions.get(item)!;
    const create = blocks.find(thread => thread[0]?.type?.startsWith('function_create'))?.[0];
    let field = create?.params?.[0], param = 0;
    const seen = new Set<unknown>();
    while (field && !seen.has(field)) {
      seen.add(field);
      if (field.type === 'function_field_string' || field.type === 'function_field_boolean') {
        const type = field.params?.[0]?.type;
        if (type) local.set(type, `${field.type}:${param++}`);
      }
      field = field.params?.[1];
    }
    return [key, { ...omit(item, ['id']), localVariables: locals.map(({ item: variable }) => omit(variable, ['id'])), content: code(item.content, local) }];
  }));
  return { value, assets };
}

function describe(value: unknown): string {
  if (value === undefined) return '(missing)';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return `object(${Object.keys(value).slice(0, 8).join(', ')})`;
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// Compare saved data directly; source convergence alone cannot detect first-round loss.
export function compareEntryProjects(before: RawEntity, after: RawEntity, options: ProjectAuditOptions = {}): ProjectAudit {
  const left = snapshot(before), right = snapshot(after);
  const report: ProjectAudit = {
    counts: { data: 0, metadata: 0, code: 0, layout: 0, asset: 0 }, differences: [], truncated: false,
    checkedAssets: 0, unavailableAssets: 0,
    excluded: ['generated IDs', 'asset archive paths', 'block coordinates and omitted defaults', 'text/number block labels with identical values'],
  };
  const limit = Math.max(0, options.maxDifferences ?? 100);
  const add = (kind: ProjectDifference['kind'], path: string, before: unknown, after: unknown) => {
    report.counts[kind]++;
    if (report.differences.length < limit) report.differences.push({ kind, path, before: describe(before), after: describe(after) });
    else report.truncated = true;
  };
  const pending = [{ a: left.value, b: right.value, path: '', kind: 'metadata' as ProjectDifference['kind'] }];
  while (pending.length) {
    const { a, b, path, kind } = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
      add(kind, path, a, b); continue;
    }
    if (Array.isArray(a) && a.length !== b.length) add(kind, `${path}.length`, a.length, b.length);
    // Added defaults are harmless; missing or changed original fields must be visible.
    for (const key of Object.keys(a)) {
      const childPath = path ? `${path}${Array.isArray(a) ? `[${key}]` : `.${key}`}` : key;
      const childKind = key === 'script' || key === 'content' ? 'code'
        : ['variables', 'tables', 'messages', 'variableOrder', 'objectOrder', 'scenes'].includes(key) && !path ? 'data'
        : key === 'interface' && !path ? 'layout' : kind;
      pending.push({ a: (a as RawEntity)[key], b: b[key], path: childPath, kind: childKind });
    }
  }
  const originalAssets = new Map(options.beforeAssets?.map(asset => [asset.name, asset.data]));
  const rebuiltAssets = new Map(options.afterAssets?.map(asset => [asset.name, asset.data]));
  const checked = new Set<string>();
  for (const [path, asset] of left.assets) {
    const other = right.assets.get(path);
    if (!other) continue;
    const pair = JSON.stringify([asset.fileurl, other.fileurl]);
    if (checked.has(pair)) continue;
    checked.add(pair);
    if (!asset.fileurl && !other.fileurl) continue;
    const a = originalAssets.get(asset.fileurl), b = rebuiltAssets.get(other.fileurl);
    if (a && !b) { add('asset', path, `${a.length} bytes`, undefined); continue; }
    if (!a || !b) { report.unavailableAssets++; continue; }
    report.checkedAssets++;
    if (a.length !== b.length || a.some((byte, i) => byte !== b[i])) add('asset', path, `${a.length} bytes`, `${b.length} bytes (different content)`);
  }
  return report;
}
