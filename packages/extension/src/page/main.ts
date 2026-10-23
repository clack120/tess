import { mountPlayer, type MountedPlayer } from './player.ts';

const HOST_SELECTOR = '[data-tessvm-project]';
const players = new Map<HTMLElement, { player: MountedPlayer; key: string }>();

function keyOf(host: HTMLElement): string {
  return JSON.stringify([host.dataset.tessvmProject, host.dataset.tessvmGroup, host.dataset.tessvmSvg, host.dataset.tessvmCache]);
}

function scan(): void {
  for (const [host, { player, key }] of players) {
    if (!host.isConnected || !host.dataset.tessvmProject || key !== keyOf(host)) {
      player.dispose();
      players.delete(host);
    }
  }
  for (const host of document.querySelectorAll<HTMLElement>(HOST_SELECTOR)) {
    const id = host.dataset.tessvmProject;
    if (players.has(host) || !id) {
      continue;
    }
    players.set(
      host,
      { key: keyOf(host), player: mountPlayer(
        host,
        id,
        host.dataset.tessvmGroup ?? null,
        host.dataset.tessvmSvg !== '0',
        host.dataset.tessvmCache === '1',
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
  const data = event.data as { __tessvm?: string } | null;
  if (!data || typeof data !== 'object') {
    return;
  }
  if (data.__tessvm === 'scan') {
    scan();
  } else if (data.__tessvm === 'unmount') {
    unmountAll();
  }
});

scan();
