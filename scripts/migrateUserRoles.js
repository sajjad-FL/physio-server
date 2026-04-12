/**
 * Collapse legacy `roles: string[]` into single `role`, then remove `roles`.
 * Run from server directory: node scripts/migrateUserRoles.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';

function pickRoleFromArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 'user';
  if (arr.includes('admin')) return 'admin';
  if (arr.includes('physio')) return 'physio';
  return 'user';
}

async function main() {
  await connectDB();
  const col = mongoose.connection.collection('users');
  const cursor = col.find({});
  let n = 0;
  for await (const doc of cursor) {
    const role =
      doc.role && ['user', 'physio', 'admin'].includes(doc.role)
        ? doc.role
        : pickRoleFromArray(doc.roles);
    await col.updateOne({ _id: doc._id }, { $set: { role }, $unset: { roles: '' } });
    n += 1;
  }
  console.log('Migrated users:', n);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
