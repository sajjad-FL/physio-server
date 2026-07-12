/** Server-side assessment / session progress formatters. */

const SLEEP = { good: 'Good', ok: 'OK', poor: 'Poor' }
const MOBILITY = { easy: 'Easy', limited: 'Limited', difficult: 'Difficult', unable: 'Unable' }
const VS_LAST = { better: 'Better', same: 'Same', worse: 'Worse' }
const EXERCISES = { yes: 'Yes', partial: 'Partial', no: 'No' }
const MEDS = { none: 'None', as_needed: 'As needed', regular: 'Regular' }

function score(n) {
  if (n == null || Number.isNaN(Number(n))) return null
  return String(Number(n))
}

function pick(map, value) {
  if (!value) return null
  return map[value] || value
}

export function formatAssessmentNotesText(data) {
  if (!data || typeof data !== 'object') return ''
  const lines = []
  if (data.painNow != null) lines.push(`Pain now: ${score(data.painNow)}/10`)
  if (data.painOnMovement != null) lines.push(`Pain on movement: ${score(data.painOnMovement)}/10`)
  if (data.functionNow != null) lines.push(`Function / daily activity: ${score(data.functionNow)}/10`)
  if (Array.isArray(data.areas) && data.areas.length) {
    const areasLabel = data.areas
      .map((a) =>
        a === 'Other' && String(data.areasOther || '').trim()
          ? `Other (${String(data.areasOther).trim()})`
          : a,
      )
      .join(', ')
    lines.push(`Affected areas: ${areasLabel}`)
  }
  if (Array.isArray(data.findings) && data.findings.length) {
    const findingsLabel = data.findings
      .map((a) =>
        a === 'Other' && String(data.findingsOther || '').trim()
          ? `Other (${String(data.findingsOther).trim()})`
          : a,
      )
      .join(', ')
    lines.push(`Findings: ${findingsLabel}`)
  }
  if (Array.isArray(data.precautions) && data.precautions.length) {
    const precautionsLabel = data.precautions
      .map((a) =>
        a === 'Other' && String(data.precautionsOther || '').trim()
          ? `Other (${String(data.precautionsOther).trim()})`
          : a,
      )
      .join(', ')
    lines.push(`Precautions: ${precautionsLabel}`)
  }
  if (data.sleep) lines.push(`Sleep: ${pick(SLEEP, data.sleep)}`)
  if (data.mobility) lines.push(`Walking / mobility: ${pick(MOBILITY, data.mobility)}`)
  if (data.patientGoal) {
    const goal =
      data.patientGoal === 'Other' && String(data.patientGoalOther || '').trim()
        ? String(data.patientGoalOther).trim()
        : data.patientGoal
    lines.push(`Patient goal: ${goal}`)
  }
  if (String(data.extraNotes || '').trim()) lines.push(`Notes: ${String(data.extraNotes).trim()}`)
  return lines.join('\n')
}

export function formatSessionProgressText(data) {
  if (!data || typeof data !== 'object') return ''
  const lines = []
  if (data.painNow != null) lines.push(`Pain now: ${score(data.painNow)}/10`)
  if (data.painOnMovement != null) lines.push(`Pain on movement: ${score(data.painOnMovement)}/10`)
  if (data.functionNow != null) lines.push(`Function / daily activity: ${score(data.functionNow)}/10`)
  if (data.sleep) lines.push(`Sleep: ${pick(SLEEP, data.sleep)}`)
  if (data.mobility) lines.push(`Walking / mobility: ${pick(MOBILITY, data.mobility)}`)
  if (data.vsLastVisit) lines.push(`Vs last visit: ${pick(VS_LAST, data.vsLastVisit)}`)
  if (data.homeExercises) lines.push(`Home exercises: ${pick(EXERCISES, data.homeExercises)}`)
  if (data.painMeds) lines.push(`Pain meds: ${pick(MEDS, data.painMeds)}`)
  if (String(data.text || '').trim()) lines.push(`Notes: ${String(data.text).trim()}`)
  return lines.join('\n')
}

export function validateAssessmentData(data) {
  const hasPain = data?.painNow != null && data?.painNow !== ''
  const hasFn = data?.functionNow != null && data?.functionNow !== ''
  const pain = Number(data?.painNow)
  const fn = Number(data?.functionNow)
  const areas = Array.isArray(data?.areas) ? data.areas : []
  if (!hasPain || !Number.isFinite(pain) || pain < 0 || pain > 10) return 'Select pain now (0–10)'
  if (!hasFn || !Number.isFinite(fn) || fn < 0 || fn > 10) return 'Select function / daily activity (0–10)'
  if (areas.length < 1) return 'Select at least one affected area'
  if (areas.includes('Other') && !String(data?.areasOther || '').trim()) {
    return 'Describe the other affected area'
  }
  const findings = Array.isArray(data?.findings) ? data.findings : []
  if (findings.includes('Other') && !String(data?.findingsOther || '').trim()) {
    return 'Describe the other key finding'
  }
  const precautions = Array.isArray(data?.precautions) ? data.precautions : []
  if (precautions.includes('Other') && !String(data?.precautionsOther || '').trim()) {
    return 'Describe the other precaution'
  }
  return null
}

export function validateSessionProgress(data) {
  const hasPain = data?.painNow != null && data?.painNow !== ''
  const hasFn = data?.functionNow != null && data?.functionNow !== ''
  const pain = Number(data?.painNow)
  const fn = Number(data?.functionNow)
  if (!hasPain || !Number.isFinite(pain) || pain < 0 || pain > 10) return 'Select pain now (0–10)'
  if (!hasFn || !Number.isFinite(fn) || fn < 0 || fn > 10) return 'Select function / daily activity (0–10)'
  return null
}

function clampScore(n) {
  if (n == null || n === '') return null
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  return Math.min(10, Math.max(0, Math.round(v)))
}

const CHIP_STR = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function sanitizeAssessmentData(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    painNow: clampScore(raw.painNow),
    functionNow: clampScore(raw.functionNow),
    painOnMovement: clampScore(raw.painOnMovement),
    areas: Array.isArray(raw.areas) ? raw.areas.map(String).filter(Boolean).slice(0, 12) : [],
    areasOther: String(raw.areasOther || '').trim().slice(0, 200),
    findings: Array.isArray(raw.findings) ? raw.findings.map(String).filter(Boolean).slice(0, 12) : [],
    findingsOther: String(raw.findingsOther || '').trim().slice(0, 200),
    precautions: Array.isArray(raw.precautions)
      ? raw.precautions.map(String).filter(Boolean).slice(0, 12)
      : [],
    precautionsOther: String(raw.precautionsOther || '').trim().slice(0, 200),
    sleep: CHIP_STR(raw.sleep),
    mobility: CHIP_STR(raw.mobility),
    planLength: [7, 15, 30].includes(Number(raw.planLength)) ? Number(raw.planLength) : null,
    patientGoal: CHIP_STR(raw.patientGoal),
    patientGoalOther: String(raw.patientGoalOther || '').trim().slice(0, 200),
    extraNotes: String(raw.extraNotes || '').trim().slice(0, 2000),
  }
}

export function sanitizeSessionProgress(body = {}) {
  return {
    painNow: clampScore(body.painNow),
    functionNow: clampScore(body.functionNow),
    painOnMovement: clampScore(body.painOnMovement),
    sleep: CHIP_STR(body.sleep),
    mobility: CHIP_STR(body.mobility),
    vsLastVisit: CHIP_STR(body.vsLastVisit),
    homeExercises: CHIP_STR(body.homeExercises),
    painMeds: CHIP_STR(body.painMeds),
    text: typeof body.text === 'string' ? body.text.trim().slice(0, 5000) : '',
  }
}
