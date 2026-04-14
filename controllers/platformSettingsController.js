import PlatformSettings from '../models/PlatformSettings.js';
import {
  DEFAULT_QUALIFICATION_DECLARATION,
  QUALIFICATION_DECLARATION_MAX_LENGTH,
  resolveDeclarationText,
} from '../constants/qualificationDeclaration.js';

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
    return res.json({
      physioNdaTemplateUrl: doc?.physioNdaTemplateUrl || '',
      physioNdaOriginalName: doc?.physioNdaOriginalName || '',
      physioNdaUpdatedAt: doc?.physioNdaUpdatedAt || null,
      qualificationDeclarationText: String(doc?.qualificationDeclarationText ?? '').trim(),
      qualificationDeclarationResolved: resolveDeclarationText(doc),
      qualificationDeclarationUpdatedAt: doc?.qualificationDeclarationUpdatedAt || null,
    });
  } catch (err) {
    next(err);
  }
}

/** Admin: update stored declaration (empty string = use built-in default on read). */
export async function patchAdminPlatformSettings(req, res, next) {
  try {
    const { qualificationDeclarationText } = req.body || {};
    if (qualificationDeclarationText === undefined || qualificationDeclarationText === null) {
      return res.status(400).json({
        message: 'Send qualificationDeclarationText (string). Use empty string to use the default declaration.',
      });
    }
    const raw = String(qualificationDeclarationText).trim();
    if (raw.length > QUALIFICATION_DECLARATION_MAX_LENGTH) {
      return res.status(400).json({
        message: `Declaration must be at most ${QUALIFICATION_DECLARATION_MAX_LENGTH} characters`,
      });
    }

    const updated = await PlatformSettings.findByIdAndUpdate(
      SINGLETON_ID,
      {
        $set: {
          qualificationDeclarationText: raw,
          qualificationDeclarationUpdatedAt: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({
      message: 'Declaration updated',
      qualificationDeclarationText: String(updated?.qualificationDeclarationText ?? '').trim(),
      qualificationDeclarationResolved: resolveDeclarationText(updated),
      qualificationDeclarationUpdatedAt: updated?.qualificationDeclarationUpdatedAt || null,
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
