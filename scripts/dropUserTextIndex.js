import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/database.js';
import User from '../src/models/User.js';

dotenv.config();

async function main() {
  await connectDB();
  const indexes = await User.collection.indexes();
  console.log('Current indexes:', indexes.map((i) => ({ name: i.name, key: i.key })));

  for (const idx of indexes) {
    const key = idx.key || {};
    if (key._fts === 'text' || key.name === 'text' || key.email === 'text') {
      try {
        await User.collection.dropIndex(idx.name);
        console.log('Dropped index:', idx.name);
      } catch (err) {
        console.warn('Could not drop', idx.name, err.message);
      }
    }
  }

  await User.syncIndexes();
  console.log('Synced indexes:', (await User.collection.indexes()).map((i) => i.name));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
