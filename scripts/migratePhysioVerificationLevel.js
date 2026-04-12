/**
 * Map legacy verification.level to not_verified | verified.
 * Approved physios → verified; basic/premium/missing otherwise normalized.
 * Run from server directory: node scripts/migratePhysioVerificationLevel.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';

async function main() {
  await connectDB();
  const col = mongoose.connection.collection('physiotherapists');

  const r0 = await col.updateMany(
    { verificationStatus: 'approved', isVerified: true },
    { $set: { 'verification.level': 'verified' } }
  );
  const r1 = await col.updateMany(
    { 'verification.level': 'premium' },
    { $set: { 'verification.level': 'verified' } }
  );
  const r2 = await col.updateMany(
    { 'verification.level': 'basic' },
    { $set: { 'verification.level': 'not_verified' } }
  );
  const r3 = await col.updateMany(
    {
      $or: [
        { 'verification.level': { $exists: false } },
        { 'verification.level': null },
        { 'verification.level': '' },
      ],
    },
    { $set: { 'verification.level': 'not_verified' } }
  );

  console.log('approved → level verified:', r0.modifiedCount);
  console.log('premium → verified:', r1.modifiedCount);
  console.log('basic → not_verified:', r2.modifiedCount);
  console.log('missing → not_verified:', r3.modifiedCount);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
