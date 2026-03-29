import 'dotenv/config';
import mongoose from 'mongoose';

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }

  await mongoose.connect(uri);

  const collection = mongoose.connection.db.collection('bookings');

  // user -> userId
  const resUser = await collection.updateMany(
    { userId: { $exists: false }, user: { $exists: true } },
    [
      { $set: { userId: '$user' } },
      { $unset: 'user' },
    ]
  );

  // physio -> physioId
  const resPhysio = await collection.updateMany(
    { physioId: { $exists: false }, physio: { $exists: true } },
    [
      { $set: { physioId: '$physio' } },
      { $unset: 'physio' },
    ]
  );

  // paymentStatus backfill
  const resPayment = await collection.updateMany(
    { paymentStatus: { $exists: false } },
    { $set: { paymentStatus: 'pending' } }
  );

  console.log('[migration] bookings field migration complete');
  console.log('  user modified:', resUser.modifiedCount);
  console.log('  physio modified:', resPhysio.modifiedCount);
  console.log('  paymentStatus modified:', resPayment.modifiedCount);

  await mongoose.disconnect();
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migration] failed:', err);
    process.exit(1);
  });

