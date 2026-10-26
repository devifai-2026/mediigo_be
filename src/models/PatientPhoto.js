import mongoose from 'mongoose';

export const PATIENT_PHOTO_KIND = {
  // A paper prescription: the doctor's own handwritten pad, or one the patient
  // brought from elsewhere.
  PRESCRIPTION: 'PRESCRIPTION',
  // Anything else about the patient's health: a wound, a rash, a lab report.
  HEALTH: 'HEALTH',
};

/**
 * A photo attached to one visit, kept with the patient's record.
 *
 * Medical images, so never at a public URL: the object is stored privately and
 * read back only through the API, under the same scope as the visit's
 * prescriptions. The patient's details are frozen at upload, like a
 * prescription's, so the record reads the same if the profile changes later.
 */
const patientPhotoSchema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'OPDToken', required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    date: String, // the visit's date, YYYY-MM-DD
    patientSnapshot: { name: String, phone: String },

    kind: { type: String, enum: Object.values(PATIENT_PHOTO_KIND), required: true },
    caption: { type: String, trim: true, maxlength: 200, default: '' },

    objectPath: { type: String, required: true },
    contentType: { type: String, default: 'image/jpeg' },
    bytes: Number,

    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedByRole: String,
    uploadedByName: String,
  },
  { timestamps: true },
);

patientPhotoSchema.index({ tokenId: 1, createdAt: -1 });
patientPhotoSchema.index({ hospitalId: 1, 'patientSnapshot.phone': 1, createdAt: -1 });

export const PatientPhoto = mongoose.model('PatientPhoto', patientPhotoSchema);
