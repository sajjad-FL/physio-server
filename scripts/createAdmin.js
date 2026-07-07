/**
 * Bootstrap (or promote) an admin account. Admin auth is JWT-only — there is no
 * static admin API key — so an admin signs in through the normal /auth/login flow
 * (10-digit Indian phone + password). The server issues a role:'admin' JWT because
 * the User document has role:'admin' (role is resolved server-side from the DB).
 *
 * Run from the server directory:
 *   node scripts/createAdmin.js --phone 9876543210 --password 'StrongPass1' --name 'Ops Admin'
 *
 * Values may also come from env: ADMIN_PHONE, ADMIN_PASSWORD, ADMIN_NAME.
 * Pass --force to modify an account that already exists (e.g. promote an existing
 * user to admin and/or reset its password). Creating a brand-new account needs no flag.
 *
 * Mirrors registerPatient in controllers/authController.js: phone is stored as the
 * normalized 10 digits and the password is bcrypt-hashed with the same cost.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectDB } from '../config/db.js';
import User from '../models/User.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 6;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === 'force') {
      out.force = true;
    } else if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const phoneInput = args.phone ?? process.env.ADMIN_PHONE;
  const password = args.password ?? process.env.ADMIN_PASSWORD;
  const nameProvided = args.name ?? process.env.ADMIN_NAME;
  const name = nameProvided ?? 'Administrator';

  const pv = validateIndianMobile(phoneInput);
  if (!pv.valid) {
    throw new Error(`Invalid --phone: ${pv.message}`);
  }
  if (!password || String(password).length < MIN_PASSWORD_LEN) {
    throw new Error(`--password is required and must be at least ${MIN_PASSWORD_LEN} characters`);
  }

  await connectDB();

  const phone = pv.normalized;
  const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  const existing = await User.findOne({ phone });

  if (existing) {
    if (!args.force) {
      throw new Error(
        `A user already exists with phone ${phone} (role: ${existing.role}). ` +
          'Re-run with --force to promote it to admin and set this password.',
      );
    }
    existing.role = 'admin';
    existing.passwordHash = passwordHash;
    existing.hasPasswordLogin = true;
    existing.isVerified = true;
    if (!existing.isProfileComplete) existing.isProfileComplete = true;
    if (nameProvided) existing.name = name;
    await existing.save();
    console.log(`Updated existing account ${phone} -> role: admin (password reset).`);
  } else {
    await User.create({
      phone,
      name,
      email: '',
      role: 'admin',
      passwordHash,
      hasPasswordLogin: true,
      isVerified: true,
      isProfileComplete: true,
    });
    console.log(`Created admin account ${phone} (name: ${name}).`);
  }

  console.log('Sign in at /login with this phone + password; the server issues a role:admin JWT.');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
