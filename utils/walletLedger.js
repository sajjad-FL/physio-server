import mongoose from 'mongoose';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import { roundMoney2 } from './marketplacePayment.js';

/**
 * Deduct patient wallet balance and post platform subsidy ledger (idempotent per booking).
 */
export async function deductWalletForBooking(booking, userId) {
  const discount = roundMoney2(Number(booking.walletDiscount) || 0);
  if (discount <= 0 || booking.walletDeducted) {
    return { deducted: false };
  }

  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      role: 'user',
      walletBalance: { $gte: discount },
    },
    { $inc: { walletBalance: -discount } },
    { new: true },
  );
  if (!updated) {
    const err = new Error('Insufficient wallet balance');
    err.statusCode = 400;
    throw err;
  }

  booking.walletDeducted = true;
  await booking.save();

  const existing = await Transaction.findOne({
    bookingId: booking._id,
    type: 'wallet_discount',
    status: 'posted',
  }).lean();
  if (!existing) {
    await Transaction.create({
      userId,
      bookingId: booking._id,
      physioId: booking.physioId || undefined,
      type: 'wallet_discount',
      totalAmount: discount,
      direction: 'debit',
      status: 'posted',
      meta: { leg: 'platform_subsidy' },
    });
  }

  return { deducted: true, amount: discount };
}

/**
 * Deduct wallet for an installment payment row (stores discount on Payment.meta).
 */
export async function deductWalletForInstallment({ userId, booking, payment, walletDeduction }) {
  const discount = roundMoney2(Number(walletDeduction) || 0);
  if (discount <= 0) return { deducted: false };
  if (payment.meta?.walletDeducted) return { deducted: false };

  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      role: 'user',
      walletBalance: { $gte: discount },
    },
    { $inc: { walletBalance: -discount } },
    { new: true },
  );
  if (!updated) {
    const err = new Error('Insufficient wallet balance');
    err.statusCode = 400;
    throw err;
  }

  payment.meta = {
    ...(payment.meta || {}),
    walletDiscount: discount,
    walletDeducted: true,
  };
  await payment.save();

  if (mongoose.isValidObjectId(String(booking._id))) {
    const existing = await Transaction.findOne({
      bookingId: booking._id,
      type: 'wallet_discount',
      status: 'posted',
      'meta.paymentId': String(payment._id),
    }).lean();
    if (!existing) {
      await Transaction.create({
        userId,
        bookingId: booking._id,
        physioId: booking.physioId || undefined,
        type: 'wallet_discount',
        totalAmount: discount,
        direction: 'debit',
        status: 'posted',
        meta: { leg: 'platform_subsidy', paymentId: String(payment._id) },
      });
    }
  }

  return { deducted: true, amount: discount };
}
