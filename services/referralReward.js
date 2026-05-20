import Booking from '../models/Booking.js';
import User from '../models/User.js';
import ReferralReward from '../models/ReferralReward.js';
import Transaction from '../models/Transaction.js';
import { getReferralRewardAmount } from '../utils/referralConfig.js';
import { notifyExpoUsers, fireBookingPush } from '../utils/expoPush.js';

/**
 * Issue platform credit to referrer when referred user completes first booking.
 * Amount comes from admin PlatformSettings. Idempotent via unique index on referredUserId.
 */
export async function processReferralRewardOnBookingCompleted(booking) {
  if (!booking?.userId || booking.status !== 'completed') {
    return { processed: false, reason: 'not_completed' };
  }

  const patientId =
    booking.userId?._id != null ? booking.userId._id : booking.userId;
  if (!patientId) {
    return { processed: false, reason: 'no_patient' };
  }

  const patient = await User.findById(patientId).select('referredBy').lean();
  if (!patient?.referredBy) {
    return { processed: false, reason: 'not_referred' };
  }

  const referredUserId = patientId;
  const existing = await ReferralReward.findOne({ referredUserId }).lean();
  if (existing) {
    return { processed: false, reason: 'already_rewarded' };
  }

  const priorCompleted = await Booking.countDocuments({
    userId: referredUserId,
    status: 'completed',
    _id: { $ne: booking._id },
  });
  if (priorCompleted > 0) {
    return { processed: false, reason: 'not_first_completion' };
  }

  const referrerId = patient.referredBy;
  const rewardAmount = await getReferralRewardAmount();

  try {
    const reward = await ReferralReward.create({
      referrerId,
      referredUserId,
      bookingId: booking._id,
      amount: rewardAmount,
      status: 'pending',
    });

    await User.findByIdAndUpdate(referrerId, {
      $inc: { walletBalance: rewardAmount },
    });

    reward.status = 'credited';
    reward.creditedAt = new Date();
    await reward.save();

    await Transaction.create({
      userId: referrerId,
      bookingId: booking._id,
      type: 'referral_credit',
      totalAmount: rewardAmount,
      direction: 'credit',
      status: 'posted',
      meta: {
        referredUserId: String(referredUserId),
        bookingId: String(booking._id),
      },
    });

    fireBookingPush(() =>
      notifyExpoUsers([referrerId], {
        title: 'Referral reward',
        body: `You earned ₹${rewardAmount}! Your friend just completed their first session.`,
        data: { type: 'referral_credit', amount: String(rewardAmount) },
      }),
    );

    return { processed: true, rewardId: reward._id };
  } catch (err) {
    if (err?.code === 11000) {
      return { processed: false, reason: 'duplicate' };
    }
    throw err;
  }
}
