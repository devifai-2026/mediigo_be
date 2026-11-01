import { AuditLog } from '../models/AuditLog.js';
import { logger } from './logger.js';
import { requestContext } from './requestContext.js';

// Fire-and-forget. An audit write must never fail the operation it is recording
// — the operation already committed by the time this is called.
// A Super Admin acting as someone else is named on everything done that way.
const withImpersonator = (entry) => {
  const imp = requestContext()?.impersonatorId;
  return imp && !entry?.impersonatorId ? { ...entry, impersonatorId: imp } : entry;
};

export const writeAuditLog = (entry) => {
  AuditLog.create(withImpersonator(entry)).catch((err) =>
    logger.error({ err, action: entry?.action }, 'failed to write audit log'),
  );
};

export const writeAuditLogAwaited = async (entry) => {
  try {
    return await AuditLog.create(withImpersonator(entry));
  } catch (err) {
    logger.error({ err, action: entry?.action }, 'failed to write audit log');
    return null;
  }
};
