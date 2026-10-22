export const chamberRoom = (doctorId) => `chamber:${doctorId}`;
export const chamberPublicRoom = (doctorId) => `chamber:${doctorId}:public`;
export const hospitalRoom = (hospitalId) => `hospital:${hospitalId}`;
export const hospitalPublicRoom = (hospitalId) => `hospital:${hospitalId}:public`;
export const districtRoom = (districtId) => `district:${districtId}`;
export const patientRoom = (userId) => `patient:${userId}`;
// The clinic pharmacy's own room: it gets prescriptions, never the queue.
export const pharmacyRoom = (hospitalId) => `pharmacy:${hospitalId}`;
export const PLATFORM_ROOM = 'platform';
