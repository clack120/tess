import assert from 'node:assert/strict';
import { parse } from '@tess/parser';
import type { Expr, ParseRoot, StartRule, Stmt } from '@tess/parser';

export function inObject(code: string, kind = 'object'): string {
  const indented = code.split('\n').map((line) => `    ${line}`).join('\n');
  return `${kind} "o":\n  when start do\n${indented}\n  end\nend`;
}

const attempt = (source: string, startRule?: StartRule) => parse(source, { startRule, validate: false });

export function assertParses(source: string, label = source.slice(0, 40)) {
  const result = attempt(source);
  assert.ok(result.ok, `파싱에 실패했습니다 [${label}]\n${result.errors[0]?.message ?? ''}`);
}

export function assertRejects(source: string, label = source.slice(0, 40)) {
  assert.ok(!attempt(source).ok, `파싱에 성공하면 안 됩니다 [${label}]`);
}

export function expr(source: string): any {
  const result = attempt(source, 'Expr');
  assert.ok(result.ok, `표현식 파싱 실패: ${source}\n${result.errors[0]?.message ?? ''}`);
  return strip(result.ast);
}

export function stmt(source: string): any {
  const result = attempt(source, 'Statement');
  assert.ok(result.ok, `문장 파싱 실패: ${source}\n${result.errors[0]?.message ?? ''}`);
  return strip(result.ast);
}

export function strip(node: unknown): any {
  return JSON.parse(JSON.stringify(node, (key, value) => (key === 'loc' ? undefined : value)));
}

export { parse };
