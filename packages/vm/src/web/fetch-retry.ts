const RETRIES = 4;
const MAX_WAIT_MS = 10_000;

// playentry answers bursts of asset requests with 429, so retry rate limits and transient failures.
export async function fetchRetry(url: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(url, { signal });
    } catch (error) {
      if (signal?.aborted || attempt >= RETRIES) throw error;
    }
    if (response) {
      if (response.ok) return response;
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt >= RETRIES) throw new Error(`Asset request failed: HTTP ${response.status}`);
      void response.body?.cancel().catch(() => undefined);
    }
    await sleep(retryDelay(response, attempt), signal);
  }
}

function retryDelay(response: Response | null, attempt: number): number {
  const after = Number(response?.headers.get('retry-after'));
  const base = after > 0 ? after * 1000 : 500 * 2 ** attempt;
  return Math.min(base + Math.random() * 250, MAX_WAIT_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    const id = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(id);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

const CACHE_NAME = 'entropy-assets';
let cacheOn: boolean | undefined;
let cacheVersion = 0;
let cacheDeletion: Promise<unknown> = Promise.resolve();
const cacheBytes = new Map<string, number>();
const cacheListeners = new Set<() => void>();
let bulkDepth = 0;
let bulkChanged = false;

export function onAssetCacheChange(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => { cacheListeners.delete(listener); };
}

function cacheChanged(): void {
  if (bulkDepth > 0) {
    bulkChanged = true;
    return;
  }
  for (const listener of cacheListeners) listener();
}

// Preloading thousands of assets changes the cache on every put; tell listeners once when it ends.
export function beginAssetBulk(): void {
  bulkDepth += 1;
}

export function endAssetBulk(): void {
  if (bulkDepth > 0) bulkDepth -= 1;
  if (bulkDepth !== 0 || !bulkChanged) return;
  bulkChanged = false;
  cacheChanged();
}

function rememberSize(url: string, response: Response, replaced = false): void {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > 0) cacheBytes.set(url, length);
  else if (replaced) cacheBytes.delete(url);
}

// Entry gives every upload a new file name, so a stored copy is used without asking the server again.
export function setAssetCache(on: boolean): void {
  if (cacheOn === on) return;
  cacheOn = on;
  cacheVersion++;
  cacheChanged();
}

export function clearAssetCache(): Promise<void> {
  cacheVersion++;
  cacheBytes.clear();
  cacheDeletion = cacheDeletion.then(() => globalThis.caches?.delete(CACHE_NAME))
    .catch((error) => console.warn('[entropy] 에셋 캐시를 지우지 못했습니다', error));
  return cacheDeletion.then(() => { cacheChanged(); });
}

export function fetchAsset(url: string, signal?: AbortSignal): Promise<Response> {
  return cacheOn && /^https?:/.test(url) ? fetchCached(url, signal) : fetchRetry(url, signal);
}

async function fetchCached(url: string, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const version = cacheVersion;
  const store = await openCache();
  signal?.throwIfAborted();
  const stored = await store?.match(url).catch((error) => console.warn('[entropy] 에셋 캐시를 읽지 못했습니다', url, error));
  signal?.throwIfAborted();
  if (stored && cacheOn && version === cacheVersion) {
    rememberSize(url, stored);
    return stored;
  }
  const response = await fetchRetry(url, signal);
  if (store && cacheOn && version === cacheVersion) {
    void store.put(url, response.clone()).then(() => {
      if (!cacheOn || version !== cacheVersion) return;
      rememberSize(url, response, true);
      cacheChanged();
    }).catch((error) => console.warn('[entropy] 에셋을 캐시에 넣지 못했습니다', url, error));
  }
  return response;
}

let opened: { storage: CacheStorage; deletion: Promise<unknown>; open: Promise<Cache | null> } | null = null;

async function openCache(): Promise<Cache | null> {
  const storage = globalThis.caches;
  if (!storage) return null;
  // Finish explicit deletion before opening the cache for new requests.
  const deletion = cacheDeletion;
  await deletion;
  if (opened && opened.storage === storage && opened.deletion === deletion) return opened.open;
  // Firefox makes each open call round-trip through its quota manager, and a large
  // work was spending most of its load time opening the same cache per costume.
  let open!: Promise<Cache | null>;
  open = storage.open(CACHE_NAME).catch((error) => {
    if (opened?.open === open) opened = null;
    console.warn('[entropy] 에셋 캐시를 열지 못했습니다', error);
    return null;
  });
  opened = { storage, deletion, open };
  return open;
}

// Sum stored bodies so the extension popup can show how much disk the cache uses.
export async function assetCacheSize(): Promise<{ count: number; bytes: number }> {
  await cacheDeletion;
  if (!globalThis.caches || !await globalThis.caches.has(CACHE_NAME)) return { count: 0, bytes: 0 };
  const store = await openCache();
  if (!store) return { count: 0, bytes: 0 };
  const keys = await store.keys();
  let bytes = 0;
  let next = 0;
  // Read a few file headers together without flooding Cache Storage during loading.
  await Promise.all(Array.from({ length: Math.min(8, keys.length) }, async () => {
    while (next < keys.length) {
      const key = keys[next++]!;
      const known = cacheBytes.get(key.url);
      if (known !== undefined) {
        bytes += known;
        continue;
      }
      const stored = await store.match(key);
      if (stored) {
        const size = Number(stored.headers.get('content-length')) || (await stored.blob()).size;
        cacheBytes.set(key.url, size);
        bytes += size;
      }
    }
  }));
  return { count: keys.length, bytes };
}
