import sharp from 'sharp';

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export async function makeThumbnail(source) {
  if (!Buffer.isBuffer(source)) throw new TypeError('source must be a Buffer');
  if (source.length === 0 || source.length > MAX_SOURCE_BYTES) {
    throw new Error('SOURCE_SIZE_REJECTED');
  }
  const inputOptions = {
    limitInputPixels: MAX_PIXELS,
    failOn: 'warning',
    animated: false
  };
  const metadata = await sharp(source, inputOptions).metadata();
  if (!ALLOWED_FORMATS.has(metadata.format)) {
    throw new Error('FORMAT_REJECTED');
  }
  if ((metadata.pages ?? 1) !== 1) throw new Error('ANIMATION_REJECTED');
  if (!metadata.width || !metadata.height ||
      metadata.width * metadata.height > MAX_PIXELS) {
    throw new Error('PIXEL_LIMIT_REJECTED');
  }
  const { data, info } = await sharp(source, inputOptions)
    .rotate()
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  if (info.width > 800 || info.height > 800 || data.length === 0) {
    throw new Error('OUTPUT_VALIDATION_FAILED');
  }
  return {
    bytes: data,
    contentType: 'image/webp',
    width: info.width,
    height: info.height,
    size: data.length
  };
}