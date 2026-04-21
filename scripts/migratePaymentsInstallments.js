/**
 * Migration: installment payments.
 *
 * 1. For every booking whose legacy atomic `payment.status` was
 *    'paid' | 'verified' but which has no Payment rows yet, create a single
 *    Payment doc capturing the lump-sum as one verified installment.
 *     - Online: `{ mode:'online', status:'verified', amount:totalAmount,
 *        razorpayPaymentId, verifiedAt: paidAt }`.
 *     - Offline: `{ mode:'offline', status:'verified', amount:totalAmount,
 *        collectedAt:paidAt, verifiedAt:paidAt }`.
 * 2. Backfill `totalPaid = totalAmount` on those bookings so the new
 *    coverage gate sees the full payment immediately.
 * 3. Drop the old single-key unique index on `transactions` so the widened
 *    `{..., meta.leg, meta.paymentId}` partial unique index (synced by the
 *    server on startup) can take over cleanly.
 *
 * Idempotent: skips bookings that already have Payment rows.
 *
 * Run from the server directory:
 *   node scripts/migratePaymentsInstallments.js
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
  const bookings = db.collection('bookings');
  const payments = db.collection('payments');
  const transactions = db.collection('transactions');

  // Drop the legacy transactions index so syncIndexes() can install the
  // widened version that includes `meta.paymentId`. Safe to skip if missing.
  try {
    const existing = await transactions.indexes();
    const legacy = existing.find(
      (i) =>
        JSON.stringify(i.key) ===
        JSON.stringify({
          bookingId: 1,
          physioId: 1,
          type: 1,
          direction: 1,
          'meta.leg': 1,
        }),
    );
    if (legacy) {
      await transactions.dropIndex(legacy.name);
      console.log('[txn] Dropped legacy unique index:', legacy.name);
    } else {
      console.log('[txn] No legacy unique index to drop.');
    }
  } catch (e) {
    console.warn('[txn] Index cleanup skipped:', e?.message || e);
  }

  // Stream eligible bookings.
  const cursor = bookings.find({
    $or: [
      { 'payment.status': 'paid' },
      { 'payment.status': 'verified' },
      { paymentStatus: 'held' },
      { paymentStatus: 'released' },
    ],
  });

  let created = 0;
  let backfilled = 0;
  let skipped = 0;

  for await (const b of cursor) {
    const existing = await payments.countDocuments({ bookingId: b._id });
    if (existing > 0) {
      skipped += 1;
      continue;
    }

    const total = Number(b.totalAmount ?? b.payment?.amount ?? 0);
    if (!Number.isFinite(total) || total <= 0) {
      skipped += 1;
      continue;
    }

    const mode =
      b.payment?.mode ||
      (b.serviceType === 'home' && b.homePlanPaymentMode === 'offline' ? 'offline' : 'online');

    const when = b.paidAt || b.heldAt || b.updatedAt || b.createdAt || new Date();
    const doc = {
      bookingId: b._id,
      physioId: b.physioId || null,
      userId: b.userId,
      amount: total,
      mode,
      status: 'verified',
      collectedBy: mode === 'offline' ? b.physioId || null : null,
      collectedAt: mode === 'offline' ? when : null,
      verifiedAt: when,
      razorpayOrderId: mode === 'online' ? b.razorpayOrderId || null : null,
      razorpayPaymentId: mode === 'online' ? b.razorpayPaymentId || null : null,
      note: 'Backfilled from legacy atomic payment',
      rejectReason: '',
      createdAt: when,
      updatedAt: when,
    };
    await payments.insertOne(doc);
    created += 1;

    await bookings.updateOne(
      { _id: b._id },
      { $set: { totalPaid: total } },
    );
    backfilled += 1;
  }

  console.log(`[migrate] Created Payment rows: ${created}`);
  console.log(`[migrate] Backfilled totalPaid on bookings: ${backfilled}`);
  console.log(`[migrate] Skipped (already migrated or no total): ${skipped}`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
