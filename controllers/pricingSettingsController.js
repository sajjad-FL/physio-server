import {
  getAdminPricingSettings,
  getPublicPricingSettings,
  normalizePricingPatch,
  applyPricingPatch,
  resetPricingToDefaults,
} from '../utils/pricingConfig.js';

export async function getPublicPricingSettingsHandler(req, res, next) {
  try {
    const settings = await getPublicPricingSettings();
    return res.json(settings);
  } catch (err) {
    next(err);
  }
}

export async function getAdminPricingSettingsHandler(req, res, next) {
  try {
    const settings = await getAdminPricingSettings();
    return res.json(settings);
  } catch (err) {
    next(err);
  }
}

export async function patchAdminPricingSettingsHandler(req, res, next) {
  try {
    const normalized = normalizePricingPatch(req.body || {});
    if (!normalized.ok) {
      return res.status(400).json({ message: normalized.errors[0], errors: normalized.errors });
    }
    const settings = await applyPricingPatch(normalized.value);
    return res.json(settings);
  } catch (err) {
    next(err);
  }
}

export async function resetAdminPricingSettingsHandler(req, res, next) {
  try {
    const settings = await resetPricingToDefaults();
    return res.json(settings);
  } catch (err) {
    next(err);
  }
}
