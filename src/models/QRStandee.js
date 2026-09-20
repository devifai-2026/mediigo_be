import mongoose from 'mongoose';
import { STANDEE_STATUS } from '../config/constants.js';
import { randomToken } from '../lib/crypto.js';

const standeeSchema = new mongoose.Schema(
  {
    serialId: { type: String, required: true, uppercase: true, trim: true },
    // HMAC key behind the signed display credential — a waiting-room screen
    // authenticates with this instead of an expiring user session.
    qrSecret: { type: String, required: true, default: () => randomToken(24), select: false },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    // RECLAIMED is not in the original spec, which had only UNASSIGNED|DEPLOYED.
    // Deboarding has to put the physical standee somewhere, and reusing
    // UNASSIGNED loses the fact that it is in a van rather than a warehouse.
    status: { type: String, enum: Object.values(STANDEE_STATUS), default: STANDEE_STATUS.UNASSIGNED },
    deployedAt: Date,
    deployedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reclaimedAt: Date,
    reclaimReason: String,
    // Retained after reclamation so the audit trail can still answer "where was
    // this standee?" even though hospitalId has been nulled for reuse.
    lastHospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
    batchCode: String,
    scanCount: { type: Number, default: 0 },
    lastScanAt: Date,
  },
  { timestamps: true },
);

standeeSchema.index({ serialId: 1 }, { unique: true });
standeeSchema.index({ hospitalId: 1, status: 1 });
standeeSchema.index({ status: 1 });

export const QRStandee = mongoose.model('QRStandee', standeeSchema);
