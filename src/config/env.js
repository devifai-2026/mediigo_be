// Boot-time env validation. Anything missing or malformed fails here, loudly,
// rather than as a confusing runtime error three layers deep.
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// '1'/'true'/'yes' are all truthy — .env files are edited by humans.
const boolLike = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const intFrom = (def) => z.coerce.number().int().default(def);

const csv = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFrom(4000),
  BASE_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: csv,
  LOG_LEVEL: z.string().default('debug'),

  // These three have no safe default — a wrong value is a security hole, not an
  // inconvenience, so they are required with a minimum length.
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().default('mediigo'),
  MONGO_MAX_POOL_SIZE: intFrom(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_MINUTES: intFrom(60),
  JWT_REFRESH_TTL_DAYS: intFrom(30),
  AADHAAR_HASH_PEPPER: z.string().min(32, 'AADHAAR_HASH_PEPPER must be at least 32 characters'),

  OTP_DEMO: boolLike.default(true),
  OTP_DEMO_CODE: z.string().default('1234'),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_MINUTES: intFrom(5),
  OTP_MAX_ATTEMPTS: intFrom(5),

  MESSAGING_PROVIDER: z.enum(['console', 'wabridge']).default('console'),
  WABRIDGE_BASE_URL: z.string().default('https://web.wabridge.com/api'),
  WABRIDGE_APP_KEY: z.string().default(''),
  WABRIDGE_AUTH_KEY: z.string().default(''),
  WABRIDGE_DEVICE_ID: z.string().default(''),
  WABRIDGE_TEMPLATE_OTP: z.string().default(''),

  GOOGLE_MAPS_API_KEY: z.string().default(''),
  GOOGLE_MAPS_ENABLED: boolLike.default(true),
  GOOGLE_GEOCODE_REGION: z.string().default('in'),
  DISTANCE_MATRIX_MAX_DESTINATIONS: intFrom(25),
  DISTANCE_CACHE_TTL_HOURS: intFrom(6),
  DISTANCE_MATRIX_TIMEOUT_MS: intFrom(2500),
  MAPS_BREAKER_COOLDOWN_MS: intFrom(300000),

  NEARBY_DEFAULT_RADIUS_KM: intFrom(10),
  NEARBY_MAX_RADIUS_KM: intFrom(50),
  NEARBY_MAX_HOSPITALS: intFrom(40),

  // Proxy hops in front of this service. Render's edge is one; the frontend's
  // server.js /api proxy is a second. Too low and Express reads the wrong entry
  // from X-Forwarded-For, so req.ip becomes the frontend's address instead of
  // the caller's — which makes request logs attribute every proxied call to the
  // same client. Set to 1 if the backend is ever exposed without the frontend
  // proxy in front of it.
  TRUST_PROXY_HOPS: intFrom(2),

  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  RECEIPT_PREFIX: z.string().default('MG'),
  POLICY_BENCHMARK_VERSION: z.string().default('2025-26'),
  MINUTES_PER_CONSULT: intFrom(8),
  PLATFORM_FEE: intFrom(20),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Plain console: the logger itself depends on env, so it may not exist yet.
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = () => env.NODE_ENV === 'production';
export const isDevelopment = () => env.NODE_ENV === 'development';
export const isTest = () => env.NODE_ENV === 'test';
