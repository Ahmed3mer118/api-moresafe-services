import dotenv from 'dotenv';
dotenv.config();

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

console.log('Testing model:', model);
console.log('Key prefix:', key?.slice(0, 8));

try {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with JSON: {"ok":true}' }] }],
      }),
    }
  );
  console.log('HTTP status:', res.status);
  console.log('Body:', (await res.text()).slice(0, 1000));
} catch (err) {
  console.error('Error:', err.message);
  if (err.cause) console.error('Cause:', err.cause.message || err.cause);
}
