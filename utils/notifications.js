export async function sendSMS({ to, message }) {
  // Mock implementation for MVP.
  // Replace with real provider integration (e.g. Twilio/BharatSMS) in Phase 3.
  console.log('[SMS] to=' + to + ' msg=' + message);
  return true;
}

export async function sendWhatsApp({ to, message }) {
  // Mock implementation for MVP.
  // Replace with real provider integration later.
  console.log('[WhatsApp] to=' + to + ' msg=' + message);
  return true;
}
