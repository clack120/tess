import { assetCacheSize, clearAssetCache, onAssetCacheChange } from '../../../vm/src/web/fetch-retry.ts';

let timer: ReturnType<typeof setTimeout> | undefined;
let version = 0;
function report(): void {
  version++;
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    const current = version;
    void assetCacheSize().then(
      size => { if (current === version) window.postMessage({ __entropy: 'cache-size', ...size }, location.origin); },
      error => console.warn('[entropy] 에셋 캐시 용량을 읽지 못했습니다', error),
    );
  }, 1000);
}
onAssetCacheChange(report);

// Keep deletion requests until an Entry page can access its own Cache Storage.
export function applyCacheClear(stamp: number, live = false): Promise<void> {
  let previous = 0;
  try { previous = Number(localStorage.getItem('entropy-assets-clear')) || 0; } catch {}
  if (!stamp || !live && stamp <= previous) return Promise.resolve();
  try { localStorage.setItem('entropy-assets-clear', String(stamp)); } catch {}
  return clearAssetCache();
}
