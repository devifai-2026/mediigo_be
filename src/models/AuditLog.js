import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: String,
    action: { type: String, required: true },
    entityType: String,
    entityId: { type: mongoose.Schema.Types.ObjectId },
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', default: null },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
    reason: String,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
    ip: String,
    userAgent: String,
  },
  { timestamps: true },
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ districtId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
// 2-year TTL. Atlas M0 is 512MB and audit rows would otherwise dominate it.
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 63_072_000 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
