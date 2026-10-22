// Blank the original iframe before loading, but keep its layout box for the replacement player.
import { api, readSettings, ENABLED_KEY, SVG_KEY } from './browser.ts';

const IFRAME_MARK = '/iframe/';
const HELD = 'tessvmHeld';

interface Held {
  frame: HTMLIFrameElement;
  // Restore the original iframe URL when disabling the extension.
  src: string;
  id: string;
  // Remember positioning changes so removing the player can restore the parent.
  positioned: boolean;
}

let enabled: boolean | null = null;
let svg = true;
let injected = false;
const held: Held[] = [];

function idOf(src: string): string | null {
  return /\/iframe\/([^/?#]+)/.exec(src)?.[1] ?? null;
}

function hostAfter(frame: HTMLIFrameElement): HTMLElement | null {
  const next = frame.nextElementSibling;
  return next instanceof HTMLElement && next.dataset.tessvmProject ? next : null;
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
  // Report a missing runner instead of leaving an unexplained empty player.
  script.onerror = () => {
    for (const item of held) {
      const host = hostAfter(item.frame);
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
  if (hostAfter(item.frame)) {
    return;
  }
  const parent = item.frame.parentElement;
  if (parent && getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
    item.positioned = true;
  }
  const host = document.createElement('div');
  host.className = 'tessvm-host';
  host.dataset.tessvmProject = item.id;
  const group = new URLSearchParams(location.search).get('groupId');
  if (group) {
    host.dataset.tessvmGroup = group;
  }
  host.dataset.tessvmSvg = svg ? '1' : '0';
  item.frame.after(host);
  inject();
  window.postMessage({ __tessvm: 'scan' }, location.origin);
}

function release(item: Held): void {
  hostAfter(item.frame)?.remove();
  if (item.positioned) {
    item.frame.parentElement?.style.removeProperty('position');
    item.positioned = false;
  }
  item.frame.style.removeProperty('visibility');
  if (item.frame.getAttribute('src') !== item.src) {
    item.frame.setAttribute('src', item.src);
  }
}

function applyAll(): void {
  for (let i = held.length - 1; i >= 0; i -= 1) {
    const item = held[i]!;
    if (!item.frame.isConnected) {
      held.splice(i, 1);
      continue;
    }
    if (enabled) {
      mount(item);
    } else {
      release(item);
    }
  }
}

// Blank frames before settings arrive because Entry cannot be unloaded after it starts.
function hold(frame: HTMLIFrameElement): void {
  if (frame.dataset[HELD]) {
    return;
  }
  const src = frame.getAttribute('src') ?? '';
  if (!src.includes(IFRAME_MARK)) {
    return;
  }
  const id = idOf(src);
  if (!id) {
    return;
  }
  frame.dataset[HELD] = '1';
  const item: Held = { frame, src, id, positioned: false };
  held.push(item);
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
  if (SVG_KEY in changes) {
    svg = changes[SVG_KEY]?.newValue !== false;
    // Rebuild players because they read this setting only when mounted.
    window.postMessage({ __tessvm: 'unmount' }, location.origin);
    for (const item of held) {
      hostAfter(item.frame)?.remove();
    }
  }
  if (ENABLED_KEY in changes) {
    enabled = changes[ENABLED_KEY]?.newValue !== false;
  }
  if (!enabled) {
    window.postMessage({ __tessvm: 'unmount' }, location.origin);
  }
  applyAll();
});

void readSettings().then((settings) => {
  enabled = settings.enabled;
  svg = settings.svg;
  applyAll();
});

// Relay saves to extension storage because page scripts cannot access it directly.
window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data as { __tessvm?: string; id?: number } | null;
  if (!data || typeof data !== 'object' || !String(data.__tessvm).startsWith('store-')) {
    return;
  }
  const reply = (answer: unknown) => {
    window.postMessage({ __tessvm: 'store-answer', id: data.id, answer }, location.origin);
  };
  const sent = api.runtime.sendMessage?.(data);
  if (!sent) {
    reply({ error: true });
    return;
  }
  void sent.then(reply, () => reply({ error: true }));
});
