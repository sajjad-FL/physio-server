/** Max stored length for admin-editable declaration (Mongo string practical limit). */
export const QUALIFICATION_DECLARATION_MAX_LENGTH = 8000;

/**
 * Default declaration shown to physiotherapists when platform has no custom text.
 * Admin can override via platform settings.
 */
export const DEFAULT_QUALIFICATION_DECLARATION = `I confirm that all qualifications, credentials, and documents I submit to NearbyPhysio are true, complete, and accurate to the best of my knowledge.

I understand that any misrepresentation, omission, or falsification may result in removal from the platform, cancellation of assignments, and may expose me to civil or criminal liability where applicable.

By proceeding, I agree to these terms on behalf of myself and my practice as listed on NearbyPhysio.`;

/**
 * @param {Record<string, unknown> | null | undefined} platformDoc lean PlatformSettings or null
 * @returns {string} non-empty declaration text
 */
export function resolveDeclarationText(platformDoc) {
  const raw = String(platformDoc?.qualificationDeclarationText ?? '').trim();
  if (raw) return raw.slice(0, QUALIFICATION_DECLARATION_MAX_LENGTH);
  return DEFAULT_QUALIFICATION_DECLARATION;
}
