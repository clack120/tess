import { parseEntryBlockData } from '@entropy/core';
import type { RawBlock, RawEntity } from './types.ts';

const VARIABLE_SLOTS: Record<string, number> = {
  get_variable: 0, set_variable: 0, change_variable: 0, show_variable: 0, hide_variable: 0,
};
const LIST_SLOTS: Record<string, number> = {
  show_list: 0, hide_list: 0, change_value_list_index: 0,
  value_of_index_from_list: 1, length_of_list: 1, is_included_in_list: 1,
  add_value_to_list: 1, remove_value_from_list: 1, insert_value_to_list: 1,
};
const RESOURCE_VALUES = new Set(['text', 'number', 'get_pictures', 'get_sounds']);
const RESOURCE_SLOTS: Record<string, number> = {
  change_to_some_shape: 0, play_bgm: 0, get_sound_duration: 1,
  sound_something_with_block: 0, sound_something_wait_with_block: 0,
  sound_something_second_with_block: 0, sound_something_second_wait_with_block: 0,
  sound_from_to: 0, sound_from_to_and_wait: 0,
};

interface References {
  variables: Set<string>;
  lists: Set<string>;
  resourceValues: Set<string>;
  dataValues: Map<string, RawBlock>;
}

// Parse each script once without changing the caller's project.
export class ProjectReader {
  private readonly roots = new Map<RawEntity, { field: string; path: string }>();
  private readonly parsed = new Map<RawEntity, RawBlock[][]>();
  private readonly scanned = new Map<unknown, References>();

  constructor(project: RawEntity) {
    for (const [key, field] of [['objects', 'script'], ['functions', 'content']] as const) {
      (project[key] ?? []).forEach((owner: RawEntity, index: number) => {
        this.roots.set(owner, { field, path: `${key}[${index}].${field}` });
      });
    }
  }

  read(owner: RawEntity): RawBlock[][] {
    let blocks = this.parsed.get(owner);
    if (!blocks) {
      const root = this.roots.get(owner)!;
      blocks = parseEntryBlockData<RawBlock>(owner[root.field] ?? []);
      this.parsed.set(owner, blocks);
    }
    return blocks;
  }

  references(data: unknown): References {
    const cached = this.scanned.get(data);
    if (cached) return cached;
    const result: References = { variables: new Set(), lists: new Set(), resourceValues: new Set(), dataValues: new Map() };
    const pending = [{ value: data, resource: false }];
    const seen = new Set<object>();
    while (pending.length) {
      const { value, resource } = pending.pop()!;
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object') pending.push({ value: child, resource: false });
        continue;
      }
      const block = value as RawBlock, type = block.type ?? '';
      const variableSlot = Object.hasOwn(VARIABLE_SLOTS, type) ? VARIABLE_SLOTS[type] : undefined;
      const listSlot = Object.hasOwn(LIST_SLOTS, type) ? LIST_SLOTS[type] : undefined;
      const variable = variableSlot === undefined ? null : block.params?.[variableSlot];
      const list = listSlot === undefined ? null : block.params?.[listSlot];
      if (typeof variable === 'string' && variable) result.variables.add(variable);
      if (typeof list === 'string' && list) result.lists.add(list);
      const literal = block.params?.[0];
      if (RESOURCE_VALUES.has(type) && (typeof literal === 'string' || typeof literal === 'number')) {
        const text = String(literal);
        result.resourceValues.add(text);
        if (!resource && !result.dataValues.has(text)) result.dataValues.set(text, block);
      }
      const resourceSlot = Object.hasOwn(RESOURCE_SLOTS, type) ? RESOURCE_SLOTS[type] : undefined;
      const id = resourceSlot === undefined ? null : block.params?.[resourceSlot];
      if (typeof id === 'string') result.resourceValues.add(id);
      (block.params ?? []).forEach((child, index) => {
        if (child && typeof child === 'object') pending.push({ value: child, resource: resourceSlot === index });
      });
      for (const child of block.statements ?? []) pending.push({ value: child, resource: false });
    }
    this.scanned.set(data, result);
    return result;
  }

  location(owner: RawEntity | undefined, block?: RawBlock | null): string | undefined {
    if (!owner) return undefined;
    const root = this.roots.get(owner);
    if (!root) return undefined;
    if (!block) return root.path;
    const pending: Array<{ value: unknown; path: string }> = [{ value: this.read(owner), path: root.path }];
    const seen = new Set<object>();
    while (pending.length) {
      const { value, path } = pending.pop()!;
      if (value === block) return path;
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) pending.push({ value: value[i], path: `${path}[${i}]` });
      } else {
        const node = value as RawBlock;
        if (node.statements) pending.push({ value: node.statements, path: `${path}.statements` });
        if (node.params) pending.push({ value: node.params, path: `${path}.params` });
      }
    }
    return root.path;
  }
}
