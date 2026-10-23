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

export function onAssetCacheChange(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => { cacheListeners.delete(listener); };
}

function cacheChanged(): void {
  for (const listener of cacheListeners) listener();
}

// Entry gives every upload a new file name, so a stored copy is used without asking the server again.
export function setAssetCache(on: boolean): void {
  if (cacheOn === on) return;
  cacheOn = on;
  cacheVersion++;
  cacheBytes.clear();
  if (!on) {
    cacheDeletion = cacheDeletion.then(() => globalThis.caches?.delete(CACHE_NAME))
      .catch((error) => console.warn('[entropy] 에셋 캐시를 지우지 못했습니다', error));
  }
  cacheChanged();
}

export function fetchAsset(url: string, signal?: AbortSignal): Promise<Response> {
  return cacheOn && /^https?:/.test(url) ? fetchCached(url, signal) : fetchRetry(url, signal);
}

async function fetchCached(url: string, signal?: AbortSignal): Promise<Response> {
  const version = cacheVersion;
  const store = await openCache();
  const stored = await store?.match(url).catch((error) => console.warn('[entropy] 에셋 캐시를 읽지 못했습니다', url, error));
  if (stored && cacheOn && version === cacheVersion) return stored;
  const response = await fetchRetry(url, signal);
  if (store && cacheOn && version === cacheVersion) {
    void store.put(url, response.clone()).then(() => {
      if (!cacheOn || version !== cacheVersion) return;
      cacheBytes.delete(url);
      cacheChanged();
    }).catch((error) => console.warn('[entropy] 에셋을 캐시에 넣지 못했습니다', url, error));
  }
  return response;
}

async function openCache(): Promise<Cache | null> {
  // A quick off/on must finish deleting the old cache before opening the new one.
  await cacheDeletion;
  if (!cacheOn) return null;
  return globalThis.caches?.open(CACHE_NAME).catch((error) => {
    console.warn('[entropy] 에셋 캐시를 열지 못했습니다', error);
    return null;
  }) ?? Promise.resolve(null);
}

// Sum stored bodies so the extension popup can show how much disk the cache uses.
export async function assetCacheSize(): Promise<{ count: number; bytes: number }> {
  if (!cacheOn) return { count: 0, bytes: 0 };
  const store = await openCache();
  if (!store) return { count: 0, bytes: 0 };
  const keys = await store.keys();
  let bytes = 0;
  for (const key of keys) {
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
  return { count: keys.length, bytes };
}
