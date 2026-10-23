import test from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './stub.ts';
import { WebAudioEngine } from '../packages/tessvm/src/audio/sound.ts';

async function setup(t: any) {
  const sources: any[] = [];
  class Context {
    state = 'running'; currentTime = 5; destination = {};
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBufferSource() {
      const node = { buffer: null, playbackRate: { value: 1 }, started: [] as number[], stops: [] as (number | undefined)[],
        connect() {}, start(...args: number[]) { this.started = args; },
        stop(when?: number) { this.stops.push(when); } };
      sources.push(node); return node;
    }
    decodeAudioData() { return Promise.resolve({ duration: 4 }); }
    close() { return Promise.resolve(); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else delete (globalThis as any).AudioContext;
  });
  stub(t, globalThis, 'fetch', () => Promise.resolve(new Response(new Uint8Array([1]))));
  const engine = new WebAudioEngine();
  const sound = { id: 'tone', name: 'tone', fileurl: '/tone.wav', duration: 10 };
  t.after(() => engine.close());
  await engine.preload([sound]);
  return { engine, sources, sound };
}

test('sound cutoff uses the decoded duration regardless of rate or project metadata', async t => {
  const { engine, sources, sound } = await setup(t);
  engine.setSpeed(0.5); engine.play(sound, 'actor');
  assert.deepEqual(sources[0].stops, [9]);
  engine.setSpeed(2);
  assert.deepEqual(sources[0].stops, [9], 'Entry does not reschedule completion when the speed changes');
  engine.play(sound, 'actor', 1000, 2000);
  assert.deepEqual(sources[1].started, [0, 1, 2]);
  assert.deepEqual(sources[1].stops, [7]);
});

test('zero, negative, and invalid durations do not start a source or raise runtime errors', async t => {
  const { engine, sources, sound } = await setup(t);
  for (const duration of [0, -1000, NaN]) engine.play(sound, 'actor', 0, duration);
  assert.equal(sources.length, 0);
  engine.play(sound, 'actor', NaN, 1000);
  assert.deepEqual(sources[0].started, [0, 0, 1]);
  assert.deepEqual(sources[0].stops, [6]);
});
