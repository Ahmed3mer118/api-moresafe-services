import mongoose from 'mongoose';

const globalCache = globalThis;

if (!globalCache.__mongooseCache) {
  globalCache.__mongooseCache = { conn: null, promise: null };
}

const cache = globalCache.__mongooseCache;

export async function connectDB() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error('MONGODB_URI is not set. Add it in your environment variables.');
  }

  if (cache.conn && mongoose.connection.readyState === 1) {
    return cache.conn;
  }

  if (!cache.promise) {
    console.log('Connecting to MongoDB...');
    cache.promise = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        connectTimeoutMS: 30000,
        maxPoolSize: 10,
      })
      .then((connection) => {
        console.log(`MongoDB connected: ${connection.connection.host}`);
        return connection;
      })
      .catch((err) => {
        cache.promise = null;
        console.error(
          'MongoDB connection failed:',
          err.message,
          '\nCheck: Atlas IP whitelist (Network Access), cluster not paused, and internet/firewall allows outbound port 27017.',
        );
        throw err;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}

export function isDbConnected() {
  return mongoose.connection.readyState === 1;
}
