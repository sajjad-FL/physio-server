import User from '../models/User.js';
import ReferralReward from '../models/ReferralReward.js';
import { generateUniqueReferralCode } from '../utils/referralCode.js';
import {
  getReferralPublicSettings,
  getReferralRewardAmount,
  getReferralSignupBonusAmount,
} from '../utils/referralConfig.js';

/** Public: amounts shown on register / share (no auth). */
export async function getPublicReferralSettings(req, res, next) {
  try {
    const settings = await getReferralPublicSettings();
    return res.json(settings);
  } catch (err) {
    next(err);
  }
}

async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  const code = await generateUniqueReferralCode();
  await User.updateOne({ _id: user._id }, { $set: { referralCode: code } });
  return code;
}

export async function getMyReferralCode(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(userId).select('referralCode walletBalance role').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role !== 'user') {
      return res.status(403).json({ message: 'Referral program is for patients only' });
    }

    let referralCode = user.referralCode;
    if (!referralCode) {
      referralCode = await ensureReferralCode(user);
    }

    const fresh = await User.findById(userId).select('walletBalance').lean();
    const referralRewardAmount = await getReferralRewardAmount();
    const referralSignupBonusAmount = await getReferralSignupBonusAmount();

    return res.json({
      referralCode,
      walletBalance: Math.max(0, Number(fresh?.walletBalance ?? user.walletBalance) || 0),
      referralRewardAmount,
      referralSignupBonusAmount,
    });
  } catch (err) {
    next(err);
  }
}

export async function getReferralStats(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(userId).select('role').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role !== 'user') {
      return res.status(403).json({ message: 'Referral program is for patients only' });
    }

    const referred = await User.find({ referredBy: userId })
      .select('name phone createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const rewards = await ReferralReward.find({ referrerId: userId }).lean();
    const rewardByUser = new Map(
      rewards.map((r) => [String(r.referredUserId), r]),
    );

    const referrals = referred.map((u) => {
      const reward = rewardByUser.get(String(u._id));
      let rewardStatus = 'not_eligible_yet';
      if (reward?.status === 'credited') rewardStatus = 'credited';
      else if (reward?.status === 'pending') rewardStatus = 'pending';

      return {
        userId: u._id,
        name: u.name || 'Friend',
        phone: u.phone ? `••••${String(u.phone).slice(-4)}` : '',
        signedUpAt: u.createdAt,
        rewardStatus,
        creditedAt: reward?.creditedAt || null,
        amount: reward?.amount ?? null,
      };
    });

    return res.json({ referrals });
  } catch (err) {
    next(err);
  }
}
