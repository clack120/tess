// Entry expands block defaults on export; discard only those defaults above the save limit.
export const PROJECT_JSON_LIMIT = 16_700_000;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

function compactCode(code: unknown): unknown {
  if (typeof code !== 'string' && !Array.isArray(code)) return code;
  let threads: unknown;
  try { threads = typeof code === 'string' ? JSON.parse(code) : JSON.parse(JSON.stringify(code)); }
  catch { return code; }
  if (!Array.isArray(threads)) return code;
  const strip = (value: unknown, top: boolean): void => {
    if (Array.isArray(value)) { for (const child of value) strip(child, top); return; }
    if (!record(value) || typeof value.id !== 'string' || typeof value.type !== 'string') return;
    if (value.movable === null) delete value.movable;
    if (value.deletable === 1) delete value.deletable;
    if (value.emphasized === false) delete value.emphasized;
    if (value.readOnly === null) delete value.readOnly;
    if (value.copyable === true) delete value.copyable;
    if (value.assemble === true) delete value.assemble;
    if (Array.isArray(value.extensions) && value.extensions.length === 0) delete value.extensions;
    if (!top) {
      if (value.x === 0 || value.x === '0') delete value.x;
      if (value.y === 0 || value.y === '0') delete value.y;
    }
    for (const field of ['params', 'statements']) {
      if (!Array.isArray(value[field])) continue;
      for (const child of value[field]) strip(child, false);
      if (value[field].length === 0) delete value[field];
    }
  };
  for (const thread of threads) {
    if (Array.isArray(thread)) thread.forEach((block, index) => strip(block, index === 0));
    else strip(thread, true);
  }
  return typeof code === 'string' ? JSON.stringify(threads) : threads;
}

export function compactLargeProject<T>(project: T, limit = PROJECT_JSON_LIMIT): {
  project: T; beforeBytes: number; afterBytes: number;
} {
  const serialized = JSON.stringify(project);
  const beforeBytes = bytes(serialized);
  if (beforeBytes <= limit) return { project, beforeBytes, afterBytes: beforeBytes };
  // Work on the exported JSON copy, never on the editor's mutable model.
  const copy: unknown = JSON.parse(serialized);
  if (!record(copy)) return { project, beforeBytes, afterBytes: beforeBytes };
  if (Array.isArray(copy.objects)) for (const object of copy.objects) {
    if (!record(object)) continue;
    if ('script' in object) object.script = compactCode(object.script);
    if (record(object.sprite) && Array.isArray(object.sprite.pictures)) {
      for (const picture of object.sprite.pictures) {
        if (record(picture) && picture.imageType === 'png') delete picture.imageType;
      }
    }
  }
  if (Array.isArray(copy.functions)) for (const fn of copy.functions) {
    if (record(fn) && 'content' in fn) fn.content = compactCode(fn.content);
  }
  return { project: copy as T, beforeBytes, afterBytes: bytes(JSON.stringify(copy)) };
}
