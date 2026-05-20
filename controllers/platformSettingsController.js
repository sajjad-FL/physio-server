import PlatformSettings from '../models/PlatformSettings.js';
import {
  DEFAULT_QUALIFICATION_DECLARATION,
  QUALIFICATION_DECLARATION_MAX_LENGTH,
  resolveDeclarationText,
} from '../constants/qualificationDeclaration.js';
import {
  REFERRAL_AMOUNT_MAX,
  REFERRAL_AMOUNT_MIN,
  REFERRAL_REWARD_AMOUNT_MIN,
  getReferralRewardAmount,
  getReferralSignupBonusAmount,
  normalizeReferralRewardAmountInput,
  normalizeReferralSignupBonusAmountInput,
} from '../utils/referralConfig.js';

const SINGLETON_ID = 'singleton';

async function ensureSingletonLean() {
  let doc = await PlatformSettings.findById(SINGLETON_ID).lean();
  if (!doc) {
    await PlatformSettings.create({ _id: SINGLETON_ID });
    doc = await PlatformSettings.findById(SINGLETON_ID).lean();
  }
  return doc;
}

/** Policy payload for physio onboarding / registration UIs. */
export function buildPhysioDeclarationPolicy(platformDoc) {
  const declarationText = resolveDeclarationText(platformDoc);
  return {
    requireSignedNda: false,
    requireQualificationDeclaration: true,
    declarationText,
    templateUrl: '',
    originalName: '',
  };
}

/** Public: physios (and registration) fetch declaration text and flags. */
export async function getPublicPhysioNda(req, res, next) {
  try {
    const doc = await ensureSingletonLean();
    const declarationText = resolveDeclarationText(doc);
    const stored = String(doc?.qualificationDeclarationText ?? '').trim();
    return res.json({
      templateUrl: '',
      originalName: '',
      requireSignedNda: false,
      requireQualificationDeclaration: true,
      declarationText,
      usesPlatformDefaultDeclaration: !stored,
    });
  } catch (err) {
    next(err);
  }
}

export async function getAdminPlatformSettings(req, res, next) {
  try {
    const doc = await ensureSingletonLean();
    const referralRewardAmount = await getReferralRewardAmount();
    const referralSignupBonusAmount = await getReferralSignupBonusAmount();
    return res.json({
      physioNdaTemplateUrl: doc?.physioNdaTemplateUrl || '',
      physioNdaOriginalName: doc?.physioNdaOriginalName || '',
      physioNdaUpdatedAt: doc?.physioNdaUpdatedAt || null,
      qualificationDeclarationText: String(doc?.qualificationDeclarationText ?? '').trim(),
      qualificationDeclarationResolved: resolveDeclarationText(doc),
      qualificationDeclarationUpdatedAt: doc?.qualificationDeclarationUpdatedAt || null,
      referralRewardAmount,
      referralRewardAmountUpdatedAt: doc?.referralRewardAmountUpdatedAt || null,
      referralSignupBonusAmount,
      referralSignupBonusAmountUpdatedAt: doc?.referralSignupBonusAmountUpdatedAt || null,
    });
  } catch (err) {
    next(err);
  }
}

/** Admin: update declaration and/or referral reward amount. */
export async function patchAdminPlatformSettings(req, res, next) {
  try {
    const { qualificationDeclarationText, referralRewardAmount, referralSignupBonusAmount } =
      req.body || {};
    const hasDeclaration = qualificationDeclarationText !== undefined && qualificationDeclarationText !== null;
    const hasReferralAmount = referralRewardAmount !== undefined && referralRewardAmount !== null;
    const hasSignupBonus =
      referralSignupBonusAmount !== undefined && referralSignupBonusAmount !== null;

    if (!hasDeclaration && !hasReferralAmount && !hasSignupBonus) {
      return res.status(400).json({
        message:
          'Send qualificationDeclarationText, referralRewardAmount, and/or referralSignupBonusAmount.',
      });
    }

    const $set = {};
    const messages = [];

    if (hasDeclaration) {
      const raw = String(qualificationDeclarationText).trim();
      if (raw.length > QUALIFICATION_DECLARATION_MAX_LENGTH) {
        return res.status(400).json({
          message: `Declaration must be at most ${QUALIFICATION_DECLARATION_MAX_LENGTH} characters`,
        });
      }
      $set.qualificationDeclarationText = raw;
      $set.qualificationDeclarationUpdatedAt = new Date();
      messages.push('Declaration updated');
    }

    if (hasReferralAmount) {
      const amount = normalizeReferralRewardAmountInput(referralRewardAmount);
      if (amount == null) {
        return res.status(400).json({
          message: `referralRewardAmount must be an integer from ${REFERRAL_REWARD_AMOUNT_MIN} to ${REFERRAL_AMOUNT_MAX}`,
        });
      }
      $set.referralRewardAmount = amount;
      $set.referralRewardAmountUpdatedAt = new Date();
      messages.push('Referrer reward updated');
    }

    if (hasSignupBonus) {
      const bonus = normalizeReferralSignupBonusAmountInput(referralSignupBonusAmount);
      if (bonus == null) {
        return res.status(400).json({
          message: `referralSignupBonusAmount must be an integer from ${REFERRAL_AMOUNT_MIN} to ${REFERRAL_AMOUNT_MAX} (0 disables friend signup bonus)`,
        });
      }
      $set.referralSignupBonusAmount = bonus;
      $set.referralSignupBonusAmountUpdatedAt = new Date();
      messages.push('Friend signup bonus updated');
    }

    const updated = await PlatformSettings.findByIdAndUpdate(
      SINGLETON_ID,
      { $set },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    const resolvedReward = await getReferralRewardAmount();
    const resolvedSignupBonus = await getReferralSignupBonusAmount();

    return res.json({
      message: messages.join('. ') || 'Settings updated',
      qualificationDeclarationText: String(updated?.qualificationDeclarationText ?? '').trim(),
      qualificationDeclarationResolved: resolveDeclarationText(updated),
      qualificationDeclarationUpdatedAt: updated?.qualificationDeclarationUpdatedAt || null,
      referralRewardAmount: resolvedReward,
      referralRewardAmountUpdatedAt: updated?.referralRewardAmountUpdatedAt || null,
      referralSignupBonusAmount: resolvedSignupBonus,
      referralSignupBonusAmountUpdatedAt: updated?.referralSignupBonusAmountUpdatedAt || null,
    });
  } catch (err) {
    next(err);
  }
}

/** @deprecated PDF NDA template upload removed — use qualification declaration text in admin settings. */
export async function uploadPhysioNdaTemplate(_req, res) {
  return res.status(410).json({
    message:
      'NDA file upload is no longer supported. Edit the qualification declaration under Admin → Platform documents.',
  });
}
