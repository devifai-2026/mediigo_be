import mongoose from 'mongoose';
import { PHARMACY_STATUS } from '../config/constants.js';

/**
 * A prescription written in the chamber, kept as the patient's EMR.
 *
 * The patient's details are frozen at writing time, like a token's: a
 * prescription is a medical record of what was given to whom on that day, and
 * must read the same if the patient later edits their profile.
 *
 * Append-only by design. A wrong prescription is corrected by writing a new
 * one, never by editing the old — the old one may already be in a pharmacy.
 */
const medicineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    dosage: { type: String, trim: true, maxlength: 40, default: '' },
    duration: { type: String, trim: true, maxlength: 40, default: '' },
    instruction: { type: String, trim: true, maxlength: 120, default: '' },
  },
  { _id: false },
);

const prescriptionSchema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'OPDToken', required: true },
    tokenNumber: Number,
    // Clinic-local 'YYYY-MM-DD', the same format tokens use.
    date: { type: String, required: true },

    patientSnapshot: { name: String, phone: String, age: Number, gender: String },
    doctorSnapshot: { name: String, specialty: String, chamberNumber: String, qualifications: [String] },

    // What the patient came in with. Filled from the token's complaint and
    // declared conditions when the doctor leaves it blank, so every record
    // carries the presenting symptoms even if nobody typed them.
    symptoms: { type: String, trim: true, maxlength: 500, default: '' },
    diagnosis: { type: String, required: true, trim: true, maxlength: 300 },
    medicines: { type: [medicineSchema], default: [] },
    advice: { type: String, trim: true, maxlength: 1000, default: '' },
    // Printed on the pad. A real follow-up booking goes through the queue's
    // follow-up flow, which holds a token; this is only the advised date.
    reviewDate: { type: String, default: null },
    // Amount the patient still owes, as the doctor wrote it on the pad —
    // tests, procedures, or a fee not yet paid. Printed only; the money itself
    // is collected and receipted at the desk.
    totalDue: { type: Number, default: null, min: 0 },
    hospitalName: { type: String, default: '' },

    // Fulfilment at the clinic pharmacy. Unlike the clinical content above this
    // is workflow state and does change: sent → dispensed. Absent (null) when
    // the doctor did not send it — the patient may buy elsewhere.
    pharmacy: {
      type: new mongoose.Schema(
        {
          status: { type: String, enum: Object.values(PHARMACY_STATUS), required: true },
          sentAt: { type: Date, required: true },
          sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          dispensedAt: { type: Date, default: null },
          dispensedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          dispensedByName: { type: String, default: '' },
          // Medicine names that could not be given, for a PARTIAL dispense.
          unavailable: { type: [String], default: [] },
          note: { type: String, trim: true, maxlength: 300, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

prescriptionSchema.index({ patientId: 1, createdAt: -1 });
prescriptionSchema.index({ hospitalId: 1, date: 1 });
prescriptionSchema.index({ tokenId: 1 });
// The pad's suggestions read one doctor's recent prescriptions.
prescriptionSchema.index({ doctorId: 1, createdAt: -1 });
// The pharmacy queue: one clinic's sent prescriptions by state, newest first.
prescriptionSchema.index({ hospitalId: 1, 'pharmacy.status': 1, 'pharmacy.sentAt': -1 });

export const Prescription = mongoose.model('Prescription', prescriptionSchema);
