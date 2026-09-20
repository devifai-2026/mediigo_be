// WABridge WhatsApp sender. Ported from the request shape proven in the user's
// Extraeedge project: POST {BASE}/createmessage with app-key/auth-key/device_id
// in the BODY (not headers), a numeric template_id, and a flat positional
// `variables` array (variables[0] -> {{1}}, variables[1] -> {{2}}). Template
// name/language are configured on the WABridge side and resolved by the id.
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { toWaNumber } from '../phone.js';

const TIMEOUT_MS = 8000;

// Three-tier resolution: a hospital's own credentials beat the platform
// WaSettings document, which beats the env fallback. Each clinic can send from
// its own WhatsApp number; sending a tenant's template with the wrong account
// is what WABridge answers with "You don't have enough permission".
const resolveCreds = (creds, settings) => ({
  appKey: creds?.appKey || settings?.wabridgeAppKey || env.WABRIDGE_APP_KEY,
  authKey: creds?.authKey || settings?.wabridgeAuthKey || env.WABRIDGE_AUTH_KEY,
  deviceId: creds?.deviceId || settings?.wabridgeDeviceId || env.WABRIDGE_DEVICE_ID,
  baseUrl: creds?.baseUrl || settings?.wabridgeBaseUrl || env.WABRIDGE_BASE_URL,
});

export const isConfigured = (creds, settings) => {
  const { appKey, authKey, deviceId } = resolveCreds(creds, settings);
  return Boolean(appKey && authKey && deviceId);
};

// The upstream module has no timeout; a hung WABridge would otherwise hold an
// OTP request open until the client gave up.
const postJson = async (url, payload) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
};

// Send a template message. `variables` is positional: [ {{1}}, {{2}}, ... ].
export const sendTemplate = async ({ to, templateId, variables = [], creds, settings }) => {
  const { appKey, authKey, deviceId, baseUrl } = resolveCreds(creds, settings);
  if (!appKey || !authKey || !deviceId) {
    throw new Error('WABridge not configured (set its app key / auth key / device id in WhatsApp settings)');
  }
  if (!templateId) throw new Error('WABridge templateId is required');
  const destination = toWaNumber(to);
  if (!destination) throw new Error('Invalid destination number');

  const payload = {
    'app-key': appKey,
    'auth-key': authKey,
    destination_number: destination,
    device_id: deviceId,
    template_id: templateId,
    variables,
    button_variable: [],
    media: '',
    message: '',
  };

  const { res, data } = await postJson(`${baseUrl}/createmessage`, payload);
  if (!data?.status) {
    logger.warn({ status: res.status, body: data }, 'WABridge template send failed');
    throw new Error(data?.message || 'WABridge template send failed');
  }
  return { messageId: data?.data?.messageid || '' };
};

// Free-text only delivers inside WhatsApp's 24h customer-service window; outside
// it WABridge errors and a template is required.
export const sendText = async ({ to, message, mediaLink = '', mediaType = '', creds, settings }) => {
  const { appKey, authKey, deviceId, baseUrl } = resolveCreds(creds, settings);
  if (!appKey || !authKey || !deviceId) throw new Error('WABridge not configured');
  if (!message) throw new Error('message is required');
  const destination = toWaNumber(to);
  if (!destination) throw new Error('Invalid destination number');

  const payload = {
    'app-key': appKey,
    'auth-key': authKey,
    destination_number: destination,
    device_id: deviceId,
    message,
    media_link: mediaLink,
    media_type: mediaType,
  };

  const { res, data } = await postJson(`${baseUrl}/createtextmessage`, payload);
  if (!data?.status) {
    logger.warn({ status: res.status, body: data }, 'WABridge text send failed');
    const err = new Error(data?.message || 'WABridge text send failed');
    err.code = 'WABRIDGE_SEND_FAILED';
    throw err;
  }
  return { messageId: data?.data?.messageid || '' };
};

// Only APPROVED templates are messageable; the caller filters.
export const listTemplates = async ({ limit = 100, creds, settings } = {}) => {
  const { appKey, authKey, deviceId, baseUrl } = resolveCreds(creds, settings);
  if (!appKey || !authKey || !deviceId) throw new Error('WABridge not configured');

  const { data } = await postJson(`${baseUrl}/gettemplate`, {
    'app-key': appKey,
    'auth-key': authKey,
    device_id: deviceId,
    limit,
  });
  if (!data?.status) throw new Error(data?.message || 'WABridge template list failed');

  return (data.data || []).map((t) => {
    const body = (t.components || []).find((c) => c.type === 'BODY');
    const text = body?.text || '';
    const variableCount = (text.match(/\{\{\d+\}\}/g) || []).length;
    return {
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      bodyText: text,
      variableCount,
    };
  });
};
