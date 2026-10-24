// Blank the original iframe before loading, but keep its layout box for the replacement player.
import { api, readSettings, ENABLED_KEY, SVG_KEY, CACHE_KEY, CACHE_SIZE_KEY, CACHE_CLEAR_KEY, ESCAPE_KEY } from './browser.ts';

const IFRAME_MARK = '/iframe/';

interface Held {
  frame: HTMLIFrameElement;
  // Restore the original iframe URL when disabling the extension.
  src: string;
  id: string;
  host: HTMLElement | null;
  // Remember positioning changes so removing the player can restore the parent.
  positioned: HTMLElement | null;
}

let enabled: boolean | null = null;
let svg = true;
let cache = false;
let cacheClear = 0;
let escape = true;
let injected = false;
const held: Held[] = [];

function idOf(src: string): string | null {
  return /\/iframe\/([^/?#]+)/.exec(src)?.[1] ?? null;
}

function inject(): void {
  if (injected) {
    return;
  }
  injected = true;
  const parent = document.head ?? document.documentElement;
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = api.runtime.getURL('player.css');
  const script = document.createElement('script');
  script.type = 'module';
  script.src = api.runtime.getURL('page/main.js');
  script.onload = () => window.postMessage({ __entropy: 'scan', cache, clear: cacheClear }, location.origin);
  // Report a missing runner instead of leaving an unexplained empty player.
  script.onerror = () => {
    for (const item of held) {
      const host = item.host;
      if (host) {
        host.textContent = '실행기를 불러오지 못했습니다. 확장을 다시 불러와 주세요.';
        host.setAttribute('style', 'display:grid;place-items:center;font:13px sans-serif;color:#c0392b');
      }
    }
  };
  parent.append(style, script);
}

function capture(item: Held): void {
  item.frame.style.visibility = 'hidden';
  if (item.frame.getAttribute('src') !== 'about:blank') {
    item.frame.setAttribute('src', 'about:blank');
  }
}

function mount(item: Held): void {
  capture(item);
  if (item.host?.isConnected) {
    // A page update can clear the player while leaving its host attached.
    if (!item.host.firstChild) window.postMessage({ __entropy: 'scan' }, location.origin);
    return;
  }
  const parent = item.frame.parentElement;
  if (parent && getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
    item.positioned = parent;
  }
  const host = document.createElement('div');
  item.host = host;
  host.className = 'entropy-host';
  host.dataset.entropyProject = item.id;
  const group = new URLSearchParams(location.search).get('groupId');
  if (group) {
    host.dataset.entropyGroup = group;
  }
  host.dataset.entropySvg = svg ? '1' : '0';
  host.dataset.entropyCache = cache ? '1' : '0';
  host.dataset.entropyEscape = escape ? '1' : '0';
  item.frame.after(host);
  inject();
  window.postMessage({ __entropy: 'scan' }, location.origin);
}

function removeHost(item: Held): void {
  item.host?.remove();
  item.host = null;
  if (item.positioned) {
    item.positioned.style.removeProperty('position');
    item.positioned = null;
  }
}

function release(item: Held): void {
  removeHost(item);
  item.frame.style.removeProperty('visibility');
  if (item.frame.getAttribute('src') !== item.src) {
    item.frame.setAttribute('src', item.src);
  }
}

function applyAll(): void {
  if (enabled === null) return;
  let removed = false;
  for (let i = held.length - 1; i >= 0; i -= 1) {
    const item = held[i]!;
    if (!item.frame.isConnected) {
      // React may remove the iframe while leaving our sibling outside its ownership.
      release(item);
      held.splice(i, 1);
      removed = true;
      continue;
    }
    if (enabled) {
      mount(item);
    } else {
      release(item);
    }
  }
  if (removed) window.postMessage({ __entropy: 'scan' }, location.origin);
}

// Blank frames before settings arrive because Entry cannot be unloaded after it starts.
function hold(frame: HTMLIFrameElement): void {
  const src = frame.getAttribute('src') ?? '';
  let item = held.find(item => item.frame === frame);
  if (src === 'about:blank' && item) {
    if (enabled) mount(item);
    return;
  }
  if (!src.includes(IFRAME_MARK)) {
    if (item) {
      removeHost(item);
      frame.style.removeProperty('visibility');
      held.splice(held.indexOf(item), 1);
      window.postMessage({ __entropy: 'scan' }, location.origin);
    }
    return;
  }
  const id = idOf(src);
  if (!id) {
    return;
  }
  if (item) {
    if (item.src !== src || item.id !== id) removeHost(item);
    item.src = src;
    item.id = id;
  } else {
    item = { frame, src, id, host: null, positioned: null };
    held.push(item);
  }
  if (enabled === null) {
    capture(item);
  } else if (enabled) {
    mount(item);
  } else {
    release(item);
  }
}

function sweep(node: Node): void {
  if (node instanceof HTMLIFrameElement) {
    hold(node);
    return;
  }
  if (node instanceof HTMLElement) {
    for (const frame of node.querySelectorAll('iframe')) {
      hold(frame);
    }
  }
}

// Watch both insertion and src changes because the page may set them separately.
const observer = new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'attributes') {
      if (record.target instanceof HTMLIFrameElement) {
        hold(record.target);
      }
      continue;
    }
    for (const node of record.addedNodes) {
      sweep(node);
    }
  }
  // Sweep removals too, before a detached iframe's sibling can cover the next work.
  if (records.some(record => record.removedNodes.length)) applyAll();
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src'],
});
sweep(document.documentElement);

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (CACHE_CLEAR_KEY in changes) {
    cacheClear = Number(changes[CACHE_CLEAR_KEY]?.newValue) || 0;
    window.postMessage({ __entropy: 'scan', clear: cacheClear, live: true }, location.origin);
  }
  if (CACHE_KEY in changes) {
    cache = changes[CACHE_KEY]?.newValue === true;
    for (const item of held) {
      if (item.host) item.host.dataset.entropyCache = cache ? '1' : '0';
    }
    window.postMessage({ __entropy: 'scan', cache }, location.origin);
  }
  if (SVG_KEY in changes || ESCAPE_KEY in changes) {
    if (SVG_KEY in changes) svg = changes[SVG_KEY]?.newValue !== false;
    if (ESCAPE_KEY in changes) escape = changes[ESCAPE_KEY]?.newValue !== false;
    // Rebuild players because they read this setting only when mounted.
    window.postMessage({ __entropy: 'unmount' }, location.origin);
    for (const item of held) {
      removeHost(item);
    }
  }
  if (ENABLED_KEY in changes) {
    enabled = changes[ENABLED_KEY]?.newValue !== false;
  }
  if (!enabled) {
    window.postMessage({ __entropy: 'unmount' }, location.origin);
  }
  applyAll();
});

void readSettings().then((settings) => {
  enabled = settings.enabled;
  svg = settings.svg;
  cache = settings.cache;
  cacheClear = settings.cacheClear;
  escape = settings.escape;
  applyAll();
});

// Relay saves to extension storage because page scripts cannot access it directly.
window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data as { __entropy?: string; id?: number; count?: unknown; bytes?: unknown } | null;
  if (data && typeof data === 'object' && data.__entropy === 'cache-size') {
    const size = { count: Number(data.count) || 0, bytes: Number(data.bytes) || 0 };
    void api.storage.local.set({ [CACHE_SIZE_KEY]: size }).catch((error) => console.warn('[entropy] 캐시 용량을 기록하지 못했습니다', error));
    return;
  }
  if (!data || typeof data !== 'object' || !String(data.__entropy).startsWith('store-')) {
    return;
  }
  const reply = (answer: unknown) => {
    window.postMessage({ __entropy: 'store-answer', id: data.id, answer }, location.origin);
  };
  const sent = api.runtime.sendMessage?.(data);
  if (!sent) {
    reply({ error: true });
    return;
  }
  void sent.then(reply, () => reply({ error: true }));
});
