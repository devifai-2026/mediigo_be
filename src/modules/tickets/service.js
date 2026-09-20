import { Ticket, TICKET_STATUS, User, Doctor, Hospital, AuditLog } from '../../models/index.js';
import { nextSequence } from '../../lib/counters.js';
import { notFound, forbidden, validationError, conflict } from '../../lib/errors.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { ROLES } from '../../config/constants.js';

const LEGAL = {
  [TICKET_STATUS.TODO]: [TICKET_STATUS.IN_PROGRESS, TICKET_STATUS.DONE],
  [TICKET_STATUS.IN_PROGRESS]: [TICKET_STATUS.TODO, TICKET_STATUS.DONE],
  [TICKET_STATUS.DONE]: [TICKET_STATUS.IN_PROGRESS],
};

/**
 * Who can see which tickets.
 *
 * Mirrors the RBAC used everywhere else: the guard returns a mandatory filter
 * rather than a yes/no, so a caller cannot forget to apply it.
 */
export const visibilityFilter = async (actor) => {
  switch (actor.role) {
    case ROLES.SUPER_ADMIN:
      return {};
    case ROLES.EXEC_ADMIN:
      // Their district's tickets, plus anything they raised themselves.
      return { $or: [{ districtId: actor.districtId }, { raisedById: actor.id }] };
    case ROLES.DOCTOR:
    case ROLES.RECEPTIONIST:
      return { $or: [{ hospitalId: actor.hospitalId }, { raisedById: actor.id }] };
    case ROLES.FIELD_AGENT:
    case ROLES.PATIENT:
    default:
      // Everyone else sees only what they raised.
      return { raisedById: actor.id };
  }
};

/** Only admins move tickets across the board or comment internally. */
const canTriage = (actor) => [ROLES.SUPER_ADMIN, ROLES.EXEC_ADMIN].includes(actor.role);

const assertVisible = async (actor, ticket) => {
  if (!ticket) throw notFound('Ticket not found');
  if (actor.role === ROLES.SUPER_ADMIN) return ticket;
  if (String(ticket.raisedById) === String(actor.id)) return ticket;
  if (actor.role === ROLES.EXEC_ADMIN && String(ticket.districtId) === String(actor.districtId)) return ticket;
  if ([ROLES.DOCTOR, ROLES.RECEPTIONIST].includes(actor.role) && String(ticket.hospitalId) === String(actor.hospitalId)) return ticket;
  throw forbidden('You do not have access to this ticket');
};

/** Where the raiser sits, so the ticket lands in the right district's queue. */
const scopeForRaiser = async (actor) => {
  const user = await User.findById(actor.id).select('hospitalId districtId doctorId role').lean();
  if (!user) throw notFound('User not found');

  let hospitalId = user.hospitalId ?? null;
  let districtId = user.districtId ?? null;

  if (!districtId && hospitalId) {
    const h = await Hospital.findById(hospitalId).select('districtId').lean();
    districtId = h?.districtId ?? null;
  }
  // A patient has neither; route by the clinic of their most recent token so
  // the right district admin sees it, rather than it falling only to Super Admin.
  if (!districtId && !hospitalId && user.role === ROLES.PATIENT) {
    const { OPDToken } = await import('../../models/index.js');
    const last = await OPDToken.findOne({ patientId: user._id }).sort({ createdAt: -1 }).select('hospitalId').lean();
    if (last?.hospitalId) {
      hospitalId = last.hospitalId;
      const h = await Hospital.findById(hospitalId).select('districtId').lean();
      districtId = h?.districtId ?? null;
    }
  }
  return { hospitalId, districtId };
};

export const createTicket = async ({ body, actor, ip, userAgent }) => {
  const user = await User.findById(actor.id).select('name role').lean();
  const { hospitalId, districtId } = await scopeForRaiser(actor);
  const seq = await nextSequence('ticket');

  const ticket = await Ticket.create({
    ref: `TKT-${String(seq).padStart(6, '0')}`,
    title: body.title.trim(),
    body: body.body.trim(),
    category: body.category,
    priority: body.priority,
    status: TICKET_STATUS.TODO,
    raisedById: user._id,
    raisedByName: user.name,
    raisedByRole: user.role,
    districtId,
    hospitalId,
    statusHistory: [{ from: null, to: TICKET_STATUS.TODO, byUserId: user._id, byName: user.name }],
    // The raiser has obviously seen their own ticket.
    readBy: [{ userId: user._id, at: new Date() }],
  });

  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: 'TICKET_RAISED',
    entityType: 'Ticket', entityId: ticket._id, districtId, hospitalId, ip, userAgent,
    after: { ref: ticket.ref, title: ticket.title, priority: ticket.priority },
  });

  return ticket.toObject();
};

export const listTickets = async ({ actor, status, priority, search }) => {
  const filter = await visibilityFilter(actor);
  const and = [filter];
  if (status) and.push({ status });
  if (priority) and.push({ priority });
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [{ title: rx }, { ref: rx }, { raisedByName: rx }] });
  }

  const tickets = await Ticket.find(and.length > 1 ? { $and: and } : filter)
    .populate('districtId', 'name')
    .populate('hospitalId', 'name')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  return tickets.map((t) => ({
    ...t,
    id: String(t._id),
    districtName: t.districtId?.name ?? null,
    hospitalName: t.hospitalId?.name ?? null,
    commentCount: (t.comments || []).length,
    unread: !(t.readBy || []).some((r) => String(r.userId) === String(actor.id)),
  }));
};

/** Board counts + the unread badge, in one query each. */
export const ticketSummary = async (actor) => {
  const filter = await visibilityFilter(actor);
  const [byStatus, byPriority, unread, recent] = await Promise.all([
    Ticket.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Ticket.aggregate([{ $match: filter }, { $group: { _id: '$priority', n: { $sum: 1 } } }]),
    Ticket.countDocuments({ $and: [filter, { 'readBy.userId': { $ne: actor.id } }] }),
    Ticket.aggregate([
      { $match: filter },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $limit: 30 },
    ]),
  ]);

  const pick = (rows, k) => rows.find((r) => r._id === k)?.n ?? 0;
  return {
    counts: {
      todo: pick(byStatus, TICKET_STATUS.TODO),
      inProgress: pick(byStatus, TICKET_STATUS.IN_PROGRESS),
      done: pick(byStatus, TICKET_STATUS.DONE),
      total: byStatus.reduce((a, r) => a + r.n, 0),
    },
    byPriority: {
      CRITICAL: pick(byPriority, 'CRITICAL'),
      HIGH: pick(byPriority, 'HIGH'),
      MEDIUM: pick(byPriority, 'MEDIUM'),
      LOW: pick(byPriority, 'LOW'),
    },
    unread,
    trend: recent.map((r) => ({ date: r._id, count: r.n })),
  };
};

export const getTicket = async ({ ticketId, actor }) => {
  const ticket = await Ticket.findById(ticketId)
    .populate('districtId', 'name')
    .populate('hospitalId', 'name')
    .lean();
  await assertVisible(actor, ticket);

  // Opening it marks it read for this viewer, which is what clears the badge.
  await Ticket.updateOne(
    { _id: ticketId, 'readBy.userId': { $ne: actor.id } },
    { $push: { readBy: { userId: actor.id, at: new Date() } } },
  );

  return {
    ...ticket,
    id: String(ticket._id),
    districtName: ticket.districtId?.name ?? null,
    hospitalName: ticket.hospitalId?.name ?? null,
    // Internal notes stay hidden from the person who raised the ticket.
    comments: (ticket.comments || []).filter((c) => !c.internal || canTriage(actor)),
  };
};

export const moveTicket = async ({ ticketId, to, note, actor, ip, userAgent }) => {
  const ticket = await Ticket.findById(ticketId);
  await assertVisible(actor, ticket);
  if (!canTriage(actor)) throw forbidden('Only administrators can move tickets on the board');

  const from = ticket.status;
  if (from === to) return ticket.toObject();
  if (!LEGAL[from]?.includes(to)) {
    throw conflict(`A ticket cannot move from ${from} to ${to}`);
  }

  const user = await User.findById(actor.id).select('name').lean();
  const set = { status: to };
  if (to === TICKET_STATUS.DONE) {
    set.resolvedAt = new Date();
    if (note) set.resolutionNote = note;
  } else {
    set.resolvedAt = null;
  }

  await Ticket.updateOne(
    { _id: ticket._id },
    { $set: set, $push: { statusHistory: { from, to, at: new Date(), byUserId: actor.id, byName: user?.name } } },
  );

  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: 'TICKET_MOVED',
    entityType: 'Ticket', entityId: ticket._id, districtId: ticket.districtId, ip, userAgent,
    before: { status: from }, after: { status: to, ref: ticket.ref },
  });

  return (await Ticket.findById(ticket._id).lean());
};

export const commentOnTicket = async ({ ticketId, body, internal, actor }) => {
  const ticket = await Ticket.findById(ticketId);
  await assertVisible(actor, ticket);
  if (internal && !canTriage(actor)) throw forbidden('Only administrators can leave internal notes');

  const user = await User.findById(actor.id).select('name role').lean();
  await Ticket.updateOne(
    { _id: ticket._id },
    {
      $push: {
        comments: { authorId: actor.id, authorName: user.name, authorRole: user.role, body: body.trim(), internal: Boolean(internal) },
      },
      // A reply makes the ticket unread again for everyone except the author.
      $pull: { readBy: { userId: { $ne: actor.id } } },
    },
  );
  return (await Ticket.findById(ticket._id).lean());
};

export const assignTicket = async ({ ticketId, assigneeId, actor }) => {
  const ticket = await Ticket.findById(ticketId);
  await assertVisible(actor, ticket);
  if (!canTriage(actor)) throw forbidden('Only administrators can assign tickets');

  if (!assigneeId) {
    await Ticket.updateOne({ _id: ticket._id }, { $set: { assigneeId: null, assigneeName: null } });
  } else {
    const who = await User.findById(assigneeId).select('name').lean();
    if (!who) throw validationError([{ path: 'assigneeId', message: 'Unknown user' }]);
    await Ticket.updateOne({ _id: ticket._id }, { $set: { assigneeId, assigneeName: who.name } });
  }
  return (await Ticket.findById(ticket._id).lean());
};

/** System log feed — the audit trail, scoped the same way as tickets. */
export const systemLog = async ({ actor, action, limit = 200 }) => {
  const filter = {};
  if (actor.role === ROLES.EXEC_ADMIN) filter.districtId = actor.districtId;
  else if (actor.role !== ROLES.SUPER_ADMIN) throw forbidden('System logs are restricted to administrators');
  if (action) filter.action = action;

  const rows = await AuditLog.find(filter)
    .populate('actorId', 'name role')
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 500))
    .lean();

  // Daily volume by action family, for the activity chart.
  const trend = await AuditLog.aggregate([
    { $match: { ...filter, createdAt: { $gte: new Date(Date.now() - 14 * 86400000) } } },
    { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } }, n: { $sum: 1 } } },
    { $sort: { '_id.d': 1 } },
  ]);

  const byAction = await AuditLog.aggregate([
    { $match: filter },
    { $group: { _id: '$action', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 8 },
  ]);

  return {
    rows: rows.map((r) => ({
      id: String(r._id),
      action: r.action,
      actorName: r.actorId?.name ?? 'System',
      actorRole: r.actorRole ?? r.actorId?.role ?? null,
      entityType: r.entityType,
      reason: r.reason ?? null,
      createdAt: r.createdAt,
      ip: r.ip ?? null,
    })),
    trend: trend.map((t) => ({ date: t._id.d, count: t.n })),
    byAction: byAction.map((a) => ({ action: a._id, count: a.n })),
  };
};
