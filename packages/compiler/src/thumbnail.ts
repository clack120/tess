import sharp from 'sharp';

const THUMB_BOX = 96;

export async function makeThumbnail(bytes: Buffer, box = THUMB_BOX): Promise<Buffer | null> {
  if (!bytes?.length) return null;
  try {
    const image = sharp(bytes, { animated: false });
    const { format, width, height } = await image.metadata();
    // Entry also skips SVG thumbnails because they require explicit render dimensions.
    if (!format || format === 'svg' || !width || !height) return null;

    return await image
      // Preserve aspect ratio and avoid enlarging small images.
      .resize({ width: box, height: box, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    return null; // A damaged image should not stop the build.
  }
}

export { THUMB_BOX };
