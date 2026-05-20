import { roundMoney2 } from './marketplacePayment.js';

/**
 * Compute wallet credit to apply at checkout (does not mutate DB).
 * @returns {{ grossRupees: number, walletDeduction: number, payableRupees: number, payablePaise: number }}
 */
export function applyWalletCredit({ user, grossRupees, useWalletCredit }) {
  const gross = roundMoney2(Math.max(0, Number(grossRupees) || 0));
  if (!useWalletCredit || !user || user.role !== 'user') {
    return {
      grossRupees: gross,
      walletDeduction: 0,
      payableRupees: gross,
      payablePaise: Math.round(gross * 100),
    };
  }
  const balance = roundMoney2(Math.max(0, Number(user.walletBalance) || 0));
  const walletDeduction = roundMoney2(Math.min(balance, gross));
  if (walletDeduction > balance + 0.001) {
    const err = new Error('Insufficient wallet balance');
    err.statusCode = 400;
    throw err;
  }
  const payableRupees = roundMoney2(Math.max(0, gross - walletDeduction));
  return {
    grossRupees: gross,
    walletDeduction,
    payableRupees,
    payablePaise: Math.round(payableRupees * 100),
  };
}
