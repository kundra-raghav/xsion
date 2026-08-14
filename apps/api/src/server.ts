import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { createServer, Server } from 'http';
import { apiRouter } from './routes';
import { wsServer } from './ws';

export function createHttpServer(): Server {
  const app = express();

  // Middleware
  app.use(
    cors({
      // Accept ANY localhost/127.0.0.1 port in dev — the Vite dev server hops to 5174/5175 when 5173 is taken, and a
      // hardcoded single origin then blocks EVERY FE→API fetch (CORS), making the whole UI look broken ("Failed to
      // fetch", 0 projects). Reflect any loopback origin so a shifted port never breaks the app again.
      origin: (origin, cb) => {
        if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
        cb(null, false);
      },
      credentials: true,
    })
  );
  app.use(express.json());
  app.use(morgan('dev'));

  // Static file serving for artifacts
  app.use('/artifacts', (req, res, next) => {
    const filePath = path.join(__dirname, '../data/artifacts', req.path);

    // Check if file exists and read first bytes to detect SVG
    if (req.path.endsWith('.png') || req.path.endsWith('.svg')) {
      fs.readFile(filePath, 'utf-8', (err, data) => {
        if (!err && data.trim().startsWith('<?xml') && data.includes('<svg')) {
          // It's an SVG file, serve with correct content-type
          res.setHeader('Content-Type', 'image/svg+xml');
        }
        // Continue to express.static
        express.static(path.join(__dirname, '../data/artifacts'))(req, res, next);
      });
    } else {
      express.static(path.join(__dirname, '../data/artifacts'))(req, res, next);
    }
  });

  // API routes
  app.use('/api', apiRouter);

  // Health endpoint
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const server = createServer(app);

  // Initialize WebSocket server
  wsServer.initialize(server);

  return server;
}
