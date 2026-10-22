// Load dependencies before Entry because the engine expects their globals.

import { DEBUG_PANEL_STYLE } from './debug-style.ts';

// Keep CreateJS 2015.11.26; newer EaselJS drops cache fields that Entry's collision bounds need.
export const THIRD_PARTY_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
  'https://cdn.jsdelivr.net/npm/createjs@1.0.1/builds/createjs-2015.11.26.min.js',
  'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js',
  'https://cdn.jsdelivr.net/npm/jquery-ui-dist@1.13.2/jquery-ui.min.js',
  'https://cdn.jsdelivr.net/npm/velocity-animate@1.5.2/velocity.min.js',
  'https://cdn.jsdelivr.net/npm/react@16.14.0/umd/react.production.min.js',
  'https://cdn.jsdelivr.net/npm/react-dom@16.14.0/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@entrylabs/tool@2.0.9/dist/entry-tool.js',
  'https://cdn.jsdelivr.net/npm/@entrylabs/legacy-video@1.0.1/dist/index.js',
];

export const THIRD_PARTY_STYLE = 'https://cdn.jsdelivr.net/npm/@entrylabs/tool@2.0.9/dist/entry-tool.css';

// Load Entry's font CSS because the engine package does not include its page-level font faces.
const ENTRY_FONTS_BASE = 'https://entry-cdn.pstatic.net/uploads/fonts';

// Load font styles directly to avoid the extra import round trip before the first frame.
export const ENTRY_FONT_STYLES = [
  'nanum_gothic', 'jejuhallasan_2023', 'kopubbatang_2023', 'nanumgothiccoding_2023',
  'nanummyeongjo_2023', 'nanumpenscript_2023', 'designhouse_2023', 'dunggeunmo_2023',
  'jalnan_2023', 'square_round_2023', 'uhbeemysen_2023', 'SDComicStencil_2023',
  'SDChildfundkorea_2023', 'SDCinemaTheater_2023', 'SDMapssi_2023', 'SDShabang_2023',
  'SDWoodcarving_2023', 'SDYongbi_2023', 'notosans_2023', 'nanumbarunpen_2023',
  'maruburi_2023', 'd2coding_2023',
].map((name) => `${ENTRY_FONTS_BASE}/${name}.css`);

export const RUNTIME_FILES = [
  'extern/util/filbert.js',
  'extern/util/CanvasInput.js',
  'extern/util/ndgmr.Collision.js',
  'extern/util/handle.js',
  'extern/util/bignumber.min.js',
  'extern/lang/ko.js',
  'extern/util/static.js',
  'dist/entry.min.js',
];

export const RUNTIME_STYLE = 'dist/entry.css';

export const DEBUG_UI_PATH = '/debug-ui.js';
export const PREACT_PATH = '/preact/';

const escapeHtml = (text: unknown) => String(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// Escape script terminators in JS literals; HTML escaping does not protect script contents.
const jsValue = (value: unknown) => JSON.stringify(value ?? null)
  .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
  .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

export interface PlayerPageOptions {
  name: string;
  base: string;
  // Use the same origin for Entry's default images in WebGL mode.
  mediaBase?: string;
  summary: { scenes: number; objects: number; blocks: number };
  entName: string;
  reload?: boolean;
  boost?: boolean;
}

export function playerPage({
  name, base, mediaBase = base, summary, entName, reload = true, boost = false,
}: PlayerPageOptions): string {
  // Set crossorigin on CDN scripts so browser errors include real messages and stacks.
  const libBase = escapeHtml(base);
  const thirdPartyScripts = THIRD_PARTY_SCRIPTS
    .map((url) => `<script src="${escapeHtml(url)}" crossorigin="anonymous"></script>`)
    .join('\n    ');
  const runtimeScripts = RUNTIME_FILES
    .map((file) => `<script src="${libBase}/${escapeHtml(file)}" crossorigin="anonymous"></script>`)
    .join('\n    ');
  const fontStyles = ENTRY_FONT_STYLES
    .map((url) => `<link rel="stylesheet" href="${escapeHtml(url)}">`)
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} — Tess</title>
<link rel="stylesheet" href="${escapeHtml(THIRD_PARTY_STYLE)}">
<link rel="stylesheet" href="${libBase}/${escapeHtml(RUNTIME_STYLE)}">
${fontStyles}
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #16181d;
    display: flex; flex-direction: column; overflow: hidden;
  }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e8eaee; } }
  /* Reserve panel width so it stays beside the stage instead of covering it. */
  header {
    display: flex; align-items: baseline; gap: 12px; padding: 12px 18px; border-bottom: 1px solid #0002;
    flex: none; box-sizing: border-box; padding-right: calc(18px + var(--debug-panel-width));
  }
  header h1 { font-size: 16px; margin: 0; }
  header .summary { font-size: 13px; opacity: .7; }
  header .reload-status { font-size: 12px; opacity: .55; }
  header a { margin-left: auto; font-size: 13px; }
  /* Override Entry's minimized-preview sizing so the workspace fits the remaining viewport. */
  #workspace {
    flex: 1 1 auto; min-height: 0; height: auto; padding-top: 0; max-height: none;
    box-sizing: border-box; padding-right: var(--debug-panel-width);
    transition: padding-right .15s ease-out;
  }
  /* Override Entry's fixed preview width; layout code calculates the displayed canvas size. */
  #entryCanvas { display: block; margin: 0 auto; }
  #fallback { display: none; max-width: 640px; margin: 40px auto; padding: 24px 28px; border-radius: 12px;
              background: #fff; box-shadow: 0 1px 3px #0002; line-height: 1.7; }
  @media (prefers-color-scheme: dark) { #fallback { background: #21242b; } }
  #fallback h2 { margin-top: 0; font-size: 17px; }
  #fallback code { background: #0001; padding: 1px 5px; border-radius: 4px; }
  #fallback ol { padding-left: 20px; }
  ${DEBUG_PANEL_STYLE}

  .entryEngineMinimize .entryStopButtonMinimize { margin-right: 20px; }

  /* Wait for viewer input before starting so browser autoplay permits sound. */
  #start-gate {
    position: fixed; inset: 0; z-index: 900;
    display: flex; align-items: center; justify-content: center;
    background: #10131acc; cursor: pointer;
  }
  #start-gate-card {
    display: flex; align-items: center; gap: 8px;
    color: #fff; font-size: 15px; padding: 14px 24px; border-radius: 999px;
    background: #ffffff22; border: 1px solid #ffffff55; backdrop-filter: blur(2px);
  }
  #start-gate-card .icon { font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(name)}</h1>
  <span class="summary">장면 ${summary.scenes} · 오브젝트 ${summary.objects} · 블록 ${summary.blocks}</span>
  ${reload ? '<span class="reload-status" id="reload-status">자동 새로고침 켜짐</span>' : ''}
  <button id="debug-toggle" class="debug-toggle-btn" type="button">
    디버그 <span id="debug-badge" class="badge" hidden>0</span>
  </button>
  <a href="/${escapeHtml(entName)}" download>작품 파일(.ent) 내려받기</a>
</header>

<div id="workspace"></div>

<div id="start-gate" role="button" tabindex="0" aria-label="클릭하거나 아무 키나 눌러서 시작">
  <div id="start-gate-card"><span class="icon">▶</span> 클릭하거나 아무 키나 눌러서 시작</div>
</div>

<aside id="debug-panel" aria-hidden="true"></aside>

<section id="fallback">
  <h2>엔트리 실행기를 불러오지 못했습니다</h2>
  <p>작품은 정상적으로 컴파일됐습니다. 실행기(entryjs)만 못 가져왔습니다.</p>
  <ol>
    <li>인터넷이 막혀 있다면 <code>bun add -d @entrylabs/entry</code> 로 설치한 뒤 다시 <code>run</code> 하세요.
        entryjs 본체는 설치돼 있으면 그 파일을 쓰지만, 서드파티 라이브러리(createjs 등)는
        여전히 인터넷에서 받아야 한다.</li>
    <li>또는 위의 <b>작품 파일(.ent) 내려받기</b> 를 눌러 받은 뒤,
        <a href="https://playentry.org/ws/new" target="_blank" rel="noreferrer">playentry.org</a> 에서
        <b>불러오기 → 오프라인 작품 불러오기</b> 로 열면 됩니다.</li>
  </ol>
  <p id="fallback-reason" style="opacity:.7; font-size:13px"></p>
</section>


<script>
// Buffer early errors until the deferred debug module loads.
(function () {
  const pending = [];
  let sink = null;

  window.tessDebugSink = (fn) => {
    sink = fn;
    for (const item of pending.splice(0)) sink(item);
  };
  window.tessReportError = function reportError(kind, error) {
    const item = {
      kind: String(kind),
      message: (error && error.message) || String(error),
      stack: (error && error.stack) || '',
      time: Date.now(),
    };
    if (sink) sink(item); else pending.push(item);
    fetch('/__log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item),
    }).catch(() => {});
  };

  // Ignore this CreateJS preload warning because it does not affect playback.
  const benign = (message) => /setPlaybackResource is not a function/.test(message ?? '');

  window.addEventListener('error', (event) => {
    if (benign(event.message) || benign(event.error?.message)) return;
    if (event.target && event.target !== window && !event.message) {
      const what = event.target.src || event.target.href || '리소스';
      window.tessReportError('로딩 실패', new Error(what + ' 를 불러오지 못했습니다.'));
      return;
    }
    window.tessReportError('실행 오류', event.error || new Error(event.message));
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (reason && reason.tessAlreadyReported) return; // stopProjectWithToast 가 이미 보고했다
    if (benign(reason && reason.message)) return;
    window.tessReportError('처리되지 않은 Promise 거부', reason instanceof Error ? reason : new Error(String(reason)));
  });

  // Use no-op hooks until the debug panel loads.
  window.tessLayoutCanvas = () => {};
  window.tessHighlightBlock = () => {};
  window.tessRenderProjectDebug = () => {};
  window.tessPatchEnvironmentBlocks = () => {};
})();
</script>
${thirdPartyScripts}
<script>
  window.EntrySoundEditor = window.EntrySoundEditor || {};
  window.EntryPaint = window.EntryPaint || {};
</script>
<script>
(function () {
  // Unlock desktop audio during a viewer gesture because SoundJS installs automatic unlocking only for touch.
  const unlock = () => {
    try {
      const ctx = window.createjs && createjs.WebAudioPlugin && createjs.WebAudioPlugin.context;
      if (!ctx) return; // 아직 안 만들어졌으면 다음 상호작용 때 다시 시도한다
      if (ctx.state !== 'running') {
        const source = ctx.createBufferSource();
        source.buffer = ctx.createBuffer(1, 1, 22050);
        source.connect(ctx.destination);
        source.start(0);
        ctx.resume && ctx.resume();
      }
      if (ctx.state === 'running') detach();
    } catch (e) { /* Retry audio unlocking on the next gesture if it fails. */ }
  };
  const events = ['mousedown', 'click', 'touchstart', 'keydown'];
  const detach = () => events.forEach((type) => document.removeEventListener(type, unlock, true));
  events.forEach((type) => document.addEventListener(type, unlock, true));
})();
</script>
${runtimeScripts}
<script type="module" src="${DEBUG_UI_PATH}"></script>
<script type="module">
(async function () {
  const showFallback = (reason) => {
    document.getElementById('workspace').style.display = 'none';
    document.getElementById('fallback').style.display = 'block';
    document.getElementById('fallback-reason').textContent = reason;
    document.getElementById('start-gate')?.remove();
  };

  if (typeof window.Entry === 'undefined' || typeof window.Entry.init !== 'function') {
    showFallback('entryjs 를 불러오지 못했습니다 (라이브러리 로딩 실패). 인터넷 연결을 확인하세요.');
    return;
  }

  // Route Entry runtime failures to the debug panel with block and source positions.
  const interceptRuntimeErrors = (sourceMap) => {
    if (Entry.toast) {
      Entry.toast.alert = function (title, message) {
        const text = Array.isArray(message) ? message.join(' ') : String(message ?? '');
        window.tessReportError(String(title || '알림'), new Error(text));
      };
      // Suppress editor-only warnings in the minimized viewer; runtime failures still use error reporting.
      Entry.toast.warning = function () {};
    }
    if (!Entry.Utils) return;
    Entry.Utils.stopProjectWithToast = async function (scope, type, err) {
      const kind = type || 'Runtime Error';
      const block = scope && scope.block;
      const blockId = block && (block.id || (typeof block.getId === 'function' && block.getId()));

      let objectName = '';
      try {
        const code = block && typeof block.getCode === 'function' && block.getCode();
        if (code && code.object) objectName = code.object.name || code.object.id || '';
      } catch (e) { /* Continue reporting even when the object's name is unavailable. */ }

      const loc = (blockId && sourceMap[blockId]) || null;
      const where = loc
        ? (loc.file ? loc.file + ':' : '') + loc.line + ':' + loc.column
        : (blockId ? '컴파일된 블록 ' + blockId : '위치를 알 수 없음');
      const label = [objectName, block && block.type].filter(Boolean).join(' / ');
      const friendlyMessage = blockId && window.tessDescribeListIndexError
        ? window.tessDescribeListIndexError(blockId, err)
        : null;
      const baseMessage = friendlyMessage || (err && err.message) || kind;

      const error = new Error((label ? label + ' — ' : '') + baseMessage + ' (' + where + ')');
      if (err && err.stack) error.stack = err.stack;
      error.tessAlreadyReported = true;

      window.tessReportError(kind, error);
      if (blockId) window.tessHighlightBlock(blockId);

      try {
        if (Entry.engine && Entry.engine.isState && Entry.engine.isState('run') && Entry.engine.toggleStop) {
          await Entry.engine.toggleStop();
        }
      } catch (e) { /* Preserve the original error even if stopping the engine fails. */ }

      throw error; // entryjs 실행기가 이 스레드를 끝내는 데 필요한 신호라 그대로 던진다
    };
  };

  // Wait for font styles before preloading because canvas does not redraw after late font downloads.
  const waitForFontStyles = () => {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .filter((link) => link.href.includes('/uploads/fonts/') && !link.sheet);
    if (links.length === 0) return Promise.resolve();
    return Promise.race([
      Promise.all(links.map((link) => new Promise((resolve) => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
      }))),
      // Bound the font wait so blocked CDNs cannot prevent starting forever.
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  };

  const preloadTextFonts = async (project) => {
    const fonts = new Set(
      (project.objects ?? [])
        .filter((object) => object.objectType === 'textBox' && object.entity?.font)
        .map((object) => object.entity.font),
    );
    if (fonts.size === 0) return;
    await waitForFontStyles();
    await Promise.all([...fonts].map((font) => document.fonts.load(font).catch(() => {})));
    await document.fonts.ready.catch(() => {});
  };

  // Keep the start cover until sounds load, while using its gesture to unlock audio.
  const waitForStartGate = () => new Promise((resolve) => {
    const gate = document.getElementById('start-gate');
    if (!gate) { resolve(); return; }
    const dismiss = () => {
      gate.removeEventListener('click', dismiss);
      gate.removeEventListener('keydown', dismiss);
      resolve();
    };
    gate.addEventListener('click', dismiss);
    gate.addEventListener('keydown', dismiss);
    gate.focus();
  });

  // Wait for soundLoaded with a timeout because Entry.loadProject only queues downloads.
  const waitForSoundsLoaded = () => new Promise((resolve) => {
    const queue = window.Entry && Entry.soundQueue;
    if (!queue || queue.loadComplete || !queue.urls || queue.urls.size === 0) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      Entry.removeEventListener('soundLoaded', finish);
      clearTimeout(timer);
      resolve();
    };
    Entry.addEventListener('soundLoaded', finish);
    const timer = setTimeout(finish, 8000);
  });

  try {
    const project = await (await fetch('/project.json')).json();
    const sourceMap = await (await fetch('/sourcemap.json')).json().catch(() => ({}));
    window.tessSourceMap = sourceMap;
    window.tessRenderProjectDebug(project);
    await preloadTextFonts(project);
    Entry.init(document.getElementById('workspace'), {
      type: 'minimize',
      libDir: ${jsValue(mediaBase)},
      // Keep the local base URL for TTS proxying and avoid duplicating the package path in asset URLs.
      entryDir: '',
      fonts: [],
      useWebGL: ${jsValue(boost)},
    });
    // Install error hooks after Entry.init creates the toast object they must replace.
    interceptRuntimeErrors(sourceMap);
    // Wrap environment blocks only after Entry.init has registered them.
    window.tessPatchEnvironmentBlocks();
    Entry.loadProject(project);
    requestAnimationFrame(() => window.tessLayoutCanvas());
    await waitForStartGate();
    const gate = document.getElementById('start-gate');
    const gateCard = document.getElementById('start-gate-card');
    const soundsReady = waitForSoundsLoaded();
    // Show loading feedback until sounds arrive instead of hiding the gate immediately.
    if (gateCard && window.Entry?.soundQueue?.urls?.size > 0 && !Entry.soundQueue.loadComplete) {
      gateCard.textContent = '소리를 불러오는 중…';
    }
    await soundsReady;
    gate && gate.remove();
    Entry.engine && Entry.engine.toggleRun && Entry.engine.toggleRun();
  } catch (error) {
    showFallback('작품을 실행하는 중 문제가 생겼습니다: ' + error.message);
    window.tessReportError('초기화 오류', error);
  }
})();
${reload ? `
(function () {
  const status = document.getElementById('reload-status');
  const source = new EventSource('/__reload');
  source.addEventListener('reload', () => location.reload());
  source.addEventListener('open', () => { if (status) status.textContent = '자동 새로고침 켜짐'; });
  source.addEventListener('error', () => { if (status) status.textContent = '자동 새로고침 연결 끊김'; });
})();` : ''}
</script>
</body>
</html>
`;
}
