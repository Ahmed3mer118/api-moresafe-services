import { connectDB } from '../config/database.js';

/** Ensures MongoDB is connected before handling API requests (required on serverless). */
export async function ensureDb(req, res, next) {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('Database unavailable:', err.message);
    res.status(503).json({
      message: 'Database connection failed. Check MONGODB_URI and Atlas Network Access.',
    });
  }
}
