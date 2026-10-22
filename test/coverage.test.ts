// Read the installed Entry palette so new blocks cannot escape the coverage check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_FILE = path.join(root, 'node_modules/@entrylabs/entry/extern/util/static.js');

const NOT_A_BLOCK = /AddButton$|Button$|_title$|^learning_title/;

// Exclude editor-only checker and function-header blocks from runtime coverage.
const EDITOR_ONLY_CLASSES = new Set(['checker']);
const EDITOR_ONLY_TARGETS = new Set(['functionEdit']);

const BLOCK_DIR = path.join(root, 'node_modules/@entrylabs/entry/src/playground/blocks');

function loadBlockTraits() {
  const traits = new Map();
  const files = fs.readdirSync(BLOCK_DIR).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(BLOCK_DIR, file), 'utf8');
    for (const match of text.matchAll(/^ +([A-Za-z_][A-Za-z0-9_]*): \{$/gm)) {
      const body = text.slice(match.index, match.index + 4000);
      traits.set(match[1], {
        blockClass: /^ +class: '([^']*)'/m.exec(body)?.[1] ?? '',
        notFor: [...(/^ +isNotFor: \[([^\]]*)\]/m.exec(body)?.[1] ?? '').matchAll(/'([^']*)'/g)]
          .map((m) => m[1]),
      });
    }
  }
  return traits;
}

const traits = loadBlockTraits();

function editorOnly(type: string) {
  const trait = traits.get(type);
  if (!trait) return false;
  return EDITOR_ONLY_CLASSES.has(trait.blockClass)
    || trait.notFor.some((target: any) => EDITOR_ONLY_TARGETS.has(target));
}

function loadPalette(): Array<{ category: string; blocks?: string[] }> {
  // Build the sandbox around globals used by the palette script in its separate realm.
  const sandbox: Record<string, any> = {
    console,
    Lang: new Proxy({}, { get: () => new Proxy({}, { get: () => '' }) }),
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(STATIC_FILE, 'utf8'), sandbox);
  return sandbox.EntryStatic.getAllBlocks();
}

function toolSource(dir = path.join(root, 'packages'), text = { value: '' }): string {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) toolSource(full, text);
    else if (entry.name.endsWith('.ts')) text.value += fs.readFileSync(full, 'utf8');
  }
  return text.value;
}

const source = toolSource();
const mentions = (type: string) => new RegExp(`["'\`]${type}["'\`]|^ {2}${type}: \\{`, 'm').test(source);

const REQUIRED = [
  'start', 'flow', 'moving', 'looks', 'brush', 'text', 'sound',
  'judgement', 'calc', 'variable', 'func', 'analysis', 'expansion',
];

const palette = new Map(loadPalette().map(({ category, blocks }) => [category, blocks ?? []]));

for (const category of REQUIRED) {
  test(`엔트리 '${category}' 카테고리의 블록을 전부 지원한다`, () => {
    const blocks = palette.get(category);
    assert.ok(blocks?.length, `엔트리 팔레트에 '${category}' 카테고리가 없습니다.`);
    // Copy cross-realm arrays before deep comparison because their prototypes differ.
    const missing = [...blocks]
      .filter((type) => !NOT_A_BLOCK.test(type) && !editorOnly(type) && !mentions(type));
    assert.equal(missing.join(', '), '', `옮기지 못하는 블록: ${missing.join(', ')}`);
  });
}
