import { latin1, u16le, u32be, u32le, u64be, u64le } from './bytes.ts';


const round = (seconds: number) => Math.round(seconds * 10) / 10;

export function audioDuration(bytes: Uint8Array, ext: string): number | null {
  try {
    const seconds = measure(bytes, ext);
    return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? round(seconds) : null;
  } catch {
    return null; // A damaged sound file should not stop compilation.
  }
}

function measure(bytes: Uint8Array, ext: string): number | null {
  if (ext === '.wav') return wavDuration(bytes);
  if (ext === '.ogg') return oggDuration(bytes);
  if (ext === '.m4a' || ext === '.mp4') return mp4Duration(bytes);
  if (ext === '.mp3') return mp3Duration(bytes);
  if (bytes.length > 12 && latin1(bytes, 0, 4) === 'RIFF') return wavDuration(bytes);
  if (bytes.length > 4 && latin1(bytes, 0, 4) === 'OggS') return oggDuration(bytes);
  return mp3Duration(bytes);
}

function wavDuration(bytes: Uint8Array): number | null {
  if (bytes.length < 12 || latin1(bytes, 8, 12) !== 'WAVE') return null;

  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = latin1(bytes, offset, offset + 4);
    const size = u32le(bytes, offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) byteRate = u32le(bytes, body + 8);
    if (id === 'data') {
      if (!byteRate) return null;
      // Streaming WAV files may leave the data size unset; use the remaining bytes.
      const dataSize = size > 0 && body + size <= bytes.length ? size : bytes.length - body;
      return dataSize / byteRate;
    }
    offset = body + size + (size % 2); // WAV chunks are padded to an even byte count.
  }
  return null;
}

// The last Ogg page's granule position gives the total sample count.
function oggDuration(bytes: Uint8Array): number | null {
  if (latin1(bytes, 0, 4) !== 'OggS') return null;

  // Opus granule positions always use 48 kHz.
  const head = latin1(bytes, 0, Math.min(bytes.length, 4096));
  let rate = null;
  let preSkip = 0;
  const opus = head.indexOf('OpusHead');
  if (opus >= 0) {
    rate = 48000;
    preSkip = u16le(bytes, opus + 10);
  } else {
    const vorbis = head.indexOf('\x01vorbis');
    if (vorbis < 0) return null;
    rate = u32le(bytes, vorbis + 12);
  }
  if (!rate) return null;

  for (let offset = bytes.length - 14; offset >= 0; offset -= 1) {
    if (latin1(bytes, offset, offset + 4) !== 'OggS') continue;
    const granule = (u64le(bytes, offset + 6));
    if (granule <= 0) continue;
    return Math.max(0, granule - preSkip) / rate;
  }
  return null;
}

function mp4Duration(bytes: Uint8Array, start = 0, end = bytes.length): number | null {
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32be(bytes, offset);
    const type = latin1(bytes, offset + 4, offset + 8);
    let body = offset + 8;
    if (size === 1) { // An MP4 size of 1 means a 64-bit size follows.
      if (body + 8 > end) return null;
      size = (u64be(bytes, body));
      body += 8;
    }
    if (size === 0) size = end - offset; // An MP4 size of 0 extends to the end of the file.

    if (type === 'moov') return mp4Duration(bytes, body, Math.min(end, offset + size));
    if (type === 'mvhd') {
      const version = bytes[body];
      const at = version === 1 ? body + 20 : body + 12;
      const timescale = u32be(bytes, at);
      const duration = version === 1 ? (u64be(bytes, at + 4)) : u32be(bytes, at + 4);
      return timescale ? duration / timescale : null;
    }
    if (size < 8) return null;
    offset += size;
  }
  return null;
}

interface Mp3Frame {
  version: number;
  layer: number;
  bitrate: number;
  sampleRate: number;
  samples: number;
  size: number;
  mono: boolean;
}

const MP3_BITRATES: Record<number, Record<number, number[]>> = {
  // Bitrate indices 0 and 15 are free-format and reserved, respectively.
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
const MP3_RATES: Record<number, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

function skipId3(bytes: Uint8Array): number {
  if (bytes.length < 10 || latin1(bytes, 0, 3) !== 'ID3') return 0;
  // ID3v2 sizes use only seven bits per byte.
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14)
    | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  return 10 + size + (bytes[5]! & 0x10 ? 10 : 0); // An ID3v2 footer adds ten bytes.
}

function mp3FrameHeader(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length) return null;
  if (bytes[offset]! !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) return null;

  const versionBits = (bytes[offset + 1]! >> 3) & 0x03;
  const layerBits = (bytes[offset + 1]! >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;

  const version = ({ 0: 2.5, 2: 2, 3: 1 } as Record<number, number>)[versionBits];
  const layer = ({ 1: 3, 2: 2, 3: 1 } as Record<number, number>)[layerBits];
  if (version === undefined || layer === undefined) return null;
  const bitrate = MP3_BITRATES[version === 1 ? 1 : 2]![layer]![(bytes[offset + 2]!! >> 4) & 0x0f];
  const sampleRate = MP3_RATES[version]![(bytes[offset + 2]!! >> 2) & 0x03];
  if (!bitrate || !sampleRate) return null;

  const padding = (bytes[offset + 2]! >> 1) & 0x01;
  const mono = ((bytes[offset + 3]! >> 6) & 0x03) === 3;
  // Layer I uses 384 samples and four-byte slots; MPEG 2/2.5 halves Layer III samples.
  const samples = layer === 1 ? 384 : (layer === 2 || version === 1 ? 1152 : 576);
  const size = layer === 1
    ? Math.floor((12000 * bitrate) / sampleRate + padding) * 4
    : Math.floor((samples / 8000 * bitrate) / sampleRate) + padding;

  return { version, layer, bitrate, sampleRate, samples, size, mono };
}

function mp3Duration(bytes: Uint8Array): number | null {
  const start = skipId3(bytes);

  // Tags may be followed by extra bytes before the first MP3 frame.
  let frame = null;
  let offset = start;
  for (const limit = Math.min(bytes.length, start + 65536); offset < limit; offset += 1) {
    frame = mp3FrameHeader(bytes, offset);
    if (frame) break;
  }
  if (!frame) return null;

  const vbrFrames = xingFrames(bytes, offset, frame) ?? vbriFrames(bytes, offset);
  if (vbrFrames) return (vbrFrames * frame.samples) / frame.sampleRate;

  // Without a VBR frame count, estimate from bitrate and exclude the ID3v1 tag.
  const hasId3v1 = bytes.length >= 128
    && latin1(bytes, bytes.length - 128, bytes.length - 125) === 'TAG';
  const audioBytes = (bytes.length - (hasId3v1 ? 128 : 0)) - offset;
  return (audioBytes * 8) / (frame.bitrate * 1000);
}

function xingFrames(bytes: Uint8Array, frameStart: number, frame: Mp3Frame): number | null {
  // Xing/Info follows side info, whose size depends on MPEG version and channel count.
  const skip = frame.version === 1 ? (frame.mono ? 21 : 36) : (frame.mono ? 13 : 21);
  const at = frameStart + skip;
  if (at + 12 > bytes.length) return null;
  const tag = latin1(bytes, at, at + 4);
  if (tag !== 'Xing' && tag !== 'Info') return null;
  const flags = u32be(bytes, at + 4);
  return flags & 0x01 ? u32be(bytes, at + 8) : null;
}

function vbriFrames(bytes: Uint8Array, frameStart: number): number | null {
  const at = frameStart + 36;
  if (at + 18 > bytes.length) return null;
  if (latin1(bytes, at, at + 4) !== 'VBRI') return null;
  return u32be(bytes, at + 14);
}
