import mongoose from 'mongoose';
import User from '../models/User.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const ANDROID_CHANNEL_DEFAULT = 'default';

/**
 * Expo Push relay (free). No extra server NPM packages.
 * Set EXPO_PUSH_ENABLED=true when credentials are configured and you want sends.
 */
export function isExpoPushEnabled() {
  return String(process.env.EXPO_PUSH_ENABLED || '').toLowerCase() === 'true';
}

/** @returns {Promise<string[]>} */
export async function collectExpoTokensForUserIds(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))].filter((id) =>
    mongoose.isValidObjectId(String(id)),
  );
  if (ids.length === 0) return [];
  const users = await User.find({ _id: { $in: ids } })
    .select('expoPushTokens')
    .lean();
  const out = new Set();
  for (const u of users) {
    const entries = Array.isArray(u.expoPushTokens) ? u.expoPushTokens : [];
    for (const e of entries) {
      const t = typeof e?.token === 'string' ? e.token.trim() : '';
      if (t.startsWith('ExponentPushToken[')) out.add(t);
    }
  }
  return [...out];
}

/** Physiotherapist profile _id → User account row (owns mobile push tokens). */
export async function findUserIdForPhysioProfile(physioDocId) {
  if (!physioDocId || !mongoose.isValidObjectId(String(physioDocId))) return null;
  const row = await User.findOne({ physioId: physioDocId }).select('_id').lean();
  return row?._id || null;
}

function toExpoReceipt({ to, title, body, data }) {
  return {
    to,
    sound: 'default',
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    channelId: ANDROID_CHANNEL_DEFAULT,
    ...(data && typeof data === 'object' ? { data } : {}),
  };
}

async function sendExpoReceipts(receipts) {
  if (!isExpoPushEnabled() || receipts.length === 0) return;
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(receipts),
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn('[ExpoPush] send failed:', res.status, text.slice(0, 400));
  }
}

/** Prefer string values in `data` for client compatibility. */
export async function notifyExpoUsers(userIds, { title, body, data }) {
  try {
    const tokens = await collectExpoTokensForUserIds(userIds);
    if (tokens.length === 0) return;
    const chunkSize = 90;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const slice = tokens.slice(i, i + chunkSize);
      const receipts = slice.map((to) => toExpoReceipt({ to, title, body, data }));
      await sendExpoReceipts(receipts);
    }
  } catch (e) {
    console.warn('[ExpoPush] notifyExpoUsers error:', e?.message || e);
  }
}

export function fireBookingPush(promiseFn) {
  Promise.resolve(promiseFn()).catch((e) =>
    console.warn('[ExpoPush] async:', e?.message || e),
  );
}
