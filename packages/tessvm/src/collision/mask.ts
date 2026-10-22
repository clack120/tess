// Cache costume alpha and opaque bounds instead of redrawing textures for each collision.

export interface AlphaMask {
  width: number;
  height: number;
  // One alpha byte per pixel in row-major order.
  data: Uint8Array;
  // Bound only pixels with nonzero alpha.
  trimX: number;
  trimY: number;
  trimWidth: number;
  trimHeight: number;
}

export type MaskLoader = (key: string, width: number, height: number) => AlphaMask | null;

export function maskFromPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): AlphaMask {
  const data = new Uint8Array(width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let offset = 3;
  let index = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[offset]!;
      data[index] = alpha;
      if (alpha !== 0) {
        if (x < minX) {
          minX = x;
        }
        if (x > maxX) {
          maxX = x;
        }
        if (y < minY) {
          minY = y;
        }
        if (y > maxY) {
          maxY = y;
        }
      }
      offset += 4;
      index += 1;
    }
  }
  if (maxX < 0) {
    return { width, height, data, trimX: 0, trimY: 0, trimWidth: 0, trimHeight: 0 };
  }
  return {
    width,
    height,
    data,
    trimX: minX,
    trimY: minY,
    trimWidth: maxX - minX + 1,
    trimHeight: maxY - minY + 1,
  };
}

export function solidMask(width: number, height: number): AlphaMask {
  const data = new Uint8Array(width * height);
  data.fill(255);
  return { width, height, data, trimX: 0, trimY: 0, trimWidth: width, trimHeight: height };
}

// Build masks lazily so projects without collision blocks pay no mask cost.
export class MaskStore {
  private readonly masks = new Map<string, AlphaMask | null>();
  private readonly loader: MaskLoader;

  constructor(loader: MaskLoader) {
    this.loader = loader;
  }

  get(key: string, width: number, height: number): AlphaMask | null {
    const cached = this.masks.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const mask = this.loader(key, width, height);
    if (!mask) {
      // Retry on a later frame while the costume image is loading.
      return null;
    }
    this.masks.set(key, mask);
    return mask;
  }

  put(key: string, mask: AlphaMask | null): void {
    this.masks.set(key, mask);
  }

  clear(): void {
    this.masks.clear();
  }
}
