import { fetchAsset, setAssetCache } from '../../../vm/src/web/fetch-retry.ts';
import { applyCacheClear } from './cache.ts';

const initial = document.querySelector<HTMLScriptElement>('script[data-entropy-native-cache]');
let on = initial?.dataset.entropyNativeCache === '1';
setAssetCache(on);
void applyCacheClear(Number(initial?.dataset.entropyClear) || 0);

// Only uploaded costumes and sounds belong to this cache, never APIs or page resources.
function assetUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value), location.href);
    return url.origin === location.origin && /^\/uploads\/[a-z0-9]{2}\/[a-z0-9]{2}\/(?:image\/)?[a-z0-9]+\.(?:png|jpe?g|gif|webp|svg|mp3|wav|ogg|m4a)$/i.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
}

const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
const images = new WeakMap<HTMLImageElement, { url: string; controller: AbortController; release?: () => void }>();
Object.defineProperty(HTMLImageElement.prototype, 'src', {
  ...src,
  get() { return images.get(this)?.url ?? src.get!.call(this); },
  set(value: string) {
    const previous = images.get(this);
    previous?.controller.abort();
    previous?.release?.();
    images.delete(this);
    const url = on ? assetUrl(value) : null;
    if (!url) { src.set!.call(this, value); return; }
    const ticket: { url: string; controller: AbortController; release?: () => void } = { url, controller: new AbortController() };
    images.set(this, ticket);
    void fetchAsset(url, ticket.controller.signal).then(response => response.blob()).then(blob => {
      if (images.get(this) !== ticket) return;
      const objectUrl = URL.createObjectURL(blob);
      const release = () => {
        URL.revokeObjectURL(objectUrl);
        this.removeEventListener('load', release);
        this.removeEventListener('error', release);
        delete ticket.release;
      };
      ticket.release = release;
      this.addEventListener('load', release);
      this.addEventListener('error', release);
      src.set!.call(this, objectUrl);
    }).catch(() => {
      if (!ticket.controller.signal.aborted && images.get(this) === ticket) {
        images.delete(this);
        src.set!.call(this, value);
      }
    });
  },
});

const xhr = XMLHttpRequest.prototype;
const open = xhr.open;
const send = xhr.send;
const abort = xhr.abort;
interface RequestState { url: string; controller: AbortController; pending: boolean; cached?: boolean; timer?: ReturnType<typeof setTimeout>; }
const requests = new WeakMap<XMLHttpRequest, RequestState>();
xhr.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
  requests.get(this)?.controller.abort();
  clearTimeout(requests.get(this)?.timer);
  requests.delete(this);
  open.call(this, method, url, async, username, password);
  const asset = on && async && method.toUpperCase() === 'GET' && !username && !password ? assetUrl(url) : null;
  if (asset) requests.set(this, { url: asset, controller: new AbortController(), pending: false });
};
xhr.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
  const ticket = requests.get(this);
  if (ticket?.pending) throw new DOMException('The request has already been sent.', 'InvalidStateError');
  if (!on || !ticket || body != null) { send.call(this, body); return; }
  ticket.pending = true;
  const started = performance.now();
  const timeout = this.timeout;
  if (timeout) ticket.timer = setTimeout(() => {
    ticket.controller.abort();
    ticket.pending = false;
    abort.call(this);
    this.dispatchEvent(new ProgressEvent('timeout'));
    this.dispatchEvent(new ProgressEvent('loadend'));
  }, timeout);
  void fetchAsset(ticket.url, ticket.controller.signal).then(response => response.blob()).then(blob => {
    if (ticket.controller.signal.aborted || requests.get(this) !== ticket) return;
    clearTimeout(ticket.timer);
    const objectUrl = URL.createObjectURL(blob);
    const type = this.responseType;
    open.call(this, 'GET', objectUrl, true);
    this.responseType = type;
    this.timeout = timeout ? Math.max(1, timeout - (performance.now() - started)) : 0;
    ticket.cached = true;
    this.addEventListener('loadend', () => URL.revokeObjectURL(objectUrl), { once: true });
    ticket.pending = false;
    send.call(this);
  }).catch(() => {
    if (ticket.controller.signal.aborted || requests.get(this) !== ticket) return;
    clearTimeout(ticket.timer);
    ticket.pending = false;
    send.call(this, body);
  });
};
const responseUrl = Object.getOwnPropertyDescriptor(xhr, 'responseURL');
if (responseUrl?.get) Object.defineProperty(xhr, 'responseURL', {
  ...responseUrl,
  get() {
    const ticket = requests.get(this);
    return ticket?.cached && this.readyState >= 2 ? ticket.url : responseUrl.get!.call(this);
  },
});
xhr.abort = function() {
  const ticket = requests.get(this);
  ticket?.controller.abort();
  clearTimeout(ticket?.timer);
  requests.delete(this);
  abort.call(this);
  if (ticket?.pending) {
    this.dispatchEvent(new ProgressEvent('abort'));
    this.dispatchEvent(new ProgressEvent('loadend'));
  }
};

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.__entropy !== 'native-cache') return;
  on = event.data.on === true;
  setAssetCache(on);
  void applyCacheClear(Number(event.data.clear) || 0, event.data.live === true);
});
