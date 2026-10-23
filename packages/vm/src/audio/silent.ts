import type { AudioEngine } from '../runtime/engine.ts';

// Use a silent player for headless runs and benchmarks.
export class SilentAudioEngine implements AudioEngine {
  private volume = 1;
  private speed = 1;

  play(): void {}
  playBgm(): void {}
  stopBgm(): void {}
  stopAll(): void {}
  stopEntity(): void {}
  stopExcept(): void {}

  setVolume(volume: number): void {
    this.volume = volume;
  }

  getVolume(): number {
    return this.volume;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  getSpeed(): number {
    return this.speed;
  }
}

