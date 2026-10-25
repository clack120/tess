import test from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './stub.ts';
import { WebAudioEngine } from '../packages/vm/src/audio/sound.ts';

function setup(t: any, fetchFile: (input?: unknown, options?: RequestInit) => Promise<Response>, initialState = 'running',
  readBuffer?: ConstructorParameters<typeof WebAudioEngine>[0]) {
  const contexts: any[] = [];
  const decodes: Array<{ bytes: ArrayBuffer; resolve: (value: AudioBuffer) => void }> = [];
  const sources: any[] = [];
  let hold = false;
  class Context {
    state = initialState;
    resumes = 0;
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
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  stub(t, globalThis, 'fetch', fetchFile);
  const engine = new WebAudioEngine(readBuffer);
  t.after(() => {
    engine.close();
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else delete (globalThis as any).AudioContext;
  });
  return { engine, contexts, decodes, sources, hold: () => { hold = true; } };
}
const sound = (id: string, url: string) => ({ id, name: id, fileurl: url, duration: 1 });
const bytes = () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])));

test('the editor can share decoded native buffers without downloading or decoding them a second time', async t => {
  const native = { duration: 1 } as AudioBuffer;
  const { engine, decodes, contexts, sources } = setup(t, () => { throw new Error('duplicate download'); }, 'suspended', () => native);
  await engine.preload([sound('a', '/native.wav'), sound('alias', '/native.wav')]);
  assert.equal(decodes.length, 0); assert.equal(contexts.length, 1);
  engine.unlock(); assert.equal(contexts[0].resumes, 1, 'the playback context exists before the start gesture');
  engine.play(sound('a', '/native.wav'), 'actor');
  assert.equal(sources[0].buffer, native);
});

test('a replaced native audio host falls back to the normal download path', async t => {
  let requests = 0;
  const { engine, decodes } = setup(t, () => { requests++; return bytes(); }, 'running', () => { throw new Error('queue replaced'); });
  await engine.preload([sound('a', '/new.wav')]);
  assert.equal(requests, 1); assert.equal(decodes.length, 1);
});

test('preloading does not repeatedly resume suspended audio, and input unlock recovers Safari interruptions', async t => {
  const { engine, contexts, sources } = setup(t, bytes, 'suspended');
  await engine.preload(Array.from({ length: 40 }, (_, i) => sound(String(i), `/${i}.wav`)));
  const context = contexts[0];
  assert.equal(context.resumes, 0, 'background decoding does not consume or queue resume attempts');
  engine.unlock(); assert.equal(context.resumes, 1); assert.equal(context.state, 'running');
  context.state = 'interrupted';
  engine.play(sound('0', '/0.wav'), 'actor');
  assert.equal(context.resumes, 2); assert.equal(sources.length, 1);
  engine.pause(); context.state = 'interrupted';
  engine.unlock(); assert.equal(context.resumes, 2, 'input does not undo an intentional project pause');
  engine.resume(); assert.equal(context.resumes, 3);
  engine.close(); engine.unlock(); assert.equal(contexts.length, 1, 'unlock does not create contexts after disposal');
});

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

test('editor asset updates keep unchanged decoded sounds and discard removed buffers', async t => {
  let requests = 0;
  const { engine, decodes } = setup(t, () => { requests++; return bytes(); });
  const first = sound('first', '/first.wav'), second = sound('second', '/second.wav');
  await engine.preload([first, second]);
  const cached = (engine as any).buffers.get('/first.wav');
  engine.retain([first, sound('second', '/new.wav')]);
  await engine.preload([first, sound('second', '/new.wav')]);
  assert.equal(requests, 3); assert.equal(decodes.length, 3);
  assert.equal((engine as any).buffers.get('/first.wav'), cached);
  assert.equal((engine as any).buffers.has('/second.wav'), false);
  assert.equal((engine as any).buffers.size, 2);
  engine.retain([]); assert.equal((engine as any).buffers.size, 0);
});

test('zero-duration sounds are skipped without requests or playback, even when their URL is cached', async t => {
  let requests = 0;
  const { engine, contexts, sources } = setup(t, () => { requests++; return bytes(); });
  const placeholder = { ...sound('placeholder', '/tone.wav'), duration: 0 };
  const progress: boolean[] = [];
  await engine.preload([placeholder, { ...placeholder, fileurl: '/uploads///.mp3' }], 6, ok => progress.push(ok));
  assert.equal(requests, 0);
  assert.equal(contexts.length, 0);
  assert.deepEqual(progress, [true, true]);
  engine.play(placeholder, 'actor');
  engine.playBgm(placeholder);
  assert.equal(contexts.length, 0);

  const valid = sound('valid', '/tone.wav');
  await engine.preload([valid]);
  engine.play(valid, 'actor');
  engine.playBgm(valid);
  assert.equal(sources.length, 2);
  engine.play(placeholder, 'actor');
  engine.playBgm(placeholder);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].stopped, false);
  assert.equal(sources[1].stopped, true, 'an unregistered BGM still stops the previous track in Entry');
  assert.equal(requests, 1);
});

test('audio rejects failed HTTP responses before decoding and allows a later retry', async t => {
  let requests = 0;
  const { engine, decodes } = setup(t, () => ++requests === 1
    ? Promise.resolve(new Response('not audio', { status: 404 })) : bytes());
  await engine.preload([sound('a', '/sound.wav')]);
  assert.equal(decodes.length, 0);
  await engine.preload([sound('b', '/sound.wav')]);
  assert.equal(requests, 2); assert.equal(decodes.length, 1);
});

test('audio waits out a rate limit within the same load', async t => {
  let requests = 0;
  const { engine, decodes } = setup(t, () => ++requests === 1
    ? Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } })) : bytes());
  let ok: boolean | undefined;
  await engine.preload([sound('a', '/sound.wav')], 6, loaded => { ok = loaded; });
  assert.equal(requests, 2); assert.equal(decodes.length, 1); assert.equal(ok, true);
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
