export { parse, parseOrThrow, check, validate } from "@entropy/parser";
export {
  compileProject,
  createCompileCache,
  makeEntryBundle,
  makeTar,
  verifyEntryProject,
} from "@entropy/compiler";
export { serveProject } from "@entropy/player";
export { decompileEnt, decompileProject } from "@entropy/decompiler";
export * as builtins from "@entropy/core/builtins";

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type {
  AssetFile,
  CompileCache,
  EntryProject,
  SourceMap,
} from "@entropy/compiler";
import type { DecompileResult, RawEntity, TarEntry } from '@entropy/decompiler';
import type { RunningServer as EntryServer } from "@entropy/player";
import type { RunningServer as VmServer } from "@entropy/vm";

type RunningServer = (EntryServer | VmServer) & {
  update(next: {
    project: EntryProject;
    assets?: AssetFile[];
    sourceMap?: SourceMap;
  }): void;
};

interface CliOptions {
  assets: string[];
  out?: string;
  name?: string;
  port?: number;
  noOpen?: boolean;
  noReload?: boolean;
  boost?: boolean;
  entry?: boolean;
  quality?: number;
  stage?: { width: number; height: number };
  fps?: number;
  warnings?: boolean;
  sizes?: boolean;
  keepSvg?: boolean;
  strict?: boolean;
  rounds?: number;
  // Reuse parsed files across watch rebuilds.
  cache?: CompileCache;
}
import { spawn } from "node:child_process";
import { parse } from "@entropy/parser";
import {
  compileProject,
  createCompileCache,
  makeEntryBundle,
} from "@entropy/compiler";
import { serveProject } from "@entropy/player";
import { serveVm } from "@entropy/vm";
import * as out from "./src/output.ts";

const USAGE = `사용법
  node index.ts check      <파일.etp|파일.ent> 문법·의미 또는 3회 왕복 호환성 검사
  node index.ts build      <파일.etp> [-o 출력] 엔트리 작품으로 컴파일
  node index.ts run        <파일.etp>          컴파일 후 브라우저에서 실행 (entropy)
  node index.ts ast        <파일.etp>          AST 구조 출력
  node index.ts decompile  <파일.ent> [-o 폴더]  기존 엔트리 작품을 Entropy 소스로 디컴파일

옵션
  -o, --out <경로>   출력 파일 또는 폴더를 지정합니다.
                     - build 명령 시: 확장자가 .json이면 project.json으로,
                       .ent이면 tar 묶음으로 저장합니다.
                     - decompile 명령 시: 폴더를 생성하여 main.entropy와 에셋을 저장합니다.
                       (기본값: <파일 이름>_entropy/)
  --assets <폴더>    모양 및 소리 파일을 검색할 폴더를 지정합니다. (여러 번 지정 가능)
  --name <이름>      작품 이름을 지정합니다. (기본값: project 블록의 title)
  --port <번호>      run 명령 시 사용할 포트 번호를 지정합니다.
                     (기본값: Entropy 2014 · 엔트리 실행기 2013,
                      사용 중인 경우 빈 포트 자동 할당)
  --no-open          run 명령 시 브라우저를 자동으로 열지 않도록 설정합니다.
  --no-reload        run 명령 시 소스가 변경되어도 자동 새로고침을 하지 않습니다.
  --entry            run 명령을 엔트리 실행기(entryjs)로 돌립니다.
                     (기본값은 Entropy 입니다 — 같은 규칙으로 훨씬 빠르게 돕니다.)
  --quality <배수>   run 명령 시 화질 배수 1 · 2 · 4 (Entropy 전용, 기본 1)
  --stage <가로x세로> run 명령 시 무대 크기 (Entropy 전용, 기본 480x270)
  --fps <값>         run 명령 시 틱 속도 (Entropy 전용, 기본은 작품이 정한 speed)
  --boost            엔트리 실행기(--entry)를 WebGL 렌더러로 돌립니다.
                     Entropy는 늘 WebGL 이라 '부스트 모드인가?' 가 언제나 참이고,
                     이 옵션과 상관이 없습니다. (build 명령에는 적용되지 않습니다.)
  --strict           느슨한 실행을 끕니다. 컴파일 에러가 하나라도 있으면 build/run을
                     중단하고, '주의'로 알리던 것을 '경고'로 올려서 보여줍니다.
                     (기본값은 느슨한 실행입니다 — 에러가 난 문장만 빼고 진행합니다.)
  --rounds <횟수>    .ent check 왕복 검사 횟수 (1~10, 기본 3)
  --warnings         decompile 명령 시 변환하지 못한 부분을 콘솔에 출력하여 알려줍니다.
                     (기본적으로는 소스 내에 '# [decompile]' 주석으로만 남깁니다.)
  --sizes            decompile 명령 시 모든 모양(costume)에 'size 가로 세로' 속성을 명시합니다.
                     (기본적으로 글상자를 제외한 모양 크기는 이미지 파일 자체의 크기를 따릅니다.)
  --keep-svg         decompile 명령 시 SVG 모양을 PNG로 대체하지 않고 원본 그대로 유지합니다.`;

function parseArgs(argv: string[]) {
  const options: CliOptions = { assets: [] };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--out") options.out = argv[++i];
    else if (arg === "--assets") options.assets.push(argv[++i]!);
    else if (arg === "--name") options.name = argv[++i];
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--no-reload") options.noReload = true;
    else if (arg === "--boost") options.boost = true;
    else if (arg === "--entry") options.entry = true;
    else if (arg === "--quality") options.quality = Number(argv[++i]);
    else if (arg === "--fps") options.fps = Number(argv[++i]);
    else if (arg === "--stage") {
      const [width, height] = String(argv[++i] ?? "").split(/[x×,]/);
      if (Number(width) && Number(height)) {
        options.stage = { width: Number(width), height: Number(height) };
      }
    }
    else if (arg === "--warnings") options.warnings = true;
    else if (arg === "--sizes") options.sizes = true;
    else if (arg === "--keep-svg") options.keepSvg = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--rounds") options.rounds = Number(argv[++i]);
    else rest.push(arg!);
  }
  return { options, rest };
}

async function runCheck(file: string, options: CliOptions = { assets: [] }): Promise<number> {
  if (path.extname(file).toLowerCase() === '.ent') return runEntCheck(file, options);
  const source = fs.readFileSync(file, "utf-8");
  const label = path.basename(file);
  const assetDirs = assetDirsFor(file, options);

  out.begin("check", file);
  const result = compileProject(source, {
    path: file,
    assetDirs,
    name: options.name,
    strict: options.strict,
    cache: options.cache,
    onPhase: out.step,
  });
  out.report(label, result.errors, "에러");
  out.report(label, result.warnings, "경고");
  out.report(label, result.notices, "주의");

  if (!result.ok) {
    out.outro(out.red(`${label}: 에러 ${result.errors.length}개`));
    return 1;
  }
  out.outro(`${out.green("OK")}  ${label}`);
  return 0;
}

async function runEntCheck(file: string, options: CliOptions): Promise<number> {
  const rounds = options.rounds ?? 3;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
    console.error('--rounds 는 1부터 10 사이의 정수여야 합니다.');
    return 2;
  }
  const { decompileProject, findProjectEntry, readTar } = await import('@entropy/decompiler');
  const { verifyEntryProject } = await import('@entropy/compiler');
  out.begin('check', file);
  let entries: TarEntry[];
  try {
    entries = await readTar(fs.readFileSync(file));
  } catch (error) {
    out.log.error(`.ent 압축을 읽지 못했습니다: ${(error as Error).message}`);
    out.outro(out.red(`${path.basename(file)}: 올바른 Entry 작품인지 확인하세요.`));
    return 1;
  }
  const projectEntry = findProjectEntry(entries);
  if (!projectEntry) {
    console.error(`${path.basename(file)}: project.json 이 없는 .ent 파일입니다.`);
    return 1;
  }
  const decoder = new TextDecoder('utf-8');
  let project: RawEntity;
  try {
    project = JSON.parse(decoder.decode(projectEntry.data));
  } catch (error) {
    out.log.error(`project.json 을 읽지 못했습니다: ${(error as Error).message}`);
    out.outro(out.red(`${path.basename(file)}: project.json 이 손상됐습니다.`));
    return 1;
  }
  const originalProblems = verifyEntryProject(project as never, { references: false });
  if (originalProblems.length > 0) {
    // Old Entry releases have saved tolerable leftovers such as stale function
    // slots and duplicate nested block IDs. Report them, but judge the file by
    // the freshly compiled project that users will actually upload.
    out.log.warn(`원본 Entry 스키마 주의 ${originalProblems.length}개\n${originalProblems.join('\n')}`);
  }
  let previousSource: string | null = null;
  let decompileWarnings = 0;
  let decompileNotices = 0;
  const sourcePath = path.resolve(file.replace(/\.ent$/i, '.etp'));
  const virtualRoot = path.dirname(sourcePath);

  for (let round = 1; round <= rounds; round += 1) {
    let result: DecompileResult;
    try {
      result = decompileProject(project, entries, { inline: true, strict: options.strict });
    } catch (error) {
      out.log.error(`${round}회차 되돌리기에 실패했습니다: ${(error as Error).message}`);
      out.outro(out.red(`${path.basename(file)}: 손상되거나 지원하지 않는 작품 구조입니다.`));
      return 1;
    }
    if (round === 1) {
      decompileWarnings = result.warnings.length;
      decompileNotices = result.notices.length;
      for (const warning of result.warnings) out.log.warn(`되돌리기: ${warning}`);
      for (const notice of result.notices) out.log.message(`되돌리기: ${notice}`);
    }
    if (previousSource !== null && result.source !== previousSource) {
      out.log.error(`${round}회차에 Entropy 소스가 다시 달라졌습니다. 반복 왕복 누적 변형 버그입니다.`);
      out.outro(out.red(`${path.basename(file)}: 왕복 안정성 실패`));
      return 1;
    }

    const files = new Map(result.assets.map((asset) => [
      path.resolve(virtualRoot, asset.path), asset.data,
    ]));
    const host = {
      resolve: (base: string, target: string) => path.resolve(base, target),
      isFile: (target: string) => files.has(target),
      readFile: (target: string) => files.get(target) ?? null,
      readText: (target: string) => files.has(target) ? decoder.decode(files.get(target)!) : null,
    };
    const compiled = compileProject(result.source, {
      path: sourcePath, assetDirs: [virtualRoot], host,
      strict: options.strict,
    });
    if (round === 1) {
      out.report(path.basename(file), compiled.errors, '에러');
      out.report(path.basename(file), compiled.warnings, '경고');
      out.report(path.basename(file), compiled.notices, '주의');
    }
    if (!compiled.project || compiled.errors.length > 0) {
      out.outro(out.red(`${path.basename(file)}: ${round}회차 재컴파일 실패`));
      return 1;
    }
    const problems = verifyEntryProject(compiled.project, { references: false });
    if (problems.length > 0) {
      out.log.error(`Entry 스키마 문제 ${problems.length}개\n${problems.join('\n')}`);
      out.outro(out.red(`${path.basename(file)}: ${round}회차 Entry 호환성 실패`));
      return 1;
    }

    entries = compiled.assets.flatMap((asset) => {
      const data = files.get(asset.source);
      return data ? [{ name: asset.target, data }] : [];
    });
    project = compiled.project;
    previousSource = result.source;
  }

  out.note(out.details([
    ['왕복 검사', `${rounds}회`],
    ['되돌리기 경고', `${decompileWarnings}개`],
    ['되돌리기 주의', `${decompileNotices}개`],
    ['원본 스키마 주의', `${originalProblems.length}개${originalProblems.length ? ' (왕복 결과에서 정리됨)' : ''}`],
    ['Entry 스키마', '문제 없음'],
  ]), '요약');
  out.outro(`${out.green('OK')}  ${path.basename(file)}`);
  return 0;
}

function assetDirsFor(file: string, options: CliOptions): string[] {
  return (options.assets?.length ?? 0) > 0
    ? options.assets.map((dir) => path.resolve(dir))
    : [path.dirname(path.resolve(file))];
}

function runAst(file: string): number {
  const source = fs.readFileSync(file, "utf-8");
  const result = parse(source);
  if (!result.ok) {
    out.report(path.basename(file), result.errors, "에러");
    return 1;
  }
  console.log(JSON.stringify(result.ast, null, 2));
  return 0;
}

async function runBuild(file: string, options: CliOptions): Promise<number> {
  const source = fs.readFileSync(file, "utf-8");
  const label = path.basename(file);
  const assetDirs = assetDirsFor(file, options);

  out.begin("build", file);
  const result = compileProject(source, {
    path: file,
    assetDirs,
    name: options.name,
    strict: options.strict,
    cache: options.cache,
    onPhase: out.step,
  });
  out.report(label, result.warnings, "경고");
  out.report(label, result.notices, "주의");
  if (!result.ok) {
    out.report(label, result.errors, "에러");
    // Syntax errors leave no project to export, even in loose mode.
    if (options.strict || !result.project) {
      out.outro(
        out.red(
          `${label}: 에러 ${result.errors.length}개로 인해 내보낼 수 없습니다.`,
        ),
      );
      return 1;
    }
    out.log.warn(
      `에러 ${result.errors.length}개가 난 문장을 빼고 내보냅니다. `
        + `--strict 를 붙이면 여기서 멈춥니다.`,
    );
  }

  const outPath = options.out ?? `${file.replace(/\.etp$/, "")}.ent`;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });

  const asJson = outPath.endsWith(".json");
  const spin = out.working(
    asJson ? "작품 내보내는 중" : "작품 묶는 중",
  );
  try {
    fs.writeFileSync(
      outPath,
      asJson
        ? JSON.stringify(result.project, null, 2)
        : await makeEntryBundle(result.project!, result.assets),
    );
  } catch (error) {
    spin.fail(`내보내지 못했습니다: ${(error as Error).message}`);
    out.outro(out.red(`${label}: 실패`));
    return 1;
  }
  spin.done(asJson ? "파일 쓰기" : "묶기 · 파일 쓰기");

  const project = result.project!;
  const blocks = project.objects.reduce(
    (sum: number, o) => sum + countBlocks(JSON.parse(o.script)),
    0,
  );
  out.note(
    out.details([
      ["장면", String(project.scenes.length)],
      ["오브젝트", String(project.objects.length)],
      ["변수", String(project.variables.length)],
      ["신호", String(project.messages.length)],
      ["함수", String(project.functions.length)],
      ["블록", String(blocks)],
    ]),
    "요약",
  );
  out.outro(`${out.green("완료")}  ${label} ${out.dim("->")} ${outPath}`);
  return 0;
}

function openServer(
  file: string,
  options: CliOptions,
  result: { project: EntryProject | null; assets: AssetFile[]; sourceMap?: SourceMap },
  reload: boolean,
): Promise<RunningServer> {
  const assetDirs = assetDirsFor(file, options);
  const shared = {
    project: result.project!,
    assets: result.assets,
    assetDirs,
    name: result.project!.name,
    port: options.port,
    reload,
    sourceMap: result.sourceMap,
    boost: options.boost,
  };
  if (options.entry) {
    return serveProject({ ...shared, cwd: path.dirname(path.resolve(file)) });
  }
  return serveVm({
    ...shared,
    quality: options.quality,
    fps: options.fps,
    stageWidth: options.stage?.width,
    stageHeight: options.stage?.height,
  });
}

async function runProject(
  file: string,
  options: CliOptions,
): Promise<number | null> {
  const source = fs.readFileSync(file, "utf-8");
  const label = path.basename(file);
  const assetDirs = assetDirsFor(file, options);

  out.begin("run", file);
  const result = compileProject(source, {
    path: file,
    assetDirs,
    name: options.name,
    strict: options.strict,
    cache: options.cache,
    onPhase: out.step,
  });
  out.report(label, result.warnings, "경고");
  out.report(label, result.notices, "주의");
  if (!result.ok) {
    out.report(label, result.errors, "에러");
    if (options.strict || !result.project) {
      out.outro(
        out.red(
          `${label}: 에러 ${result.errors.length}개로 인해 실행할 수 없습니다.`,
        ),
      );
      return 1;
    }
    out.log.warn(
      `에러 ${result.errors.length}개가 난 문장을 빼고 실행합니다. `
        + `--strict 를 붙이면 여기서 멈춥니다.`,
    );
  }

  const reload = !options.noReload;
  const spin = out.working("서버 여는 중");
  const server = await openServer(file, options, result, reload);

  spin.done("서버 준비");

  const rows: Array<[string, string]> = [
    ["주소", out.cyan(server.url)],
    ["실행기", server.runtime],
    [
      "새로고침",
      reload ? "켜짐  " + out.dim("--no-reload 로 끌 수 있습니다") : "꺼짐",
    ],
  ];
  // Only Entry changes renderers with boost; Entropy always uses WebGL.
  if (options.boost && options.entry) {
    rows.push(["부스트", "켜짐  " + out.dim("WebGL 렌더러")]);
  }
  out.note(out.details(rows), "실행 중");

  out.outro(out.dim("Ctrl+C 로 끕니다."));
  if (!options.noOpen) openBrowser(server.url);

  const stopWatching = reload
    ? watchAndReload(file, options, assetDirs, label, server)
    : null;

  process.on("SIGINT", () => {
    stopWatching?.();
    // Force exit if open sockets prevent the server from closing.
    const forceExit = setTimeout(() => process.exit(0), 2000);
    forceExit.unref();
    server.close().then(() => process.exit(0));
  });
  return null;
}

// Reuse the compile cache so only changed files are parsed again.
function watchAndReload(
  file: string,
  options: CliOptions,
  assetDirs: string[],
  label: string,
  server: RunningServer,
) {
  const watchDirs = new Set([path.dirname(path.resolve(file)), ...assetDirs]);
  const cache = options.cache ?? createCompileCache();
  let timer: NodeJS.Timeout | null = null;

  const rebuild = () => {
    try {
      const source = fs.readFileSync(file, "utf-8");
      const before = cache.parsed;
      const started = Date.now();
      const result = compileProject(source, {
        path: file,
        assetDirs,
        name: options.name,
        strict: options.strict,
        cache,
      });
      out.report(label, result.warnings, "경고");
      out.report(label, result.notices, "주의");
      if (!result.ok) {
        out.report(label, result.errors, "에러");
        if (options.strict || !result.project) {
          out.log.warn("다시 불러오기 실패 — 이전 버전을 계속 보여줍니다.");
          return;
        }
        out.log.warn(
          `에러 ${result.errors.length}개가 난 문장을 빼고 반영합니다.`,
        );
      }
      server.update({
        project: result.project!,
        assets: result.assets,
        sourceMap: result.sourceMap,
      });
      const parsed = cache.parsed - before;
      out.log.success(
        `${out.green("다시 불러왔습니다")}  ` +
          out.dim(`파일 ${parsed}개 · ${out.duration(Date.now() - started)}`),
      );
    } catch (error) {
      out.log.error(`다시 불러오기 실패 — ${(error as Error).message}`);
    }
  };

  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  };

  // Object fragments need a recursive watch because they live in subfolders.
  const watchers: fs.FSWatcher[] = [];
  for (const dir of watchDirs) {
    try {
      watchers.push(fs.watch(dir, { recursive: true }, onChange));
    } catch {
      try {
        watchers.push(fs.watch(dir, onChange));
      } catch {
        // Missing or unwatched folders should not stop the server.
      }
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    watchers.forEach((watcher) => watcher.close());
  };
}

function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL still works if opening the browser fails.
  }
}

function countBlocks(node: any): number {
  if (Array.isArray(node))
    return node.reduce((sum, item) => sum + countBlocks(item), 0);
  if (!node || typeof node !== "object" || !node.type) return 0;
  return (
    1 + countBlocks(node.params ?? []) + countBlocks(node.statements ?? [])
  );
}

// Decompile notes also appear in the source; expand the full list only on request.
function showDecompileNotes(
  warnings: string[],
  notices: string[],
  options: CliOptions,
) {
  if (warnings.length + notices.length === 0) return;
  if (!options.warnings) {
    out.log.info(out.dim("--warnings 를 붙이면 모든 경고와 주의를 볼 수 있습니다."));
    return;
  }
  const listOf = (items: string[], paint: (text: unknown) => string) => {
    const shown = items.slice(0, 20);
    const more = items.length - shown.length;
    return [...shown.map(paint), ...(more > 0 ? [out.dim(`… 외 ${more}개`)] : [])]
      .join("\n");
  };
  if (warnings.length > 0) out.log.warn(listOf(warnings, String));
  if (notices.length > 0) {
    out.log.message(listOf(notices, out.grey), { symbol: out.dim("·") });
  }
}

async function runDecompile(
  file: string,
  options: CliOptions,
): Promise<number> {
  const { decompileEnt } = await import("@entropy/decompiler");
  const label = path.basename(file);
  const bytes = fs.readFileSync(file);

  out.begin("decompile", file);
  const reading = out.working("작품 읽는 중");
  let result;
  try {
    result = await decompileEnt(bytes, {
      sizes: options.sizes,
      keepSvg: options.keepSvg,
      strict: options.strict,
    });
  } catch (error) {
    reading.fail(`되돌리기 실패 — ${(error as Error).message}`);
    out.outro(out.red(`${label}: 실패`));
    return 1;
  }
  reading.done("작품 읽기");

  const outDir = options.out ?? `${file.replace(/\.ent$/i, "")}_entropy`;
  const writing = out.working("소스와 에셋 쓰는 중");
  fs.mkdirSync(outDir, { recursive: true });
  const mainFile = path.join(outDir, "main.etp");
  fs.writeFileSync(mainFile, result.source);
  for (const asset of result.assets) {
    const target = path.join(outDir, asset.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }
  writing.done("파일 쓰기");

  const fragmentCount = result.assets.filter((asset) =>
    asset.path.endsWith(".etp"),
  ).length;

  const rows: Array<[string, string]> = [
    ["오브젝트 조각", `${fragmentCount}개`],
    ["모양 · 소리", `${result.assets.length - fragmentCount}개`],
  ];
  if (result.warnings.length > 0) {
    rows.push(["경고", out.yellow(`${result.warnings.length}개`)]);
  }
  if (result.notices.length > 0) {
    rows.push(["주의", out.grey(`${result.notices.length}개`)]);
  }
  out.note(out.details(rows), "요약");

  showDecompileNotes(result.warnings, result.notices, options);

  try {
    const recheck = compileProject(result.source, {
      path: mainFile,
      assetDirs: [outDir],
      strict: options.strict,
    });
    if (recheck.ok)
      out.log.success("되돌린 소스가 다시 정상적으로 컴파일됩니다.");
    else {
      out.log.warn(
        `되돌린 소스에 아직 컴파일 에러가 ${recheck.errors.length}개 있습니다.\n` +
          out.dim(`node index.ts check ${mainFile}`),
      );
    }
  } catch {
    // Recompilation is advisory; keep the output even if it fails.
  }

  out.outro(`${out.green("완료")}  ${label} ${out.dim("->")} ${mainFile}`);
  return 0;
}

async function main(argv: string[]): Promise<number | null> {
  const { options, rest } = parseArgs(argv);
  // Share one parse cache across input files and watch rebuilds.
  options.cache = createCompileCache();
  const [first, ...others] = rest;
  const commands: Record<
    string,
    (
      file: string,
      options: CliOptions,
    ) => number | null | Promise<number | null>
  > = {
    check: runCheck,
    build: runBuild,
    run: runProject,
    ast: runAst,
    decompile: runDecompile,
  };

  const command = first && commands[first] ? first : "check";
  const files = first && commands[first] ? others : rest;

  if (files.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (command !== "decompile" && command !== "check" && ext === ".ent") {
      console.error(
        `${path.basename(file)}: .ent 파일을 바로 실행하거나 확인할 수 없습니다.` +
          ` 'decompile ${file}' 명령어로 Entropy 소스로 변환하세요.`,
      );
      process.exit(2);
    }
    if (command === "decompile" && ext === ".etp") {
      console.error(
        `${path.basename(file)}: decompile 명령어는 .ent 파일을 인수로 받습니다.` +
          " Entropy 소스를 엔트리 작품으로 만들려면 build 명령어를 사용하세요.",
      );
      process.exit(2);
    }
  }

  let failed = 0;
  let keepAlive = false;
  for (const file of files) {
    const code = await commands[command]!(file, options);
    if (code === null) keepAlive = true;
    else failed = Math.max(failed, code);
  }
  if (!keepAlive) process.exit(failed);
  return null;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
