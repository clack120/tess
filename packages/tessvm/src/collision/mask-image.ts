// Keep canvas-dependent mask loading separate so mask storage also works headlessly.
import { maskFromPixels, type AlphaMask } from './mask.ts';

export function buildMask(
  source: CanvasImageSource,
  width: number,
  height: number,
): AlphaMask | null {
  if (!(width > 0) || !(height > 0)) {
    return null;
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | null;
  if (!ctx) {
    return null;
  }
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  try {
    return maskFromPixels(ctx.getImageData(0, 0, width, height).data, width, height);
  } catch {
    return null;
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
