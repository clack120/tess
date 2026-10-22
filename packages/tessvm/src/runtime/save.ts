// Keep @-prefixed globals using the Entry save-manager convention; hosts provide storage.
import type { Variable } from './model.ts';
import type { Vm } from './engine.ts';

export const STORE_PREFIX = '@';
export const STORE_FLAG = '@확장프로그램';
export const STORE_FLAG_ON = 1;
export const SAVE_FUNCTIONS: Record<string, 'wait' | 'async'> = {
  '@저장': 'wait',
  '@비동기저장': 'async',
};

export type StoredValue = string | number | boolean | Array<{ data: string | number | boolean }>;

export interface SaveHost {
  read(): Promise<Record<string, StoredValue>>;
  write(values: Record<string, StoredValue>): Promise<void>;
}

// Cache stored values so every run can restore them without waiting for another read.
export class SaveStore {
  host: SaveHost | null = null;
  used = false;

  private readonly vm: Vm;
  private kept: Variable[] = [];
  private flag: Variable | null = null;
  private values: Record<string, StoredValue> = {};

  constructor(vm: Vm) {
    this.vm = vm;
  }

  bind(): void {
    this.kept = this.vm.variables.filter(
      (variable) =>
        variable.objectId === null &&
        variable.name.startsWith(STORE_PREFIX) &&
        variable.name !== STORE_FLAG,
    );
    this.flag =
      this.vm.variables.find(
        (variable) => variable.objectId === null && variable.name === STORE_FLAG,
      ) ?? null;
    this.used = this.kept.length > 0 || this.flag !== null;
    this.values = {};
  }

  // Read storage before starting so the opening frame already shows saved values.
  async load(): Promise<void> {
    if (!this.host || !this.used) {
      return;
    }
    this.values = await this.host.read().catch(() => ({}));
    this.apply();
  }

  started(): void {
    this.apply();
  }

  // Save waits for this promise; refused host writes are not reported as script errors.
  async write(): Promise<void> {
    if (!this.host || !this.used) {
      return;
    }
    const values: Record<string, StoredValue> = {};
    for (const variable of this.kept) {
      values[variable.name] = variable.isList
        ? variable.getArray().map((item) => ({ data: item.data }))
        : variable.getValue();
    }
    this.values = values;
    await this.host.write(values).catch(() => undefined);
  }

  private apply(): void {
    if (!this.host) {
      return;
    }
    for (const variable of this.kept) {
      const saved = this.values[variable.name];
      if (saved === undefined) {
        continue;
      }
      if (variable.isList && Array.isArray(saved)) {
        variable.array = saved.map((item) => ({ data: item.data }));
        variable.touch();
      } else if (!variable.isList && !Array.isArray(saved)) {
        variable.value = saved;
        variable.touch();
      }
    }
    // Set the presence flag even when storage has no saved values yet.
    this.flag?.setValue(STORE_FLAG_ON);
  }
}

// Entry stores a function's name in the first label of its header chain.
export function functionLabel(content: unknown): string {
  const stacks = typeof content === 'string' ? safeParse(content) : content;
  const create = (Array.isArray(stacks) ? stacks.flat() : []).find(
    (block) => (block as { type?: string })?.type?.startsWith('function_create'),
  ) as { params?: unknown[] } | undefined;
  const field = create?.params?.[0] as { type?: string; params?: unknown[] } | undefined;
  if (field?.type !== 'function_field_label') {
    return '';
  }
  return String(field.params?.[0] ?? '');
}

export function functionName(content: unknown): string {
  const stacks = typeof content === 'string' ? safeParse(content) : content;
  const create = (Array.isArray(stacks) ? stacks.flat() : []).find(
    (block) => (block as { type?: string })?.type?.startsWith('function_create'),
  ) as { params?: unknown[] } | undefined;
  const words: string[] = [];
  let field = create?.params?.[0] as { type?: string; params?: unknown[] } | undefined;
  for (let guard = 0; field && typeof field === 'object' && guard < 64; guard += 1) {
    words.push(field.type === 'function_field_label' ? String(field.params?.[0] ?? '') : '( )');
    field = field.params?.[1] as typeof field;
  }
  return words.join(' ').trim();
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}
