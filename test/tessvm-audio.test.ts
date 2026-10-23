// Compare sound behavior with Entry's sound and BGM helpers using fake browser audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypes } from '@tess/core/strip-types';
import { fileURLToPath } from 'node:url';
import { compileProject } from '@tess/compiler';
import { Vm } from '@tess/vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface FakeSource {
  buffer: unknown;
  loop: boolean;
  playbackRate: { value: number };
  target: unknown;
  started: unknown[] | null;
  stopped: boolean;
  onended: (() => void) | null;
  connect(node: unknown): void;
  start(...args: unknown[]): void;
  stop(when?: number): void;
}

interface FakeGain {
  gain: { value: number };
  target: unknown;
  connect(node: unknown): void;
}

function fakeGain(): FakeGain {
  const node: FakeGain = {
    gain: { value: 1 },
    target: null,
    connect(to) { node.target = to; },
  };
  return node;
}

function fakeSource(): FakeSource {
  const node: FakeSource = {
    buffer: null,
    loop: false,
    playbackRate: { value: 1 },
    target: null,
    started: null,
    stopped: false,
    onended: null,
    connect(to) { node.target = to; },
    start(...args) { node.started = args; },
    stop(when) {
      if (when !== undefined) return;
      node.stopped = true;
      node.onended?.();
    },
  };
  return node;
}

function fakeAudio() {
  const sources: FakeSource[] = [];
  const resumed = { count: 0 };
  const context = {
    state: 'running',
    currentTime: 0,
    destination: { name: 'destination' },
    resume: () => {
      resumed.count += 1;
      return Promise.resolve();
    },
    suspend: () => Promise.resolve(),
    close: () => Promise.resolve(),
    decodeAudioData: (bytes: unknown) => Promise.resolve({ bytes, duration: 1 }),
    createGain: fakeGain,
    createBufferSource() {
      const source = fakeSource();
      sources.push(source);
      return source;
    },
  };
  return { context, sources, resumed };
}

function loadEngine(context: unknown) {
  const source = stripTypes(fs.readFileSync(path.join(root, 'packages/tessvm/src/audio/sound.ts'), 'utf-8'));
  const sandbox: Record<string, unknown> = {
    AbortController,
    AudioContext: function AudioContext() { return context; },
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${source.replace(/^export /gm, '')};\nthis.WebAudioEngine = WebAudioEngine;`, sandbox);
  return sandbox.WebAudioEngine as new () => Record<string, (...args: never[]) => unknown>;
}

const sound = (id: string) => ({ id, name: id, fileurl: `/${id}.mp3`, duration: 1 });

async function ready(ids: string[]) {
  const { context, sources, resumed } = fakeAudio();
  const Engine = loadEngine(context);
  const engine = new Engine() as never as {
    preload(sounds: unknown[]): Promise<void>;
    play(sound: unknown, entityId: string, startMs?: number, durationMs?: number): void;
    playBgm(sound: unknown): void;
    stopAll(): void;
    stopBgm(): void;
    stopEntity(id: string): void;
    stopExcept(id: string): void;
    setVolume(value: number): void;
    setSpeed(value: number): void;
  };
  await engine.preload(ids.map(sound));
  return { engine, sources, context, resumed };
}

test('모든 소리 멈추기는 배경음악을 건드리지 않는다', async () => {
  const { engine, sources } = await ready(['a', 'bgm']);
  engine.play(sound('a'), 'e1');
  engine.playBgm(sound('bgm'));
  assert.equal(sources.length, 2);

  engine.stopAll();
  assert.equal(sources[0]!.stopped, true, '소리는 멈춰야 합니다');
  assert.equal(sources[1]!.stopped, false, '배경음악은 이어져야 합니다');

  engine.stopBgm();
  assert.equal(sources[1]!.stopped, true);
});

test('한 오브젝트만·다른 오브젝트만 멈추기도 배경음악은 남긴다', async () => {
  const own = await ready(['a', 'bgm']);
  own.engine.play(sound('a'), 'e1');
  own.engine.playBgm(sound('bgm'));
  own.engine.stopEntity('e1');
  assert.equal(own.sources[0]!.stopped, true);
  assert.equal(own.sources[1]!.stopped, false);

  const others = await ready(['a', 'bgm']);
  others.engine.play(sound('a'), 'e1');
  others.engine.playBgm(sound('bgm'));
  others.engine.stopExcept('e2');
  assert.equal(others.sources[0]!.stopped, true);
  assert.equal(others.sources[1]!.stopped, false, '배경음악은 오브젝트의 소리가 아닙니다');
});

test('배경음악은 한 번만 재생되고 소리 크기·속도를 따르지 않는다', async () => {
  const { engine, sources, context } = await ready(['a', 'bgm']);
  engine.setVolume(0.2);
  engine.setSpeed(2);
  engine.play(sound('a'), 'e1');
  engine.playBgm(sound('bgm'));

  const [normal, bgm] = sources as [FakeSource, FakeSource];
  assert.equal(bgm.loop, false, '엔트리의 배경음악은 반복하지 않습니다');
  assert.equal(bgm.playbackRate.value, 1, '재생 속도는 소리에만 걸립니다');
  assert.equal(normal.playbackRate.value, 2);
  assert.equal((bgm.target as FakeGain).target, context.destination, '배경음악은 소리 크기를 거치지 않습니다');
  assert.notEqual((normal.target as FakeGain).target, context.destination);

  engine.setSpeed(0.5);
  assert.equal(bgm.playbackRate.value, 1, '이미 나고 있는 배경음악도 그대로입니다');
  assert.equal(normal.playbackRate.value, 0.5);
});

test('배경음악은 끝나면 스스로 물러난다', async () => {
  const { engine, sources } = await ready(['bgm']);
  engine.playBgm(sound('bgm'));
  sources[0]!.onended?.();
  engine.stopBgm();
  assert.equal(sources.length, 1, '끝난 배경음악을 다시 멈추려 들지 않습니다');
});

test('일시정지를 푼 뒤에야 소리 요청이 오디오를 되살린다', async () => {
  const { engine, context, resumed } = await ready(['a']);
  const held = engine as never as { pause(): void; resume(): void };
  held.pause();
  context.state = 'suspended';
  const before = resumed.count;

  engine.play(sound('a'), 'e1');
  assert.equal(resumed.count, before, '붙잡아 둔 동안에는 되살리지 않습니다');

  held.resume();
  engine.play(sound('a'), 'e1');
  assert.ok(resumed.count > before, '풀린 뒤에는 되살립니다');
});

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    audio: {
      play: () => calls.push('play'),
      playBgm: () => calls.push('playBgm'),
      stopBgm: () => calls.push('stopBgm'),
      stopAll: () => calls.push('stopAll'),
      stopEntity: () => calls.push('stopEntity'),
      stopExcept: () => calls.push('stopExcept'),
      setVolume: () => {},
      getVolume: () => 1,
      setSpeed: () => {},
      getSpeed: () => 1,
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
    },
    speech: {
      speak: () => Promise.resolve(),
      stop: () => calls.push('speechStop'),
      pause: () => {},
      resume: () => {},
    },
  };
}

function runVm(source: string) {
  const result = compileProject(source, { path: 'test.tess' });
  assert.ok(result.project, result.errors[0]?.message ?? '컴파일 실패');
  const log = recorder();
  const machine = new Vm({ renderer: null, audio: log.audio as never, speech: log.speech as never });
  machine.load(result.project as unknown as never);
  machine.start();
  return { vm: machine, calls: log.calls };
}

test('장면을 바꾸면 그 장면이 켜 둔 소리가 멎는다', () => {
  const { vm: machine, calls } = runVm(`
scene "첫째":
  object "가":
    sound s "s.mp3" for 3
    when start do
      play sound "s"
      jump "둘째"
    end
  end
end

scene "둘째":
  object "나":
  end
end`);
  machine.tick();
  assert.deepEqual(calls, ['play', 'stopAll', 'speechStop']);
  assert.ok(!calls.includes('stopBgm'), '배경음악은 장면을 따라 넘어갑니다');
});

test('같은 장면으로 넘어가면 소리는 그대로다', () => {
  const { vm: machine, calls } = runVm(`
scene "첫째":
  object "가":
    sound s "s.mp3" for 3
    when start do
      play sound "s"
      jump "첫째"
    end
  end
end`);
  machine.tick();
  assert.deepEqual(calls, ['play']);
});

test('소리 멈추기의 대상에 따라 읽어주기까지 멎는다', () => {
  const all = runVm(`
scene "s":
  object "o":
    when start do
      stop sound all
    end
  end
end`);
  all.vm.tick();
  assert.deepEqual(all.calls, ['stopAll', 'speechStop']);

  const mine = runVm(`
scene "s":
  object "o":
    when start do
      stop sound this
    end
  end
end`);
  mine.vm.tick();
  assert.deepEqual(mine.calls, ['stopEntity'], '자기 소리만 멈출 때는 읽어주기가 남습니다');
});

test('배경음악 재생은 앞의 것을 한 번만 물린다', () => {
  const { vm: machine, calls } = runVm(`
scene "s":
  object "o":
    sound s "s.mp3" for 3
    when start do
      play bgm "s"
    end
  end
end`);
  machine.tick();
  assert.deepEqual(calls, ['playBgm']);
});

test('일시정지한 채로 멈추면 다음 실행이 벙어리가 되지 않는다', () => {
  const { vm: machine, calls } = runVm(`
scene "s":
  object "o":
    when start do
      forever:
        wait 1
      end
    end
  end
end`);
  machine.pause();
  machine.stop();
  assert.deepEqual(
    calls.filter((name) => name === 'pause' || name === 'resume'),
    ['pause', 'resume'],
    '멈추면 붙잡아 둔 것이 없으므로 일시정지도 함께 풀립니다',
  );
});

test('장면이 바뀌면 묻고 기다리기 상자가 내려간다', () => {
  const { vm: machine } = runVm(`
scene "첫째":
  object "가":
    when start do
      ask "이름은?"
    end
    when signal "가자" do
      jump "둘째"
    end
  end
end

scene "둘째":
  object "나":
  end
end`);
  machine.tick();
  assert.equal(machine.question, '이름은?');
  machine.fireEvent('when_message_cast', machine.messages[0]!.id);
  machine.tick();
  assert.equal(machine.question, null);
  assert.equal(machine.pendingAnswer, null);
});

interface FakeSpeech {
  src: string;
  volume: number;
  paused: boolean;
  fire(name: string): void;
}

// Simulate audio completion, network errors, autoplay refusal, and a pending playback.
function fakeSpeaker(how: 'end' | 'error' | 'blocked' | 'hold') {
  const made: FakeSpeech[] = [];
  function FakeAudio(this: unknown, src: string) {
    const listeners = new Map<string, () => void>();
    const element = {
      src,
      volume: 1,
      paused: false,
      fire: (name: string) => listeners.get(name)?.(),
      addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn); },
      pause() { element.paused = true; },
      play() {
        if (how === 'blocked') return Promise.reject(new Error('NotAllowedError'));
        if (how === 'error' || how === 'end') {
          setTimeout(() => element.fire(how === 'end' ? 'ended' : 'error'), 0);
        }
        return Promise.resolve();
      },
    };
    made.push(element as FakeSpeech);
    return element;
  }
  return { FakeAudio, made };
}

function loadTts(how: 'end' | 'error' | 'blocked' | 'hold', origin = 'https://example.test') {
  const source = stripTypes(fs.readFileSync(path.join(root, 'packages/tessvm/src/audio/sound.ts'), 'utf-8'));
  const { FakeAudio, made } = fakeSpeaker(how);
  const spoken: Array<{ text: string; rate: number; pitch: number }> = [];
  const sandbox: Record<string, unknown> = {
    Audio: FakeAudio,
    URL,
    URLSearchParams,
    location: { origin },
    setTimeout,
    speechSynthesis: {
      getVoices: () => [{ lang: 'ko-KR', name: '한국어', localService: true }],
      speak: (utterance: { text: string; rate: number; pitch: number; onend?: () => void }) => {
        spoken.push({ text: utterance.text, rate: utterance.rate, pitch: utterance.pitch });
        utterance.onend?.();
      },
      cancel() {}, pause() {}, resume() {}, addEventListener() {},
    },
    SpeechSynthesisUtterance: function Utterance(this: { text: string }, text: string) { this.text = text; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${source.replace(/^export /gm, '')};\nthis.EntryTtsEngine = EntryTtsEngine;`, sandbox);
  const Engine = sandbox.EntryTtsEngine as new () => {
    speak(text: string, voice: unknown): Promise<void>;
    stop(): void;
    pause(): void;
    resume(): void;
  };
  return { engine: new Engine(), made, spoken };
}

const VOICE = { speaker: 'sally', speed: 0, pitch: 5, volume: 1 };

test('읽어주기는 엔트리의 TTS 주소를 부른다', async () => {
  const { engine, made, spoken } = loadTts('end');
  await engine.speak('안녕', VOICE);
  assert.equal(made.length, 1);
  const url = new URL(made[0]!.src);
  assert.equal(url.origin, 'https://playentry.org');
  assert.equal(url.pathname, '/api/expansionBlock/tts/read.mp3');
  assert.equal(url.searchParams.get('text'), '안녕');
  assert.equal(url.searchParams.get('speaker'), 'sally');
  assert.equal(url.searchParams.get('speed'), '0');
  assert.equal(url.searchParams.get('pitch'), '5');
  assert.deepEqual(spoken, [], '서버가 답하면 브라우저 목소리는 쓰지 않습니다');
});

test('사이트 위에서는 같은 오리진으로 부른다', async () => {
  const { engine, made } = loadTts('end', 'https://playentry.org');
  await engine.speak('안녕', VOICE);
  assert.ok(made[0]!.src.startsWith('/api/expansionBlock/tts/read.mp3?'), made[0]!.src);
});

test('TTS query text follows Entry encodeURI semantics for dynamic voice parameters', async () => {
  const { engine, made } = loadTts('end');
  await engine.speak('아&&pitch=-4.97&speaker=nwoof#', VOICE);
  const url = new URL(made[0]!.src);
  assert.equal(url.origin, 'https://playentry.org');
  assert.equal(url.pathname, '/api/expansionBlock/tts/read.mp3');
  assert.equal(url.searchParams.get('text'), '아');
  assert.equal(url.searchParams.get('pitch'), '-4.97');
  assert.equal(url.searchParams.get('speaker'), 'nwoof');
});

test('reserved TTS characters match the original query serializer without changing the endpoint', async () => {
  const { engine, made } = loadTts('end');
  for (const text of ['가 나+다%26라', 'a&speed=3&pitch=2', '//example.test/a?x=y#fragment']) {
    await engine.speak(text, VOICE);
    const expected = encodeURI(Object.entries({ text, ...VOICE }).map(([key, value]) => `${key}=${value}`).join('&'));
    const actual = new URL(made.at(-1)!.src);
    const original = new URL(`https://playentry.org/api/expansionBlock/tts/read.mp3?${expected}`);
    assert.deepEqual([...actual.searchParams], [...original.searchParams]);
    assert.equal(actual.hash, original.hash);
    assert.equal(actual.origin, 'https://playentry.org');
    assert.equal(actual.pathname, '/api/expansionBlock/tts/read.mp3');
  }
});

test('TTS sentences pass every query key through, as entry does', async () => {
  const { engine, made } = loadTts('end');
  await engine.speak('hello&extra=1&pitch=2#rest', VOICE);
  const url = new URL(made[0]!.src);
  assert.equal(url.searchParams.get('text'), 'hello');
  assert.equal(url.searchParams.get('extra'), '1');
  assert.equal(url.searchParams.get('pitch'), '2');
  assert.equal(url.origin, 'https://playentry.org');
  assert.equal(url.pathname, '/api/expansionBlock/tts/read.mp3');
});

test('빈 문장과 2500 자를 넘는 문장은 읽지 않는다', async () => {
  const { engine, made, spoken } = loadTts('end');
  await engine.speak('   ', VOICE);
  await engine.speak('가'.repeat(2501), VOICE);
  assert.equal(made.length, 0);
  assert.deepEqual(spoken, []);
});

test('TTS 서버에 닿지 못하면 브라우저 목소리로 읽는다', async () => {
  for (const how of ['error', 'blocked'] as const) {
    const { engine, spoken } = loadTts(how);
    await engine.speak('안녕', VOICE);
    assert.equal(spoken.length, 1, how);
    assert.equal(spoken[0]!.text, '안녕', how);
  }
});

// Positive Entry codes mean slower speech and lower pitch.
test('대신 읽을 때 속도와 높낮이는 엔트리와 같은 방향으로 간다', async () => {
  const { engine, spoken } = loadTts('error');
  await engine.speak('안녕', { speaker: 'kyuri', speed: 5, pitch: 5, volume: 1 });
  await engine.speak('안녕', { speaker: 'kyuri', speed: -5, pitch: -5, volume: 1 });
  const [slow, fast] = spoken;
  assert.ok(slow!.rate < 1, `5 는 느리게 여야 합니다: ${slow!.rate}`);
  assert.ok(fast!.rate > 1, `-5 는 빠르게 여야 합니다: ${fast!.rate}`);
  assert.ok(slow!.pitch < fast!.pitch, '5 가 -5 보다 낮아야 합니다');
});

// Stopping the work must also finish a pending TTS wait.
test('작품을 멈추면 읽어주기를 기다리던 자리가 풀린다', async () => {
  const { engine, made } = loadTts('hold');
  let done = false;
  const reading = engine.speak('안녕', VOICE).then(() => { done = true; });
  await new Promise((wait) => setTimeout(wait, 0));
  assert.equal(done, false, '아직 읽는 중입니다');
  engine.stop();
  await reading;
  assert.equal(done, true);
  assert.equal(made[0]!.paused, true);
});
