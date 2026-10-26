#!/usr/bin/env node
// Run, inspect, benchmark, and export projects with entropy.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { Vm } from '../runtime/engine.ts';
import { SilentAudioEngine } from '../audio/silent.ts';
import { loadProject } from './load.ts';
import { serveVm, DEFAULT_PORT } from './server.ts';
import { exportHtml, exportZip, type ExportResult } from './export.ts';

const MAX_DIAGNOSTICS = 8;

const USAGE = `사용법
  entropy-vm run    <파일.etp|파일.ent>   작품을 브라우저로 실행
  entropy-vm bench  <파일.etp|파일.ent>   화면 없이 돌려 속도를 잰다
  entropy-vm emit   <파일.etp|파일.ent>   JIT 가 만든 자바스크립트를 출력
  entropy-vm check  <파일.etp|파일.ent>   아직 지원하지 않는 블록을 보고한다
  entropy-vm export <파일.etp|파일.ent>   혼자 도는 한 덩어리로 내보낸다

옵션
  --port <번호>     run 이 쓸 포트 (기본 ${DEFAULT_PORT}, 사용 중이면 빈 포트)
  --quality <배수>  화질 배수 1 · 2 · 4 (기본 1)
  --fps <값>        틱 속도 (기본: 작품의 speed, 없으면 64)
  --stage <가로x세로> 무대 크기 (기본 480x270)
  --ticks <횟수>    bench 가 돌릴 프레임 수 (기본 6000)
  --assets <폴더>   모양·소리를 찾을 폴더 (여러 번 지정 가능)
  --keep <폴더>     .ent 를 되돌린 Entropy 소스를 남길 폴더
  --no-open         브라우저를 열지 않는다
  --no-stats        무대 아래 성능 표시를 끈다
  --start           페이지를 열자마자 작품을 시작한다
  --no-boost        부스트 모드를 끈다
  --no-kernel       숫자 함수용 JIT 커널을 끈다
  --html            export 결과를 단일 HTML로 만든다
  --zip             export 결과를 ZIP으로 만든다 (기본)
  --out <경로>      export 가 쓸 파일 이름 (기본은 작품 이름)
  --no-svg          SVG 대신 함께 저장된 PNG를 사용한다`;

interface Options {
  port?: number;
  quality: number;
  fps?: number;
  stageWidth?: number;
  stageHeight?: number;
  ticks: number;
  assets: string[];
  keep?: string;
  open: boolean;
  stats: boolean;
  autoStart: boolean;
  boost: boolean;
  svg: boolean;
  kernel: boolean;
  html: boolean;
  zip: boolean;
  out?: string;
}

function parseArgs(argv: string[]): { options: Options; rest: string[] } {
  const options: Options = {
    quality: 1,
    ticks: 6000,
    assets: [],
    open: true,
    stats: true,
    autoStart: false,
    boost: true,
    svg: true,
    kernel: true,
    html: false,
    zip: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--quality') options.quality = Number(argv[++i]);
    else if (arg === '--fps') options.fps = Number(argv[++i]);
    else if (arg === '--stage') {
      const [width, height] = String(argv[++i] ?? '').split(/[x×,]/);
      options.stageWidth = Number(width) || undefined;
      options.stageHeight = Number(height) || undefined;
    }
    else if (arg === '--ticks') options.ticks = Number(argv[++i]);
    else if (arg === '--assets') options.assets.push(argv[++i]!);
    else if (arg === '--keep') options.keep = argv[++i];
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--no-stats') options.stats = false;
    else if (arg === '--start') options.autoStart = true;
    else if (arg === '--no-start') options.autoStart = false;
    else if (arg === '--boost') options.boost = true;
    else if (arg === '--no-boost') options.boost = false;
    else if (arg === '--kernel') options.kernel = true;
    else if (arg === '--no-kernel') options.kernel = false;
    else if (arg === '--html') options.html = true;
    else if (arg === '--zip') options.zip = true;
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--svg') options.svg = true;
    else if (arg === '--no-svg') options.svg = false;
    else rest.push(arg);
  }
  return { options, rest };
}

async function main(): Promise<number> {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const [command, file] = rest;
  if (!command || !file) {
    console.log(USAGE);
    return command ? 1 : 0;
  }
  if (!fs.existsSync(file)) {
    console.error(`파일을 찾을 수 없습니다: ${file}`);
    return 1;
  }

  const loaded = await loadProject(file, {
    assetDirs: options.assets,
    decompileTo: options.keep,
  });
  try {
    if (loaded.decompiledTo) {
      console.log(`${path.basename(file)} → ${path.join(loaded.decompiledTo, 'entry.etp')} (되돌린 Entropy 소스)`);
    }
    const grades = [
      ['에러', loaded.errors, console.error],
      ['경고', loaded.warnings, console.warn],
      ['주의', loaded.notices, console.log],
    ] as const;
    for (const [grade, items, write] of grades) {
      for (const item of items.slice(0, MAX_DIAGNOSTICS)) {
        write(`  ${grade} ${item.line}:${item.column} ${item.message}`);
      }
      if (items.length > MAX_DIAGNOSTICS) {
        write(`  … ${grade} 외 ${items.length - MAX_DIAGNOSTICS}개`);
      }
    }

    switch (command) {
      case 'run':
        return await run(loaded, options);
      case 'bench':
        return bench(loaded, options);
      case 'emit':
        return emit(loaded);
      case 'check':
        return check(loaded, options);
      case 'export':
        return exportWork(loaded, options);
      default:
        console.log(USAGE);
        return 1;
    }
  } finally {
    loaded.cleanup();
  }
}

type Loaded = Awaited<ReturnType<typeof loadProject>>;

async function run(loaded: Loaded, options: Options): Promise<number> {
  const server = await serveVm({
    project: loaded.project,
    assets: loaded.assets,
    assetDirs: loaded.assetDirs,
    sourceMap: loaded.sourceMap,
    name: loaded.name,
    port: options.port,
    quality: options.quality,
    fps: options.fps,
    stageWidth: options.stageWidth,
    stageHeight: options.stageHeight,
    stats: options.stats,
    autoStart: options.autoStart,
    boost: options.boost,
    svg: options.svg,
    kernel: options.kernel,
  });
  console.log(`${loaded.name} → ${server.url}`);
  console.log(`  오브젝트 ${loaded.project.objects.length} · 장면 ${loaded.project.scenes.length} · 에셋 ${loaded.assets.length}`);
  console.log(`  커널   ${options.kernel ? '켬' : '끔 (--no-kernel)'}`);
  console.log('  Ctrl+C 로 끕니다.');
  if (options.open) {
    openBrowser(server.url);
  }
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      void server.close().then(resolve);
    });
  });
  return 0;
}

function bench(loaded: Loaded, options: Options): number {
  const vm = new Vm({
    renderer: null,
    audio: new SilentAudioEngine(),
    fps: options.fps,
    stageWidth: options.stageWidth,
    stageHeight: options.stageHeight,
    kernel: options.kernel,
  });
  const compileStart = performance.now();
  vm.load(loaded.project as never);
  const compileMs = performance.now() - compileStart;

  vm.start();
  // Warm the JIT before measuring.
  for (let i = 0; i < 120; i += 1) {
    vm.tick();
  }
  const start = performance.now();
  for (let i = 0; i < options.ticks; i += 1) {
    vm.tick();
  }
  const elapsed = performance.now() - start;
  const perTick = elapsed / options.ticks;
  console.log(`${loaded.name}`);
  console.log(`  컴파일   ${compileMs.toFixed(1)} ms  (오브젝트 ${vm.targets.length} · ${vm.frameRate}fps)`);
  console.log(`  ${options.ticks} 틱  ${elapsed.toFixed(1)} ms  (틱당 ${perTick.toFixed(4)} ms)`);
  console.log(`  여유     ${(16.67 / perTick).toFixed(0)}× (60fps 한 프레임 예산 대비)`);
  console.log(vm.kernel
    ? `  커널     함수 ${vm.kernel.roots.size}개 · 실행 ${vm.kernel.stats.runs}회` +
      `${vm.kernel.stats.fallbacks ? ` · 되돌림 ${vm.kernel.stats.fallbacks}회` : ''}`
    : `  커널     없음${options.kernel ? '' : ' (--no-kernel)'}`);
  if (vm.errors.length) {
    console.log(`  오류 ${vm.errors.length}건 — 첫 번째: ${vm.errors[0]!.message}`);
  }
  return 0;
}

function exportWork(loaded: Loaded, options: Options): number {
  const shapes: Array<{ suffix: string; make: () => ExportResult }> = [];
  const settings = {
    project: loaded.project,
    assets: loaded.assets,
    name: loaded.name,
    quality: options.quality,
    fps: options.fps,
    stageWidth: options.stageWidth,
    stageHeight: options.stageHeight,
    autoStart: options.autoStart,
    boost: options.boost,
    svg: options.svg,
    kernel: options.kernel,
  };
  if (options.html) shapes.push({ suffix: '.html', make: () => exportHtml(settings) });
  if (options.zip || !options.html) shapes.push({ suffix: '.zip', make: () => exportZip(settings) });

  for (const shape of shapes) {
    const file = fileFor(options.out, loaded.name, shape.suffix, shapes.length > 1);
    const made = shape.make();
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, made.data);
    console.log(`${loaded.name} → ${file} (${(made.data.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  모듈 ${made.modules}개 · 에셋 ${made.assets}개 · 커널 ${made.kernel ? '켬' : '끔'}`);
  }
  return 0;
}

// Replace the output extension when writing both formats.
function fileFor(out: string | undefined, name: string, suffix: string, both: boolean): string {
  if (!out) {
    return `${name}${suffix}`;
  }
  if (!both && path.extname(out)) {
    return out;
  }
  return `${out.replace(/\.(zip|html)$/i, '')}${suffix}`;
}

function emit(loaded: Loaded): number {
  const vm = new Vm({ renderer: null, audio: null });
  vm.load(loaded.project as never);
  process.stdout.write(vm.compiledSource(loaded.project as never));
  return 0;
}

function check(loaded: Loaded, options: Options): number {
  const vm = new Vm({
    renderer: null,
    audio: null,
    kernel: options.kernel,
  });
  vm.load(loaded.project as never);
  const plan = vm.kernelPlan;
  if (plan?.roots.size) {
    console.log(`${loaded.name}: 커널로 내릴 함수 ${plan.roots.size}개 (값 ${plan.size}칸 · 깊이 ${plan.depth})`);
    const why = new Map<string, number>();
    for (const reason of plan.rejected.values()) {
      const kind = reason.startsWith('calls ') ? '부른 함수가 못 감' : reason;
      why.set(kind, (why.get(kind) ?? 0) + 1);
    }
    for (const [reason, count] of [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DIAGNOSTICS)) {
      console.log(`  못 감 ${String(count).padStart(4)}개  ${reason}`);
    }
  } else {
    console.log(`${loaded.name}: 커널로 내릴 함수가 없습니다.`);
  }
  if (!vm.unknownBlocks.size) {
    console.log(`${loaded.name}: 모든 블록을 실행할 수 있습니다.`);
    return 0;
  }
  const rows = [...vm.unknownBlocks.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`${loaded.name}: 아직 실행하지 못하는 블록 ${rows.length}종`);
  for (const [type, count] of rows) {
    console.log(`  ${type.padEnd(38)} ${count}개`);
  }
  return 0;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  } catch {
    // The printed URL still works if opening the browser fails.
  }
}

process.exitCode = await main();
