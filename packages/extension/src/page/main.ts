import { mountPlayer, type MountedPlayer } from './player.ts';

const HOST_SELECTOR = '[data-entropy-project]';
const players = new Map<HTMLElement, { player: MountedPlayer; key: string }>();

function keyOf(host: HTMLElement): string {
  return JSON.stringify([host.dataset.entropyProject, host.dataset.entropyGroup, host.dataset.entropySvg, host.dataset.entropyCache, host.dataset.entropyEscape]);
}

function scan(): void {
  for (const [host, { player, key }] of players) {
    if (!host.isConnected || !host.dataset.entropyProject || key !== keyOf(host)) {
      player.dispose();
      players.delete(host);
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
  const data = event.data as { __entropy?: string } | null;
  if (!data || typeof data !== 'object') {
    return;
  }
  if (data.__entropy === 'scan') {
    scan();
  } else if (data.__entropy === 'unmount') {
    unmountAll();
  }
});

scan();
