import test from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './stub.ts';
import { CloudClient } from '../packages/extension/src/page/cloud.ts';
import { SpeechSynthesisEngine, EntryTtsEngine } from '../packages/vm/src/audio/sound.ts';

function global(t: any, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete (globalThis as any)[key]; });
}
const cloud = () => new CloudClient('work', '', [], new Map([['shared', 'shared']]), new Map(), new Map());

test('disposed cloud clients abort requests and cannot open sockets after a late response', async t => {
  let reply: (value: Response) => void = () => {};
  let signal: AbortSignal | undefined; let sockets = 0;
  stub(t, globalThis, 'fetch', (_: unknown, options?: RequestInit) => { signal = options?.signal as AbortSignal; return new Promise<Response>(resolve => { reply = resolve; }); });
  global(t, 'WebSocket', class { constructor() { sockets++; } });
  const client = cloud(), pending = client.connect();
  client.dispose(); assert.equal(signal?.aborted, true);
  reply(new Response(JSON.stringify({ data: { cloudServerInfo: { url: 'https://example.test', query: 'test' } } })));
  await pending; await client.connect();
  assert.equal(sockets, 0);
});

test('repeated cloud handshakes leave one heartbeat and disposal removes socket callbacks', async t => {
  const timers = new Set<number>(); let next = 0; let socket: any;
  global(t, 'window', { setInterval: () => { timers.add(++next); return next; } });
  stub(t, globalThis, 'clearInterval', ((id: number) => timers.delete(id)) as never);
  stub(t, globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { cloudServerInfo: { url: 'https://example.test', query: 'test' } } })));
  global(t, 'WebSocket', class { onmessage: any; onclose: any; onerror: any; closed = false;
    constructor() { socket = this; } send() {} close() { this.closed = true; } });
  const client = cloud(); await client.connect();
  for (let i = 0; i < 20; i++) socket.onmessage({ data: '0{"pingInterval":1000}' });
  assert.equal(timers.size, 1);
  client.dispose(); client.dispose();
  assert.equal(timers.size, 0); assert.equal(socket.closed, true);
  assert.equal(socket.onmessage, null); assert.equal(socket.onclose, null); assert.equal(socket.onerror, null);
});

test('speech fallback cancellation resolves all waits and removes the voice-loading listener', async t => {
  const synth = new EventTarget();
  let listeners = 0; const utterances: any[] = [];
  const add = synth.addEventListener.bind(synth), remove = synth.removeEventListener.bind(synth);
  Object.assign(synth, { getVoices: () => [], speak: (u: any) => utterances.push(u), cancel() {} });
  stub(t, synth, 'addEventListener', ((...args: any[]) => { listeners++; add(...args as [string, EventListener]); }) as never);
  stub(t, synth, 'removeEventListener', ((...args: any[]) => { listeners--; remove(...args as [string, EventListener]); }) as never);
  global(t, 'speechSynthesis', synth); global(t, 'SpeechSynthesisUtterance', class {});
  for (let run = 0; run < 30; run++) {
    const engine = new SpeechSynthesisEngine();
    const waits = Array.from({ length: 10 }, () => engine.speak('test', { speed: 0, pitch: 0, volume: 1 }));
    assert.equal(listeners, 1); engine.stop(); await Promise.all(waits);
    assert.equal(listeners, 0);
  }
  assert.equal(utterances.every(u => u.onend === null && u.onerror === null), true);
});

test('TTS completion and stop release audio sources and event handlers', async t => {
  const audios: any[] = [];
  class Audio extends EventTarget {
    volume = 1; src = 'test'; loads = 0; pauses = 0; listeners = 0;
    constructor() { super(); audios.push(this); }
    addEventListener(...args: any[]) { this.listeners++; super.addEventListener(...args as [string, EventListener]); }
    removeEventListener(...args: any[]) { this.listeners--; super.removeEventListener(...args as [string, EventListener]); }
    play() { return Promise.resolve(); } pause() { this.pauses++; }
    removeAttribute() { this.src = ''; } load() { this.loads++; }
  }
  global(t, 'Audio', Audio);
  const engine = new EntryTtsEngine();
  for (let i = 0; i < 100; i++) {
    const done = engine.speak('test', { speaker: 'kyuri', speed: 0, pitch: 0, volume: 1 });
    const audio = audios.at(-1)!;
    if (i % 2) engine.stop(); else audio.dispatchEvent(new Event('ended'));
    await done;
    assert.equal(audio.src, ''); assert.equal(audio.listeners, 0); assert.equal(audio.loads, 1);
  }
});
