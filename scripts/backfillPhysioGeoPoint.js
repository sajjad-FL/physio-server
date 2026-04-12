/**
 * One-time: set geoPoint from coordinates for existing physiotherapists (enables 2dsphere nearby queries).
 * Run from server/: node scripts/backfillPhysioGeoPoint.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Physiotherapist from '../models/Physiotherapist.js';
import { connectDB } from '../config/db.js';

async function main() {
  await connectDB();
  const cursor = Physiotherapist.find({
    'coordinates.lat': { $exists: true, $ne: null },
    'coordinates.lng': { $exists: true, $ne: null },
  }).cursor();

  let n = 0;
  for await (const doc of cursor) {
    const lat = doc.coordinates?.lat;
    const lng = doc.coordinates?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    doc.geoPoint = { type: 'Point', coordinates: [lng, lat] };
    await doc.save();
    n += 1;
  }
  console.log('[backfillPhysioGeoPoint] updated', n, 'documents');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
