/**
 * One-time migration for legacy Dispute docs (message-only schema).
 * Run: node server/scripts/migrateDisputesPhase4.js (from repo root, with dotenv)
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import Dispute from '../models/Dispute.js';

async function main() {
  await connectDB();

  const cursor = Dispute.collection.find({
    $or: [{ description: { $exists: false } }, { reason: { $exists: false } }],
  });

  let n = 0;
  for await (const doc of cursor) {
    const description = doc.description || doc.message || '(migrated)';
    const reason = doc.reason || 'Legacy dispute';
    const raisedBy = doc.raisedBy === 'physio' ? 'physio' : 'user';
    const status =
      doc.status === 'resolved'
        ? 'resolved'
        : ['open', 'under_review', 'resolved', 'rejected'].includes(doc.status)
          ? doc.status
          : 'open';

    await Dispute.collection.updateOne(
      { _id: doc._id },
      {
        $set: {
          description,
          reason,
          raisedBy,
          raiserUserId: doc.raiserUserId || null,
          raiserPhysioId: doc.raiserPhysioId || null,
          status,
          resolution: typeof doc.resolution === 'string' ? doc.resolution : '',
        },
        $unset: { message: '' },
      }
    );
    n += 1;
  }

  console.log(`Migrated ${n} dispute document(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
