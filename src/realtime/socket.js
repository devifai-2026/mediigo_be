import { Server } from 'socket.io';
import { verifyToken } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { Doctor, Hospital, OPDToken, QRStandee } from '../models/index.js';
import { verifyStandeeToken } from '../lib/crypto.js';
import { clinicDate } from '../lib/dates.js';
import { buildQueueSnapshot } from '../services/queueSnapshot.js';
import { setIo } from './emitters.js';
import { ROLES, SOCKET_EVENTS } from '../config/constants.js';
import {
  chamberRoom, chamberPublicRoom, hospitalRoom, hospitalPublicRoom,
  districtRoom, patientRoom, PLATFORM_ROOM,
} from './rooms.js';

const PUBLIC_ROLE = 'PUBLIC';

// A waiting-room TV cannot hold a session that expires overnight, so rather
// than weakening the handshake we accept a signed standee credential that grants
// read-only access to that hospital's public rooms.
const authenticateStandee = async (credential) => {
  const [serialId] = String(credential || '').split(':');
  if (!serialId) return null;
  const standee = await QRStandee.findOne({ serialId: serialId.toUpperCase() }).select('+qrSecret hospitalId status').lean();
  if (!standee?.qrSecret || !standee.hospitalId) return null;
  if (verifyStandeeToken(credential, standee.qrSecret) !== standee.serialId?.toUpperCase?.() && verifyStandeeToken(credential, standee.qrSecret) !== serialId.toUpperCase()) {
    return null;
  }
  return { role: PUBLIC_ROLE, hospitalId: String(standee.hospitalId), standeeId: String(standee._id) };
};

export const initSocket = (httpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : true, credentials: true },
    // Deliberately disabled: replaying buffered deltas after a reconnect can
    // resurrect stale state that loses to MongoDB. Clients refetch instead.
    connectionStateRecovery: {},
  });

  io.use(async (socket, next) => {
    try {
      const { token, publicStandee } = socket.handshake.auth || {};

      if (publicStandee) {
        const pub = await authenticateStandee(publicStandee);
        if (!pub) return next(new Error('INVALID_STANDEE'));
        socket.data.user = pub;
        return next();
      }

      if (!token) return next(new Error('UNAUTHENTICATED'));
      const claims = verifyToken(token);
      if (!claims || claims.type !== 'access') return next(new Error('INVALID_TOKEN'));

      socket.data.user = {
        id: claims.sub,
        role: claims.role,
        hospitalId: claims.hospitalId || null,
        districtId: claims.districtId || null,
        doctorId: claims.doctorId || null,
      };
      return next();
    } catch (err) {
      return next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    logger.debug({ role: u.role, sid: socket.id }, 'socket connected');

    // Default rooms by role.
    switch (u.role) {
      case ROLES.DOCTOR:
        if (u.doctorId) socket.join(chamberRoom(u.doctorId));
        if (u.hospitalId) socket.join(hospitalRoom(u.hospitalId));
        break;
      case ROLES.RECEPTIONIST:
        if (u.hospitalId) socket.join(hospitalRoom(u.hospitalId));
        break;
      case ROLES.EXEC_ADMIN:
        if (u.districtId) socket.join(districtRoom(u.districtId));
        break;
      case ROLES.SUPER_ADMIN:
        socket.join(PLATFORM_ROOM);
        break;
      case ROLES.PATIENT:
        socket.join(patientRoom(u.id));
        break;
      case PUBLIC_ROLE:
        socket.join(hospitalPublicRoom(u.hospitalId));
        break;
      default:
        break;
    }

    // On-demand chamber joins are always verified server-side. A patient may
    // only watch a chamber they actually hold a token for today — otherwise
    // anyone could subscribe to every chamber on the platform.
    socket.on(SOCKET_EVENTS.JOIN_CHAMBER, async ({ doctorId } = {}, ack) => {
      try {
        const doctor = await Doctor.findById(doctorId).select('hospitalId').lean();
        if (!doctor) return ack?.({ ok: false, error: 'NOT_FOUND' });

        let allowed = false;
        if (u.role === ROLES.SUPER_ADMIN) allowed = true;
        else if ((u.role === ROLES.DOCTOR || u.role === ROLES.RECEPTIONIST) &&
                 String(doctor.hospitalId) === String(u.hospitalId)) allowed = true;
        else if (u.role === ROLES.EXEC_ADMIN) {
          const h = await Hospital.findById(doctor.hospitalId).select('districtId').lean();
          allowed = String(h?.districtId) === String(u.districtId);
        } else if (u.role === ROLES.PATIENT) {
          const held = await OPDToken.countDocuments({
            patientId: u.id, doctorId, date: clinicDate(),
          });
          allowed = held > 0;
        } else if (u.role === PUBLIC_ROLE) {
          allowed = String(doctor.hospitalId) === String(u.hospitalId);
        }

        if (!allowed) return ack?.({ ok: false, error: 'SCOPE_DENIED' });

        const isStaff = [ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN].includes(u.role);
        socket.join(isStaff ? chamberRoom(doctorId) : chamberPublicRoom(doctorId));

        const snapshot = await buildQueueSnapshot(doctorId, clinicDate(), { includePii: isStaff });
        socket.emit(SOCKET_EVENTS.QUEUE_SNAPSHOT, snapshot);
        return ack?.({ ok: true });
      } catch (err) {
        logger.warn({ err }, 'JOIN_CHAMBER failed');
        return ack?.({ ok: false, error: 'INTERNAL' });
      }
    });

    socket.on(SOCKET_EVENTS.LEAVE_CHAMBER, ({ doctorId } = {}, ack) => {
      socket.leave(chamberRoom(doctorId));
      socket.leave(chamberPublicRoom(doctorId));
      ack?.({ ok: true });
    });

    // The reconnect path: clients never trust replayed deltas, they ask for the
    // authoritative snapshot again.
    socket.on(SOCKET_EVENTS.REQUEST_QUEUE_SNAPSHOT, async ({ doctorId, date } = {}, ack) => {
      try {
        const isStaff = [ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN].includes(u.role);
        const snapshot = await buildQueueSnapshot(doctorId, date || clinicDate(), { includePii: isStaff });
        socket.emit(SOCKET_EVENTS.QUEUE_SNAPSHOT, snapshot);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: 'INTERNAL' });
      }
    });

    socket.on('disconnect', (reason) => logger.debug({ sid: socket.id, reason }, 'socket disconnected'));
  });

  setIo(io);
  logger.info('Socket.io initialised');
  return io;
};
