import './config/env.js';
import app from './app.js';
import { connectDB } from './config/database.js';
import fs from 'fs/promises';
import path from 'path';

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDB();
  await fs.mkdir(path.join(process.cwd(), 'uploads', 'invoices'), { recursive: true });
  app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error('Failed to start server:', err.message || err);
  process.exit(1);
});
