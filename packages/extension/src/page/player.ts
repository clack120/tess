import { boot, type EntropyHandle } from "../../../vm/src/web/boot.ts";
import { formatVmError } from "../../../vm/src/runtime/diagnostics.ts";
import { ASK_FIELD_STYLE } from "../../../vm/src/web/ask-style.ts";
import { CHART_WINDOW_STYLE } from "../../../vm/src/web/chart-view.ts";
import { assetCacheSize } from "../../../vm/src/web/fetch-retry.ts";
import { EXTRAS_DIALOG_STYLE } from "../../../vm/src/web/extras.ts";
import { fetchWork, thumbUrl } from "./entry-project.ts";
import { bridgeSaveStore } from "./save-bridge.ts";
import { CloudClient } from "./cloud.ts";
import { mountInspector } from "./inspector.ts";

import { signedInUser } from "./signed-in.ts";

const ICONS = {
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3" width="3" height="10" rx="1"/>' +
    '<rect x="9.5" y="3" width="3" height="10" rx="1"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 3.1 12.9 8l-8.3 4.9Z"/></svg>',
  enterFull:
    '<svg viewBox="0 0 16 16" aria-hidden="true" class="stroke"><path d="M2.8 6V2.8H6M13.2 6V2.8H10' +
    'M2.8 10v3.2H6M13.2 10v3.2H10"/></svg>',
  exitFull:
    '<svg viewBox="0 0 16 16" aria-hidden="true" class="stroke"><path d="M6 2.8V6H2.8M10 2.8V6h3.2' +
    'M6 13.2V10H2.8M10 13.2V10h3.2"/></svg>',
};

const STAGE_STYLE_ID = "entropy-stage-style";

// A timer also releases background tabs where animation frames may not arrive.
const nextFrame = () =>
  new Promise<void>((done) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        done();
      }
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });

export interface MountedPlayer {
  dispose(): void;
}

function ensureStageStyle(): void {
  if (document.getElementById(STAGE_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STAGE_STYLE_ID;
  style.textContent = `${ASK_FIELD_STYLE}\n${CHART_WINDOW_STYLE}\n${EXTRAS_DIALOG_STYLE}`;
  (document.head ?? document.documentElement).appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

function iconButton(
  parent: HTMLElement,
  className: string,
  label: string,
  icon: string,
) {
  const button = el("button", `entropy-btn ${className}`, parent);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  return button;
}

interface MenuItem {
  label: string;
  run(): void;
  disabled?: boolean;
}

// Rebuild the menu on open because available actions depend on current player state.
function mountMenu(
  root: HTMLElement,
  lines: () => Array<MenuItem | null>,
): { close(): void; dispose(): void } {
  const menu = el("div", "entropy-menu", root);
  menu.hidden = true;
  menu.setAttribute("role", "menu");

  const close = () => {
    menu.hidden = true;
  };

  const open = (clientX: number, clientY: number) => {
    menu.textContent = "";
    for (const line of lines()) {
      if (!line) {
        menu.appendChild(document.createElement("hr"));
        continue;
      }
      const item = el("button", "", menu);
      item.type = "button";
      item.textContent = line.label;
      item.disabled = Boolean(line.disabled);
      item.onclick = () => {
        close();
        line.run();
      };
    }
    const box = root.getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";
    const size = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(clientX - box.left, box.width - size.width - 4));
    const top = Math.max(0, Math.min(clientY - box.top, box.height - size.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  const onContext = (event: Event) => {
    event.preventDefault();
    const pointer = event as MouseEvent;
    open(pointer.clientX, pointer.clientY);
  };
  const onDown = (event: Event) => {
    if (!menu.hidden && !menu.contains(event.target as Node)) {
      close();
    }
  };
  const onKey = (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape") {
      close();
    }
  };
  root.addEventListener("contextmenu", onContext);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);

  return {
    close,
    dispose() {
      root.removeEventListener("contextmenu", onContext);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      menu.remove();
    },
  };
}

// Return a live handle immediately so unmounting during load still cleans up.
export function mountPlayer(
  host: HTMLElement,
  projectId: string,
  groupId: string | null = null,
  svg = true,
  cacheAssets = false,
  grabEscape = true,
): MountedPlayer {
  ensureStageStyle();
  const root = el("div", "entropy-player is-idle", host);
  // Capture work keys only inside the player so page inputs remain usable.
  root.tabIndex = 0;

  const view = el("div", "entropy-view", root);
  const cover = el("div", "entropy-cover", view);
  const startButton = el("button", "entropy-start", cover);
  startButton.type = "button";
  startButton.hidden = true;
  startButton.title = "시작하기";
  startButton.setAttribute("aria-label", "시작하기");
  startButton.innerHTML = ICONS.play;
  const status = el("div", "entropy-status", cover);
  status.textContent = "작품을 읽어들이는 중";

  const bar = el("div", "entropy-bar", root);
  const left = el("div", "entropy-bar-side", bar);
  const stopButton = iconButton(left, "entropy-stop", "정지", ICONS.stop);
  const pauseButton = iconButton(left, "entropy-pause", "일시정지", ICONS.pause);
  const coords = el("div", "entropy-coords", bar);
  const right = el("div", "entropy-bar-side entropy-bar-right", bar);
  const boostLabel = el("label", "entropy-boost", right);
  const boostText = el("span", "entropy-boost-text", boostLabel);
  boostText.textContent = "부스트모드";
  const boostInput = document.createElement("input");
  boostInput.type = "checkbox";
  boostInput.checked = true;
  boostLabel.appendChild(boostInput);
  el("span", "entropy-switch", boostLabel);
  const fullButton = iconButton(
    right,
    "entropy-full",
    "전체화면",
    ICONS.enterFull,
  );

  const errorBox = el("div", "entropy-error", root);
  errorBox.hidden = true;

  let handle: EntropyHandle | null = null;
  let cloudStore: CloudClient | null = null;
  let disposed = false;
  const controller = new AbortController();
  let onTick: (() => void) | null = null;
  let menu: { close(): void; dispose(): void } | null = null;
  let inspector: ReturnType<typeof mountInspector> | null = null;

  const showError = (text: string) => {
    errorBox.classList.remove("is-notice");
    errorBox.textContent = text;
    errorBox.hidden = false;
  };
  let notice = "";
  const drawNotice = () => {
    if (!notice) {
      errorBox.hidden = true;
      errorBox.textContent = "";
      return;
    }
    errorBox.classList.add("is-notice");
    errorBox.textContent = notice;
    errorBox.hidden = false;
  };
  const setNotice = (text: string) => {
    notice = text;
    drawNotice();
  };
  const clearError = () => {
    errorBox.classList.remove("is-notice");
    drawNotice();
  };

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    controller.abort();
    clearInterval(timer);
    menu?.dispose();
    inspector?.dispose();
    onTick = null;
    document.removeEventListener("fullscreenchange", onFullscreen);
    handle?.dispose();
    cloudStore?.dispose();
    handle = null;
    root.remove();
  };

  function onFullscreen(): void {
    const full = document.fullscreenElement === root;
    fullButton.innerHTML = full ? ICONS.exitFull : ICONS.enterFull;
    fullButton.title = full ? "전체화면 끄기" : "전체화면";
    fullButton.setAttribute("aria-label", fullButton.title);
    root.classList.toggle("is-full", full);
    // Restore work focus when fullscreen hides the clicked control.
    if (full) {
      root.focus({ preventScroll: true });
    }
    handle?.relayout();
  }
  document.addEventListener("fullscreenchange", onFullscreen);

  // Also check whether navigation removed the player while updating the readout.
  const timer = window.setInterval(() => {
    if (!host.isConnected) {
      dispose();
      return;
    }
    onTick?.();
  }, 100);

  fullButton.onclick = () => {
    if (document.fullscreenElement === root) {
      void document.exitFullscreen();
    } else {
      void root
        .requestFullscreen()
        .catch(() => showError("전체화면으로 바꾸지 못했습니다"));
      // Lock Escape in the fullscreen click; locking first can delay fullscreen.
      const keyboard = (navigator as Navigator & { keyboard?: { lock?(keys: string[]): Promise<void> } }).keyboard;
      if (grabEscape && keyboard?.lock) {
        keyboard.lock(["Escape"]).catch((error) => console.warn("[entropy] 전체화면에서 Esc 를 잡지 못했습니다", error));
      }
    }
  };

  // Restore focus after mouse clicks, but preserve keyboard navigation through controls.
  bar.addEventListener("click", (event) => {
    if (event.detail > 0 && handle && handle.vm.state !== "stop") {
      root.focus({ preventScroll: true });
    }
  });

  void load();

  async function load(): Promise<void> {
    let work;
    try {
      work = await fetchWork(projectId, groupId, controller.signal);
    } catch (error) {
      if (disposed) return;
      status.textContent = "";
      showError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (disposed) {
      return;
    }
    const thumb = thumbUrl(work.thumb);
    if (thumb) {
      cover.style.backgroundImage = `url("${thumb}")`;
    }

    // Execute original blocks directly to preserve Entry IDs.
    status.textContent = "실행기를 준비하는 중";
    await nextFrame();
    if (disposed) {
      return;
    }

    const entropyIdToEntryId = new Map<string, string>();
    const entryIdToEntropyId = new Map<string, string>();
    const variableMongoIds = new Map<string, string>();
    for (const v of work.variables ?? []) {
      if (v.isCloud || v.isRealTime) {
        entropyIdToEntryId.set(String(v.id), String(v.id));
        entryIdToEntropyId.set(String(v.id), String(v.id));
        variableMongoIds.set(String(v.id), String(v._id));
      }
    }
    const csrfToken = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
    const cloud = new CloudClient(projectId, csrfToken, work.variables ?? [], entropyIdToEntryId, entryIdToEntropyId, variableMongoIds);
    cloudStore = cloud;
    await cloud.connect();
    if (disposed) return;

    try {
      handle = await boot({
        signal: controller.signal,
        project: work,
        store: cloud,
        // Keep saves in extension storage so the popup can manage them.
        saveStore: bridgeSaveStore(projectId, String(work.name ?? projectId)),
        container: view,
        autoStart: false,
        keyTarget: root,
        boost: true,
        svg,
        cacheAssets,
        grabEscape,
        user: signedInUser(),
        tableColumnName: (window as Window & { Lang?: { DataAnalytics?: { new_attribute?: string } } })
          .Lang?.DataAnalytics?.new_attribute,
        // Wait for assets before enabling input.
        onProgress: (done, all) => {
          status.textContent = all
            ? `읽어들이는 중: ${((done / all) * 100).toFixed(2)}%`
            : "읽어들이는 중";
        },
      });
      cloud.setChangeListener(() => {
        handle?.vm.readStore();
      });

    } catch (error) {
      if (disposed) return;
      status.textContent = "";
      showError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (disposed) {
      handle.dispose();
      handle = null;
      return;
    }
    status.textContent = "";
    startButton.hidden = false;
    reportUnsupported(handle);
    ready(handle);
    // The popup cannot read this page's Cache Storage, so hand the size to the content script.
    void assetCacheSize().then(
      (size) => window.postMessage({ __entropy: "cache-size", ...size }, location.origin),
      (error) => console.warn("[entropy] 에셋 캐시 용량을 읽지 못했습니다", error),
    );
  }

  // Report unsupported blocks so skipped code cannot look like a broken project.
  function reportUnsupported(live: EntropyHandle): void {
    const blocks = [...live.vm.unknownBlocks.keys()].filter(
      (type) => !type.startsWith("variable:"),
    );
    reportDropped(blocks);
  }

  function reportDropped(blocks: string[]): void {
    if (!blocks.length) {
      return;
    }
    const shown = blocks.slice(0, 6).join(", ");
    setNotice(
      `이 실행기가 아직 모르는 블록이 ${blocks.length}종 있습니다: ` +
        `${shown}${blocks.length > 6 ? ` 외 ${blocks.length - 6}종` : ""}`,
    );
  }

  function ready(live: EntropyHandle): void {
    inspector = mountInspector(root, live);
    const seen = new Set<string>();
    let shown = "";

    const showState = () => {
      const state = live.vm.state;
      // Replace button markup only when it changes; replacing it mid-press cancels the click.
      if (state !== shown) {
        shown = state;
        root.classList.toggle("is-idle", state === "stop");
        root.classList.toggle("is-paused", state === "pause");
        pauseButton.innerHTML = state === "pause" ? ICONS.play : ICONS.pause;
        pauseButton.title = state === "pause" ? "이어서 하기" : "일시정지";
        pauseButton.setAttribute("aria-label", pauseButton.title);
      }
      coords.textContent = `X: ${Math.round(live.vm.mouseX)}  Y: ${Math.round(live.vm.mouseY)}`;
    };
    const start = () => {
      clearError();
      seen.clear();
      live.start();
      root.focus({ preventScroll: true });
      showState();
    };
    const stop = () => {
      live.stop();
      showState();
    };

    // Match Entry by stopping the whole work when a script fails.
    live.vm.onError = (error) => {
      const key = `${error.blockId}:${error.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        showError(`오류로 멈췄습니다: ${formatVmError(error)}`);
      }
      if (live.vm.state !== "stop") {
        stop();
      }
    };

    startButton.onclick = start;
    stopButton.onclick = stop;
    pauseButton.onclick = () => {
      if (live.vm.state === "run") {
        live.pause();
      } else if (live.vm.state === "pause") {
        live.start();
      }
      showState();
    };
    boostInput.onchange = () => {
      live.vm.boost = boostInput.checked;
    };
    boostInput.checked = live.vm.boost;

    const sceneStep = (to: "prev" | "next") => {
      live.vm.ops.startNeighborScene(to);
      root.focus({ preventScroll: true });
    };
    const sceneAt = (offset: number) =>
      live.vm.scenes[
        live.vm.scenes.findIndex((scene) => scene.id === live.vm.currentSceneId) + offset
      ];
    menu = mountMenu(root, () => {
      const state = live.vm.state;
      const still = state === "stop";
      return [
        still || state === "pause"
          ? { label: still ? "시작하기" : "이어서 하기", run: still ? start : live.start }
          : { label: "일시정지", run: () => live.pause() },
        { label: "정지", run: stop, disabled: still },
        null,
        { label: "현재 상태 보기", run: () => live.inspect() },
        { label: `Entropy 디버그 ${inspector?.enabled ? "끄기" : "켜기"}`, run: () => inspector?.toggle() },
        { label: "진단 파일 저장", run: () => live.downloadDiagnostics() },
        null,
        { label: "이전 장면", run: () => sceneStep("prev"), disabled: still || !sceneAt(-1) },
        { label: "다음 장면", run: () => sceneStep("next"), disabled: still || !sceneAt(1) },
        null,
        {
          label: document.fullscreenElement === root ? "전체화면 끄기" : "전체화면",
          run: () => fullButton.click(),
        },
      ];
    });

    // Read player state from the VM because works can stop themselves.
    onTick = () => { showState(); inspector?.syncHost(); };
    showState();
  }

  return {
    dispose,
  };
}
