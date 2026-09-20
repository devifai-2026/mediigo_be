import { AuditLog } from '../models/AuditLog.js';
import { logger } from './logger.js';

// Fire-and-forget. An audit write must never fail the operation it is recording
// — the operation already committed by the time this is called.
export const writeAuditLog = (entry) => {
  AuditLog.create(entry).catch((err) =>
    logger.error({ err, action: entry?.action }, 'failed to write audit log'),
  );
};

export const writeAuditLogAwaited = async (entry) => {
  try {
    return await AuditLog.create(entry);
  } catch (err) {
    logger.error({ err, action: entry?.action }, 'failed to write audit log');
    return null;
  }
};
