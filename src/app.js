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

  // Behind TWO proxies in production, not one: Render's edge terminates TLS and
  // forwards to the frontend service, whose server.js then proxies /api here.
  // Trusting a single hop made Express read the wrong entry from
  // X-Forwarded-For, so every proxied request resolved to the frontend's own IP
  // — and the rate limiter bucketed the ENTIRE user base into one counter,
  // handing out 429s to everybody once any one person was busy.
  //
  // TRUST_PROXY_HOPS keeps this tunable: a direct-to-backend deploy with no
  // frontend proxy in front of it wants 1, not 2.
  if (isProduction()) app.set('trust proxy', env.TRUST_PROXY_HOPS);

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

  // Exempt from the global limiter:
  //   - health probes, because a rate-limited probe looks like an outage;
  //   - signing in, because being locked out of the app you are trying to enter
  //     is the worst possible failure mode, and a 429 on the login screen reads
  //     as "the app is broken" rather than "slow down".
  // OTP requests keep their own limiter in auth/routes.js — that one is keyed
  // by phone number and guards an endpoint that SENDS MESSAGES AND COSTS MONEY,
  // so it stays.
  const LIMIT_EXEMPT = new Set([
    '/healthz',
    '/readyz',
    '/api/auth/staff/login',
    '/api/auth/otp/verify',
    '/api/auth/refresh',
    '/api/auth/logout',
  ]);

  app.use((req, res, next) => {
    if (LIMIT_EXEMPT.has(req.path)) return next();
    return globalLimiter(req, res, next);
  });

  mountRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
