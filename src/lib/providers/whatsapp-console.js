import { logger } from '../logger.js';
import { randomUUID } from '../crypto.js';
import { toWaNumber } from '../phone.js';

// Default driver. A fresh clone with no credentials boots and works end-to-end;
// the OTP is printed to the server log instead of sent.
export const isConfigured = () => true;

export const sendTemplate = async ({ to, templateId, variables = [] }) => {
  logger.info(
    { to: toWaNumber(to), templateId, variables, driver: 'console' },
    '[WA console] template message (not actually sent)',
  );
  return { messageId: `console-${randomUUID()}` };
};

export const sendText = async ({ to, message, mediaLink = '', mediaType = '' }) => {
  logger.info({ to: toWaNumber(to), message, mediaLink, mediaType, driver: 'console' }, '[WA console] text message');
  return { messageId: `console-${randomUUID()}` };
};

export const listTemplates = async () => [];
