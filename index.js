import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { connectDB } from './config/db.js';
import { warmPricingCache } from './utils/pricingConfig.js';
import Booking from './models/Booking.js';
import { uploadsRoot, MAX_UPLOAD_BYTES } from './config/upload.js';
import bookingRoutes from './routes/bookingRoutes.js';
import physioRoutes from './routes/physioRoutes.js';
import physioPortalRoutes from './routes/physioPortalRoutes.js';
import authRoutes from './routes/authRoutes.js';
import slotRoutes from './routes/slotRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import notesRoutes from './routes/notesRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import disputeRoutes from './routes/disputeRoutes.js';
import sessionNotesRoutes from './routes/sessionNotesRoutes.js';
import profileRoutes from './routes/profileRoutes.js';
import withdrawRoutes from './routes/withdrawRoutes.js';
import reviewRoutes from './routes/reviewRoutes.js';
import platformRoutes from './routes/platformRoutes.js';
import seoRoutes from './routes/seoRoutes.js';
import referralRoutes from './routes/referralRoutes.js';
import shopRoutes from './routes/shopRoutes.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const envOrigin = process.env.CLIENT_ORIGIN;
const allowedOrigins = envOrigin ? [...defaultOrigins, envOrigin] : defaultOrigins;

app.use(
  helmet({
    // Client and API run on different origins in dev (:5173 and :5000),
    // so uploaded assets must be allowed cross-origin.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
// app.use(
//   cors({
//     origin(origin, callback) {
//       if (!origin || allowedOrigins.includes(origin)) {
//         callback(null, true);
//       } else {
//         callback(new Error('Not allowed by CORS'));
//       }
//     },
//   })
// );
app.use(
  cors({
    origin: true,        // ✅ allow all origins
    credentials: true
  })
);
app.use(express.json());

app.use('/uploads', express.static(uploadsRoot));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    /** If false, the running server is an old build that still required patient-selected physios. */
    bookingCreateAdminAssignsPhysio: true,
  });
});

app.use('/api/auth', authRoutes);
// Backward compatibility for clients that call /auth/* without /api prefix
app.use('/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/slots', slotRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/physios', physioRoutes);
app.use('/api/physio', physioPortalRoutes);
app.use('/api/sessions', sessionNotesRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/seo', seoRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/shop', shopRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxKb = Math.round(MAX_UPLOAD_BYTES / 1024);
    return res.status(400).json({ message: `File too large. Maximum size is ${maxKb} KB per file.` });
  }
  const status = err.statusCode || 500;
  const message = status === 500 ? 'Internal server error' : err.message || 'Error';
  res.status(status).json({ message });
});

async function main() {
  await connectDB();
  await warmPricingCache();
  // Drops legacy unique { date, timeSlot } (and any other indexes not declared on the schema)
  // so multiple unassigned patients can share the same calendar slot until a physio is assigned.
  try {
    await Booking.syncIndexes();
  } catch (e) {
    console.error('[db] Booking.syncIndexes failed:', e?.message || e);
    console.error(
      '[db] Fix duplicate physio+date+slot rows if any, then run from server/: npm run migrate:booking-slot-index'
    );
    throw e;
  }
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
