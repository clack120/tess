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
  'objects', 'scenes', 'variables', 'messages', 'functions', 'tables',
  'expansionBlocks', 'aiUtilizeBlocks', 'speed', 'interface',
];

const PROJECT_ARRAY_KEYS = [
  'objects', 'scenes', 'variables', 'messages', 'functions', 'tables',
  'expansionBlocks', 'aiUtilizeBlocks',
] as const;

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

  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return ['프로젝트가 객체가 아닙니다.'];
  }

  for (const key of PROJECT_KEYS) {
    if (!(key in project)) add(`프로젝트에 '${key}' 항목이 없습니다.`);
  }
  for (const key of PROJECT_ARRAY_KEYS) {
    if (key in project && !Array.isArray(project[key])) add(`프로젝트의 '${key}' 항목이 배열이 아닙니다.`);
  }
  if (PROJECT_ARRAY_KEYS.some((key) => !Array.isArray(project[key]))) return problems;

  const records = (key: 'objects' | 'scenes' | 'variables' | 'messages' | 'functions' | 'tables') => {
    const valid: AnyBlock[] = [];
    (project[key] as unknown[]).forEach((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        add(`프로젝트의 '${key}[${index}]' 항목이 객체가 아닙니다.`);
      } else {
        valid.push(value as AnyBlock);
      }
    });
    return valid;
  };
  const objects = records('objects');
  const scenes = records('scenes');
  const variables = records('variables');
  const messages = records('messages');
  const functions = records('functions');
  records('tables');

  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const messageIds = new Set(messages.map((message) => message.id));
  const functionIds = new Set(functions.map((fn) => fn.id));
  const functionParamCounts = new Map<string, number>();
  for (const fn of functions) {
    try {
      const create = JSON.parse(fn.content)?.[0]?.[0];
      let count = 0;
      let field = create?.params?.[0];
      while (field && typeof field === 'object') {
        if (field.type === 'function_field_string' || field.type === 'function_field_boolean') count += 1;
        field = field.params?.[1];
      }
      functionParamCounts.set(fn.id, count);
    } catch {
      // The detailed function-content error is reported below.
    }
  }
  const variableIds = new Set<string>();
  const listIds = new Set<string>();
  for (const variable of variables) {
    (variable.variableType === 'list' ? listIds : variableIds).add(variable.id);
  }
  const objectIds = new Set(objects.map((object) => object.id));

  // Block IDs only need to be unique within each object or function.
  let blockIds = new Set<string>();

  const checkBlock = (initial: AnyBlock | null | undefined, owner: BlockOwner | null, rootPath: string) => {
    const pending: Array<{ block: AnyBlock | null | undefined; path: string; depth: number }> = [
      { block: initial, path: rootPath, depth: 0 },
    ];
    const seen = new WeakSet<object>();
    const nestedPath = (parent: string, suffix: string, depth: number) => depth < 80
      ? `${parent}${suffix}`
      : `${rootPath}>…(깊이 ${depth + 1})`;
    while (pending.length) {
      const { block, path, depth } = pending.pop()!;
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        add(`${path}: 블록이 객체가 아닙니다.`);
        continue;
      }
      if (seen.has(block)) {
        add(`${path}: 블록 구조가 순환하거나 같은 객체를 두 번 가리킵니다.`);
        continue;
      }
      seen.add(block);
      for (const field of BLOCK_FIELDS) {
        if (!(field in block)) add(`${path}: 블록에 '${field}' 가 없습니다. (type=${block.type})`);
      }
      if (typeof block.type !== 'string' || block.type.length === 0) {
        add(`${path}: 블록 타입이 비었습니다.`);
        continue;
      }
      if (blockIds.has(block.id)) add(`${path}: 블록 id '${block.id}' 가 중복됩니다.`);
      blockIds.add(block.id);

      const params = Array.isArray(block.params) ? block.params : [];
      const statements = Array.isArray(block.statements) ? block.statements : [];
      if (!Array.isArray(block.params)) add(`${path}: params 가 배열이 아닙니다.`);
      if (!Array.isArray(block.statements)) add(`${path}: statements 가 배열이 아닙니다.`);

      const expansion = expansionBlock(block.type);
      const expected = BLOCK_PARAM_COUNTS[block.type] ?? expansion?.slots.length;
      if (expected !== undefined && params.length !== expected) {
        add(`${path}: ${block.type} 의 params 가 ${params.length}개입니다. (엔트리는 ${expected}개)`);
      }

      if (block.type.startsWith('func_')) {
        const id = block.type.slice(5);
        if (checkReferences && !functionIds.has(id)) add(`${path}: 함수 '${id}' 가 functions 에 없습니다.`);
        const fields = functionParamCounts.get(id);
        // Native Entry saves some calls with a trailing null icon slot, including value
        // functions from older works. The icon is not an argument and may be omitted.
        const count = params.length;
        const trailingIcon = fields !== undefined
          && count === fields + 1 && params[fields] === null;
        if (fields !== undefined && count !== fields && !trailingIcon) {
          add(`${path}: ${block.type} 호출의 params 가 ${count}개입니다. (함수 인자는 ${fields}개이고 끝의 null 아이콘 칸만 추가할 수 있습니다)`);
        }
      }

      if (expansion) {
        const modules = expansion.ai ? project.aiUtilizeBlocks : project.expansionBlocks;
        if (!modules.includes(expansion.module)) {
          add(`${path}: ${block.type} 에 필요한 '${expansion.module}' 모듈이 프로젝트에 없습니다.`);
        }
      }

      for (const [index, kind] of checkReferences ? (REFERENCES[block.type] ?? []) : []) {
        const value = params[index];
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

      const children: Array<{ block: AnyBlock; path: string }> = [];
      params.forEach((param: unknown, index: number) => {
        if (param && typeof param === 'object') {
          children.push({ block: param as AnyBlock, path: nestedPath(path, `>params[${index}]`, depth) });
        }
      });
      statements.forEach((statement: unknown, index: number) => {
        if (!Array.isArray(statement)) {
          add(`${path}: statements[${index}] 가 배열이 아닙니다.`);
          return;
        }
        statement.forEach((child: AnyBlock, i: number) => children.push({
          block: child,
          path: nestedPath(path, `>do[${index}][${i}]`, depth),
        }));
      });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ ...children[index]!, depth: depth + 1 });
      }
    }
  };

  for (const object of objects) {
    const label = `오브젝트 '${object.name}'`;
    if (checkReferences && !sceneIds.has(object.scene)) add(`${label}: 없는 장면 '${object.scene}' 에 속해 있습니다.`);
    if (!['sprite', 'textBox'].includes(object.objectType)) {
      add(`${label}: objectType 이 '${object.objectType}' 입니다.`);
    }
    if (!object.entity) add(`${label}: entity 가 없습니다.`);

    const resourceIds = (kind: 'pictures' | 'sounds'): Set<string> => {
      const value = object.sprite?.[kind];
      if (value === undefined) return new Set();
      if (!Array.isArray(value)) {
        add(`${label}: sprite.${kind} 가 배열이 아닙니다.`);
        return new Set();
      }
      const ids = new Set<string>();
      value.forEach((resource: unknown, index: number) => {
        if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
          add(`${label}: sprite.${kind}[${index}] 항목이 객체가 아닙니다.`);
        } else {
          const id = (resource as AnyBlock).id;
          if (typeof id === 'string') ids.add(id);
          else add(`${label}: sprite.${kind}[${index}] 의 id 가 문자열이 아닙니다.`);
        }
      });
      return ids;
    };
    const owner = { pictures: resourceIds('pictures'), sounds: resourceIds('sounds') };

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

  for (const fn of functions) {
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

function collectParamTypes(node: unknown): Set<string> {
  const found = new Set<string>();
  const pending = [node];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push(value[index]);
      continue;
    }
    const block = value as AnyBlock;
    if (typeof block.type === 'string' && /^(string|boolean)Param_/.test(block.type)) found.add(block.type);
    pending.push(block.statements, block.params);
  }
  return found;
}
