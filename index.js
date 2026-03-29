import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { connectDB } from './config/db.js';
import { uploadsRoot } from './config/upload.js';
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
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);
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

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File too large. Maximum size is 2MB per file.' });
  }
  const status = err.statusCode || 500;
  const message = status === 500 ? 'Internal server error' : err.message || 'Error';
  res.status(status).json({ message });
});

async function main() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
