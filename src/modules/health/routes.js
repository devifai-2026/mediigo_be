import { Router } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { pingDb } from '../../config/db.js';

export const healthRoutes = Router();

// Liveness: process is up. Deliberately does NOT touch the DB — a DB blip must
// not cause an orchestrator to kill a healthy process.
healthRoutes.get('/healthz', (_req, res) => {
  res.json({ ok: true, status: 'alive', uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
});

// Readiness: can we actually serve traffic?
healthRoutes.get(
  '/readyz',
  asyncHandler(async (_req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    let dbOk = false;
    try {
      dbOk = await pingDb();
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      status: dbOk ? 'ready' : 'not-ready',
      db: { state: states[mongoose.connection.readyState] ?? 'unknown', ok: dbOk },
      ts: new Date().toISOString(),
    });
  }),
);
