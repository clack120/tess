import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProject, makeEntryBundle, verifyEntryProject } from '@entropy/compiler';
import { decompileEnt } from '@entropy/decompiler';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Archive timestamps, generated IDs and missing fixture asset hashes are not source semantics.
function stableSource(source: string): string {
  return source.replace(
    /temp\/[a-z0-9]{2}\/[a-z0-9]{2}\/(?:image|sound)\/[a-z0-9]{32}(\.[a-z0-9]+(?:\.png)?)/g,
    'temp/<asset>$1',
  );
}

test('.ent → .etp → .ent repeated three times reaches a stable, Entry-valid project', async () => {
  const file = path.join(root, 'examples/all_blocks.etp');
  let compiled = compileProject(fs.readFileSync(file, 'utf-8'), { path: file });
  assert.deepEqual(compiled.errors, []);
  assert.ok(compiled.project);

  let previous: string | null = null;
  for (let round = 1; round <= 3; round += 1) {
    assert.deepEqual(verifyEntryProject(compiled.project!), [], `round ${round} Entry schema`);
    const bundle = await makeEntryBundle(compiled.project!, compiled.assets);
    const decompiled = await decompileEnt(bundle, { inline: true });
    assert.deepEqual(decompiled.warnings, [], `round ${round} decompile warnings`);
    assert.deepEqual(decompiled.notices, [], `round ${round} decompile notices`);

    const current = stableSource(decompiled.source);
    if (previous !== null) assert.equal(current, previous, `round ${round} source drifted`);
    previous = current;

    compiled = compileProject(decompiled.source, { path: `round-${round}.etp` });
    assert.deepEqual(compiled.errors, [], `round ${round} compile errors`);
    assert.ok(compiled.project);
  }
});
