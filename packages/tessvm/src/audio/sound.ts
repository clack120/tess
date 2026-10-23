import type { AudioEngine, SpeechEngine } from '../runtime/engine.ts';
import type { Sound, VoiceProps } from '../runtime/model.ts';

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
  entityId: string;
}

export class WebAudioEngine implements AudioEngine {
  private context: AudioContext | null = null;
  // Entry keeps background music separate from sounds, so volume, speed, and stop affect sounds only.
  private master: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  private readonly playing = new Set<Playing>();
  private bgm: Playing | null = null;
  private volume = 1;
  private speed = 1;
  private paused = false;
  // Track pending loads so stops and scene changes also cancel sounds that have not started.
  private readonly pending = new Set<{ entityId: string; bgm: boolean; live: boolean }>();

  // Browsers require a gesture, so create the audio context lazily.
  private ensure(): AudioContext | null {
    if (this.context) {
      if (this.context.state === 'suspended' && !this.paused) {
        void this.context.resume().catch(() => undefined);
      }
      return this.context;
    }
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) {
      return null;
    }
    this.context = new Ctor();
    this.master = this.context.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.context.destination);
    return this.context;
  }

  // Limit parallel sound loads so they do not starve costume downloads.
  async preload(sounds: Sound[], limit = 6, onLoaded?: () => void): Promise<void> {
    let next = 0;
    const runners = new Array(Math.min(limit, sounds.length)).fill(0).map(async () => {
      while (next < sounds.length) {
        const sound = sounds[next];
        next += 1;
        if (sound) {
          await this.buffer(sound);
          onLoaded?.();
        }
      }
    });
    await Promise.all(runners);
  }

  private buffer(sound: Sound): Promise<AudioBuffer | null> {
    const url = sound.fileurl;
    const cached = this.buffers.get(url);
    if (cached) {
      return Promise.resolve(cached);
    }
    const inFlight = this.loading.get(url);
    if (inFlight) {
      return inFlight;
    }
    const context = this.ensure();
    if (!context) return Promise.resolve(null);
    const job = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Sound request failed: HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const decoded = await context.decodeAudioData(bytes);
        if (this.context !== context) return null;
        this.buffers.set(url, decoded);
        return decoded;
      } catch {
        return null;
      }
    })().finally(() => {
      // A finished old load must not remove a newer request after close.
      if (this.loading.get(url) === job) this.loading.delete(url);
    });
    this.loading.set(url, job);
    return job;
  }

  play(sound: Sound, entityId: string, startMs = 0, durationMs?: number): (() => void) | void {
    const context = this.ensure();
    if (!context) {
      return;
    }
    const buffer = this.buffers.get(sound.fileurl);
    if (!buffer) {
      const ticket = this.ticket(entityId, false);
      let entry: Playing | undefined;
      void this.buffer(sound).then((loaded) => {
        if (this.claim(ticket) && loaded) {
          entry = this.start(loaded, entityId, startMs, durationMs, false);
        }
      });
      return () => {
        ticket.live = false;
        if (entry) this.stopEntry(entry);
      };
    }
    const entry = this.start(buffer, entityId, startMs, durationMs, false);
    return () => { if (entry) this.stopEntry(entry); };
  }

  playBgm(sound: Sound): void {
    // Cancel earlier background music requests so overlapping loads cannot start duplicate tracks.
    this.stopBgm();
    const buffer = this.buffers.get(sound.fileurl);
    if (!buffer) {
      const ticket = this.ticket('', true);
      void this.buffer(sound).then((loaded) => {
        if (this.claim(ticket) && loaded) {
          this.start(loaded, '', 0, undefined, true);
        }
      });
      return;
    }
    this.start(buffer, '', 0, undefined, true);
  }

  private ticket(entityId: string, bgm: boolean) {
    const item = { entityId, bgm, live: true };
    this.pending.add(item);
    return item;
  }

  private claim(item: { entityId: string; bgm: boolean; live: boolean }): boolean {
    this.pending.delete(item);
    return item.live;
  }

  private cancel(matches: (item: { entityId: string; bgm: boolean }) => boolean): void {
    for (const item of this.pending) {
      if (matches(item)) {
        item.live = false;
      }
    }
  }

  // Background music plays once at full volume and ignores sound volume, speed, and stop blocks.
  private start(
    buffer: AudioBuffer,
    entityId: string,
    startMs: number,
    durationMs: number | undefined,
    bgm: boolean,
  ): Playing | undefined {
    const context = this.ensure();
    if (!context || !this.master) {
      return;
    }
    const duration = durationMs === undefined ? buffer.duration : Math.max(0, durationMs || 0) / 1000;
    if (!duration) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = bgm ? 1 : this.speed;
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(bgm ? context.destination : this.master);
    const offset = Math.max(0, startMs || 0) / 1000;
    const entry: Playing = { source, gain, entityId };
    source.start(0, offset, duration);
    // Entry ends the instance after the original duration even when playback slows down.
    source.stop(context.currentTime + duration);
    source.onended = () => {
      this.playing.delete(entry);
      if (this.bgm === entry) {
        this.bgm = null;
      }
    };
    if (bgm) {
      this.bgm = entry;
    } else {
      this.playing.add(entry);
    }
    return entry;
  }

  // Stopping sounds leaves background music playing, matching Entry.
  stopAll(): void {
    this.cancel((item) => !item.bgm);
    for (const entry of [...this.playing]) {
      this.stopEntry(entry);
    }
  }

  // Pause sound instances in place rather than discarding them.
  pause(): void {
    this.paused = true;
    void this.context?.suspend().catch(() => undefined);
  }

  resume(): void {
    this.paused = false;
    void this.context?.resume().catch(() => undefined);
  }

  // Release the audio context because browsers limit the number per page.
  close(): void {
    this.stopAll();
    this.stopBgm();
    this.buffers.clear();
    this.loading.clear();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
  }

  stopEntity(entityId: string): void {
    this.cancel((item) => !item.bgm && item.entityId === entityId);
    for (const entry of [...this.playing]) {
      if (entry.entityId === entityId) {
        this.stopEntry(entry);
      }
    }
  }

  stopExcept(entityId: string): void {
    this.cancel((item) => !item.bgm && item.entityId !== entityId);
    for (const entry of [...this.playing]) {
      if (entry.entityId !== entityId) {
        this.stopEntry(entry);
      }
    }
  }

  stopBgm(): void {
    this.cancel((item) => item.bgm);
    if (this.bgm) {
      this.stopEntry(this.bgm);
      this.bgm = null;
    }
  }

  private stopEntry(entry: Playing): void {
    try {
      entry.source.stop();
    } catch {
    }
    this.playing.delete(entry);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.master) {
      this.master.gain.value = volume;
    }
  }

  getVolume(): number {
    return this.volume;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    for (const entry of this.playing) {
      entry.source.playbackRate.value = speed;
    }
  }

  getSpeed(): number {
    return this.speed;
  }
}

// Map Entry voices to available Korean browser voices because Clova voices are unavailable locally.
const SPEAKERS: Record<string, { pitch: number; rate: number }> = {
  kyuri: { pitch: 1.05, rate: 1 },
  jinho: { pitch: 0.8, rate: 1 },
  hana: { pitch: 1.1, rate: 0.95 },
  dinna: { pitch: 1.15, rate: 0.95 },
  brown: { pitch: 0.85, rate: 0.95 },
  minions: { pitch: 1.5, rate: 1.15 },
  sally: { pitch: 1.25, rate: 1.05 },
  nsabina: { pitch: 1, rate: 0.95 },
  nmammon: { pitch: 0.7, rate: 0.9 },
  nmeow: { pitch: 1.6, rate: 1.1 },
  nwoof: { pitch: 0.75, rate: 1 },
};

export class SpeechSynthesisEngine {
  private voice: SpeechSynthesisVoice | null = null;
  private looked = false;

  // Retry voice lookup until the browser finishes loading Korean voices.
  private korean(): SpeechSynthesisVoice | null {
    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    if (this.voice || !synth) {
      return this.voice;
    }
    const voices = synth.getVoices();
    if (!voices.length) {
      if (!this.looked) {
        this.looked = true;
        synth.addEventListener?.('voiceschanged', () => {
          this.voice = null;
          this.korean();
        });
      }
      return null;
    }
    const korean = voices.filter((item) => item.lang.replace('_', '-').startsWith('ko'));
    this.voice = korean.find((item) => item.localService) ?? korean[0] ?? null;
    return this.voice;
  }

  speak(text: string, voice: { speaker?: string; speed: number; pitch: number; volume: number }): Promise<void> {
    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    if (!synth || !text) {
      return Promise.resolve();
    }
    const utterance = new SpeechSynthesisUtterance(text);
    const speaker = SPEAKERS[voice.speaker ?? 'kyuri'] ?? SPEAKERS.kyuri!;
    const picked = this.korean();
    if (picked) {
      utterance.voice = picked;
    }
    utterance.lang = picked?.lang ?? 'ko-KR';
    // Positive Entry codes mean slower speech and lower pitch.
    utterance.rate = Math.max(0.1, Math.min(10, speaker.rate * (1 - voice.speed * 0.1)));
    utterance.pitch = Math.max(0, Math.min(2, speaker.pitch * (1 - voice.pitch * 0.1)));
    utterance.volume = voice.volume;
    return new Promise((resolve) => {
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      synth.speak(utterance);
    });
  }

  pause(): void {
    (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.pause();
  }

  resume(): void {
    (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.resume();
  }

  stop(): void {
    (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.cancel();
  }
}

const TTS_ORIGIN = 'https://playentry.org';
const TTS_PATH = '/api/expansionBlock/tts/read.mp3';
// Entry refuses empty text and text longer than this limit.
const TTS_MAX_CHARS = 2500;

interface Reading {
  audio: HTMLAudioElement;
  end(): void;
}

// Use Entry's TTS audio when available, with browser speech synthesis as a fallback.
export class EntryTtsEngine implements SpeechEngine {
  private readonly fallback = new SpeechSynthesisEngine();
  private readonly playing = new Set<Reading>();

  private address(text: string, voice: VoiceProps): string {
    // Match Entry's encodeURI of the whole query; ampersands in text remain query separators.
    const query = encodeURI(Object.entries({
      text,
      speaker: voice.speaker || 'kyuri',
      speed: String(voice.speed || 0),
      pitch: String(voice.pitch || 0),
      volume: String(voice.volume ?? 1),
    }).map(([key, value]) => `${key}=${value}`).join('&'));
    const here = (globalThis as { location?: Location }).location?.origin;
    return `${here === TTS_ORIGIN ? '' : TTS_ORIGIN}${TTS_PATH}?${query}`;
  }

  async speak(text: string, voice: VoiceProps): Promise<void> {
    const message = String(text ?? '').trim();
    if (!message || message.length > TTS_MAX_CHARS) {
      return;
    }
    const Ctor = (globalThis as { Audio?: typeof Audio }).Audio;
    if (Ctor && (await this.play(new Ctor(this.address(message, voice)), voice))) {
      return;
    }
    await this.fallback.speak(message, voice);
  }

  private play(audio: HTMLAudioElement, voice: VoiceProps): Promise<boolean> {
    audio.volume = Math.max(0, Math.min(1, voice.volume ?? 1));
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (played: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        this.playing.delete(reading);
        resolve(played);
      };
      // Stopping the work must end the TTS wait too.
      const reading: Reading = { audio, end: () => finish(true) };
      audio.addEventListener('ended', () => finish(true));
      audio.addEventListener('error', () => finish(false));
      this.playing.add(reading);
      audio.play().catch(() => finish(false));
    });
  }

  pause(): void {
    for (const reading of this.playing) {
      reading.audio.pause();
    }
    this.fallback.pause();
  }

  resume(): void {
    for (const reading of this.playing) {
      void reading.audio.play().catch(() => undefined);
    }
    this.fallback.resume();
  }

  stop(): void {
    for (const reading of [...this.playing]) {
      reading.audio.pause();
      reading.end();
    }
    this.fallback.stop();
  }
}
