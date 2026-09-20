import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthenticated } from './errors.js';

// Scope anchors (hospitalId / districtId / doctorId) live in the token so RBAC
// scope checks cost zero DB reads on the hot path. They are refreshed whenever a
// new access token is minted.
export const signAccessToken = (user) =>
  jwt.sign(
    {
      sub: String(user._id ?? user.id),
      type: 'access',
      role: user.role,
      hospitalId: user.hospitalId ? String(user.hospitalId) : null,
      districtId: user.districtId ? String(user.districtId) : null,
      doctorId: user.doctorId ? String(user.doctorId) : null,
    },
    env.JWT_SECRET,
    { expiresIn: `${env.JWT_ACCESS_TTL_MINUTES}m` },
  );

export const signRefreshToken = (user, sessionId) =>
  jwt.sign({ sub: String(user._id ?? user.id), type: 'refresh', sid: sessionId }, env.JWT_SECRET, {
    expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d`,
  });

export const verifyToken = (token) => {
  try {
    return jwt.verify(token, env.JWT_SECRET);
  } catch {
    return null;
  }
};

export const requireClaims = (token, expectedType) => {
  const claims = verifyToken(token);
  if (!claims || claims.type !== expectedType) throw unauthenticated('Invalid or expired token');
  return claims;
};
