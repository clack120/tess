import { parseEntryBlockData } from '@entropy/core';

export interface RawBlock {
  id: string;
  type: string;
  params: unknown[];
  statements?: RawBlock[][];
}

export interface FunctionEntry {
  id: string;
  type: string;
  localVariables: Array<{ id: string; name: string; value: string | number }>;
  content: string | RawBlock[][];
}

export function isBlock(value: unknown): value is RawBlock {
  return Boolean(value) && typeof value === 'object' && typeof (value as RawBlock).type === 'string';
}

export function parseScript(script: string | RawBlock[][] | undefined): RawBlock[][] {
  if (!script || (typeof script === 'string' && !script.trim())) {
    return [];
  }
  try {
    script = parseEntryBlockData<RawBlock>(script);
  } catch (error) {
    console.warn('[entropy] 스크립트를 읽지 못해 이 오브젝트의 블록을 건너뜁니다', error);
    return [];
  }
  // Visit containers only; a JSON reviver also calls back for every scalar field.
  const pending: object[] = [script];
  while (pending.length) {
    const value = pending.pop()!;
    if (!Array.isArray(value) && isBlock(value) && !Array.isArray(value.params)) {
      value.params = [];
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return script;
}

// Find the definition stack even when workspace comments precede it.
export function findFunctionDefine(content: RawBlock[][]): RawBlock[] | null {
  for (const stack of content) {
    const first = stack[0];
    if (first && (first.type === 'function_create' || first.type === 'function_create_value')) {
      return stack;
    }
  }
  return null;
}

// Accept both inline playentry function bodies and bodies nested in saved archives.
export function functionBody(stack: RawBlock[]): RawBlock[] {
  const nested = stack[0]?.statements?.[0];
  if (nested?.length) {
    return nested;
  }
  return stack.slice(1);
}

export function collectParams(field: unknown): string[] {
  const names: string[] = [];
  let node = field;
  while (isBlock(node)) {
    if (node.type === 'function_field_string' || node.type === 'function_field_boolean') {
      const slot = node.params[0];
      if (isBlock(slot)) {
        names.push(slot.type);
      }
      node = node.params[1];
    } else if (node.type === 'function_field_label') {
      node = node.params[1];
    } else {
      break;
    }
  }
  return names;
}

