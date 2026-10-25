import { BLOCK_PARAM_COUNTS } from './block-params.ts';
import { expansionBlock } from '@entropy/core';
import type { EntryProject } from './types.ts';

type AnyBlock = Record<string, any>;

type ReferenceKind = 'variable' | 'list' | 'message' | 'scene' | 'picture' | 'sound' | 'objectOrSelf';

interface BlockOwner {
  pictures: Set<string>;
  sounds: Set<string>;
}

export interface VerifyEntryProjectOptions {
  // Loose compilation may intentionally preserve dangling IDs from a decompiled project.
  references?: boolean;
}

const BLOCK_FIELDS = ['id', 'x', 'y', 'type', 'params', 'statements'];

const PROJECT_KEYS = [
  'objects', 'scenes', 'variables', 'messages', 'functions', 'speed', 'interface',
];

const REFERENCES: Record<string, Array<[number, ReferenceKind]>> = {
  get_variable: [[0, 'variable']],
  set_variable: [[0, 'variable']],
  change_variable: [[0, 'variable']],
  show_variable: [[0, 'variable']],
  hide_variable: [[0, 'variable']],
  value_of_index_from_list: [[1, 'list']],
  add_value_to_list: [[1, 'list']],
  remove_value_from_list: [[1, 'list']],
  insert_value_to_list: [[1, 'list']],
  change_value_list_index: [[0, 'list']],
  length_of_list: [[1, 'list']],
  is_included_in_list: [[1, 'list']],
  show_list: [[0, 'list']],
  hide_list: [[0, 'list']],
  message_cast: [[0, 'message']],
  message_cast_wait: [[0, 'message']],
  when_message_cast: [[1, 'message']],
  start_scene: [[0, 'scene']],
  get_pictures: [[0, 'picture']],
  get_sounds: [[0, 'sound']],
  create_clone: [[0, 'objectOrSelf']],
  locate: [[0, 'objectOrSelf']],
  see_angle_object: [[0, 'objectOrSelf']],
  text_read: [[0, 'objectOrSelf']],
};

export function verifyEntryProject(
  project: EntryProject,
  options: VerifyEntryProjectOptions = {},
): string[] {
  const problems: string[] = [];
  const add = (message: string) => problems.push(message);
  const checkReferences = options.references !== false;

  for (const key of PROJECT_KEYS) {
    if (!(key in project)) add(`프로젝트에 '${key}' 항목이 없습니다.`);
  }
  if (!Array.isArray(project.objects)) return problems;

  const sceneIds = new Set(project.scenes.map((scene) => scene.id));
  const messageIds = new Set(project.messages.map((message) => message.id));
  const functionIds = new Set(project.functions.map((fn) => fn.id));
  const functionParamCounts = new Map<string, { fields: number; statementIcon: boolean }>();
  for (const fn of project.functions) {
    try {
      const create = JSON.parse(fn.content)?.[0]?.[0];
      let count = 0;
      let field = create?.params?.[0];
      while (field && typeof field === 'object') {
        if (field.type === 'function_field_string' || field.type === 'function_field_boolean') count += 1;
        field = field.params?.[1];
      }
      functionParamCounts.set(fn.id, { fields: count, statementIcon: fn.type !== 'value' });
    } catch {
      // The detailed function-content error is reported below.
    }
  }
  const variableIds = new Set<string>();
  const listIds = new Set<string>();
  for (const variable of project.variables) {
    (variable.variableType === 'list' ? listIds : variableIds).add(variable.id);
  }
  const objectIds = new Set(project.objects.map((object) => object.id));

  // Block IDs only need to be unique within each object or function.
  let blockIds = new Set<string>();

  const checkBlock = (block: AnyBlock | null | undefined, owner: BlockOwner | null, path: string) => {
    if (!block || typeof block !== 'object') {
      add(`${path}: 블록이 객체가 아닙니다.`);
      return;
    }
    for (const field of BLOCK_FIELDS) {
      if (!(field in block)) add(`${path}: 블록에 '${field}' 가 없습니다. (type=${block.type})`);
    }
    if (typeof block.type !== 'string' || block.type.length === 0) {
      add(`${path}: 블록 타입이 비었습니다.`);
      return;
    }
    if (blockIds.has(block.id)) add(`${path}: 블록 id '${block.id}' 가 중복됩니다.`);
    blockIds.add(block.id);

    if (!Array.isArray(block.params)) add(`${path}: params 가 배열이 아닙니다.`);
    if (!Array.isArray(block.statements)) add(`${path}: statements 가 배열이 아닙니다.`);

    const expansion = expansionBlock(block.type);
    const expected = BLOCK_PARAM_COUNTS[block.type] ?? expansion?.slots.length;
    if (expected !== undefined && block.params?.length !== expected) {
      add(`${path}: ${block.type} 의 params 가 ${block.params?.length}개입니다. (엔트리는 ${expected}개)`);
    }

    if (block.type.startsWith('func_')) {
      const id = block.type.slice(5);
      if (checkReferences && !functionIds.has(id)) add(`${path}: 함수 '${id}' 가 functions 에 없습니다.`);
      const call = functionParamCounts.get(id);
      // Void functions have a trailing icon slot as statements, but Entry also accepts
      // them without that slot when they are embedded in a value position.
      const validCounts = call && (call.statementIcon ? [call.fields, call.fields + 1] : [call.fields]);
      if (validCounts && !validCounts.includes(block.params?.length)) {
        add(`${path}: ${block.type} 호출의 params 가 ${block.params?.length}개입니다. (함수 스키마는 ${validCounts.join('개 또는 ')}개)`);
      }
    }

    if (expansion) {
      const modules = expansion.ai ? project.aiUtilizeBlocks : project.expansionBlocks;
      if (!modules.includes(expansion.module)) {
        add(`${path}: ${block.type} 에 필요한 '${expansion.module}' 모듈이 프로젝트에 없습니다.`);
      }
    }

    for (const [index, kind] of checkReferences ? (REFERENCES[block.type] ?? []) : []) {
      const value = block.params?.[index];
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') continue;
      // Function resources belong to the calling object and cannot be checked here.
      if (!owner && (kind === 'picture' || kind === 'sound')) continue;
      const checks: Record<ReferenceKind, () => boolean> = {
        variable: () => variableIds.has(value),
        list: () => listIds.has(value),
        message: () => messageIds.has(value),
        scene: () => sceneIds.has(value),
        picture: () => Boolean(owner?.pictures.has(value)),
        sound: () => Boolean(owner?.sounds.has(value)),
        objectOrSelf: () => value === 'self' || value === 'mouse' || objectIds.has(value),
      };
      const ok = checks[kind]();
      if (!ok) add(`${path}: ${block.type} 이(가) 없는 ${kind} '${value}' 를 가리킵니다.`);
    }

    (block.params ?? []).forEach((param: unknown, index: number) => {
      if (param && typeof param === 'object') checkBlock(param as AnyBlock, owner, `${path}>params[${index}]`);
    });
    (block.statements ?? []).forEach((statement: unknown, index: number) => {
      if (!Array.isArray(statement)) {
        add(`${path}: statements[${index}] 가 배열이 아닙니다.`);
        return;
      }
      statement.forEach((child: AnyBlock, i: number) => checkBlock(child, owner, `${path}>do[${index}][${i}]`));
    });
  };

  for (const object of project.objects) {
    const label = `오브젝트 '${object.name}'`;
    if (checkReferences && !sceneIds.has(object.scene)) add(`${label}: 없는 장면 '${object.scene}' 에 속해 있습니다.`);
    if (!['sprite', 'textBox'].includes(object.objectType)) {
      add(`${label}: objectType 이 '${object.objectType}' 입니다.`);
    }
    if (!object.entity) add(`${label}: entity 가 없습니다.`);

    const owner = {
      pictures: new Set((object.sprite?.pictures ?? []).map((picture) => picture.id)),
      sounds: new Set((object.sprite?.sounds ?? []).map((sound) => sound.id)),
    };

    if (object.objectType === 'sprite') {
      if (checkReferences && object.selectedPictureId && !owner.pictures.has(object.selectedPictureId)) {
        add(`${label}: selectedPictureId 가 모양 목록에 없습니다.`);
      }
    } else if (typeof object.text !== 'string') {
      add(`${label}: 글상자에 text 가 없습니다.`);
    }

    blockIds = new Set();
    let script;
    try {
      script = JSON.parse(object.script);
    } catch {
      add(`${label}: script 가 JSON 문자열이 아닙니다.`);
      continue;
    }
    if (!Array.isArray(script)) {
      add(`${label}: script 가 배열이 아닙니다.`);
      continue;
    }
    script.forEach((thread, index) => {
      if (!Array.isArray(thread)) {
        add(`${label}: script[${index}] 가 배열이 아닙니다.`);
        return;
      }
      thread.forEach((block, i) => checkBlock(block, owner, `${label} 스크립트[${index}][${i}]`));
    });
  }

  for (const fn of project.functions) {
    blockIds = new Set();
    let content;
    try {
      content = JSON.parse(fn.content);
    } catch {
      add(`함수 '${fn.id}': content 가 JSON 문자열이 아닙니다.`);
      continue;
    }
    const create = content?.[0]?.[0];
    if (!create || !['function_create', 'function_create_value'].includes(create.type)) {
      add(`함수 '${fn.id}': 정의 블록이 function_create 계열이 아닙니다.`);
      continue;
    }
    checkBlock(create, null, `함수 '${fn.id}'`);

    const declared = new Set();
    let field = create.params?.[0];
    while (field && typeof field === 'object') {
      if (field.type === 'function_field_string' || field.type === 'function_field_boolean') {
        const param = field.params?.[0];
        if (param?.type) declared.add(param.type);
      }
      field = field.params?.[1];
    }
    for (const used of collectParamTypes(create.statements)) {
      if (!declared.has(used)) add(`함수 '${fn.id}': 선언되지 않은 매개변수 블록 '${used}' 를 씁니다.`);
    }
  }

  return problems;
}

function collectParamTypes(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((child) => collectParamTypes(child, found));
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const block = node as AnyBlock;
  if (typeof block.type === 'string' && /^(string|boolean)Param_/.test(block.type)) found.add(block.type);
  collectParamTypes(block.params ?? [], found);
  collectParamTypes(block.statements ?? [], found);
  return found;
}
