/** Allowed degree values for physio qualification (registration + onboarding). */
export const PHYSIO_DEGREE_OPTIONS = Object.freeze(['BPT', 'MPT'])

export function isPhysioDegreeOption(value) {
  const d = String(value ?? '').trim()
  return PHYSIO_DEGREE_OPTIONS.includes(d)
}
