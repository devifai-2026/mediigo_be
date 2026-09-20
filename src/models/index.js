// Barrel. Importing this once at boot registers every model with Mongoose, so
// ref: 'X' lookups resolve regardless of which module loaded first.
export { User } from './User.js';
export { District } from './District.js';
export { Hospital } from './Hospital.js';
export { Doctor } from './Doctor.js';
export { QRStandee } from './QRStandee.js';
export { OPDToken } from './OPDToken.js';
export { Transaction } from './Transaction.js';
export { PatientPolicy } from './PatientPolicy.js';
export { OnboardingSubmission } from './OnboardingSubmission.js';
export { AuditLog } from './AuditLog.js';
export { OtpVerification } from './OtpVerification.js';
export { WaSettings } from './WaSettings.js';
export { Counter } from './Counter.js';
export { DistanceCache } from './DistanceCache.js';
export { Ticket, TICKET_STATUS, TICKET_PRIORITY, TICKET_CATEGORY } from './Ticket.js';

import { User } from './User.js';
import { District } from './District.js';
import { Hospital } from './Hospital.js';
import { Doctor } from './Doctor.js';
import { QRStandee } from './QRStandee.js';
import { OPDToken } from './OPDToken.js';
import { Transaction } from './Transaction.js';
import { PatientPolicy } from './PatientPolicy.js';
import { OnboardingSubmission } from './OnboardingSubmission.js';
import { AuditLog } from './AuditLog.js';
import { OtpVerification } from './OtpVerification.js';
import { WaSettings } from './WaSettings.js';
import { Counter } from './Counter.js';
import { DistanceCache } from './DistanceCache.js';
import { Ticket } from './Ticket.js';

export const allModels = [
  User, District, Hospital, Doctor, QRStandee, OPDToken, Transaction,
  PatientPolicy, OnboardingSubmission, AuditLog, OtpVerification,
  WaSettings, Counter, DistanceCache, Ticket,
];

export const syncAllIndexes = async () => {
  const results = [];
  for (const model of allModels) {
    // Sequential, not Promise.all: Atlas M0 throttles concurrent index builds.
    // eslint-disable-next-line no-await-in-loop
    await model.syncIndexes();
    // eslint-disable-next-line no-await-in-loop
    const idx = await model.collection.indexes();
    results.push({ model: model.modelName, indexes: idx.map((i) => i.name) });
  }
  return results;
};
