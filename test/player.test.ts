import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProject } from '@tess/compiler';
import { serveProject, findLocalRuntime } from '@tess/player';
import { assetRoutes } from '@tess/player';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function compileExample(name = 'examples/all_blocks.tess') {
  const file = path.join(root, name);
  const result = compileProject(fs.readFileSync(file, 'utf-8'), { path: file });
  assert.deepEqual(result.errors, []);
  return { ...result, assetDirs: [path.dirname(file)] };
}

async function withServer(options: any, body: any) {
  const result = compileExample(options.example);
  const server = await serveProject({
    project: result.project,
    assets: result.assets,
    assetDirs: result.assetDirs,
    name: result.project!.name,
    port: 0,
    ...options,
  });
  try {
    await body(server, result);
  } finally {
    await server.close();
  }
}

test('작품과 실행 페이지를 내보낸다', async () => {
  await withServer({}, async (server: any, result: any) => {
    const page = await (await fetch(server.url)).text();
    assert.match(page, /블록 검증/);
    assert.match(page, /장면 3 · 오브젝트 5 · 블록 \d+/);
    assert.match(page, /Entry\.loadProject/);

    const project = await (await fetch(`${server.url}project.json`)).json();
    assert.equal(project.scenes.length, result.project.scenes.length);
    assert.equal(project.objects.length, result.project.objects.length);
  });
});

test('실행하기 전에 글상자 폰트를 먼저 내려받는다', async () => {
  // Load fonts before the project starts because canvas does not redraw automatically after font downloads.
  await withServer({}, async (server: any) => {
    const page = await (await fetch(server.url)).text();

    const preloadCall = page.indexOf('preloadTextFonts(project)');
    const loadProjectCall = page.indexOf('Entry.loadProject(project)');
    assert.notEqual(preloadCall, -1, '폰트를 미리 불러오는 코드가 있어야 한다');
    assert.notEqual(loadProjectCall, -1);
    assert.ok(
      preloadCall < loadProjectCall,
      '폰트를 먼저 불러온 다음에 Entry.loadProject 를 불러야 한다',
    );

    // CSS font-face declarations alone do not fetch fonts until they are used.
    assert.match(page, /document\.fonts\.load/);
    assert.match(page, /document\.fonts\.ready/);
  });
});

test('작품 파일(.ent)을 내려받을 수 있다', async () => {
  await withServer({}, async (server: any) => {
    const page = await (await fetch(server.url)).text();
    const href = page.match(/href="\/([^"]+\.ent)"/)![1];
    const response = await fetch(server.url + encodeURIComponent(href));
    assert.equal(response.status, 200);

    const bytes = zlib.gunzipSync(Buffer.from(await response.arrayBuffer()));
    assert.equal(bytes.length % 512, 0);
    assert.equal(bytes.subarray(0, 100).toString('utf-8').replace(/\0+$/, ''), 'temp/project.json');
  });
});

test('리소스를 디스크에 있는 그대로의 주소로 내보낸다', async () => {
  await withServer({ example: 'examples/cat_run.tess' }, async (server: any, result: any) => {
    const project = await (await fetch(`${server.url}project.json`)).json();
    const pictures = project.objects.flatMap((object: any) => object.sprite.pictures);
    const cat = pictures.find((picture: any) => picture.fileurl.endsWith('cat_idle.png'));

    assert.equal(cat.fileurl, '/cat_idle.png');

    const served = await fetch(server.url + cat.fileurl.slice(1));
    assert.equal(served.status, 200);
    assert.deepEqual(
      Buffer.from(await served.arrayBuffer()),
      fs.readFileSync(path.join(root, 'examples/cat_idle.png')),
    );

    const hashed = result.assets.find((asset: any) => asset.source.endsWith('cat_idle.png')).target;
    assert.equal((await fetch(`${server.url}${hashed}`)).status, 200);
  });
});

test('리소스 폴더 밖의 파일은 엔트리의 원래 주소를 그대로 쓴다', () => {
  const { files, rewrites } = assetRoutes(
    [{ source: '/그밖/멀리.png', target: 'temp/aa/bb/image/x.png' }],
    ['/작품'],
  );
  assert.equal(rewrites.size, 0);
  assert.equal(files.get('/temp/aa/bb/image/x.png'), '/그밖/멀리.png');
});

test('두 폴더가 같은 이름을 주장하면 어느 쪽도 그 주소를 쓰지 않는다', () => {
  const { rewrites } = assetRoutes(
    [
      { source: path.join('/작품/가', '고양이.png'), target: 'temp/aa/bb/image/1.png' },
      { source: path.join('/작품/나', '고양이.png'), target: 'temp/cc/dd/image/2.png' },
    ],
    ['/작품/가', '/작품/나'],
  );
  assert.equal(rewrites.size, 0);
});

test('없는 주소는 404 를 준다', async () => {
  await withServer({}, async (server: any) => {
    assert.equal((await fetch(`${server.url}없는것`)).status, 404);
  });
});

test('설치된 entryjs 가 없으면 CDN 을 가리킨다', async () => {
  await withServer({ cwd: os.tmpdir() }, async (server: any) => {
    assert.match(server.runtime, /^CDN/);
    const page = await (await fetch(server.url)).text();
    // Load Entry from unpkg because its package exceeds jsDelivr's size limit.
    assert.match(page, /unpkg\.com\/@entrylabs\/entry/);
    assert.match(page, /cdn\.jsdelivr\.net/);
    assert.match(page, /엔트리 실행기를 불러오지 못했습니다/);
    assert.match(page, /playentry\.org/);
  });
});

test('설치된 entryjs 가 있으면 그것을 내보낸다', async (t) => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-runtime-'));
  const dist = path.join(fake, 'node_modules', '@entrylabs', 'entry', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'entry.min.js'), 'window.Entry = {};');
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));

  assert.ok(findLocalRuntime(fake));

  await withServer({ cwd: fake }, async (server: any) => {
    assert.match(server.runtime, /^설치된/);
    const page = await (await fetch(server.url)).text();
    assert.match(page, /src="\/lib\/dist\/entry\.min\.js"/);

    const runtime = await fetch(`${server.url}lib/dist/entry.min.js`);
    assert.equal(runtime.status, 200);
    assert.equal(await runtime.text(), 'window.Entry = {};');
  });
});

test('lib 바깥 파일은 주지 않는다', async (t) => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-runtime-'));
  const dist = path.join(fake, 'node_modules', '@entrylabs', 'entry', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'entry.min.js'), 'x');
  fs.writeFileSync(path.join(fake, 'secret.txt'), '비밀');
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));

  await withServer({ cwd: fake }, async (server: any) => {
    const escaped = await fetch(`${server.url}lib/${encodeURIComponent('../../../secret.txt')}`);
    assert.equal(escaped.status, 404);
  });
});

test('엔트리 글꼴 CSS 를 하나씩 <link> 로 직접 붙인다', async () => {
  // Direct font styles avoid the extra import round trip before preloading.
  await withServer({}, async (server: any) => {
    const page = await (await fetch(server.url)).text();
    const hrefs = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    const fontHrefs = hrefs.filter((href) => href.includes('/uploads/fonts/'));

    assert.equal(fontHrefs.length, 22, fontHrefs.join('\n'));
    for (const href of fontHrefs) {
      assert.match(href, /^https:\/\/entry-cdn\.pstatic\.net\/uploads\/fonts\/[\w.]+\.css$/);
    }
    assert.ok(!fontHrefs.some((href) => href.includes('fonts_2023_10')), 'fonts_2023_10.css 는 빼야 한다');
    for (const name of ['nanum_gothic', 'dunggeunmo_2023', 'd2coding_2023', 'SDShabang_2023']) {
      assert.ok(fontHrefs.some((href) => href.endsWith('/' + name + '.css')), name + ' 이 빠졌다');
    }
  });
});

test('캔버스 그리기 해상도는 처음 한 번만 정하고, 그 뒤에는 CSS 크기만 바꾼다', async () => {
  // Keep canvas buffer size fixed on layout changes because resizing clears it and resets transforms.
  await withServer({}, async (server: any) => {
    const ui = await (await fetch(`${server.url}debug-ui.js`)).text();

    assert.match(ui, /const setCanvasResolution = \(\) => \{/);
    assert.match(ui, /if \(resolutionFixed\) return;/);
    assert.match(ui, /resolutionFixed = true;/);

    const layout = ui.slice(ui.indexOf('function layoutCanvas()'), ui.indexOf('window.tessLayoutCanvas ='));
    assert.match(layout, /canvas\.style\.width/);
    assert.match(layout, /canvas\.style\.height/);
    assert.doesNotMatch(layout, /canvasEl\.width\s*=/);
    assert.doesNotMatch(layout, /canvasEl\.height\s*=/);
  });
});

test('물어보기 입력창을 캔버스 해상도에 맞춰 키운다', async () => {
  // Scale the ask field with Entry's larger drawing buffer so it stays aligned.
  await withServer({}, async (server: any) => {
    const ui = await (await fetch(`${server.url}debug-ui.js`)).text();

    assert.match(ui, /const ENTRY_BUFFER_WIDTH = 640;/);
    const scale = ui.slice(ui.indexOf('const scaleInputFieldToBuffer'), ui.indexOf('const setCanvasResolution'));
    assert.match(scale, /stage\.showInputField = /);
    // Accept either quote style in source checks.
    const quoted = (name: string) => new RegExp(`['"]${name}['"]`);
    const at = (name: string) => scale.search(quoted(name));
    for (const name of ['fontSize', 'borderWidth', 'borderRadius', 'padding', 'width', 'height', 'x', 'y']) {
      assert.match(scale, quoted(name), `${name} 도 같이 키워야 한다`);
    }
    // Set size before position because the last setter redraws.
    assert.ok(at('width') < at('x'));
    assert.ok(ui.includes('scaleInputFieldToBuffer(bufferW);'));
  });
});

test('무대 배치가 바뀌면 엔트리가 캐시한 캔버스 위치를 새로 잰다', async () => {
  // Refresh cached canvas bounds after panel layout changes.
  await withServer({}, async (server: any) => {
    const ui = await (await fetch(`${server.url}debug-ui.js`)).text();

    assert.match(ui, /const refreshBoundRect = \(\) => \{/);
    assert.match(ui, /stage\.updateBoundRect\(\)/);

    const layout = ui.slice(ui.indexOf('function layoutCanvas()'), ui.indexOf('window.addEventListener(\'resize\''));
    assert.match(layout, /refreshBoundRect\(\);/);
    // Measure final stage bounds after the panel transition ends.
    assert.match(ui, /propertyName === ['"]padding-right['"]/);
  });
});

test('디버그 UI 와 preact 를 모듈로 내보낸다', async () => {
  await withServer({}, async (server: any) => {
    const page = await (await fetch(server.url)).text();
    assert.match(page, /<script type="module" src="\/debug-ui\.js"><\/script>/);

    const ui = await fetch(`${server.url}debug-ui.js`);
    assert.equal(ui.status, 200);
    const uiSource = await ui.text();
    const preactFile = uiSource.match(/from ['"]\/preact\/([^'"]+)['"]/)![1];
    assert.equal((await fetch(`${server.url}preact/${preactFile}`)).status, 200);
    const escaped = await fetch(`${server.url}preact/${encodeURIComponent('../../../package.json')}`);
    assert.equal(escaped.status, 404);
  });
});

test('run --boost 는 엔트리를 부스트 모드(WebGL 렌더러)로 띄운다', async () => {
  await withServer({ boost: true }, async (server: any) => {
    assert.match(await (await fetch(server.url)).text(), /useWebGL: true/);
  });
  await withServer({}, async (server: any) => {
    assert.match(await (await fetch(server.url)).text(), /useWebGL: false/);
  });
});

test('부스트 모드는 실행기가 CDN 이어도 기본 그림을 같은 origin 으로 내보낸다', async () => {
  // Proxy default images through the local origin because Entry omits crossOrigin for WebGL textures.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-boost-'));
  try {
    await withServer({ cwd, boost: true }, async (server: any) => {
      const page = await (await fetch(server.url)).text();
      assert.match(page, /libDir: "\/lib"/);
      assert.match(page, /src="https:\/\/unpkg\.com\/@entrylabs\/entry@[\d.]+\/dist\/entry\.min\.js"/);
    });
    await withServer({ cwd }, async (server: any) => {
      assert.match(await (await fetch(server.url)).text(), /libDir: "https:\/\/unpkg\.com\//);
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('부스트 모드에서는 캔버스 버퍼 대신 렌더러 해상도를 올린다', async () => {
  // Use renderer resolution instead of changing PIXI's canvas width directly.
  await withServer({}, async (server: any) => {
    const ui = await (await fetch(`${server.url}debug-ui.js`)).text();
    const fn = ui.slice(ui.indexOf('const setCanvasResolution'), ui.indexOf('const refreshBoundRect'));
    assert.match(fn, /renderer\.resolution = bufferW \/ ENTRY_BUFFER_WIDTH;/);
    assert.match(fn, /renderer\.resize\(ENTRY_BUFFER_WIDTH, ENTRY_BUFFER_HEIGHT\)/);
    const pixiBranch = fn.slice(fn.indexOf('if (renderer'), fn.indexOf('} else {'));
    assert.doesNotMatch(pixiBranch, /canvasEl\.(width|height)\s*=/);
  });
});

test('부스트 모드에서 클릭 판정도 올린 해상도를 따라간다', async () => {
  // Keep PIXI's interaction resolution in sync or pointer coordinates will use the wrong scale.
  await withServer({}, async (server: any) => {
    const ui = await (await fetch(`${server.url}debug-ui.js`)).text();
    const fn = ui.slice(ui.indexOf('const setCanvasResolution'), ui.indexOf('const refreshBoundRect'));
    assert.match(fn, /interaction\.resolution = renderer\.resolution;/);
    assert.ok(fn.indexOf('renderer.resolution =') < fn.indexOf('interaction.resolution ='),
      '렌더러 해상도를 정한 다음에 판정 해상도를 맞춰야 한다');
  });
});

test('디버그 패널의 부스트 모드 흉내내기는 그대로 남는다', async () => {
  // Keep simulated boost answers independent of the actual renderer selection.
  await withServer({}, async (server: any) => {
    const ui = await (await fetch(`${server.url}debug-ui.js`)).text();
    assert.match(ui, /wrap\(['"]is_boost_mode['"], \(\) => choice\(env\.boost\)\)/);
    assert.match(ui, /['"]env-boost['"]/);
    assert.match(ui, /realBoost: null\s*,/);
    assert.match(ui, /Boolean\(window\.Entry && Entry\.options && Entry\.options\.useWebGL\)/);
  });
});
