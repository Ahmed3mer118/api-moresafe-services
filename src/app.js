import './config/env.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { ensureDb } from './middleware/ensureDb.js';
import { isDbConnected } from './config/database.js';

const app = express();
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.get("/ping", (req, res) => {
    res.send("OK");
});
app.get('/api/health', (req, res) =>
  res.json({
    status: 'ok',
    service: 'Smart Custody ERP',
    db: isDbConnected() ? 'connected' : 'disconnected',
  }),
);

app.use('/api', ensureDb, routes);

app.use(notFound);
app.use(errorHandler);

export default app;
