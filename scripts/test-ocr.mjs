import 'dotenv/config';
import geminiService from '../src/services/geminiService.js';

// 1x1 PNG
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

try {
  const result = await geminiService.extractInvoiceData(tinyPng.toString('base64'), 'image/png');
  console.log('OCR OK:', JSON.stringify(result, null, 2));
} catch (err) {
  console.error('OCR FAIL:', err.message);
  process.exit(1);
}
