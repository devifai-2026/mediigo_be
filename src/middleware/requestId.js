import { randomUUID } from '../lib/crypto.js';
import { runWithContext } from '../lib/requestContext.js';

export const requestId = (req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);
  runWithContext(next);
};
