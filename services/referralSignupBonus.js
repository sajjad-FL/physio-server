import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import { getReferralSignupBonusAmount } from '../utils/referralConfig.js';
import { notifyExpoUsers, fireBookingPush } from '../utils/expoPush.js';

/**
 * Credit referred friend (new patient) on signup when they used a referral code.
 * Idempotent via unique transaction index per user.
 */
export async function processReferralSignupBonus(user) {
  if (!user?._id || !user.referredBy) {
    return { processed: false, reason: 'not_referred' };
  }

  const bonusAmount = await getReferralSignupBonusAmount();
  if (bonusAmount <= 0) {
    return { processed: false, reason: 'bonus_disabled' };
  }

  const userId = user._id;

  try {
    await Transaction.create({
      userId,
      type: 'referral_signup_bonus',
      totalAmount: bonusAmount,
      direction: 'credit',
      status: 'posted',
      meta: {
        referrerId: String(user.referredBy),
      },
    });

    await User.findByIdAndUpdate(userId, {
      $inc: { walletBalance: bonusAmount },
    });

    fireBookingPush(() =>
      notifyExpoUsers([userId], {
        title: 'Welcome bonus',
        body: `You received ₹${bonusAmount} wallet credit for joining with a referral code!`,
        data: { type: 'referral_signup_bonus', amount: String(bonusAmount) },
      }),
    );

    return { processed: true, amount: bonusAmount };
  } catch (err) {
    if (err?.code === 11000) {
      return { processed: false, reason: 'already_credited' };
    }
    throw err;
  }
}
