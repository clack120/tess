import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@tess/parser';
import { compileProject } from '@tess/compiler';
import type { StartRule } from '@tess/parser';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const FRAGMENT_RULES: Array<StartRule | undefined> = [undefined, 'SceneFragment', 'ObjectFragment'];

function tessFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tessFiles(full);
    return entry.name.endsWith('.tess') ? [full] : [];
  });
}

function usedFiles(node: any, base: string, found = new Set<string>()): Set<string> {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    node.forEach((child) => usedFiles(child, base, found));
    return found;
  }
  if (node.type === 'Use' || node.type === 'UseObject') {
    found.add(path.resolve(path.dirname(base), node.path));
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc') usedFiles(value, base, found);
  }
  return found;
}

const files = tessFiles(root);
const fragments = new Set<string>();
for (const file of files) {
  const result = parse(fs.readFileSync(file, 'utf-8'));
  if (result.ast) usedFiles(result.ast, file, fragments);
}

test('예제 파일이 있다', () => {
  assert.ok(files.length > 0);
});

const show = (list: any) => list.map((d: any) => `${d.line}:${d.column} ${d.message}`).join('\n');

for (const file of files) {
  const label = path.relative(root, file);
  const source = fs.readFileSync(file, 'utf-8');

  if (fragments.has(file)) {
    test(`예제(조각): ${label}`, () => {
      // Fragments may parse under different start rules depending on their inclusion scope.
      const ok = FRAGMENT_RULES.some((startRule) => parse(source, { startRule, validate: false }).ok);
      assert.ok(ok, `${label} 을(를) 어떤 자리의 조각으로도 읽을 수 없습니다.`);
    });
    continue;
  }

  // Fully compile entry files with their includes; parse-only checks cannot resolve fragment ownership.
  const parsed = parse(source, { validate: false });
  const included = parsed.ast ? [...usedFiles(parsed.ast, file)] : [];
  const buildable = included.length > 0 && included.every((used) => fs.existsSync(used));

  test(`예제: ${label}`, () => {
    if (buildable) {
      const result = compileProject(source, { path: file });
      const errors = result.errors.map((e) => ({ ...e, message: `${e.file ?? label} ${e.message}` }));
      assert.deepEqual(errors, [], `\n${show(errors)}`);
      return;
    }
    const result = parse(source);
    assert.deepEqual(result.errors, [], `\n${show(result.errors)}`);
    assert.deepEqual(result.warnings, [], `\n${show(result.warnings)}`);
  });
}
