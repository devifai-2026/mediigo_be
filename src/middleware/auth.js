import { verifyToken } from '../lib/jwt.js';
import { unauthenticated, forbidden } from '../lib/errors.js';
import { User } from '../models/User.js';

const bearer = (req) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.cookies?.accessToken || null;
};

// Populates req.user from the JWT. Scope anchors ride in the token, so this
// costs zero DB reads on the hot path.
export const requireAuth = (req, _res, next) => {
  const token = bearer(req);
  if (!token) return next(unauthenticated());

  const claims = verifyToken(token);
  if (!claims || claims.type !== 'access') return next(unauthenticated('Invalid or expired token'));

  req.user = {
    id: claims.sub,
    role: claims.role,
    hospitalId: claims.hospitalId || null,
    districtId: claims.districtId || null,
    doctorId: claims.doctorId || null,
  };
  return next();
};

// For routes that behave differently when signed in but are still public
// (patient clinic discovery browses fine as a guest).
export const optionalAuth = (req, _res, next) => {
  const token = bearer(req);
  if (token) {
    const claims = verifyToken(token);
    if (claims?.type === 'access') {
      req.user = {
        id: claims.sub,
        role: claims.role,
        hospitalId: claims.hospitalId || null,
        districtId: claims.districtId || null,
        doctorId: claims.doctorId || null,
      };
    }
  }
  next();
};

// A deactivated user's JWT stays cryptographically valid until it expires.
// Deboarding relies on this check to actually log a clinic's staff out.
export const requireActiveUser = async (req, _res, next) => {
  try {
    const user = await User.findById(req.user.id).select('isActive role').lean();
    if (!user || !user.isActive) return next(forbidden('This account has been deactivated'));
    return next();
  } catch (err) {
    return next(err);
  }
};
