import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { compileProject } from '@entropy/compiler';
import { exportHtml, exportZip } from '../packages/vm/src/node/export.ts';

// Use real PNG bytes because the compiler reads image dimensions.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SOURCE = `scene "s":
  object "o":
    default costume 기본 "dot.png" size 1 1
    when start do
      move 10 steps
    end
  end
end`;

function fixture(): { project: ReturnType<typeof compileProject>['project']; assets: { source: string; target: string }[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-export-'));
  fs.writeFileSync(path.join(dir, 'dot.png'), PNG);
  const main = path.join(dir, 'main.etp');
  fs.writeFileSync(main, SOURCE);
  const result = compileProject(SOURCE, { path: main, assetDirs: [dir] });
  assert.ok(result.project, result.errors.map((error) => error.message).join('\n'));
  return { project: result.project, assets: result.assets };
}

function unzip(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let at = 0;
  while (data.readUInt32LE(at) === 0x04034b50) {
    const compressed = data.readUInt32LE(at + 18);
    const nameLength = data.readUInt16LE(at + 26);
    const extraLength = data.readUInt16LE(at + 28);
    const name = data.subarray(at + 30, at + 30 + nameLength).toString('utf-8');
    const start = at + 30 + nameLength + extraLength;
    files.set(name, zlib.inflateRawSync(data.subarray(start, start + compressed)));
    at = start + compressed;
  }
  return files;
}

test('zip 으로 내보내면 페이지·작품·모듈·에셋이 모두 들어간다', () => {
  const { project, assets } = fixture();
  const made = exportZip({ project: project!, assets, name: '내보내기', kernel: false });
  const files = unzip(made.data);

  assert.ok(files.has('index.html'));
  assert.ok(files.has('project.json'));
  assert.ok(files.has('vm/web/boot.js'));
  assert.ok(files.has('vm/pixi.mjs'));
  assert.equal(made.assets, 1);
  assert.equal(made.kernel, false);

  // Use .js because static servers give .ts a content type browsers cannot execute.
  for (const name of files.keys()) {
    assert.ok(!name.endsWith('.ts'), name);
  }
  const boot = files.get('vm/web/boot.js')!.toString('utf-8');
  assert.match(boot, /from ['"]\.\.\/runtime\/engine\.js['"]/);
  assert.doesNotMatch(boot, /from ['"][^'"]*\.ts['"]/);

  const served = JSON.parse(files.get('project.json')!.toString('utf-8'));
  const fileurl = served.objects[0].sprite.pictures[0].fileurl;
  assert.match(fileurl, /^assets\//);
  assert.ok(files.has(fileurl));
});

test('단일 html 은 모듈·작품·에셋을 글 안에 담고 커널을 끈 채로도 돈다', () => {
  const { project, assets } = fixture();
  const made = exportHtml({ project: project!, assets, name: '내보내기', kernel: false });
  const html = made.data.toString('utf-8');

  // Rewrite relative module imports because blob URLs have no directory base.
  assert.match(html, /entropy\/web\/boot\.ts/);
  assert.match(html, /entropy\/runtime\/engine\.ts/);
  assert.ok(!html.includes('../runtime/engine.ts'));
  // Decode textures on this thread so they can access the page's in-memory assets.
  assert.match(html, /preferWorkers = false/);
  // Keep asset URLs unchanged and answer their fetches from memory.
  assert.match(html, /\\"fileurl\\":\\"temp\//);
  assert.match(html, new RegExp(PNG.toString('base64').slice(0, 24)));
  assert.match(html, /\\"kernel\\":false/);
  assert.equal(made.assets, 1);
});

test('단일 html 이 바깥에서 받아 오는 것은 엔트리 글꼴뿐이다', () => {
  const { project, assets } = fixture();
  const html = exportHtml({ project: project!, assets, name: '내보내기', kernel: false })
    .data.toString('utf-8');
  const linked = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]*)"/g)]
    .map((match) => match[1]!)
    .filter((url) => !url.startsWith('https://entry-cdn.pstatic.net/'));
  assert.deepEqual(linked, []);
});
