import fs from 'node:fs';
import assert from 'node:assert/strict';

interface Schema {
  event?: boolean | string;
  primitive?: boolean;
  params: Array<{ type: string; value?: unknown }>;
  statements: number;
}

const [, , snapshot, version] = process.argv;
assert.ok(snapshot && /^\d+\.\d+\.\d+(?:[\w.-]*)$/.test(version ?? ''),
  'Usage: bun packages/vm/tools/update-block-shapes.ts snapshot.json entry-version');
const schemas = JSON.parse(fs.readFileSync(snapshot, 'utf8')) as Record<string, Schema>;
const groups = new Map<string, string[]>();
for (const [name, schema] of Object.entries(schemas)) {
  assert.match(name, /^[\w.-]+$/);
  if (/^(func_|stringParam_|booleanParam_)/.test(name)) continue;
  const slots = schema.params.flatMap((param, index) => ['Block', 'Output'].includes(param.type) ? [index] : []);
  const defaults = slots.flatMap(index => {
    const value = schema.params[index].value;
    return value && typeof value === 'object' && 'type' in value ? [[index, value.type]] : [];
  });
  const key = JSON.stringify([Number(Boolean(schema.event)) | Number(Boolean(schema.primitive)) * 2, slots, schema.statements, defaults]);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(name);
}

const lines = [
  `// Entry ${version} schema shapes; regenerate with tools/update-block-shapes.ts.`,
  `export const ENTRY_SCHEMA_VERSION = '${version}';`, '',
  'export interface BlockShape {', '  event: boolean;', '  primitive: boolean;',
  '  slots: readonly number[];', '  statements: number;', '  defaults: ReadonlyMap<number, string>;', '}', '',
  'const groups: ReadonlyArray<readonly [number, readonly number[], number, ReadonlyArray<readonly [number, string]>, string]> = [',
];
for (const [key, names] of [...groups].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
  lines.push(`  [${JSON.parse(key).map((value: unknown) => JSON.stringify(value)).join(', ')}, \``);
  let line = '   ';
  for (const name of names.sort()) {
    if (line.length > 3 && line.length + name.length > 114) { lines.push(line); line = '   '; }
    line += ` ${name}`;
  }
  lines.push(line, '  `],');
}
lines.push('];', '', 'let shapes: Map<string, BlockShape> | undefined;', '',
  'export function blockShape(type: string): BlockShape | undefined {', '  if (!shapes) {', '    shapes = new Map();',
  '    for (const [flags, slots, statements, defaults, names] of groups) {',
  '      const shape = { event: Boolean(flags & 1), primitive: Boolean(flags & 2), slots, statements, defaults: new Map(defaults) };',
  '      for (const name of names.trim().split(/\\s+/)) shapes.set(name, shape);',
  '    }', '  }', '  return shapes.get(type);', '}', '');
fs.writeFileSync(new URL('../src/compile/block-shapes.ts', import.meta.url), lines.join('\n'));
