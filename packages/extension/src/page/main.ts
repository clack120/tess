import { mountPlayer, type MountedPlayer } from './player.ts';
import { assetCacheSize, onAssetCacheChange, setAssetCache } from '../../../vm/src/web/fetch-retry.ts';

const HOST_SELECTOR = '[data-entropy-project]';
const players = new Map<HTMLElement, { player: MountedPlayer; key: string }>();

function keyOf(host: HTMLElement): string {
  return JSON.stringify([host.dataset.entropyProject, host.dataset.entropyGroup, host.dataset.entropySvg, host.dataset.entropyEscape]);
}

function scan(): void {
  for (const [host, { player, key }] of players) {
    if (!host.isConnected || !host.dataset.entropyProject || key !== keyOf(host)) {
      player.dispose();
      players.delete(host);
    } else {
      player.setAssetCache(host.dataset.entropyCache === '1');
    }
  }
  for (const host of document.querySelectorAll<HTMLElement>(HOST_SELECTOR)) {
    const id = host.dataset.entropyProject;
    if (players.has(host) || !id) {
      continue;
    }
    players.set(
      host,
      { key: keyOf(host), player: mountPlayer(
        host,
        id,
        host.dataset.entropyGroup ?? null,
        host.dataset.entropySvg !== '0',
        host.dataset.entropyCache === '1',
        host.dataset.entropyEscape !== '0',
      ) },
    );
  }
}

let sizeTimer: ReturnType<typeof setTimeout> | undefined;
let sizeVersion = 0;
function reportCacheSize(): void {
  sizeVersion++;
  // Batch writes while a work loads, without delaying updates until loading finishes.
  if (sizeTimer !== undefined) return;
  sizeTimer = setTimeout(() => {
    sizeTimer = undefined;
    const version = sizeVersion;
    void assetCacheSize().then(
      (size) => {
        if (version === sizeVersion) window.postMessage({ __entropy: 'cache-size', ...size }, location.origin);
      },
      (error) => console.warn('[entropy] 에셋 캐시 용량을 읽지 못했습니다', error),
    );
  }, 250);
}
onAssetCacheChange(reportCacheSize);
reportCacheSize();

function unmountAll(): void {
  for (const { player } of players.values()) {
    player.dispose();
  }
  players.clear();
}

window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data as { __entropy?: string; cache?: boolean } | null;
  if (!data || typeof data !== 'object') {
    return;
  }
  if (data.__entropy === 'scan') {
    if (typeof data.cache === 'boolean') setAssetCache(data.cache);
    scan();
  } else if (data.__entropy === 'unmount') {
    unmountAll();
  }
});

scan();
