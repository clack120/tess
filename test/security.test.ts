// Check generated code, decompiled source, and output paths against project-controlled input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vmModule from 'node:vm';
import zlib from 'node:zlib';
import { stripTypes } from '@entropy/core/strip-types';
import { fileURLToPath } from 'node:url';
import { compileProject } from '@entropy/compiler';
import { Codegen, serveVm, Vm } from '@entropy/vm';
import { decompileEnt } from '@entropy/decompiler';
import { parse } from '@entropy/parser';
import { entropyComment, entropyCommentLines, entropyString } from '../packages/decompiler/src/ident.ts';
import { stub } from './stub.ts';

const utf8 = (data: Uint8Array) => new TextDecoder('utf-8').decode(data);


function work(blocks: unknown[], object: Record<string, unknown> = {}) {
  return {
    scenes: [{ id: 's', name: 's' }],
    variables: [],
    messages: [],
    functions: [],
    tables: [],
    objects: [
      {
        id: 'o',
        name: 'o',
        scene: 's',
        objectType: 'sprite',
        entity: { x: 0, y: 0 },
        sprite: { pictures: [], sounds: [] },
        script: JSON.stringify([blocks]),
        ...object,
      },
    ],
  };
}

const HAT = { id: 'a', type: 'when_run_button_click', params: [null], statements: [] };

test('function IDs cannot escape generated kernel comments', () => {
  const flag = '__entropyKernelSecurityProbe';
  const globals = globalThis as Record<string, unknown>;
  try {
    for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
      const compiled = compileProject(`var output = 0
function result() do
  return 7
end
object "actor":
  when start do
    output = result()
  end
end`);
      assert.ok(compiled.project);
      const project = compiled.project;
      const original = project.functions[0]!.id;
      const hostile = `f${separator}globalThis.${flag} = 1;${separator}//`;
      project.functions[0]!.id = hostile;
      const rewrite = (item: unknown): void => {
        if (Array.isArray(item)) item.forEach(rewrite);
        else if (item && typeof item === 'object') {
          const block = item as Record<string, unknown>;
          if (block.type === `func_${original}`) block.type = `func_${hostile}`;
          Object.values(block).forEach(rewrite);
        }
      };
      for (const object of project.objects) {
        const script = JSON.parse(object.script);
        rewrite(script);
        object.script = JSON.stringify(script);
      }
      delete globals[flag];
      const vm = new Vm({ renderer: null, audio: null, kernel: true });
      vm.load(project as never);
      assert.equal(globals[flag], undefined, `separator ${JSON.stringify(separator)}`);
      vm.start(); vm.tick();
      assert.deepEqual(vm.errors, []);
      assert.equal(vm.variables.find((item) => item.name === 'output')!.value, '7');
      assert.ok(vm.kernel!.stats.runs > 0, 'the function must still execute in the kernel');
      assert.equal(globals[flag], undefined);
    }
  } finally {
    delete globals[flag];
  }
});

function runsOwnCode(blocks: unknown[]): boolean {
  const source = new Codegen(work(blocks) as never).compile().source;
  const flag = '__entropySecurityProbe';
  delete (globalThis as Record<string, unknown>)[flag];
  try {
    const made = new Function('R', source)({ ops: {}, cast: {} }) as {
      scripts?: Array<(entity: unknown, thread: unknown) => Iterator<unknown>>;
    };
    for (const script of made.scripts ?? []) {
      const step = script({ target: {} }, {});
      for (let i = 0; i < 4; i += 1) {
        if (step.next().done) break;
      }
    }
  } catch {
    // An invalid generated program cannot execute injected project code either.
  }
  return flag in globalThis;
}

test('블록 이름은 만들어진 자바스크립트를 빠져나가지 못한다', () => {
  // Sanitize unknown block names so they cannot close a generated comment and inject JavaScript.
  const escapes = [
    "*/;globalThis.__entropySecurityProbe=1;/*",
    "func_*/;globalThis.__entropySecurityProbe=1;/*",
    "x*/\n;globalThis.__entropySecurityProbe=1;/*",
    "x\u2028;globalThis.__entropySecurityProbe=1;//",
    "open_table\n;globalThis.__entropySecurityProbe=1;//",
  ];
  for (const type of escapes) {
    assert.equal(
      runsOwnCode([HAT, { id: 'b', type, params: [], statements: [] }]),
      false,
      JSON.stringify(type),
    );
  }
});

test('빠져나가려는 이름이 있어도 나머지 블록은 그대로 돈다', () => {
  const source = new Codegen(
    work([HAT, { id: 'b', type: '*/;evil();/*', params: [], statements: [] }]) as never,
  ).compile().source;
  assert.doesNotThrow(() => new Function('R', source));
  assert.match(source, /\/\*[^*]*\*\//, '알 수 없는 블록은 여전히 주석으로 남습니다');
  assert.doesNotMatch(source, /evil\(\)/, '실행될 수 있는 형태로는 남지 않습니다');
});

// Ignore inherited lookup keys because prototype values can enter generated source.
test('연산자 이름이 Object.prototype 의 것이어도 프로그램은 만들어진다', () => {
  for (const operator of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    const compare = { id: 'c', type: 'boolean_basic_operator', params: [1, operator, 2] };
    const source = new Codegen(
      work([HAT, { id: 'b', type: '_if', params: [compare], statements: [[]] }]) as never,
    ).compile().source;
    assert.doesNotThrow(() => new Function('R', source), operator);
    assert.match(source, /C\.cmpEqual\(/, operator);
  }
});

test('햇 블록 이름이 Object.prototype 의 것이면 아무 스크립트도 되지 않는다', () => {
  for (const type of ['constructor', 'toString', '__proto__', 'valueOf']) {
    const program = new Codegen(
      work([{ id: 'a', type, params: [null, 'x'], statements: [] }]) as never,
    ).compile();
    assert.deepEqual(program.plans, [], type);
    assert.doesNotThrow(() => new Function('R', program.source), type);
  }
});

// JSON can shadow toString; failed primitive conversion must not abort project compilation.
test('원시 값이 없는 값이 슬롯에 있어도 컴파일은 끝난다', () => {
  const hostile = { toString: 'x' };
  const blocks = [
    HAT,
    { id: 'b', type: 'set_variable', params: [hostile, hostile], statements: [] },
    { id: 'c', type: 'stop_object', params: [hostile], statements: [] },
    { id: 'd', type: 'text_write', params: [hostile], statements: [] },
    { id: 'e', type: 'wait_second', params: [hostile], statements: [] },
    { id: 'f', type: 'repeat_while_true', params: [null, hostile], statements: [[]] },
    { id: 'g', type: 'calc_basic', params: [1, hostile, 2], statements: [] },
  ];
  const source = new Codegen(work(blocks) as never).compile().source;
  assert.doesNotThrow(() => new Function('R', source));
});

// Quote function-local keys because project text becomes a generated object property name.
test('함수 지역 변수의 이름이 글자가 아니어도 프로그램은 만들어진다', () => {
  const define = { id: 'd', type: 'function_create', params: [null], statements: [[]] };
  for (const id of [['a', 'b'], { a: 1 }, 12, null]) {
    const project = {
      ...work([HAT, { id: 'c', type: 'func_fid', params: [], statements: [] }]),
      functions: [{
        id: 'fid',
        type: 'normal',
        localVariables: [{ id, name: 'L', value: 1 }],
        content: JSON.stringify([[define]]),
      }],
    };
    const source = new Codegen(project as never).compile().source;
    assert.doesNotThrow(() => new Function('R', source), JSON.stringify(id));
  }
});

// Input flow blocks execute before their carrier and can restart or end the loop.
test('값 자리에 놓인 흐름 블록은 그 자리에서 반복을 다시 돌리거나 끝낸다', () => {
  const slot = (type: string) => ({
    id: 'w', type: 'wait_until_true',
    params: [{ id: 'n', type: 'boolean_not', params: [null, { id: 'f', type, params: [null] }] }, null],
    statements: [],
  });
  const carrier = (type: string) => ({
    id: 'h', type: 'some_hardware_block',
    params: [{ id: 'f', type, params: [null] }],
    statements: [],
  });
  const inLoop = (inner: unknown) => [
    HAT,
    { id: 'r', type: 'repeat_inf', params: [null], statements: [[inner]] },
  ];

  for (const make of [slot, carrier]) {
    const ended = new Codegen(work(inLoop(make('stop_repeat'))) as never).compile().source;
    assert.match(ended, /while \(true\) \{\n\s*break;/, '반복 중단은 break 다');
    const again = new Codegen(work(inLoop(make('continue_repeat'))) as never).compile().source;
    assert.match(again, /while \(true\) \{\n\s*\{ yield 0; continue; \}|continue;/, '이어 하기는 continue 다');
    for (const source of [ended, again]) {
      assert.doesNotThrow(() => new Function('R', source));
    }
  }

  // Outside a loop, Entry unwinds the call stack and ends the script.
  const loose = new Codegen(work([HAT, slot('stop_repeat')]) as never).compile().source;
  assert.match(loose, /return;/);
});

// Detect carriers before block-name dispatch because supported blocks can carry flow control too.
test('컴파일러가 아는 블록에 실린 흐름 블록도 같은 치트다', () => {
  const carriers: Array<[string, unknown[]]> = [
    ['sound_something_wait_with_block', []],
    ['sound_something_second_wait_with_block', [{ id: 'n', type: 'number', params: ['0'] }]],
    ['dialog_time', [{ id: 'n', type: 'number', params: ['0'] }, 'speak']],
    ['move_xy_time', [{ id: 'n', type: 'number', params: ['0'] }, { id: 'm', type: 'number', params: ['0'] }]],
    ['rotate_by_time', [{ id: 'a', type: 'angle', params: ['0'] }]],
    ['wait_second', []],
  ];
  for (const [type, rest] of carriers) {
    const carrier = (flow: string) => ({
      id: 'c', type,
      params: [{ id: 'f', type: flow, params: [null] }, ...rest, null],
      statements: [],
    });
    const body = (flow: string) => [
      HAT,
      { id: 'r', type: 'repeat_inf', params: [null], statements: [[carrier(flow)]] },
    ];
    const ended = new Codegen(work(body('stop_repeat')) as never).compile();
    assert.match(ended.source, /while \(true\) \{\n\s*break;/, `${type}: 반복 중단`);
    const again = new Codegen(work(body('continue_repeat')) as never).compile();
    assert.match(again.source, /continue;/, `${type}: 이어 하기`);
    for (const built of [ended, again]) {
      assert.doesNotMatch(built.source, new RegExp(type.replace(/_/g, '[_]')), type);
      assert.equal(built.unknown.size, 0, type);
      assert.doesNotThrow(() => new Function('R', built.source));
    }
  }
});

// Keep adjacent side-effecting inputs rather than discarding them with a flow carrier.
test('값 자리에 함수 호출이 같이 있으면 치트로 삼키지 않는다', () => {
  const carrier = {
    id: 'c', type: 'wait_second',
    params: [
      { id: 'k', type: 'func_zz', params: [] },
      { id: 'f', type: 'continue_repeat', params: [null] },
      null,
    ],
    statements: [],
  };
  const built = new Codegen(work([
    HAT,
    { id: 'r', type: 'repeat_inf', params: [null], statements: [[carrier]] },
  ]) as never).compile();
  assert.match(built.source, /waitSecond/);
});

// Maze loops do not spend frames; keep a spin guard instead of yielding each iteration.
test('미로 수업의 반복 블록은 한 바퀴에 프레임을 쓰지 않는다', () => {
  const maze = (inner: unknown) => new Codegen(work([
    HAT,
    { id: 'r', type: 'ai_repeat_until_reach', params: [null], statements: [[inner]] },
  ]) as never).compile();
  const program = maze({
    id: 'm', type: 'move_y', params: [{ id: 'n', type: 'number', params: ['10'] }, null], statements: [],
  });
  assert.deepEqual([...program.unknown.keys()], [], '모르는 블록이 아니다');
  assert.doesNotMatch(program.source, /O\.moveY\(e, 10\);\n\s*yield 0;/);
  assert.match(program.source, /while \(true\) \{\n\s*if \(m0 !== O\.frame\(\)\)/);
  assert.doesNotThrow(() => new Function('R', program.source));

  const bare = new Codegen(work([
    HAT,
    { id: 'r', type: 'ai_repeat_until_reach', params: [null], statements: [[]] },
  ]) as never).compile();
  assert.doesNotMatch(bare.source, /while \(true\)/);

  const ended = maze({ id: 's', type: 'stop_repeat', params: [null], statements: [] });
  assert.match(ended.source, /while \(true\) \{[\s\S]*?\n\s*break;/);
});

// Guard frameless loops so a stuck work can still be stopped.
test('프레임을 안 넘기는 반복도 실행기를 붙잡지 못한다', async () => {
  const { compileProject } = await import('@entropy/compiler');
  const { Vm } = await import('@entropy/vm');
  const result = compileProject(
    'scene "s":\n  object "o":\n    when start do\n      forever:\n        skip\n      end\n    end\n  end\nend',
    { path: 'spin.etp' },
  );
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const machine = new Vm({ renderer: null, audio: null });
  machine.load(result.project as unknown as never);
  machine.start();
  for (let i = 0; i < 5; i += 1) {
    machine.tick();
  }
  assert.equal(machine.frame, 5, '틱마다 돌아와야 합니다');
});

test('되돌린 소스에서 주석과 문자열은 한 줄을 벗어나지 못한다', () => {
  // Escape all four lexer line endings in strings and comments.
  for (const brk of ['\n', '\r', '\u2028', '\u2029']) {
    assert.equal(
      entropyComment(`note${brk}say "INJECTED"`).includes(brk),
      false,
      `entropyComment ${JSON.stringify(brk)}`,
    );
    assert.equal(
      entropyString(`a${brk}b`).includes(brk),
      false,
      `entropyString ${JSON.stringify(brk)}`,
    );
    for (const line of entropyCommentLines(`note${brk}say "INJECTED"`)) {
      assert.match(line, /^# /, line);
    }
  }
});

test('작품의 글자가 되돌린 소스의 문법을 바꾸지 못한다', async () => {
  const script = [
    {
      ...HAT,
      comment: { value: 'note\rsay "INJECTED"\u2028say "INJECTED"' },
    },
    { id: 'b', type: 'unknown_block\nsay "INJECTED"', params: [], statements: [] },
  ];
  const bytes = entFile(work(script, { name: 'o\u2028INJECTED' }));
  const out = await decompileEnt(bytes, {});
  const fragment = out.files.find((file) => file.path.startsWith('objects/'));
  assert.ok(fragment, '오브젝트 조각이 나와야 합니다');
  const text = utf8(fragment.data);

  // Any injection marker left outside strings and comments became executable syntax.
  const bare = text.replace(/^\s*#.*$/gm, '').replace(/"(?:\\.|[^"\\])*"/g, '""');
  assert.doesNotMatch(bare, /INJECTED/, `문장으로 새어 나왔습니다:\n${text}`);
  assert.ok(
    parse(text, { startRule: 'ObjectFragment', validate: false }).ok,
    `되돌린 조각이 읽히지 않습니다:\n${text}`,
  );
});

test('모양·소리 파일은 내보낼 폴더 밖으로 나가지 못한다', async () => {
  const picture = {
    id: 'p',
    name: 'pic',
    filename: 'aaaaaaaa',
    imageType: 'png/../../../../ESCAPED',
    fileurl: 'temp/aa/11/image/aaaaaaaa.png',
    dimension: { width: 1, height: 1 },
  };
  const sound = {
    id: 'q',
    name: 'snd',
    filename: 'bbbbbbbb',
    ext: '.mp3/../../../../ESCAPED',
    fileurl: 'temp/bb/11/bbbbbbbb.mp3',
    duration: 1,
  };
  const project = work([], {
    selectedPictureId: 'p',
    sprite: { pictures: [picture], sounds: [sound] },
  });
  const out = await decompileEnt(entFile(project, { [picture.fileurl]: PNG, [sound.fileurl]: PNG }), {});

  const root = path.join(os.tmpdir(), 'entropy-security');
  for (const asset of out.assets) {
    assert.doesNotMatch(asset.path, /(^|\/)\.\.($|\/)/, asset.path);
    const target = path.resolve(root, asset.path);
    assert.ok(target.startsWith(root + path.sep), `폴더를 벗어납니다: ${asset.path}`);
  }
});

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

function tarHeader(name: string, size: number): Buffer {
  const head = Buffer.alloc(512);
  head.write(name, 0, 100, 'utf-8');
  head.write('000644 \0', 100, 8, 'utf-8');
  head.write('000000 \0', 108, 8, 'utf-8');
  head.write('000000 \0', 116, 8, 'utf-8');
  head.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'utf-8');
  head.write('00000000000 ', 136, 12, 'utf-8');
  head.write('        ', 148, 8, 'utf-8'); // TAR checksum placeholder.
  head.write('0', 156, 1, 'utf-8');
  let sum = 0;
  for (const byte of head) sum += byte;
  head.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf-8');
  return head;
}

function entFile(project: unknown, extra: Record<string, Buffer> = {}): Buffer {
  const parts: Buffer[] = [];
  const add = (name: string, data: Buffer) => {
    parts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  };
  add('temp/project.json', Buffer.from(JSON.stringify(project), 'utf-8'));
  for (const [name, data] of Object.entries(extra)) add(name, data);
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

test('만든 .ent 를 되돌리기가 실제로 읽는다', async () => {
  // Verify the archive fixture itself so malformed empty input cannot make the security checks pass.
  const out = await decompileEnt(entFile(work([HAT])), {});
  assert.match(out.source, /scene/);
  assert.ok(out.files.some((file) => file.path.startsWith('objects/')));
});

test('파일을 쓰는 자리가 폴더 밖 경로를 거부한다', () => {
  const load = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'packages/vm/src/node/load.ts'),
    'utf-8',
  );
  // Keep output-path validation even when decompilation already rejects unsafe paths.
  assert.match(load, /path\.resolve\(root, asset\.path\)/);
  assert.match(load, /startsWith\(root \+ path\.sep\)/);
});

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function entryProjectReaders(): {
  thumbUrl(thumb: unknown): string | null;
  withAssetUrls(work: unknown): any;
} {
  const source = stripTypes(fs.readFileSync(path.join(repoRoot, 'packages/extension/src/page/entry-project.ts'), 'utf-8'));
  const sandbox: Record<string, unknown> = {
    location: { origin: 'https://playentry.org' },
    URL,
  };
  sandbox.globalThis = sandbox;
  vmModule.createContext(sandbox);
  vmModule.runInContext(
    `${source.replace(/^import[^;]*;$/gm, '').replace(/^export /gm, '')}\nthis.read = { thumbUrl, withAssetUrls };`,
    sandbox,
  );
  return sandbox.read as ReturnType<typeof entryProjectReaders>;
}

// Validate thumbnail URLs before inserting them into CSS so project text cannot redirect requests.
test('미리보기 그림 주소는 playentry 를 벗어나지도, 따옴표를 남기지도 않는다', () => {
  const { thumbUrl } = entryProjectReaders();
  assert.equal(thumbUrl('/uploads/aa/bb/thumb/cc.png'), 'https://playentry.org/uploads/aa/bb/thumb/cc.png');
  assert.equal(thumbUrl('https://evil.example/x.png'), null);
  assert.equal(thumbUrl('//evil.example/x.png'), null);
  assert.equal(thumbUrl('javascript:alert(1)'), null);
  assert.equal(thumbUrl(''), null);
  assert.equal(thumbUrl(null), null);
  for (const thumb of ['/a"),url("https://evil.example/x.png', '/a?q=")']) {
    const url = thumbUrl(thumb);
    assert.ok(url && !url.includes('"'), `따옴표가 남았습니다: ${url}`);
    assert.ok(url.startsWith('https://playentry.org/'), url);
  }
});

test('에셋 주소를 채울 때 엔트리에서 내보낸 원본을 바꾸지 않는다', () => {
  const { withAssetUrls } = entryProjectReaders();
  const picture: { filename: string; imageType: string; fileurl?: string } = { filename: 'aabbcc', imageType: 'svg' };
  const sound: { filename: string; ext: string; fileurl?: string } = { filename: 'ddeeff', ext: '.mp3' };
  const sprite = { pictures: [picture], sounds: [sound] };
  const object = { sprite };
  const work = { objects: [object] };
  const normalized = withAssetUrls(work);

  assert.equal(picture.fileurl, undefined);
  assert.equal(sound.fileurl, undefined);
  assert.notEqual(normalized, work);
  assert.notEqual(normalized.objects[0], object);
  assert.notEqual(normalized.objects[0].sprite, sprite);
  assert.equal(normalized.objects[0].sprite.pictures[0].fileurl,
    'https://playentry.org/uploads/aa/bb/image/aabbcc.svg');
  assert.equal(normalized.objects[0].sprite.sounds[0].fileurl,
    'https://playentry.org/uploads/dd/ee/ddeeff.mp3');
});

async function withVmServer(body: (server: { port: number }) => Promise<void>) {
  const result = compileProject('scene "s":\n  text "t":\n    text_content = "x"\n  end\nend', {
    path: 'main.etp',
  });
  assert.deepEqual(result.errors, [], result.errors.map((e) => e.message).join('\n'));
  const server = await serveVm({
    project: result.project!,
    assets: result.assets,
    assetDirs: [],
    name: 'security',
    port: 0,
  });
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

// Use HTTP directly so tests can set Host and Origin headers.
function request(
  port: number,
  options: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = http.request(
      { host: '127.0.0.1', port, path: options.path, method: options.method ?? 'GET', headers: options.headers },
      (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    call.on('error', reject);
    call.end(options.body);
  });
}

// Check Host to prevent a foreign name resolving to loopback from reading the local server.
test('run 서버는 자기 이름으로 오지 않은 요청을 거절한다', async () => {
  await withVmServer(async ({ port }) => {
    assert.equal((await request(port, { path: '/project.json' })).status, 200);
    assert.equal(
      (await request(port, { path: '/project.json', headers: { host: 'work.example' } })).status,
      403,
    );
    assert.equal(
      (await request(port, { path: '/vm/web/boot.ts', headers: { host: 'work.example' } })).status,
      403,
    );
  });
});

test('run 서버는 잘못 인코딩된 URL 을 안전하게 거절한다', async () => {
  await withVmServer(async ({ port }) => {
    assert.equal((await request(port, { path: '/%ZZ' })).status, 400);
  });
});

// Log endpoints must reject foreign origins because form-style requests need no preflight.
test('오류 기록 자리는 이 페이지가 보낸 것만 받는다', async () => {
  await withVmServer(async ({ port }) => {
    const log = JSON.stringify({ kind: 'k', message: 'm' });
    const sent = await request(port, {
      path: '/__log',
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://work.example' },
      body: log,
    });
    assert.equal(sent.status, 403);
    const own = await request(port, {
      path: '/__log',
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: log,
    });
    assert.equal(own.status, 204);
  });
});

test('터미널에 적히는 글에서는 제어 문자가 빠진다', async () => {
  const printed: string[] = [];
  const wasError = console.error;
  console.error = (...parts: unknown[]) => { printed.push(parts.join(' ')); };
  try {
    await withVmServer(async ({ port }) => {
      const response = await request(port, {
        path: '/__log',
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({
          kind: '오류',
          message: `\u001b[2J\u001b]0;bell\u0007`,
          stack: `줄1\n\u001b[31m줄2`,
        }),
      });
      assert.equal(response.status, 204);
    });
  } finally {
    console.error = wasError;
  }
  const all = printed.join('\n');
  assert.ok(all.includes('오류'), all);
  assert.doesNotMatch(all, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  // Keep line breaks for readable stack traces.
  assert.match(all, /줄1\n/);
  assert.ok(all.includes('줄2'), all);
});

// Restrict the expansion proxy to Entry's read-only API path.
test('확장 API 호출은 정해진 자리와 방법으로만 넘어간다', async () => {
  await withVmServer(async ({ port }) => {
    assert.equal(
      (await request(port, { path: '/api/expansionBlock/papago/translate/n2mt', method: 'POST' })).status,
      404,
    );
    assert.equal(
      (await request(port, { path: '/api/expansionBlock/papago/../../../etc/passwd' })).status,
      404,
    );
    assert.equal(
      (await request(port, {
        path: '/api/expansionBlock/papago/translate/n2mt',
        headers: { host: 'work.example' },
      })).status,
      403,
    );
  });
});

test('확장 API 프록시는 음성 같은 바이너리의 형식을 보존한다', async (t) => {
  const audio = Uint8Array.of(0, 255, 1, 254);
  stub(t, globalThis, 'fetch', async () => new Response(audio, {
    status: 206,
    headers: { 'content-type': 'audio/mpeg' },
  }));
  await withVmServer(async ({ port }) => {
    const received = await new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/expansionBlock/tts/read' }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          type: String(response.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks),
        }));
      }).on('error', reject);
    });
    assert.equal(received.status, 206);
    assert.equal(received.type, 'audio/mpeg');
    assert.deepEqual(received.body, Buffer.from(audio));
  });
});
