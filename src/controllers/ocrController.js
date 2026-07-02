import geminiService from '../services/geminiService.js';
import fs from 'fs/promises';
import { fileBuffer } from '../services/attachmentStorage.js';

export async function scanInvoice(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'File required' });
    }

    let buffer = fileBuffer(req.file);
    if (!buffer && req.file.path) {
      buffer = await fs.readFile(req.file.path);
      await fs.unlink(req.file.path).catch(() => {});
    }
    if (!buffer) {
      return res.status(400).json({ message: 'File required' });
    }

    const base64 = buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const data = await geminiService.extractInvoiceData(base64, mimeType);

    res.json({ success: true, data });
  } catch (err) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    next(err);
  }
}

export async function scanInvoiceText(req, res, next) {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ message: 'Text required' });
    const data = await geminiService.extractFromText(text);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
