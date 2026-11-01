import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request state that deep code (the audit log) needs without every caller
// threading it through. Opened once per request by the requestId middleware.
const storage = new AsyncLocalStorage();

export const runWithContext = (fn) => storage.run({}, fn);

export const requestContext = () => storage.getStore() ?? null;
