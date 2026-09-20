import { validationError } from '../lib/errors.js';

// Replaces the request part with the PARSED value, so downstream code gets
// coerced types (numbers from query strings) and stripped unknown keys.
export const validate = (schemas) => (req, _res, next) => {
  for (const part of ['body', 'query', 'params']) {
    const schema = schemas?.[part];
    if (!schema) continue;
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      next(
        validationError(
          result.error.issues.map((i) => ({ path: `${part}.${i.path.join('.')}`, message: i.message })),
        ),
      );
      return;
    }
    // req.query is a getter-only property in Express 5; assign defensively.
    try {
      req[part] = result.data;
    } catch {
      Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
    }
  }
  next();
};
