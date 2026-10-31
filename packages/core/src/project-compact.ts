// Leave room for other fields and storage overhead, which vary by project and account.
export const PROJECT_JSON_LIMIT = 16_730_000;

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

export type CompactionCache = Map<string, { bytes: number; compacted?: string }>;

export function compactLargeProject<T>(project: T, limit = PROJECT_JSON_LIMIT, cache: CompactionCache = new Map()): {
  project: T; beforeBytes: number; afterBytes: number;
} {
  if (!record(project)) {
    const size = bytes(JSON.stringify(project));
    return { project, beforeBytes: size, afterBytes: size };
  }
  // Normalize custom JSON serializers before measuring their output.
  if (typeof project.toJSON === 'function') {
    const serialized = JSON.stringify(project), beforeBytes = bytes(serialized);
    if (beforeBytes <= limit) return { project, beforeBytes, afterBytes: beforeBytes };
    return compactLargeProject(JSON.parse(serialized), limit, cache);
  }
  const used = new Set<string>();
  const codeSize = (code: string) => {
    used.add(code);
    let entry = cache.get(code);
    if (!entry) { entry = { bytes: bytes(JSON.stringify(code)) }; cache.set(code, entry); }
    return entry;
  };
  let codeBytes = 0;
  const measureCode = (owner: unknown, field: string) => {
    if (!record(owner) || !Object.hasOwn(owner, field) || typeof owner[field] !== 'string' || typeof owner.toJSON === 'function') return owner;
    codeBytes += codeSize(owner[field]).bytes - 4; // JSON null occupies four bytes.
    return { ...owner, [field]: null };
  };
  // Measure metadata once and reuse cached code sizes.
  const measured: JsonRecord = { ...project };
  if (Object.hasOwn(project, 'objects') && Array.isArray(project.objects)) measured.objects = project.objects.map(object => measureCode(object, 'script'));
  if (Object.hasOwn(project, 'functions') && Array.isArray(project.functions)) measured.functions = project.functions.map(fn => measureCode(fn, 'content'));
  const beforeBytes = bytes(JSON.stringify(measured)) + codeBytes;
  const finish = (copy: T, afterBytes: number) => {
    for (const code of cache.keys()) if (!used.has(code)) cache.delete(code);
    return { project: copy, beforeBytes, afterBytes };
  };
  if (beforeBytes <= limit) return finish(project, beforeBytes);
  let difference = 0;
  const compact = (code: unknown) => {
    if (typeof code === 'string') {
      const entry = codeSize(code);
      entry.compacted ??= compactCode(code) as string;
      difference += codeSize(entry.compacted).bytes - entry.bytes;
      return entry.compacted;
    }
    const copy = compactCode(code);
    if (copy !== code) difference += bytes(JSON.stringify(copy)) - bytes(JSON.stringify(code));
    return copy;
  };
  // Copy changed branches without touching live editor data.
  const copy: JsonRecord = { ...project };
  if (Object.hasOwn(project, 'objects') && Array.isArray(project.objects)) copy.objects = project.objects.map(object => {
    if (!record(object) || typeof object.toJSON === 'function') return object;
    const next = { ...object };
    if (Object.hasOwn(object, 'script')) next.script = compact(object.script);
    if (record(object.sprite) && Array.isArray(object.sprite.pictures)) {
      const pictures = object.sprite.pictures.map(picture => {
        if (!record(picture) || !Object.hasOwn(picture, 'imageType') || picture.imageType !== 'png' || typeof picture.toJSON === 'function') return picture;
        const next = { ...picture }; delete next.imageType;
        // Count the removed comma when another JSON property remains.
        const other = Object.values(next).some(value => value !== undefined && typeof value !== 'function' && typeof value !== 'symbol');
        difference -= '"imageType":"png"'.length + Number(other);
        return next;
      });
      next.sprite = { ...object.sprite, pictures };
    }
    return next;
  });
  if (Object.hasOwn(project, 'functions') && Array.isArray(project.functions)) copy.functions = project.functions.map(fn => {
    if (!record(fn) || typeof fn.toJSON === 'function' || !Object.hasOwn(fn, 'content')) return fn;
    return { ...fn, content: compact(fn.content) };
  });
  return finish(copy as T, beforeBytes + difference);
}
