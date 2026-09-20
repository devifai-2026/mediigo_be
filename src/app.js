import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { env, isProduction } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { mountRoutes } from './routes.js';

export const createApp = () => {
  const app = express();

  // Behind a reverse proxy in production; needed for correct req.ip in rate limits.
  if (isProduction()) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, cb) => {
        // No origin = same-origin, curl, or a mobile webview.
        if (!origin || env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed: ${origin}`));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  if (!isProduction()) {
    app.use(morgan('dev', { stream: { write: (m) => logger.debug(m.trim()) } }));
  }

  // Health checks are exempt: a rate-limited probe would look like an outage.
  app.use((req, res, next) => {
    if (req.path === '/healthz' || req.path === '/readyz') return next();
    return globalLimiter(req, res, next);
  });

  mountRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
