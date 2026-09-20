import * as service from './service.js';
import { env, isProduction } from '../../config/env.js';

const REFRESH_COOKIE = 'refreshToken';

// httpOnly so XSS cannot read it; the access token is kept in memory client-side.
const setRefreshCookie = (res, token) => {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    maxAge: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
};

const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

export const requestOtp = async (req, res) => {
  const data = await service.requestOtp({ ...req.body, ...meta(req) });
  res.json({ ok: true, data });
};

export const verifyOtp = async (req, res) => {
  const result = await service.verifyOtp({ ...req.body, ...meta(req) });
  setRefreshCookie(res, result.refreshToken);
  res.json({ ok: true, data: { accessToken: result.accessToken, user: result.user } });
};

export const staffLogin = async (req, res) => {
  const result = await service.staffLogin({ ...req.body, ...meta(req) });
  if (result.requires2fa) {
    res.json({ ok: true, data: result });
    return;
  }
  setRefreshCookie(res, result.refreshToken);
  res.json({ ok: true, data: { accessToken: result.accessToken, user: result.user, requires2fa: false } });
};

export const refresh = async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
  const result = await service.refreshSession({ refreshToken: token });
  setRefreshCookie(res, result.refreshToken);
  res.json({ ok: true, data: { accessToken: result.accessToken } });
};

export const logout = async (_req, res) => {
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  res.json({ ok: true, data: { loggedOut: true } });
};

export const me = async (req, res) => {
  const user = await service.getMe(req.user.id);
  res.json({ ok: true, data: user });
};
