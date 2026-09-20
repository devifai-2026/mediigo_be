import mongoose from 'mongoose';
import { ROLES } from '../config/constants.js';

export const TICKET_STATUS = { TODO: 'TODO', IN_PROGRESS: 'IN_PROGRESS', DONE: 'DONE' };
export const TICKET_PRIORITY = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };
export const TICKET_CATEGORY = {
  TECHNICAL: 'TECHNICAL',
  BILLING: 'BILLING',
  ONBOARDING: 'ONBOARDING',
  QUEUE: 'QUEUE',
  ACCOUNT: 'ACCOUNT',
  OTHER: 'OTHER',
};

const commentSchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: String,
    authorRole: String,
    body: { type: String, required: true, maxlength: 2000 },
    // An internal note is visible to admins but not to whoever raised the ticket.
    internal: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const ticketSchema = new mongoose.Schema(
  {
    // Human-facing reference: TKT-000042.
    ref: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body: { type: String, required: true, maxlength: 4000 },

    category: { type: String, enum: Object.values(TICKET_CATEGORY), default: TICKET_CATEGORY.OTHER },
    priority: { type: String, enum: Object.values(TICKET_PRIORITY), default: TICKET_PRIORITY.MEDIUM },
    status: { type: String, enum: Object.values(TICKET_STATUS), default: TICKET_STATUS.TODO },

    raisedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    raisedByName: String,
    raisedByRole: { type: String, enum: Object.values(ROLES) },

    // Scope anchors, copied at creation so visibility can be resolved without
    // walking back through the raiser's current assignment — which may change.
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', default: null },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },

    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assigneeName: String,

    comments: { type: [commentSchema], default: [] },
    statusHistory: [
      {
        from: String,
        to: String,
        at: { type: Date, default: Date.now },
        byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: String,
      },
    ],

    // Per-viewer read state. Absent = never opened, which is what the unread
    // badge counts. Storing it on the ticket keeps the badge a single query.
    readBy: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
      },
    ],

    resolvedAt: Date,
    resolutionNote: String,
  },
  { timestamps: true },
);

ticketSchema.index({ ref: 1 }, { unique: true });
ticketSchema.index({ status: 1, priority: 1, createdAt: -1 });
ticketSchema.index({ raisedById: 1, createdAt: -1 });
ticketSchema.index({ districtId: 1, status: 1 });
ticketSchema.index({ hospitalId: 1, status: 1 });
ticketSchema.index({ assigneeId: 1, status: 1 });
// Drives the unread badge: "tickets in my scope I have never opened".
ticketSchema.index({ 'readBy.userId': 1 });

export const Ticket = mongoose.model('Ticket', ticketSchema);
