import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('extension watch rebuilds VM and extension edits, ignores output, and recovers after failure', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-watch-'));
  const extension = path.join(dir, 'packages/extension');
  for (const source of ['extension/src', 'vm/src', 'core/src']) {
    fs.mkdirSync(path.join(dir, 'packages', source), { recursive: true });
  }
  fs.copyFileSync(new URL('../packages/extension/watch.ts', import.meta.url), path.join(extension, 'watch.ts'));
  fs.writeFileSync(path.join(extension, 'build.ts'), `
    import fs from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const root = fileURLToPath(new URL('.', import.meta.url));
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/output.js'), 'build output');
    const failed = fs.existsSync(path.join(root, 'src/fail'));
    console.log('test-build');
    if (failed) process.exit(1);
  `);
  const child = spawn(process.execPath, [path.join(extension, 'watch.ts')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await stopped;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const waitFor = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!ready()) {
      assert.equal(child.exitCode, null, output);
      assert.ok(Date.now() < deadline, output);
      await new Promise((done) => setTimeout(done, 25));
    }
  };
  const builds = () => output.split('test-build').length - 1;
  await waitFor(() => output.includes('Ctrl+C'));
  assert.equal(builds(), 1);
  fs.writeFileSync(path.join(dir, 'packages/vm/src/engine.ts'), 'vm edit');
  await waitFor(() => builds() === 2);
  fs.writeFileSync(path.join(extension, 'src/fail'), 'broken edit');
  // stdout and stderr can arrive in either order under load.
  await waitFor(() => output.includes('빌드 실패') && builds() === 3);
  assert.equal(builds(), 3);
  fs.rmSync(path.join(extension, 'src/fail'));
  await waitFor(() => builds() === 4);
  fs.writeFileSync(path.join(extension, 'manifest.json'), '{}');
  await waitFor(() => builds() === 5);
  await new Promise((done) => setTimeout(done, 350));
  assert.equal(builds(), 5, 'writing dist must not trigger another build');
});
