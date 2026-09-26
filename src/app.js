import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { env, isProduction } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
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
      // Every origin is allowed while this is a development/demo deployment,
      // reflected back so Access-Control-Allow-Credentials stays usable — the
      // wildcard '*' is illegal on a credentialed request, so the caller's own
      // origin has to be echoed instead.
      //
      // The allowlist is still honoured when CORS_ORIGINS is set, so locking
      // this down for real users is a config change, not a code change. Until
      // then any site can call this API with a user's cookies; that is the
      // trade being made deliberately, not an oversight.
      //
      // A rejected origin is denied by withholding the header rather than
      // throwing: throwing surfaced as a 500 INTERNAL_ERROR, which reads as
      // "the API is broken" when the truth is "this origin is not allowed".
      origin: (origin, cb) => {
        // No origin = same-origin, curl, or a mobile webview.
        if (!origin) return cb(null, true);
        // Empty list, or a literal '*', means allow everything. Note the
        // response still echoes the caller's own origin rather than sending
        // '*': a wildcard is ILLEGAL on a credentialed request, so sending it
        // would make browsers drop the refresh cookie and sign users out on
        // every reload. Echoing is how you get allow-all WITH cookies.
        if (env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes('*')) return cb(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        logger.warn({ origin }, 'CORS: origin not in CORS_ORIGINS allowlist');
        return cb(null, false);
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

  // Rate limiting is deliberately absent: removed at the product owner's
  // request so no endpoint ever answers 429.
  //
  // Reinstating it means restoring middleware/rateLimit.js, the globalLimiter
  // mount here, and the per-phone otpLimiter on POST /api/auth/otp/request.
  // That OTP one is the first to bring back if abuse shows up: the endpoint is
  // unauthenticated and every call sends a WhatsApp message that costs money,
  // so without a limit it can be looped to drain the messaging balance.
  //
  // trust proxy above stays regardless — req.ip must be the real client for
  // logging and for any limiter that returns later.

  mountRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
