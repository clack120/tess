import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from '@tess/compiler';
import { audioDuration } from '@tess/compiler';
import { compileProject } from '@tess/compiler';
import { makeEntryBundle } from '@tess/compiler';
import { makeThumbnail } from '@tess/compiler';
import { readTar } from '@tess/decompiler';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('PNG 헤더에서 원본 크기를 읽는다 (회귀)', () => {
  const bytes = fs.readFileSync(path.join(root, 'examples/cat_idle.png'));
  assert.deepEqual(imageSize(bytes), { width: 220, height: 350 });
});

test('SVG 는 viewBox 에서 원본 크기를 읽는다', () => {
  const svg = Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 490"></svg>',
    'utf-8',
  );
  assert.deepEqual(imageSize(svg), { width: 800, height: 490 });
});

test('SVG 는 width/height 속성을 viewBox 보다 먼저 쓴다', () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120px" height="80" viewBox="0 0 800 490"></svg>',
    'utf-8',
  );
  assert.deepEqual(imageSize(svg), { width: 120, height: 80 });
});

test('SVG 의 width/height 가 %(퍼센트) 뿐이면 무시하고 viewBox 로 넘어간다', () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 640 360"></svg>',
    'utf-8',
  );
  assert.deepEqual(imageSize(svg), { width: 640, height: 360 });
});

test('크기를 전혀 알 수 없는 SVG 는 null 을 돌려준다 (makeAsset 이 100x100 으로 대체)', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf-8');
  assert.equal(imageSize(svg), null);
});

test('실제로 디컴파일한 배경 SVG(새그림1.svg, 800x490)에서도 정확히 읽힌다', () => {
  const file = path.join(root, 'temp/dd_tess/assets/image/새그림1.svg');
  if (!fs.existsSync(file)) return; // Skip only this asset check when the optional example directory is absent.
  const bytes = fs.readFileSync(file);
  assert.deepEqual(imageSize(bytes), { width: 800, height: 490 });
});

// Minimal WAV with 2.5 seconds of PCM data.
function wavFixture(seconds: any, byteRate = 88200) {
  const dataSize = Math.round(seconds * byteRate);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);            // Format chunk size.
  header.writeUInt16LE(1, 20);             // PCM format.
  header.writeUInt16LE(2, 22);             // Channel count.
  header.writeUInt32LE(44100, 24);         // Sample rate.
  header.writeUInt32LE(byteRate, 28);      // Bytes per second.
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

// One 417-byte MPEG 1 Layer III stereo frame at 44.1 kHz and 128 kbps.
function mp3Frame() {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG 1, Layer III, no CRC.
  frame[2] = 0x90; // 128 kbps, 44.1 kHz, no padding.
  frame[3] = 0x00; // Stereo mode.
  return frame;
}

test('WAV 는 fmt 의 초당 바이트로 data 청크를 나눈다', () => {
  assert.equal(audioDuration(wavFixture(2.5), '.wav'), 2.5);
  assert.equal(audioDuration(wavFixture(0.3), '.wav'), 0.3);
});

test('MP3 는 고정 비트레이트면 파일 크기로 잰다', () => {
  // One hundred 417-byte frames represent 2.6 seconds.
  const bytes = Buffer.concat(Array.from({ length: 100 }, mp3Frame));
  assert.equal(audioDuration(bytes, '.mp3'), 2.6);
});

test('MP3 앞의 ID3v2 태그와 뒤의 ID3v1 태그는 길이에서 뺀다', () => {
  const id3v2 = Buffer.alloc(2010);
  id3v2.write('ID3', 0, 'latin1');
  id3v2[6] = 0x00; id3v2[7] = 0x00; id3v2[8] = 0x0f; id3v2[9] = 0x50; // Synchsafe encoding of 2000.
  const id3v1 = Buffer.alloc(128);
  id3v1.write('TAG', 0, 'latin1');
  const audio = Buffer.concat(Array.from({ length: 100 }, mp3Frame));

  assert.equal(audioDuration(Buffer.concat([id3v2, audio, id3v1]), '.mp3'), 2.6);
});

test('MP3 에 Xing/Info 표가 있으면 프레임 수로 잰다 (VBR)', () => {
  // Use the VBR frame count rather than estimating from variable bitrates.
  const first = mp3Frame();
  first.write('Info', 36, 'latin1');       // MPEG 1 stereo places Xing 36 bytes after the frame header starts.
  first.writeUInt32BE(0x01, 40);           // Frame-count field is present.
  first.writeUInt32BE(200, 44);            // Two hundred frames at 1152 samples and 44100 Hz represent 5.2 seconds.
  const bytes = Buffer.concat([first, Buffer.alloc(999999)]);
  assert.equal(audioDuration(bytes, '.mp3'), 5.2);
});

test('소리가 아닌/깨진 파일은 null 을 돌려준다 (makeAsset 이 1초로 대체)', () => {
  assert.equal(audioDuration(Buffer.from('그냥 글자입니다'), '.mp3'), null);
  assert.equal(audioDuration(Buffer.alloc(0), '.wav'), null);
});

test('컴파일러는 for 를 안 적어도 소리 파일에서 길이를 재서 넣는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-duration-'));
  fs.writeFileSync(path.join(dir, 'click.wav'), wavFixture(2.5));
  const main = path.join(dir, 'main.tess');
  const source = `scene "s":
  object "o":
    default costume 기본 "없음.png" size 10 10
    sound 딸깍 "click.wav"
    when start do
      play sound "딸깍"
    end
  end
end`;
  fs.writeFileSync(main, source);

  const result = compileProject(source, { path: main, assetDirs: [dir] });
  assert.deepEqual(result.warnings, [], result.warnings.map((w) => w.message).join('\n'));
  assert.equal(result.project!.objects[0].sprite.sounds[0].duration, 2.5);

  // Explicit dimensions take precedence when the asset file is not available yet.
  const declared = compileProject(source.replace('"click.wav"', '"click.wav" for 9'), { path: main, assetDirs: [dir] });
  assert.equal(declared.project!.objects[0].sprite.sounds[0].duration, 9);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('PNG 에서 96x96 안에 맞춘 미리보기를 만든다', async () => {
  const bytes = fs.readFileSync(path.join(root, 'examples/cat_run.png'));
  const original = imageSize(bytes);
  const thumb = await makeThumbnail(bytes);
  assert.ok(thumb, '미리보기를 만들어야 한다');

  const size = imageSize(thumb);
  assert.ok(size!.width <= 96 && size!.height <= 96, `96 안에 들어와야 한다: ${size!.width}x${size!.height}`);
  assert.equal(Math.max(size!.width, size!.height), 96);

  const before = original!.width / original!.height;
  const after = size!.width / size!.height;
  assert.ok(Math.abs(before - after) / before < 0.02, `비율이 달라졌다: ${before} -> ${after}`);
  assert.ok(thumb.length < bytes.length, '미리보기가 원본보다 작아야 한다');
});

test('원본이 96 보다 작으면 늘리지 않는다', async () => {
  const tiny = await makeThumbnail(fs.readFileSync(path.join(root, 'examples/cat_run.png')), 4096);
  assert.equal(imageSize(tiny!)!.width, imageSize(fs.readFileSync(path.join(root, 'examples/cat_run.png')))!.width);
});

test('PNG 가 아닌 파일은 미리보기를 만들지 않는다 (엔트리도 SVG 는 안 만든다)', async () => {
  assert.equal(await makeThumbnail(Buffer.from('<svg viewBox="0 0 10 10"></svg>')), null);
  assert.equal(await makeThumbnail(Buffer.alloc(0)), null);
});

test('.ent 묶음에 image/ 와 나란히 thumb/ 가 들어간다', async () => {
  const source = `scene "s":
  object "o":
    default costume 달리기 "cat_run.png"
  end
end`;
  const result = compileProject(source, { path: path.join(root, 'x.tess'), assetDirs: [path.join(root, 'examples')] });
  assert.deepEqual(result.errors, []);

  const entries = await readTar(await makeEntryBundle(result.project!, result.assets));
  const names = entries.map((e) => e.name);
  const image = names.find((n) => n.includes('/image/'));
  assert.ok(image, '그림이 담겨야 한다');
  const thumb = image.replace('/image/', '/thumb/');
  assert.ok(names.includes(thumb), `미리보기가 같이 담겨야 한다: ${thumb}`);

  const thumbBytes = entries.find((e) => e.name === thumb)!.data;
  assert.equal(Math.max(imageSize(thumbBytes)!.width, imageSize(thumbBytes)!.height), 96);
});
