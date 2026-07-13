import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

/** Stored / policy target — must match client MAX_UPLOAD_BYTES. */
export const IMAGE_TARGET_BYTES = 500 * 1024;

const MAX_EDGE = 2048;

/**
 * @param {Buffer} input
 * @param {string} [mimeHint]
 * @param {{ maxBytes?: number, maxEdge?: number }} [opts]
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string }>}
 */
export async function compressImageBuffer(input, mimeHint = '', opts = {}) {
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : IMAGE_TARGET_BYTES;
  const maxEdge = Number(opts.maxEdge) > 0 ? Number(opts.maxEdge) : MAX_EDGE;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);

  if (!buf.length) {
    throw new Error('Empty image buffer');
  }

  const hint = String(mimeHint || '').toLowerCase();
  if (hint === 'application/pdf' || hint.includes('pdf')) {
    return { buffer: buf, mime: 'application/pdf', ext: 'pdf' };
  }

  let pipeline = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await pipeline.metadata();
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  const needsResize = width > maxEdge || height > maxEdge;

  if (!needsResize && buf.length <= maxBytes) {
    const mime = hint.startsWith('image/') ? hint : mimeFromFormat(meta.format);
    return { buffer: buf, mime, ext: extFromMime(mime) };
  }

  if (needsResize) {
    pipeline = pipeline.resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // Prefer WebP for better size/quality; fall back to JPEG if needed.
  let quality = 88;
  let best = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const webpBuf = await pipeline.clone().webp({ quality, effort: 4 }).toBuffer();
    best = { buffer: webpBuf, mime: 'image/webp', ext: 'webp' };
    if (webpBuf.length <= maxBytes) return best;
    quality = Math.max(40, quality - 8);
  }

  quality = 85;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const jpegBuf = await pipeline
      .clone()
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    best = { buffer: jpegBuf, mime: 'image/jpeg', ext: 'jpg' };
    if (jpegBuf.length <= maxBytes) return best;
    quality = Math.max(35, quality - 8);
  }

  if (best && best.buffer.length <= maxBytes) return best;

  // Last resort: smaller edge
  const tiny = await sharp(buf, { failOn: 'none' })
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70, effort: 4 })
    .toBuffer();

  if (tiny.length <= maxBytes) {
    return { buffer: tiny, mime: 'image/webp', ext: 'webp' };
  }

  throw new Error(`Could not compress image under ${Math.round(maxBytes / 1024)} KB`);
}

/**
 * Compress a multer file in place (memory or disk). Skips non-images / PDFs.
 * @param {Express.Multer.File} file
 * @param {{ maxBytes?: number, maxEdge?: number }} [opts]
 * @returns {Promise<Express.Multer.File>}
 */
export async function ensureCompressedMulterImage(file, opts = {}) {
  if (!file) return file;

  const mime = String(file.mimetype || '').toLowerCase();
  const name = String(file.originalname || '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return file;
  if (mime && !mime.startsWith('image/')) return file;

  let input;
  if (file.buffer && file.buffer.length) {
    input = file.buffer;
  } else if (file.path) {
    input = await fs.readFile(file.path);
  } else {
    return file;
  }

  const compressed = await compressImageBuffer(input, mime || 'image/jpeg', opts);
  const nextName = replaceExt(file.originalname || `image.${compressed.ext}`, compressed.ext);

  if (file.buffer) {
    file.buffer = compressed.buffer;
    file.size = compressed.buffer.length;
    file.mimetype = compressed.mime;
    file.originalname = nextName;
    return file;
  }

  if (file.path) {
    const dir = path.dirname(file.path);
    const base = path.basename(file.path, path.extname(file.path));
    const nextPath = path.join(dir, `${base}.${compressed.ext}`);
    await fs.writeFile(nextPath, compressed.buffer);
    if (nextPath !== file.path) {
      try {
        await fs.unlink(file.path);
      } catch {
        /* ignore */
      }
    }
    file.path = nextPath;
    file.filename = path.basename(nextPath);
    file.size = compressed.buffer.length;
    file.mimetype = compressed.mime;
    file.originalname = nextName;
  }

  return file;
}

function mimeFromFormat(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'png') return 'image/png';
  if (f === 'webp') return 'image/webp';
  if (f === 'gif') return 'image/gif';
  return 'image/jpeg';
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return 'jpg';
}

function replaceExt(name, ext) {
  const safe = String(name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
  const bare = safe.replace(/\.[^.]+$/, '') || 'image';
  return `${bare}.${ext}`;
}
