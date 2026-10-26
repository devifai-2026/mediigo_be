import mongoose from 'mongoose';
import { SUBMISSION_STATUS } from '../config/constants.js';

const submissionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['HOSPITAL', 'DOCTOR'], required: true },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', required: true },

    status: { type: String, enum: Object.values(SUBMISSION_STATUS), default: SUBMISSION_STATUS.DRAFT },

    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    /**
     * How the logins approval creates will sign in. PASSWORD uses the one the
     * agent set with the clinic, stored only as a hash (never in the payload,
     * which agents and reviewers can read) and cleared once approval has used
     * it. OTP creates the logins with no password at all.
     */
    loginMethod: { type: String, enum: ['PASSWORD', 'OTP'], default: 'PASSWORD' },
    loginPasswordHash: { type: String, default: null, select: false },
    documents: [{ kind: String, url: String, uploadedAt: { type: Date, default: Date.now } }],
    // Resolved at submit time. Approval refuses without it — a hospital with no
    // coordinates is invisible to nearby search, so activating one is pointless.
    geocodeResult: {
      lat: Number,
      lng: Number,
      formatted: String,
      placeId: String,
      accuracy: String,
    },

    // When the agent sent it for review — the start of the approval wait.
    submittedAt: { type: Date, default: null },
    // The agent's prospect this came from, if any.
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClinicLead', default: null },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNotes: String,
    rejectionReason: String,

    createdHospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
    createdDoctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
  },
  { timestamps: true },
);

submissionSchema.index({ agentId: 1, createdAt: -1 });
submissionSchema.index({ districtId: 1, status: 1, createdAt: -1 });
submissionSchema.index({ status: 1 });

export const OnboardingSubmission = mongoose.model('OnboardingSubmission', submissionSchema);
