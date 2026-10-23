import test from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '@tess/vm';

const block = (type: string, ...params: unknown[]) => ({ type, params });
const hat = block('when_run_button_click');
const mark = block('set_variable', 'result', 'done');

function setup(type: string, params: unknown[], speed = 1, extra: unknown[][] = []) {
  const plays: Array<{ args: unknown[]; stopped: boolean }> = [];
  const audio = {
    play(...args: unknown[]) {
      const item = { args, stopped: false }; plays.push(item);
      return () => { item.stopped = true; };
    },
    getSpeed: () => speed, setSpeed() {}, setVolume() {},
    stopAll() {}, stopBgm() {}, resume() {}, pause() {},
  };
  const vm = new Vm({ renderer: null, audio: audio as never });
  vm.load({
    objects: [{ id: 'actor', name: 'actor', objectType: 'sprite', scene: 'scene',
      sprite: { pictures: [], sounds: [{ id: 'tone', name: 'tone name', fileurl: '/tone.wav', duration: 4 }] },
      entity: {}, script: JSON.stringify([[hat, block(type, ...params), mark], ...extra]),
    }],
    scenes: [{ id: 'scene', name: 'scene' }],
    variables: [{ id: 'result', name: 'result', variableType: 'variable', value: '' }],
    messages: [], functions: [],
  });
  vm.start();
  const tick = (ms = 10) => { vm.tick(ms); assert.deepEqual(vm.errors, []); };
  return { vm, plays, tick, result: () => vm.variables[0]!.value };
}

test('timed sound waits stop only their own instance after engine time, regardless of playback speed', () => {
  for (const speed of [0.5, 1, 2]) {
    const { tick, plays, result } = setup('sound_something_second_wait_with_block', ['tone', 1], speed,
      [[hat, block('sound_something_with_block', 'tone')]]);
    tick();
    assert.equal(plays.length, 2);
    assert.equal(plays[0]!.args[3], undefined, 'play the full sound before the timed stop');
    tick(990); assert.equal(plays[0]!.stopped, false);
    tick(); assert.equal(plays[0]!.stopped, true);
    assert.equal(plays[1]!.stopped, false);
    assert.equal(result(), '', 'Entry processes timeouts after scripts');
    tick(); assert.equal(result(), 'done');
  }
});

test('zero, negative, and invalid timed waits stop immediately without waiting for the sound duration', () => {
  for (const seconds of [0, -1, 'bad']) {
    const { tick, plays, result } = setup('sound_something_second_wait_with_block', ['tone', seconds]);
    tick(); assert.equal(plays[0]!.stopped, true); assert.equal(result(), '');
    tick(); assert.equal(result(), 'done');
  }
});

test('timed waits use Entry number-slot parsing and retain their stop after the script is cancelled', () => {
  const { vm, tick, plays } = setup('sound_something_second_wait_with_block', ['tone', '1foo']);
  tick(); vm.targets[0]!.threads.forEach(thread => thread.stop());
  tick(999); assert.equal(plays[0]!.stopped, false);
  tick(1); assert.equal(plays[0]!.stopped, true);
});

test('stopping the work clears old timed stops before a new run', () => {
  const { vm, tick, plays } = setup('sound_something_second_wait_with_block', ['tone', 1]);
  tick(); vm.stop(); vm.start();
  tick(2000); assert.equal(plays.length, 2);
  assert.equal(plays[0]!.stopped, false, 'the audio host handles project-wide stop');
  assert.equal(plays[1]!.stopped, false);
});

test('non-waiting timed playback preserves a zero duration instead of playing the whole file', () => {
  const { tick, plays } = setup('sound_something_second_with_block', ['tone', 0]);
  tick(); assert.equal(plays[0]!.args[3], 0);
});

test('wait blocks yield once even when the requested sound is missing', () => {
  for (const type of ['sound_something_wait_with_block', 'sound_something_second_wait_with_block', 'sound_from_to_and_wait']) {
    const { tick, plays, result } = setup(type, ['missing', 1, 2]);
    tick(); assert.equal(plays.length, 0); assert.equal(result(), '');
    tick(); assert.equal(result(), 'done');
  }
});

test('range waits with invalid endpoints finish after the first engine timeout', () => {
  const { tick, result } = setup('sound_from_to_and_wait', ['tone', 'bad', 2]);
  tick(); assert.equal(result(), '');
  tick(); assert.equal(result(), 'done');
});

test('sound duration uses the exact saved ID and preserves a missing result', () => {
  const { vm } = setup('sound_something_with_block', ['tone']);
  const entity = vm.targets[0]!.entity;
  assert.equal(vm.ops.soundDuration(entity, 'tone'), 4);
  for (const id of ['tone name', '1', 'missing']) assert.equal(vm.ops.soundDuration(entity, id), undefined);
});
