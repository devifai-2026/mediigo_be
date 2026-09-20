import { WaSettings } from '../../models/WaSettings.js';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import * as wabridge from './whatsapp-wabridge.js';
import * as consoleDriver from './whatsapp-console.js';

const DRIVERS = { wabridge, console: consoleDriver };

// The settings document is read on nearly every auth request. A short cache
// keeps that off the hot path; writes bust it immediately so the Super Admin UI
// feels instant.
const CACHE_TTL_MS = 60_000;
let cache = { value: null, at: 0 };

export const bustWaSettingsCache = () => {
  cache = { value: null, at: 0 };
};

const defaults = () => ({
  _id: 'singleton',
  enabled: false,
  provider: env.MESSAGING_PROVIDER,
  wabridgeBaseUrl: env.WABRIDGE_BASE_URL,
  wabridgeAppKey: env.WABRIDGE_APP_KEY,
  wabridgeAuthKey: env.WABRIDGE_AUTH_KEY,
  wabridgeDeviceId: env.WABRIDGE_DEVICE_ID,
  templateOtp: env.WABRIDGE_TEMPLATE_OTP,
  otpDemo: env.OTP_DEMO,
  otpDemoCode: env.OTP_DEMO_CODE,
  otpTtlMinutes: env.OTP_TTL_MINUTES,
  otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
  otpLength: env.OTP_LENGTH,
  require2faRoles: [],
});

export const getWaSettings = async ({ fresh = false } = {}) => {
  if (!fresh && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let doc = null;
  try {
    // authKey is select:false; it is needed to actually send.
    doc = await WaSettings.findById('singleton').select('+wabridgeAuthKey').lean();
  } catch (err) {
    // A settings read failure must not take down login — fall back to env.
    logger.warn({ err: err.message }, 'WaSettings read failed, using env defaults');
  }

  const value = { ...defaults(), ...(doc || {}) };
  cache = { value, at: Date.now() };
  return value;
};

// Resolves which driver to use. When messaging is disabled we deliberately fall
// back to the console driver rather than throwing: an unconfigured platform
// should still let people log in.
export const getMessagingProvider = async () => {
  const settings = await getWaSettings();
  const name = settings.enabled ? settings.provider || 'console' : 'console';
  return { name, driver: DRIVERS[name] ?? DRIVERS.console, settings };
};

export const getDriver = (name) => DRIVERS[name] ?? DRIVERS.console;
