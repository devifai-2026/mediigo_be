import mongoose from 'mongoose';

/**
 * A doctor or clinic asking about Mediigo from the public landing page
 * (/clinic), usually from an ad.
 *
 * Kept as its own record, not only as a lead, for two reasons: the ad
 * attribution (utm_*) belongs to the enquiry, not to the agent's follow-up;
 * and an enquiry from a city no agent covers still has to land somewhere a
 * super admin can see and hand out.
 */
export const ENQUIRY_STATUS = {
  ASSIGNED: 'ASSIGNED',     // a lead exists in a field agent's follow-ups
  UNASSIGNED: 'UNASSIGNED', // no agent covers the city yet — super admin assigns
  SPAM: 'SPAM',
};

const enquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 10 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
    clinicName: { type: String, trim: true, maxlength: 120, default: '' },
    city: { type: String, required: true, trim: true, maxlength: 60 },
    specialty: { type: String, trim: true, maxlength: 60, default: '' },
    doctorsCount: { type: String, trim: true, maxlength: 10, default: '' },
    preferredTime: { type: String, trim: true, maxlength: 40, default: '' },
    message: { type: String, trim: true, maxlength: 1000, default: '' },

    // Where it came from: Instagram ad, Google, a shared link.
    utm: {
      source: { type: String, trim: true, maxlength: 80, default: '' },
      medium: { type: String, trim: true, maxlength: 80, default: '' },
      campaign: { type: String, trim: true, maxlength: 120, default: '' },
      content: { type: String, trim: true, maxlength: 120, default: '' },
    },
    referrer: { type: String, trim: true, maxlength: 300, default: '' },

    status: { type: String, enum: Object.values(ENQUIRY_STATUS), default: ENQUIRY_STATUS.UNASSIGNED },
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', default: null },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClinicLead', default: null },
    // Repeat submissions from the same number fold into this record.
    submissions: { type: Number, default: 1 },
    lastSubmittedAt: { type: Date, default: Date.now },

    ip: { type: String, default: '' },
    userAgent: { type: String, maxlength: 300, default: '' },
  },
  { timestamps: true },
);

enquirySchema.index({ phone: 1, createdAt: -1 });
enquirySchema.index({ status: 1, createdAt: -1 });

export const DoctorEnquiry = mongoose.model('DoctorEnquiry', enquirySchema);
