/**
 * Migration: Phase 2 enum values + new fields for Phase 3.
 * Run: node server/scripts/migratePhase3.js (from repo root: node scripts/migratePhase3.js from server dir)
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';

async function run() {
  await connectDB();
  const db = mongoose.connection.db;

  const bookings = db.collection('bookings');
  const r1 = await bookings.updateMany(
    { paymentStatus: 'paid' },
    {
      $set: {
        paymentStatus: 'held',
        sessionStatus: 'scheduled',
        consentAccepted: true,
      },
    }
  );
  console.log('Bookings paid→held:', r1.modifiedCount);

  await bookings.updateMany(
    { paymentStatus: 'pending', sessionStatus: { $exists: false } },
    { $set: { consentAccepted: false } }
  );

  const physios = db.collection('physiotherapists');
  const r2 = await physios.updateMany(
    { verificationStatus: { $exists: false } },
    {
      $set: {
        verificationStatus: 'approved',
        isVerified: true,
        documents: [],
      },
    }
  );
  console.log('Physios defaulted verification:', r2.modifiedCount);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
