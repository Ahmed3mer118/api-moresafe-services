import fs from 'fs/promises';
import path from 'path';

const uploadRoot = path.join(process.cwd(), 'uploads', 'invoices');

/** Vercel/Lambda have read-only filesystem except /tmp — store images as data URLs in MongoDB. */
export function canUseLocalDisk() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL_ENV) {
    return false;
  }
  return process.env.UPLOAD_TO_DISK !== 'false';
}

function randomName(ext) {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`;
}

function extFromMime(mimeType = 'image/jpeg') {
  if (mimeType.includes('pdf')) return '.pdf';
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('webp')) return '.webp';
  return '.jpg';
}

export function attachmentFromBuffer(buffer, { originalname, mimetype } = {}) {
  const mimeType = mimetype || 'image/jpeg';
  const base64 = buffer.toString('base64');
  return {
    filename: originalname || `invoice${extFromMime(mimeType)}`,
    mimeType,
    url: `data:${mimeType};base64,${base64}`,
  };
}

export async function storeBuffer(buffer, { originalname, mimetype } = {}) {
  const mimeType = mimetype || 'image/jpeg';
  const ext = path.extname(originalname || '') || extFromMime(mimeType);

  if (!canUseLocalDisk()) {
    return attachmentFromBuffer(buffer, { originalname, mimetype: mimeType });
  }

  await fs.mkdir(uploadRoot, { recursive: true });
  const filename = randomName(ext);
  await fs.writeFile(path.join(uploadRoot, filename), buffer);
  return {
    filename: originalname || filename,
    mimeType,
    url: `/api/uploads/invoices/${filename}`,
  };
}

export async function storeBase64Payload(att) {
  const data = att.data || att.base64;
  if (!data) return null;

  let mimeType = att.mimeType || 'image/jpeg';
  let base64 = data;
  const match = String(data).match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    mimeType = match[1];
    base64 = match[2];
  }

  const buffer = Buffer.from(base64, 'base64');
  return storeBuffer(buffer, {
    originalname: att.filename,
    mimetype: mimeType,
  });
}

export async function storeMulterFile(file) {
  if (file.buffer) {
    return storeBuffer(file.buffer, {
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
  }
  if (file.path) {
    const buffer = await fs.readFile(file.path);
    await fs.unlink(file.path).catch(() => {});
    return storeBuffer(buffer, {
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
  }
  return null;
}

export function fileBuffer(file) {
  if (file?.buffer) return file.buffer;
  return null;
}
