import PlatformSettings from '../models/PlatformSettings.js';

export const DEFAULT_REFERRAL_REWARD_AMOUNT = 300;
export const DEFAULT_REFERRAL_SIGNUP_BONUS_AMOUNT = 100;
export const REFERRAL_AMOUNT_MIN = 0;
export const REFERRAL_REWARD_AMOUNT_MIN = 1;
export const REFERRAL_AMOUNT_MAX = 10000;

const SINGLETON_ID = 'singleton';

async function ensureSingletonLean() {
  let doc = await PlatformSettings.findById(SINGLETON_ID).lean();
  if (!doc) {
    await PlatformSettings.create({ _id: SINGLETON_ID });
    doc = await PlatformSettings.findById(SINGLETON_ID).lean();
  }
  return doc;
}

function readAmount(doc, field, { min, defaultValue }) {
  const n = Number(doc?.[field]);
  if (Number.isFinite(n) && n >= min && n <= REFERRAL_AMOUNT_MAX) {
    return Math.round(n);
  }
  return defaultValue;
}

/** INR credited to referrer when referred friend completes first booking. */
export async function getReferralRewardAmount() {
  const doc = await ensureSingletonLean();
  return readAmount(doc, 'referralRewardAmount', {
    min: REFERRAL_REWARD_AMOUNT_MIN,
    defaultValue: DEFAULT_REFERRAL_REWARD_AMOUNT,
  });
}

/** INR credited to new user who signs up with a referral code (0 = disabled). */
export async function getReferralSignupBonusAmount() {
  const doc = await ensureSingletonLean();
  return readAmount(doc, 'referralSignupBonusAmount', {
    min: REFERRAL_AMOUNT_MIN,
    defaultValue: DEFAULT_REFERRAL_SIGNUP_BONUS_AMOUNT,
  });
}

export async function getReferralPublicSettings() {
  const [referralRewardAmount, referralSignupBonusAmount] = await Promise.all([
    getReferralRewardAmount(),
    getReferralSignupBonusAmount(),
  ]);
  return { referralRewardAmount, referralSignupBonusAmount };
}

export function normalizeReferralRewardAmountInput(raw) {
  return normalizeReferralAmountInput(raw, { min: REFERRAL_REWARD_AMOUNT_MIN });
}

export function normalizeReferralSignupBonusAmountInput(raw) {
  return normalizeReferralAmountInput(raw, { min: REFERRAL_AMOUNT_MIN });
}

function normalizeReferralAmountInput(raw, { min }) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < min || n > REFERRAL_AMOUNT_MAX) {
    return null;
  }
  return n;
}
