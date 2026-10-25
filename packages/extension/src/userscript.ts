import type { MountedPlayer } from "./page/player.ts";
import { mountPlayer } from "./page/player.ts";
import { readWork, writeWork, type StoredValue } from "./store-db.ts";
import { clearAssetCache } from "../../vm/src/web/fetch-retry.ts";

declare const ENTROPY_PLAYER_CSS: string;

interface HeldFrame {
  frame: HTMLIFrameElement;
  src: string;
  id: string;
  host: HTMLElement | null;
  player: MountedPlayer | null;
  positioned: HTMLElement | null;
}

function startUserscript(): void {
  // A userscript has no extension worker. Answer the same save bridge locally so
  // works keep their saved values in playentry.org's IndexedDB origin.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as {
      __entropy?: string;
      id?: number;
      work?: string;
      title?: string;
      values?: Record<string, StoredValue>;
    } | null;
    if (
      !data ||
      (data.__entropy !== "store-read" && data.__entropy !== "store-write") ||
      !data.work
    )
      return;
    const reply = (answer: unknown) => {
      window.postMessage(
        { __entropy: "store-answer", id: data.id, answer },
        location.origin,
      );
    };
    if (data.__entropy === "store-read") {
      void readWork(data.work).then(
        (values) => reply({ values }),
        () => reply({ error: true }),
      );
    } else {
      void writeWork(data.work, data.title ?? "", data.values ?? {}).then(
        () => reply({ ok: true }),
        () => reply({ error: true }),
      );
    }
  });

  const style = document.createElement("style");
  style.dataset.entropyUserscript = "style";
  style.textContent = ENTROPY_PLAYER_CSS;
  const attachStyle = () => {
    const parent = document.head ?? document.documentElement;
    if (!parent) return false;
    parent.appendChild(style);
    return true;
  };
  if (!attachStyle()) {
    const rootObserver = new MutationObserver(() => {
      if (attachStyle()) rootObserver.disconnect();
    });
    rootObserver.observe(document, { childList: true, subtree: true });
  }

  const CACHE_KEY = "entropy-userscript-asset-cache";
  let cacheAssets = true;
  try {
    cacheAssets = localStorage.getItem(CACHE_KEY) !== "0";
  } catch {}
  const rememberCache = (on: boolean) => {
    cacheAssets = on;
    try {
      localStorage.setItem(CACHE_KEY, on ? "1" : "0");
    } catch {}
  };

  if (/^\/ws(?:\/|$)/.test(location.pathname)) {
    // The editor module waits for Entry and keeps save compaction active even
    // before the replacement VM has attached.
    void import("./page/editor.ts").then(() => {
      window.postMessage(
        {
          __entropy: "editor-settings",
          enabled: true,
          svg: true,
          cache: cacheAssets,
          // Browser fullscreen Escape handling differs too much across userscript hosts.
          escape: false,
        },
        location.origin,
      );
    });
  } else {
    const held: HeldFrame[] = [];
    const changeCache = (on: boolean) => {
      rememberCache(on);
      for (const item of held) item.player?.setAssetCache(on);
    };

    const idOf = (src: string) => /\/iframe\/([^/?#]+)/.exec(src)?.[1] ?? null;

    const release = (item: HeldFrame) => {
      item.player?.dispose();
      item.player = null;
      item.host?.remove();
      item.host = null;
      if (item.positioned) {
        item.positioned.style.removeProperty("position");
        item.positioned = null;
      }
      item.frame.style.removeProperty("visibility");
      if (item.frame.getAttribute("src") !== item.src)
        item.frame.setAttribute("src", item.src);
    };

    const mount = (item: HeldFrame) => {
      item.frame.style.visibility = "hidden";
      if (item.frame.getAttribute("src") !== "about:blank")
        item.frame.setAttribute("src", "about:blank");
      if (item.host?.isConnected && item.player?.isConnected) return;
      item.player?.dispose();
      item.host?.remove();
      const parent = item.frame.parentElement;
      if (!parent) return;
      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
        item.positioned = parent;
      }
      const host = document.createElement("div");
      host.className = "entropy-host";
      item.host = host;
      item.frame.after(host);
      const group = new URLSearchParams(location.search).get("groupId");
      item.player = mountPlayer(
        host,
        item.id,
        group,
        true,
        cacheAssets,
        false,
        {
          change: changeCache,
          clear: clearAssetCache,
        },
      );
    };

    const hold = (frame: HTMLIFrameElement) => {
      const src = frame.getAttribute("src") ?? "";
      let item = held.find((current) => current.frame === frame);
      if (src === "about:blank" && item) return;
      const id = idOf(src);
      if (!id) {
        if (item) {
          release(item);
          held.splice(held.indexOf(item), 1);
        }
        return;
      }
      if (item && (item.src !== src || item.id !== id)) {
        release(item);
        item = undefined;
      }
      if (!item) {
        item = { frame, src, id, host: null, player: null, positioned: null };
        held.push(item);
      }
      mount(item);
    };

    const sweep = (node: Node) => {
      if (node instanceof HTMLIFrameElement) hold(node);
      else if (node instanceof Element || node instanceof Document) {
        for (const frame of node.querySelectorAll("iframe")) hold(frame);
      }
    };

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target instanceof HTMLIFrameElement) hold(record.target);
        } else {
          for (const node of record.addedNodes) sweep(node);
        }
      }
      for (let index = held.length - 1; index >= 0; index--) {
        const item = held[index]!;
        if (item.frame.isConnected) continue;
        release(item);
        held.splice(index, 1);
      }
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    sweep(document);
  }
}

// Keep this guard in code as well as @noframes because userscript hosts differ
// in how early they apply metadata during document-start navigation.
if (window.top === window.self) startUserscript();
