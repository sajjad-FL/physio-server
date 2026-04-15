import 'dotenv/config';
import mongoose from 'mongoose';

const NEW_INDEX_NAME = 'uniq_physio_slot';

/** Legacy global “one booking per slot” indexes (multi-physio uses partial uniq_physio_slot only). */
function isLegacyDateTimeSlotUniqueIndex(idx) {
  if (!idx?.unique || idx.name === NEW_INDEX_NAME) return false;
  const key = idx.key || {};
  const names = Object.keys(key);
  if (names.length !== 2) return false;
  return key.date === 1 && key.timeSlot === 1;
}

async function dropLegacySlotUniqueIndexes(collection) {
  const indexes = await collection.indexes();
  for (const idx of indexes) {
    if (!isLegacyDateTimeSlotUniqueIndex(idx)) continue;
    console.log(`[migration] dropping legacy unique slot index: ${idx.name}`);
    await collection.dropIndex(idx.name);
  }
}

async function logPotentialConflicts(collection) {
  const conflicts = await collection
    .aggregate([
      {
        $match: {
          physioId: { $type: 'objectId' },
          date: { $type: 'string' },
          timeSlot: { $type: 'string' },
        },
      },
      {
        $group: {
          _id: {
            physioId: '$physioId',
            date: '$date',
            timeSlot: '$timeSlot',
          },
          count: { $sum: 1 },
          bookingIds: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();

  if (!conflicts.length) {
    console.log('[migration] no duplicate physio-slot conflicts detected');
    return;
  }

  console.log(`[migration] found ${conflicts.length} physio-slot conflicts (must be fixed before unique index)`);
  for (const c of conflicts.slice(0, 20)) {
    console.log(
      `  physio=${String(c._id.physioId)} date=${c._id.date} timeSlot=${c._id.timeSlot} count=${c.count} ids=${c.bookingIds
        .map((id) => String(id))
        .join(',')}`
    );
  }
  if (conflicts.length > 20) {
    console.log(`  ... ${conflicts.length - 20} more conflicts omitted`);
  }
  throw new Error('Resolve duplicate physio-slot bookings before running this migration');
}

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  await mongoose.connect(uri);
  const collection = mongoose.connection.db.collection('bookings');

  await dropLegacySlotUniqueIndexes(collection);

  const indexes = await collection.indexes();
  const names = new Set(indexes.map((i) => i.name));

  await logPotentialConflicts(collection);

  if (names.has(NEW_INDEX_NAME)) {
    console.log(`[migration] new index already exists: ${NEW_INDEX_NAME}`);
  } else {
    console.log(`[migration] creating new index: ${NEW_INDEX_NAME}`);
    await collection.createIndex(
      { physioId: 1, date: 1, timeSlot: 1 },
      {
        unique: true,
        partialFilterExpression: { physioId: { $type: 'objectId' } },
        name: NEW_INDEX_NAME,
      }
    );
  }

  console.log('[migration] booking slot index migration complete');
  await mongoose.disconnect();
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migration] failed:', err);
    process.exit(1);
  });

