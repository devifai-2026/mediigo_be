/**
 * Bootstrap the first Super Admin on an empty database — every other account is
 * created from inside the app, so this is the only login that needs a script.
 * Also builds indexes, since a freshly dropped database has none.
 *
 *   npm run superadmin -- --phone 9xxxxxxxxx --name "Your Name" --password '...' [--email you@x.com]
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { User, syncAllIndexes } from '../src/models/index.js';
import { ROLES } from '../src/config/constants.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const run = async () => {
  const phone = (arg('phone') || '').replace(/\D/g, '');
  const name = arg('name');
  const password = arg('password');
  const email = arg('email')?.toLowerCase() || null;

  if (phone.length !== 10 || !name || !password || password.length < 8) {
    logger.error('Usage: --phone <10 digits> --name "<name>" --password <min 8 chars> [--email <email>]');
    process.exit(1);
  }

  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  await syncAllIndexes();

  if (await User.exists({ phone })) {
    logger.error(`A user with phone ${phone} already exists`);
    process.exit(1);
  }

  const user = await User.create({
    phone, name, email, role: ROLES.SUPER_ADMIN, passwordHash: await hashPassword(password),
  });
  logger.info({ id: user._id.toString(), phone }, 'Super Admin created');
  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error({ err }, 'create-superadmin failed');
  process.exit(1);
});
