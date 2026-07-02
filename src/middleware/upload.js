import multer from 'multer';

/** In-memory uploads — required for Vercel/serverless (read-only filesystem). */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
