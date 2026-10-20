import mongoose from 'mongoose';

/**
 * A clinic a field agent is working on but has not yet onboarded.
 *
 * Onboarding rarely happens on the first visit: the doctor is busy, asks to
 * be seen next week, wants to think about it. Each visit is logged with what
 * happened and when to go back, so the agent's follow-up list is built from
 * their own notes rather than their memory.
 *
 * Once the agent submits the clinic for onboarding the lead points at that
 * submission, and its approval status is read from there.
 */
export const LEAD_STAGE = {
  NEW: 'NEW',
  FOLLOW_UP: 'FOLLOW_UP',
  INTERESTED: 'INTERESTED',
  NOT_INTERESTED: 'NOT_INTERESTED',
  SUBMITTED: 'SUBMITTED',
};

export const VISIT_OUTCOME = {
  MET: 'MET',
  RESCHEDULED: 'RESCHEDULED',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  INTERESTED: 'INTERESTED',
  NOT_INTERESTED: 'NOT_INTERESTED',
  ONBOARDED: 'ONBOARDED',
};

const visitSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    outcome: { type: String, enum: Object.values(VISIT_OUTCOME), required: true },
    note: { type: String, trim: true, maxlength: 1000, default: '' },
    nextVisitAt: { type: Date, default: null },
  },
  { _id: true },
);

const clinicLeadSchema = new mongoose.Schema(
  {
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', default: null },

    clinicName: { type: String, required: true, trim: true, maxlength: 120 },
    contactName: { type: String, trim: true, maxlength: 80, default: '' },
    contactPhone: { type: String, trim: true, maxlength: 15, default: '' },
    specialty: { type: String, trim: true, maxlength: 60, default: '' },
    address: {
      line1: { type: String, trim: true, maxlength: 200, default: '' },
      city: { type: String, trim: true, maxlength: 60, default: '' },
      pincode: { type: String, trim: true, maxlength: 6, default: '' },
    },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    // AGENT: met on the ground. ENQUIRY: the clinic asked first, from the
    // public landing page — call them back quickly.
    source: { type: String, enum: ['AGENT', 'ENQUIRY'], default: 'AGENT' },
    enquiryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorEnquiry', default: null },

    stage: { type: String, enum: Object.values(LEAD_STAGE), default: LEAD_STAGE.NEW },
    // The next meeting the agent has agreed with the clinic. Drives the list.
    nextVisitAt: { type: Date, default: null },
    visits: { type: [visitSchema], default: [] },

    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'OnboardingSubmission', default: null },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

clinicLeadSchema.index({ agentId: 1, stage: 1, nextVisitAt: 1 });
clinicLeadSchema.index({ agentId: 1, updatedAt: -1 });
clinicLeadSchema.index({ submissionId: 1 });

export const ClinicLead = mongoose.model('ClinicLead', clinicLeadSchema);
