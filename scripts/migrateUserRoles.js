/**
 * Ensure every User has a non-empty roles array (default ["user"]).
 * Run from repo `syco` folder: node server/scripts/migrateUserRoles.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import User from '../models/User.js';

async function main() {
  await connectDB();
  const res = await User.updateMany(
    { $or: [{ roles: { $exists: false } }, { roles: { $size: 0 } }] },
    { $set: { roles: ['user'] } }
  );
  console.log('Updated users without roles:', res.modifiedCount);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
