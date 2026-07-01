import https from 'https';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function useInsecureTls() {
  if (process.env.GEMINI_INSECURE_TLS === 'false') return false;
  if (process.env.GEMINI_INSECURE_TLS === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

function geminiFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers: options.headers,
        agent: useInsecureTls()
          ? new https.Agent({ rejectUnauthorized: false })
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      }
    );

    req.on('error', (err) => {
      const cause = err.cause?.message || err.message || 'unknown error';
      if (/certificate|UNABLE_TO_VERIFY|TLS|SSL/i.test(cause)) {
        reject(
          new Error(
            'فشل الاتصال بـ Gemini (مشكلة SSL). أضف GEMINI_INSECURE_TLS=true في backend/.env ثم أعد تشغيل السيرفر.'
          )
        );
        return;
      }
      reject(new Error(`Gemini connection failed: ${cause}`));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

function formatGeminiError(status, body) {
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message;
    if (msg) {
      if (status === 429 || /quota|rate limit/i.test(msg)) {
        return 'تم تجاوز حصة Gemini API — انتظر قليلاً أو راجع المفتاح في Google AI Studio';
      }
      if (status === 503 || /high demand|overloaded/i.test(msg)) {
        return 'خدمة Gemini مشغولة حالياً — حاول مرة أخرى بعد دقيقة';
      }
      return `Gemini API error (${status}): ${msg}`;
    }
  } catch {
    /* use raw body */
  }
  return `Gemini API error (${status}): ${body.slice(0, 300)}`;
}

export class GeminiService {
  get apiKey() {
    return process.env.GEMINI_API_KEY;
  }

  get model() {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  }

  ensureConfigured() {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY غير مُعرّف في backend/.env');
    }
  }

  async generateJson(prompt, inlinePart = null) {
    this.ensureConfigured();

    const parts = [{ text: prompt }];
    if (inlinePart) parts.push(inlinePart);

    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    };

    const response = await geminiFetch(`${GEMINI_URL}/${this.model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(formatGeminiError(response.status, errText));
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('لم يُرجع Gemini أي نتيجة OCR');

    try {
      return JSON.parse(text);
    } catch {
      throw new Error('تعذّر قراءة JSON من استجابة Gemini');
    }
  }

  async extractInvoiceData(base64Data, mimeType) {
    const prompt = `Extract invoice data from this document. Return ONLY valid JSON with this structure:
{
  "invoiceNumber": "string",
  "invoiceDate": "YYYY-MM-DD or null",
  "supplier": "string",
  "taxNumber": "string or null",
  "lineItems": [{"description": "string", "quantity": number, "unitPrice": number, "total": number}],
  "subtotal": number,
  "vatAmount": number,
  "total": number,
  "category": "string"
}
Use Arabic or English as found. Numbers as plain numbers without currency symbols.`;

    return this.generateJson(prompt, {
      inline_data: {
        mime_type: mimeType,
        data: base64Data,
      },
    });
  }

  async extractFromText(text) {
    const prompt = `Extract invoice data from this text. Return ONLY valid JSON:
{"invoiceNumber":"","invoiceDate":"","supplier":"","taxNumber":"","lineItems":[],"subtotal":0,"vatAmount":0,"total":0,"category":""}

Text:
${text}`;

    return this.generateJson(prompt);
  }
}

export default new GeminiService();
