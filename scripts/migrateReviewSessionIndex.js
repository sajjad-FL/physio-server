/**
 * Migration: per-session reviews.
 *
 * 1. Drop the legacy unique index on reviews.bookingId (was one review per booking).
 * 2. Add the new compound unique index (bookingId, sessionId). Existing rows
 *    implicitly have sessionId=null, which is treated as the "primary visit"
 *    rating and remains unique per booking under the new index.
 * 3. Default any existing schedule[] entries on bookings to status='scheduled'
 *    so the new per-session status field has a sensible baseline.
 *
 * Run from the server directory:
 *   node scripts/migrateReviewSessionIndex.js
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const mongoose = (await import('mongoose')).default;
const { connectDB } = await import('../config/db.js');

async function run() {
  await connectDB();
  const db = mongoose.connection.db;
  const reviews = db.collection('reviews');

  const existing = await reviews.indexes();
  const oldUnique = existing.find(
    (i) =>
      i.name === 'bookingId_1' ||
      (i.unique && JSON.stringify(i.key) === JSON.stringify({ bookingId: 1 })),
  );
  if (oldUnique) {
    await reviews.dropIndex(oldUnique.name);
    console.log('Dropped legacy index:', oldUnique.name);
  } else {
    console.log('No legacy bookingId_1 unique index found, skipping drop.');
  }

  await reviews.createIndex(
    { bookingId: 1, sessionId: 1 },
    { unique: true, name: 'uniq_review_booking_session' },
  );
  console.log('Ensured compound index uniq_review_booking_session.');

  const bookings = db.collection('bookings');
  const scheduleBackfill = await bookings.updateMany(
    {
      'schedule.0': { $exists: true },
      'schedule.status': { $exists: false },
    },
    { $set: { 'schedule.$[].status': 'scheduled' } },
  );
  console.log('Schedule entries defaulted to scheduled:', scheduleBackfill.modifiedCount);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
