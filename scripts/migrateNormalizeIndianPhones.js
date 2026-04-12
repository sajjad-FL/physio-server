/**
 * One-time: normalize User.phone and Physiotherapist.phone to 10-digit Indian mobiles.
 * Run: node server/scripts/migrateNormalizeIndianPhones.js
 * Requires MONGODB_URI / same env as app (see config/db.js).
 */
import mongoose from 'mongoose';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI (or MONGO_URI)');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected. Migrating phones…');

  let usersUpdated = 0;
  let physiosUpdated = 0;
  const conflicts = [];

  const users = await User.find({}).select('phone').lean();
  for (const u of users) {
    const raw = u.phone;
    const pv = validateIndianMobile(raw);
    if (!pv.valid) {
      console.warn(`[User ${u._id}] invalid phone stored: ${JSON.stringify(raw)} — ${pv.message}`);
      continue;
    }
    if (pv.normalized !== raw) {
      try {
        await User.updateOne({ _id: u._id }, { $set: { phone: pv.normalized } });
        usersUpdated += 1;
      } catch (e) {
        if (e?.code === 11000) {
          conflicts.push({ collection: 'User', id: String(u._id), from: raw, to: pv.normalized });
        } else {
          throw e;
        }
      }
    }
  }

  const physios = await Physiotherapist.find({ phone: { $exists: true, $ne: '' } })
    .select('phone')
    .lean();
  for (const p of physios) {
    const raw = p.phone;
    if (raw == null || String(raw).trim() === '') continue;
    const pv = validateIndianMobile(raw);
    if (!pv.valid) {
      console.warn(`[Physio ${p._id}] invalid phone stored: ${JSON.stringify(raw)} — ${pv.message}`);
      continue;
    }
    if (pv.normalized !== raw) {
      try {
        await Physiotherapist.updateOne({ _id: p._id }, { $set: { phone: pv.normalized } });
        physiosUpdated += 1;
      } catch (e) {
        if (e?.code === 11000) {
          conflicts.push({ collection: 'Physiotherapist', id: String(p._id), from: raw, to: pv.normalized });
        } else {
          throw e;
        }
      }
    }
  }

  console.log(`Done. Users updated: ${usersUpdated}, Physiotherapists updated: ${physiosUpdated}`);
  if (conflicts.length) {
    console.warn('Unique index conflicts (resolve manually):', conflicts);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
