import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
let pending: ReturnType<typeof setTimeout>;

function build(): void {
  const result = spawnSync(process.execPath, [path.join(root, 'build.ts')], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) {
    console.error('빌드 실패 — 다음 변경 때 다시 시도합니다.');
  }
}

function changed(): void {
  clearTimeout(pending);
  pending = setTimeout(build, 150);
}

// Watch source directories because the build replaces dist.
const watchers = ['src', '../vm/src', '../core/src'].map((dir) =>
  fs.watch(path.resolve(root, dir), { recursive: true }, changed),
);
for (const [dir, names] of [
  [root, ['build.ts', 'icons.ts', 'pack.ts', 'manifest.json', 'package.json']],
  [path.resolve(root, '../vm'), ['package.json']],
  [path.resolve(root, '../..'), ['package.json', 'bun.lock']],
] as const) {
  watchers.push(fs.watch(dir, (_event, name) => {
    if (name === null || names.some((file) => file === name)) changed();
  }));
}
for (const watcher of watchers) {
  watcher.on('error', (error) => {
    console.error('파일 감시 실패:', error.message);
    process.exit(1);
  });
}
build();
console.log('소스 변경을 감시합니다. dist 자동 갱신 · 종료 Ctrl+C');
