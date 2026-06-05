import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let adminAuthInstance = null;

export function isFirebaseConfigured() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_PRIVATE_KEY &&
      process.env.FIREBASE_CLIENT_EMAIL,
  );
}

function buildServiceAccount() {
  return {
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    universe_domain: 'googleapis.com',
  };
}

/** Lazily initialize Firebase Admin; throws if env vars are missing. */
export function getAdminAuth() {
  if (adminAuthInstance) return adminAuthInstance;

  if (!isFirebaseConfigured()) {
    throw new Error(
      'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, and FIREBASE_CLIENT_EMAIL in server/.env',
    );
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(buildServiceAccount()) });
  }

  adminAuthInstance = getAuth();
  return adminAuthInstance;
}

if (!isFirebaseConfigured()) {
  console.warn('[firebase] Admin SDK not configured — Firebase phone OTP verification is disabled.');
}
