import test from 'node:test';
import assert from 'node:assert/strict';
import { WebAudioEngine } from '../packages/tessvm/src/audio/sound.ts';

function setup(t: any, fetchFile: (input?: unknown, options?: RequestInit) => Promise<Response>) {
  const contexts: any[] = [];
  const decodes: Array<{ bytes: ArrayBuffer; resolve: (value: AudioBuffer) => void }> = [];
  const sources: any[] = [];
  let hold = false;
  class Context {
    state = 'running';
    currentTime = 0;
    destination = {};
    constructor() { contexts.push(this); }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBufferSource() {
      const node = { buffer: null, playbackRate: { value: 1 }, stopped: false,
        connect() {}, start() {}, stop(when?: number) { if (when === undefined) this.stopped = true; }, onended: null };
      sources.push(node); return node;
    }
    decodeAudioData(bytes: ArrayBuffer) {
      const buffer = { bytes, duration: 1 } as unknown as AudioBuffer;
      if (!hold) { decodes.push({ bytes, resolve() {} }); return Promise.resolve(buffer); }
      return new Promise<AudioBuffer>(resolve => decodes.push({ bytes, resolve }));
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
    resume() { return Promise.resolve(); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  t.mock.method(globalThis, 'fetch', fetchFile);
  const engine = new WebAudioEngine();
  t.after(() => {
    engine.close();
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else delete (globalThis as any).AudioContext;
  });
  return { engine, contexts, decodes, sources, hold: () => { hold = true; } };
}
const sound = (id: string, url: string) => ({ id, name: id, fileurl: url, duration: 1 });
const bytes = () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])));

test('audio shares downloads and decoded buffers by URL while keeping playback instances separate', async t => {
  let requests = 0, progress = 0;
  const { engine, decodes, sources } = setup(t, () => { requests++; return bytes(); });
  const sounds = Array.from({ length: 40 }, (_, i) => sound(String(i), `/${i % 2}.wav`));
  await engine.preload(sounds, 6, () => progress++);
  assert.equal(requests, 2); assert.equal(decodes.length, 2); assert.equal(progress, 40);
  engine.play(sounds[0]!, 'first'); engine.play(sounds[2]!, 'second'); engine.playBgm(sounds[4]!);
  assert.equal(sources.length, 3);
  assert.equal(sources[0].buffer, sources[1].buffer);
  assert.equal(sources[1].buffer, sources[2].buffer);
  engine.stopEntity('first');
  assert.equal(sources[0].stopped, true); assert.equal(sources[1].stopped, false);
  engine.stopAll();
  assert.equal(sources[1].stopped, true); assert.equal(sources[2].stopped, false);
  assert.equal(requests, 2);
});

test('audio rejects failed HTTP responses before decoding and allows a later retry', async t => {
  let requests = 0;
  const { engine, decodes } = setup(t, () => ++requests === 1
    ? Promise.resolve(new Response('not audio', { status: 429 })) : bytes());
  await engine.preload([sound('a', '/sound.wav')]);
  assert.equal(decodes.length, 0);
  await engine.preload([sound('b', '/sound.wav')]);
  assert.equal(requests, 2); assert.equal(decodes.length, 1);
});

test('closing audio discards old decodes without replacing or deleting a new in-flight load', async t => {
  let requests = 0;
  const { engine, decodes, sources, hold } = setup(t, () => { requests++; return bytes(); });
  hold();
  const first = engine.preload([sound('a', '/same.wav')]);
  while (decodes.length < 1) await new Promise(resolve => setImmediate(resolve));
  engine.close();
  const second = engine.preload([sound('b', '/same.wav')]);
  while (decodes.length < 2) await new Promise(resolve => setImmediate(resolve));
  decodes[0]!.resolve({ tag: 'old' } as never); await first;
  const third = engine.preload([sound('c', '/same.wav')]);
  assert.equal(requests, 2);
  const fresh = { tag: 'fresh', duration: 1 } as unknown as AudioBuffer;
  decodes[1]!.resolve(fresh); await Promise.all([second, third]);
  engine.play(sound('c', '/same.wav'), 'actor');
  assert.equal(sources[0].buffer, fresh);
  assert.equal(requests, 2);
});

test('individual playback stops cancel pending loads and stop only the requested instance', async t => {
  const { engine, decodes, sources, hold } = setup(t, bytes);
  hold();
  const tone = sound('tone', '/tone.wav');
  const cancelled = engine.play(tone, 'actor');
  const active = engine.play(tone, 'actor');
  cancelled?.();
  while (!decodes.length) await new Promise(resolve => setImmediate(resolve));
  decodes[0]!.resolve({ duration: 1 } as AudioBuffer);
  await engine.preload([tone]);
  assert.equal(sources.length, 1);
  engine.play(tone, 'actor');
  active?.();
  assert.equal(sources[0].stopped, true);
  assert.equal(sources[1].stopped, false);
});

test('closing during preload aborts requests without restarting audio for the remaining queue', async t => {
  let requests = 0;
  const { engine, contexts } = setup(t, (_, options) => {
    requests++;
    return new Promise<Response>((_, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
  });
  const loading = engine.preload(Array.from({ length: 40 }, (_, i) => sound(String(i), `/${i}.wav`)), 2);
  assert.equal(requests, 2);
  engine.close(); await loading;
  assert.equal(requests, 2); assert.equal(contexts.length, 1);
  assert.equal(contexts[0].state, 'closed');
});
