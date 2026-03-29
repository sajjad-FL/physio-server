import Physiotherapist from '../models/Physiotherapist.js';
import { getPlatformCommissionPercent } from '../config/commission.js';
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
 * @param {number} amountRupees - gross amount (patient pays)
 * @returns {{ amount: number, commission: number, physioEarning: number }}
 */
export function computeMarketplaceSplit(amountRupees) {
  const amount = roundMoney2(Math.max(0, Number(amountRupees) || 0));
  const pct = getPlatformCommissionPercent();
  const commission = roundMoney2((amount * pct) / 100);
  const physioEarning = roundMoney2(Math.max(0, amount - commission));
  return { amount, commission, physioEarning };
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
 * Offline cash verified — ledger: credit gross + debit commission.
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
