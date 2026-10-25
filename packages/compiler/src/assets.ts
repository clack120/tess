import { includesText, u16be, u16le, u32be } from './bytes.ts';
import { EMPTY_HOST, basename, extname } from './host.ts';
import { seedFrom } from './ids.ts';
import { audioDuration } from './audio.ts';
import type { Node } from '@entropy/parser';
import type { Context } from './context.ts';
import type { EntryAsset } from './types.ts';

interface Size {
  width: number;
  height: number;
}

interface AssetDecl {
  id: string;
  file: string;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const IMAGE_TYPES: Record<string, string> = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.gif': 'gif', '.svg': 'svg', '.bmp': 'bmp' };
const SOUND_TYPES = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

const DATA_TYPES: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
  'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/wave': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
};

// Data URLs carry their type in the MIME header, not a file extension.
function assetExt(file: string): string {
  const data = /^data:([^;,]+)/i.exec(file);
  if (data) return DATA_TYPES[data[1]!.toLowerCase()] ?? '';
  return extname(file).toLowerCase();
}

export function assetFilename(key: string): string {
  let state = seedFrom(key) || 1;
  let name = '';
  for (let i = 0; i < 32; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    name += ALPHABET[state % ALPHABET.length];
  }
  return name;
}

export function fileUrlFor(kind: string, filename: string, ext: string): string {
  return `temp/${filename.slice(0, 2)}/${filename.slice(2, 4)}/${kind}/${filename}${ext}`;
}

export function imageSize(buffer: Uint8Array): Size | null {
  if (buffer.length >= 24 && u32be(buffer, 0) === 0x89504e47) {
    return { width: u32be(buffer, 16), height: u32be(buffer, 20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: u16le(buffer, 6), height: u16le(buffer, 8) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = u16be(buffer, offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: u16be(buffer, offset + 5), width: u16be(buffer, offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (includesText(buffer, '<svg')) return svgSize(buffer);
  return null;
}

function svgSize(buffer: Uint8Array): Size | null {
  const text = new TextDecoder('utf-8').decode(buffer);
  const tag = text.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;

  const length = (attr: string): number | null => {
    const raw = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]?.trim();
    if (!raw) return null;
    const match = raw.match(/^([\d.]+)(px)?$/i); // Relative units cannot determine a pixel size.
    const value = match ? Number(match[1]) : null;
    return value !== null && Number.isFinite(value) && value > 0 ? value : null;
  };

  const width = length('width');
  const height = length('height');
  if (width && height) return { width, height };

  const viewBox = tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) {
      return { width: parts[2]!, height: parts[3]! };
    }
  }
  return null;
}

export function makeAsset(
  kind: 'image' | 'sound',
  { id, file, name, width, height, duration }: AssetDecl,
  ctx: Context,
  node: Node,
): EntryAsset {
  const ext = assetExt(file);
  const isImage = kind === 'image';

  if (isImage && !IMAGE_TYPES[ext]) ctx.warn(node, `'${file}' 은(는) 엔트리가 아는 이미지 형식이 아닙니다.`);
  if (!isImage && !SOUND_TYPES.has(ext)) ctx.warn(node, `'${file}' 은(는) 엔트리가 아는 소리 형식이 아닙니다.`);

  const resolved = findAsset(file, ctx);
  const declared = isImage ? Boolean(width && height) : duration !== null && duration !== undefined;
  let size = width && height ? { width, height } : null;
  let seconds = duration ?? null;
  let bytes = null;

  if (resolved) {
    bytes = host(ctx).readFile(resolved);
    if (bytes) {
      const limit = isImage ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
      if (bytes.length > limit) {
        ctx.warn(node, `'${file}' 크기가 ${(bytes.length / 1024 / 1024).toFixed(1)}MB라 Entry의 ${isImage ? '이미지 5MB' : '오디오 10MB'} 기준을 넘습니다.`, {
          code: 'W0006',
          help: isImage
            ? '투명도가 필요하면 PNG 팔레트·해상도를 줄이고, 필요 없으면 JPEG 품질을 조정하세요.'
            : 'MP3 비트레이트를 낮추거나 소리를 나누세요. 업로드가 조용히 실패할 수 있습니다.',
        });
      }
      if (isImage && !size) size = imageSize(bytes);
      if (!isImage && seconds === null) seconds = audioDuration(bytes, ext);
    }
  } else if (!declared) {
    const hint = isImage ? `size ${'가로'} ${'세로'}` : 'for 초';
    ctx.warn(node, `리소스 파일 '${file}' 을(를) 찾지 못했습니다. 경로만 기록합니다. (${hint} 를 적어 두면 이 알림이 사라집니다)`);
  }
  if (isImage && !size) size = { width: 100, height: 100 };

  const filename = assetFilename(`${kind}:${file}:${bytes ? bytes.length : 0}`);
  const asset: EntryAsset = {
    id,
    name: name ?? basename(file),
    filename,
    fileurl: fileUrlFor(kind, filename, ext),
    ext,
  };

  if (isImage) {
    asset.imageType = IMAGE_TYPES[ext] ?? 'png';
    asset.dimension = { width: size!.width, height: size!.height };
    delete asset.ext;
  } else {
    asset.duration = seconds ?? 1;
  }

  if (resolved) ctx.assetFiles.push({ source: resolved, target: asset.fileurl });

  // Entry keeps vector and raster copies; the player uses the raster copy.
  if (isImage && resolved && ext === '.svg') {
    const twin = resolved.replace(/\.svg$/i, '.png');
    if (host(ctx).isFile(twin)) {
      const target = fileUrlFor(kind, filename, '.png');
      asset.pngurl = target;
      ctx.assetFiles.push({ source: twin, target });
    }
  }
  return asset;
}

function findAsset(file: string, ctx: Context): string | null {
  const files = host(ctx);
  for (const dir of ctx.options.assetDirs ?? []) {
    const candidate = files.resolve(dir, file);
    if (files.isFile(candidate)) return candidate;
  }
  return null;
}

// File access is disabled unless the caller supplies a host.
function host(ctx: Context) {
  return ctx.options.host ?? EMPTY_HOST;
}

