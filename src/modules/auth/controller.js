import * as service from './service.js';
import { env, isProduction } from '../../config/env.js';

const REFRESH_COOKIE = 'refreshToken';

// httpOnly so XSS cannot read it; the access token is kept in memory client-side.
//
// SameSite=None in production because the browser now calls this API directly
// on a different origin than the app it is served from. Under 'lax' the browser
// simply never sends this cookie on those requests, so every refresh would 401
// and the user would be signed out on each page reload.
//
// None REQUIRES Secure, which is why the two are set together — a None cookie
// without Secure is rejected outright by every current browser. Development
// stays on 'lax' over plain http, where None/Secure could not be set anyway.
const setRefreshCookie = (res, token) => {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: isProduction() ? 'none' : 'lax',
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
  // The browser only removes a cookie when the clearing attributes MATCH the
  // ones it was set with. Omitting sameSite/secure here would leave the refresh
  // cookie alive, so a "logged out" user would be silently signed back in on
  // the next page load.
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: isProduction() ? 'none' : 'lax',
    path: '/',
  });
  res.json({ ok: true, data: { loggedOut: true } });
};

export const me = async (req, res) => {
  const user = await service.getMe(req.user.id);
  res.json({ ok: true, data: user });
};
