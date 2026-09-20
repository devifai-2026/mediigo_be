import mongoose from 'mongoose';
import { SUBMISSION_STATUS } from '../config/constants.js';

const submissionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['HOSPITAL', 'DOCTOR'], required: true },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', required: true },

    status: { type: String, enum: Object.values(SUBMISSION_STATUS), default: SUBMISSION_STATUS.DRAFT },

    payload: { type: mongoose.Schema.Types.Mixed, required: true },
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
