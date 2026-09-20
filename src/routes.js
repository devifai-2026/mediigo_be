import { healthRoutes } from './modules/health/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { posRoutes } from './modules/pos/routes.js';
import { queueRoutes } from './modules/queue/routes.js';
import { doctorRoutes } from './modules/doctors/routes.js';
import { policyRoutes } from './modules/policy/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { onboardingRoutes } from './modules/onboarding/routes.js';
import { patientRoutes } from './modules/patients/routes.js';
import { standeeRoutes } from './modules/standees/routes.js';
import { superadminRoutes } from './modules/superadmin/routes.js';
import { ticketRoutes } from './modules/tickets/routes.js';

// Single mount point for every route in the app.
export const mountRoutes = (app) => {
  app.use('/', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/patients', patientRoutes);
  app.use('/api/doctors', doctorRoutes);
  app.use('/api/queue', queueRoutes);
  app.use('/api/pos', posRoutes);
  app.use('/api/policy', policyRoutes);
  app.use('/api/onboarding', onboardingRoutes);
  app.use('/api/standees', standeeRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/superadmin', superadminRoutes);
  app.use('/api/tickets', ticketRoutes);
};
