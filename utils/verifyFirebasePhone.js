import { getAdminAuth, isFirebaseConfigured } from './firebaseAdmin.js';

/**
 * Verifies a Firebase Phone Auth idToken.
 * Returns the E.164 phone number (e.g. "+919876543210") on success.
 * Throws an Error with a user-friendly message on failure.
 */
export async function verifyFirebasePhone(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Firebase ID token is required');
  }
  if (!isFirebaseConfigured()) {
    throw new Error('Phone verification is not configured on this server.');
  }
  let decoded;
  try {
    decoded = await getAdminAuth().verifyIdToken(idToken);
  } catch (e) {
    throw new Error('Phone verification expired or invalid. Please request a new OTP.');
  }
  const phone = decoded.phone_number;
  if (!phone) {
    throw new Error('This token does not carry a verified phone number.');
  }
  return phone; // e.g. "+919876543210"
}
