// Bake text and vector textures at their displayed size to keep them sharp.

// Cap texture pixels per stage pixel to bound high-resolution rendering costs.
export const MAX_SHARPNESS = 8;
// Keep at least HD canvas width.
export const MIN_CANVAS_WIDTH = 1280;
// Use at least full HD when displayed at HD width or more.
export const FULLSCREEN_CANVAS_WIDTH = 1920;
export const MIN_TEXT_SHARPNESS = 2;
// Keep vectors sharper than their raster copies so rerasterizing them has a benefit.
export const MIN_SVG_SHARPNESS = 3;
// Account for drawn costume scale before applying texture pixel caps.
export const MAX_SVG_SCALE = 4;
// Give small vector icons enough pixels to survive moderate enlargement.
export const MIN_SVG_SIDE = 960;
// Limit texture sides to 4096 pixels to stay within the baseline WebGL texture size.
export const MAX_TEXTURE_SIDE = 4096;
// Limit each vector to 16 MB of RGBA pixels.
export const MAX_SVG_PIXELS = 2048 * 2048;
// Cap total vector textures at 256 MB so large works do not churn GPU memory.
export const SVG_PIXEL_BUDGET = 64 * 1024 * 1024;

// Use half steps to avoid rebaking textures for every small size change.
const stepped = (value: number) => Math.ceil(value * 2) / 2;

// Limit text sharpness by its unscaled longest side so the texture still fits.
export function textSharpness(displayScale: number, scale: number, longest: number): number {
  const wanted = Math.min(MAX_SHARPNESS, stepped(displayScale * Math.abs(scale)));
  const bySide = MAX_TEXTURE_SIDE / Math.max(longest, 1);
  return Math.min(Math.max(MIN_TEXT_SHARPNESS, wanted), bySide);
}

// Include drawn scale and shared budget when choosing vector sharpness.
export function svgSharpness(
  displayScale: number,
  width: number,
  height: number,
  budget = 1,
  scale = 1,
): number {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const drawn = Math.min(MAX_SVG_SCALE, Math.max(1, scale));
  // Aim for one texture pixel per screen pixel, with a minimum sharper than the raster copy.
  const asked = Math.max(MIN_SVG_SHARPNESS, displayScale * drawn);
  const share = Math.min(1, budget);
  // Raise tiny textures to the minimum side length before applying the budget.
  const byFloor = MIN_SVG_SIDE / Math.max(w, h);
  const wanted = Math.max(stepped(asked * share), stepped(byFloor * share));
  const bySide = MAX_TEXTURE_SIDE / Math.max(w, h);
  const byArea = Math.sqrt(MAX_SVG_PIXELS / (w * h));
  // Apply caps last so oversized drawings render smaller instead of failing.
  return Math.min(Math.max(1, wanted), bySide, byArea);
}

// Share pixel budgets by square-root scaling because texture area grows with sharpness squared.
export function svgBudgetScale(wantedPixels: number, budget = SVG_PIXEL_BUDGET): number {
  if (wantedPixels <= budget) {
    return 1;
  }
  return Math.sqrt(budget / wantedPixels);
}
