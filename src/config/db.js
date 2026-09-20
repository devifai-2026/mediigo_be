import mongoose from 'mongoose';
import { env, isProduction } from './env.js';
import { logger } from '../lib/logger.js';

export const connectDb = async () => {
  mongoose.set('strictQuery', true);
  // Index creation is owned by the seed/deploy step in production. Letting every
  // process race to build indexes on boot is how you get a surprise foreground
  // index build on a live primary.
  mongoose.set('autoIndex', !isProduction());

  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DB_NAME,
    maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    serverSelectionTimeoutMS: 15_000,
  });

  await assertReplicaSet();
  return mongoose.connection;
};

// Transactions require a replica set. A standalone mongod accepts every other
// operation happily and then throws only when the POS runs — which would be
// discovered in production, at a cash counter. Fail loudly at boot instead.
export const assertReplicaSet = async () => {
  try {
    const info = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!info.setName) {
      logger.error(
        'MongoDB is NOT a replica set. Transactions will fail — the POS walk-in endpoint cannot work. Use MongoDB Atlas or a local replica set.',
      );
      return false;
    }
    logger.info({ replicaSet: info.setName }, 'Replica set confirmed — transactions available');
    return true;
  } catch (err) {
    // Atlas M0 restricts some admin commands; a failure here is not fatal.
    logger.warn({ err: err.message }, 'Could not verify replica set status');
    return null;
  }
};

export const disconnectDb = async () => {
  await mongoose.connection.close();
  logger.info('MongoDB connection closed');
};

export const pingDb = async () => {
  if (mongoose.connection.readyState !== 1) return false;
  await mongoose.connection.db.admin().ping();
  return true;
};
