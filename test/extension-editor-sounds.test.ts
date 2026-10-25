import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { stub } from './stub.ts';
import { improveSoundLoading } from '../packages/extension/src/page/editor-sounds.ts';

function setup(t: any, cached: unknown = null) {
  const dom = new JSDOM('<div id="sounds"></div>');
  t.after(() => dom.window.close());
  stub(t, globalThis, 'document', dom.window.document);
  stub(t, globalThis, 'getComputedStyle', () => ({ position: 'static' }));
  const loaded: unknown[] = [], decoded: Array<{ resolve(buffer: unknown): void }> = [];
  let hold = false, hides = 0, clears = 0, generated = 0, injected = 0;
  class Context {
    decodeAudioData() {
      if (!hold) return Promise.resolve({ tag: 'decoded' });
      return new Promise(resolve => decoded.push({ resolve }));
    }
    close() { return Promise.resolve(); }
  }
  stub(t, globalThis, 'AudioContext', Context);
  const editor = { updateSound() {}, getEntryAudioBuffer: () => cached, hide() { hides++; } } as any;
  const original = editor.updateSound;
  const object: any = { id: 'object' };
  const playground = { object, soundEditor: editor, soundView_: dom.window.document.getElementById('sounds'),
    generateSoundElement(sound: any) { generated++; sound.view = { soundLengthView: {} }; },
    injectSound() { injected++; } };
  const restore = improveSoundLoading(playground, { loadSound: (buffer: unknown) => loaded.push(buffer), clearSound: () => { clears++; } });
  assert.ok(restore); t.after(restore);
  const status = () => dom.window.document.querySelector('.entropy-editor-sound-status') as HTMLElement;
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { editor, object, playground, loaded, original, restore, status, decoded, settle, hold: () => { hold = true; }, counts: () => ({ hides, clears, generated, injected }) };
}
const sound = (id: string) => ({ id, name: id, path: '/' + id + '.wav' });

test('sound editing uses the existing native buffer without a blocking page overlay or download', async t => {
  const buffer = { duration: 1 };
  const s = setup(t, buffer);
  stub(t, globalThis, 'fetch', () => { throw new Error('cached sounds must not download'); });
  await s.editor.updateSound(sound('cached'), s.object);
  assert.deepEqual(s.loaded, [buffer]); assert.equal(s.status().hidden, true);
  s.editor.hide(); assert.equal(s.counts().hides, 1);
  assert.equal(s.editor.sound.id, 'cached', 'completed selections retain the native save-confirmation context');
  s.restore(); assert.equal(s.editor.updateSound, s.original);
});

test('changing sounds aborts the earlier download and never displays an old waveform', async t => {
  const s = setup(t);
  let firstSignal: AbortSignal | undefined;
  stub(t, globalThis, 'fetch', (url: string, options: RequestInit) => {
    if (url === '/first.wav') {
      firstSignal = options.signal as AbortSignal;
      return new Promise((_resolve, reject) => firstSignal!.addEventListener('abort', () => reject(firstSignal!.reason)));
    }
    return Promise.resolve(new Response(new Uint8Array([1, 2])));
  });
  const first = s.editor.updateSound(sound('first'), s.object);
  await s.editor.updateSound(sound('second'), s.object); await first;
  assert.equal(firstSignal!.aborted, true);
  assert.deepEqual(s.loaded, [{ tag: 'decoded' }]);
  assert.equal(s.editor.sound.id, 'second');
});

test('leaving the sound tab cancels a pending decode without waiting for the decoder', async t => {
  const s = setup(t); s.hold();
  stub(t, globalThis, 'fetch', async () => new Response(new Uint8Array([1])));
  const loading = s.editor.updateSound(sound('first'), s.object);
  await s.settle(); assert.equal(s.decoded.length, 1);
  s.editor.hide(); await loading;
  assert.equal(s.status().hidden, true);
  assert.equal(s.editor.sound, null, 'Entry must allow selecting the cancelled sound on tab re-entry');
  s.decoded[0]!.resolve({ tag: 'late' }); await s.settle();
  assert.deepEqual(s.loaded, []);
});

test('a failed sound stays local to the panel and can be retried without reloading the editor', async t => {
  const s = setup(t);
  let calls = 0;
  stub(t, globalThis, 'fetch', async () => ++calls === 1
    ? new Response('missing', { status: 404 }) : new Response(new Uint8Array([1])));
  await s.editor.updateSound(sound('first'), s.object);
  assert.equal(s.editor.sound, null); assert.equal(s.status().hidden, false);
  assert.ok(s.status().querySelector('button'));
  await s.editor.updateSound(sound('first'), s.object);
  assert.equal(calls, 2); assert.equal(s.loaded.length, 1); assert.equal(s.status().hidden, true);
});

test('large sound lists yield between batches and leaving the tab cannot publish a stale list', async t => {
  const s = setup(t);
  let now = 0;
  stub(t, performance, 'now', () => { now += 9; return now; });
  s.object.sounds = Array.from({ length: 500 }, (_, i) => sound(String(i)));
  s.playground.injectSound();
  assert.ok(s.counts().generated < 500); assert.equal(s.counts().injected, 0);
  s.editor.hide(); await s.settle();
  assert.equal(s.counts().injected, 0);
  s.object.sounds = [sound('new')]; s.playground.injectSound();
  await s.settle(); assert.equal(s.counts().injected, 1);
});

test('a stalled audio decoder times out and leaves a retry action in the sound panel', async t => {
  const s = setup(t); s.hold();
  stub(t, globalThis, 'fetch', async () => new Response(new Uint8Array([1])));
  const nativeTimeout = globalThis.setTimeout;
  let timeout!: () => void;
  stub(t, globalThis, 'setTimeout', (fn: () => void, ms: number) => {
    if (ms !== 20_000) return nativeTimeout(fn, ms);
    timeout = fn; return 0;
  });
  const loading = s.editor.updateSound(sound('slow'), s.object);
  await s.settle(); assert.equal(s.decoded.length, 1);
  timeout(); await loading;
  assert.ok(s.status().querySelector('button')); assert.equal(s.editor.sound, null);
  s.decoded[0]!.resolve({ tag: 'late' }); await s.settle();
  assert.deepEqual(s.loaded, []);
});

test('switching from a loading large sound list to a small list clears its progress message', async t => {
  const s = setup(t);
  let now = 0;
  stub(t, performance, 'now', () => { now += 9; return now; });
  s.object.sounds = Array.from({ length: 500 }, (_, i) => sound(String(i)));
  s.playground.injectSound();
  s.object.sounds = [sound('new')]; s.playground.injectSound();
  await s.settle();
  assert.equal(s.counts().injected, 1);
  assert.equal(s.playground.soundView_!.querySelectorAll('.entropy-editor-sound-status:not([hidden])').length, 0);
});

test('changing the selected object during a decode releases the old selection and progress', async t => {
  const s = setup(t); s.hold();
  stub(t, globalThis, 'fetch', async () => new Response(new Uint8Array([1])));
  const loading = s.editor.updateSound(sound('old'), s.object);
  await s.settle();
  s.playground.object = { id: 'new' };
  s.decoded[0]!.resolve({ tag: 'old' }); await loading;
  assert.deepEqual(s.loaded, []);
  assert.equal(s.editor.sound, null); assert.equal(s.status().hidden, true);
});

for (const field of ['updateSound', 'hide']) {
  test(`read-only sound ${field} leaves native methods and panel intact`, t => {
    const s = setup(t); s.restore();
    const inject = s.playground.injectSound, hide = s.editor.hide;
    Object.defineProperty(s.editor, field, { writable: false });
    const restore = improveSoundLoading(s.playground, { loadSound() {}, clearSound() {} });
    restore?.();
    assert.equal(s.editor.updateSound, s.original); assert.equal(s.editor.hide, hide);
    assert.equal(s.playground.injectSound, inject);
    assert.equal(s.playground.soundView_!.querySelectorAll('.entropy-editor-sound-status').length, 0);
    assert.equal(s.playground.soundView_!.style.position, '');
  });
}
