import { ROLES, RESPONSE_CODES } from '../config/constants.js';
import { forbidden } from '../lib/errors.js';

export const requireRole = (...allowed) => (req, _res, next) => {
  if (!req.user) return next(forbidden('Authentication required'));
  if (!allowed.includes(req.user.role)) {
    return next(forbidden(`This action requires one of: ${allowed.join(', ')}`));
  }
  return next();
};

// Returns a MANDATORY query filter rather than a yes/no answer. The guard is
// "here is your WHERE clause", not "may I?" — controllers spread req.scope into
// every query, which is what makes a cross-district leak structurally hard
// rather than a thing each controller must remember.
export const scopeFilter = (user) => {
  switch (user?.role) {
    case ROLES.SUPER_ADMIN:
      return {};
    case ROLES.EXEC_ADMIN:
      return { districtId: user.districtId };
    case ROLES.RECEPTIONIST:
    case ROLES.DOCTOR:
      return { hospitalId: user.hospitalId };
    case ROLES.FIELD_AGENT:
      return { agentId: user.id };
    case ROLES.PATIENT:
      return { patientId: user.id };
    default:
      throw forbidden('Unknown role');
  }
};

export const withScope = (req, _res, next) => {
  try {
    req.scope = scopeFilter(req.user);
    return next();
  } catch (err) {
    return next(err);
  }
};

const denied = (what) =>
  forbidden(`You do not have access to this ${what}`, RESPONSE_CODES.SCOPE_DENIED);

const sameId = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);

// Resource-level assertions for :id routes, where a filter cannot apply because
// the document was fetched by primary key. Call exactly one of these immediately
// after every by-id load.
export const assertHospitalScope = (user, hospital) => {
  if (!hospital) throw denied('hospital');
  if (user.role === ROLES.SUPER_ADMIN) return true;
  if (user.role === ROLES.EXEC_ADMIN) {
    if (!sameId(hospital.districtId, user.districtId)) throw denied('hospital');
    return true;
  }
  if (user.role === ROLES.DOCTOR || user.role === ROLES.RECEPTIONIST) {
    if (!sameId(hospital._id, user.hospitalId)) throw denied('hospital');
    return true;
  }
  throw denied('hospital');
};

export const assertDoctorScope = (user, doctor, { selfOnly = false } = {}) => {
  if (!doctor) throw denied('doctor');
  if (user.role === ROLES.SUPER_ADMIN) return true;
  if (user.role === ROLES.DOCTOR) {
    // Session controls (break, open/close) are self-only: one doctor must not
    // be able to put another on a break.
    if (!sameId(doctor._id, user.doctorId)) throw denied('doctor');
    return true;
  }
  if (selfOnly) throw denied('doctor');
  if (user.role === ROLES.RECEPTIONIST) {
    if (!sameId(doctor.hospitalId, user.hospitalId)) throw denied('doctor');
    return true;
  }
  if (user.role === ROLES.EXEC_ADMIN) return true; // district checked via the hospital
  throw denied('doctor');
};

export const assertTokenScope = (user, token) => {
  if (!token) throw denied('token');
  if (user.role === ROLES.SUPER_ADMIN) return true;
  if (user.role === ROLES.PATIENT) {
    if (!sameId(token.patientId, user.id)) throw denied('token');
    return true;
  }
  if (user.role === ROLES.DOCTOR || user.role === ROLES.RECEPTIONIST) {
    if (!sameId(token.hospitalId, user.hospitalId)) throw denied('token');
    return true;
  }
  if (user.role === ROLES.EXEC_ADMIN) return true;
  throw denied('token');
};

export const assertSubmissionScope = (user, submission) => {
  if (!submission) throw denied('submission');
  if (user.role === ROLES.SUPER_ADMIN) return true;
  if (user.role === ROLES.FIELD_AGENT) {
    if (!sameId(submission.agentId, user.id)) throw denied('submission');
    return true;
  }
  if (user.role === ROLES.EXEC_ADMIN) {
    if (!sameId(submission.districtId, user.districtId)) throw denied('submission');
    return true;
  }
  throw denied('submission');
};
