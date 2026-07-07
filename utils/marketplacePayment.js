import Physiotherapist from '../models/Physiotherapist.js';
import { getPlatformCommissionPerSessionSync } from '../utils/pricingConfig.js';
import {
  postOfflinePair,
  postOnlineCredit,
  postSettlementDebit,
} from '../services/ledger.js';
import { getComputedWallet } from './ledgerBalance.js';

export function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Infer how many sessions a payment amount covers (for flat per-session commission).
 */
export function inferCommissionSessionCount(amountRupees, booking, payment) {
  if (payment?.sessionId) return 1;
  const sessions = Number(booking?.sessions);
  const total = Number(booking?.totalAmount);
  const amount = Number(amountRupees);
  if (sessions > 0 && total > 0 && Number.isFinite(amount) && amount > 0) {
    const avgPerSession = total / sessions;
    const n = Math.round(amount / avgPerSession);
    return Math.max(1, Math.min(sessions, n || 1));
  }
  return 1;
}

/**
 * @param {number} amountRupees - gross amount (patient pays)
 * @param {number} [sessionCount=1] - sessions this amount covers
 * @returns {{ amount: number, commission: number, physioEarning: number, sessionCount: number }}
 */
export function computeMarketplaceSplit(amountRupees, sessionCount = 1) {
  const amount = roundMoney2(Math.max(0, Number(amountRupees) || 0));
  const sessions = Math.max(1, Math.round(Number(sessionCount) || 1));
  const perSession = getPlatformCommissionPerSessionSync();
  const commission = roundMoney2(Math.min(amount, perSession * sessions));
  const physioEarning = roundMoney2(Math.max(0, amount - commission));
  return { amount, commission, physioEarning, sessionCount: sessions };
}

/**
 * @param {import('mongoose').Document} booking
 */
export function bookingAmountRupees(booking) {
  if (booking.totalAmount != null && Number.isFinite(Number(booking.totalAmount))) {
    return roundMoney2(Number(booking.totalAmount));
  }
  const paise = booking.amountPaise;
  if (paise != null && Number.isFinite(Number(paise))) {
    return roundMoney2(Number(paise) / 100);
  }
  return 0;
}

/**
 * Online payment verified — ledger credit (physio earning); idempotent.
 */
export async function creditPhysioWalletOnline(booking) {
  await postOnlineCredit(booking);
}

/**
 * Offline cash verified — ledger: gross collection + commission due.
 */
export async function applyOfflineVerificationWallet(booking) {
  await postOfflinePair(booking);
}

/**
 * Admin settlement — ledger debit; commission due derived from transactions.
 */
export async function settlePhysioCommissionDue(physioId, amountRupees, opts = {}) {
  const physio = await Physiotherapist.findById(physioId).lean();
  if (!physio) {
    const err = new Error('Physiotherapist not found');
    err.statusCode = 404;
    throw err;
  }
  await postSettlementDebit(physioId, amountRupees, {
    note: opts.note,
    idempotencyKey: opts.idempotencyKey,
  });
  const wallet = await getComputedWallet(physioId);
  return { ...physio, wallet };
}
