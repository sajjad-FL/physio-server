/**
 * Backfill bookingSeq / bookingCode for existing bookings (oldest first).
 * Sets the global Counter to the max assigned seq so new bookings continue the series.
 *
 * Run from server/:
 *   npm run migrate:booking-codes
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import { ensureBookingCounterAtLeast } from '../utils/bookingCode.js';

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  await mongoose.connect(uri);

  const missing = await Booking.find({
    $or: [{ bookingSeq: null }, { bookingSeq: { $exists: false } }, { bookingCode: null }, { bookingCode: { $exists: false } }],
  })
    .sort({ createdAt: 1, _id: 1 })
    .select('_id createdAt bookingSeq bookingCode')
    .lean();

  const maxExisting = await Booking.findOne({ bookingSeq: { $ne: null } })
    .sort({ bookingSeq: -1 })
    .select('bookingSeq')
    .lean();

  let nextSeq = Number(maxExisting?.bookingSeq) || 0;
  let updated = 0;

  for (const row of missing) {
    if (row.bookingSeq != null && row.bookingCode) continue;
    nextSeq += 1;
    const year = row.createdAt ? new Date(row.createdAt).getFullYear() : new Date().getFullYear();
    const bookingCode = `${year}-${nextSeq}`;
    await Booking.updateOne(
      { _id: row._id },
      { $set: { bookingSeq: nextSeq, bookingCode } },
    );
    updated += 1;
  }

  await ensureBookingCounterAtLeast(nextSeq);

  console.log('[migration] booking codes backfill complete');
  console.log('  rows updated:', updated);
  console.log('  counter at least:', nextSeq);

  await mongoose.disconnect();
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migration] failed:', err);
    process.exit(1);
  });
