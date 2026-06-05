/**
 * Milestone payment schedule for home care plans.
 *
 * bySession  — session ordinal (1-indexed) at which the minimum is checked.
 * minCumPct  — cumulative fraction of the total plan amount that must have
 *              been verified (paid) before the physio can mark session #N
 *              as complete, where N >= bySession.
 *
 * All plans share the Day-1 rule: at least 1 session's worth of payment
 * must be verified before the first session can be completed.
 *
 * 7-Day  : Session 1 (1 session), Session 5 (100%)
 * 15-Day : Session 1 (1 session), Session 5 (50%), Session 12 (100%)
 * 30-Day : Session 1 (1 session), Session 10 (50%), Session 20 (75%), Session 25 (100%)
 */
export const PLAN_MILESTONES = {
  7: [
    { bySession: 1,  minCumPct: 1 / 7  }, // Day 1: at least 1 session paid
    { bySession: 5,  minCumPct: 1.0    }, // By session 5: 100%
  ],
  15: [
    { bySession: 1,  minCumPct: 1 / 15 }, // Day 1: at least 1 session paid
    { bySession: 5,  minCumPct: 0.50   }, // By session 5: 50%
    { bySession: 12, minCumPct: 1.0    }, // By session 12: 100%
  ],
  30: [
    { bySession: 1,  minCumPct: 1 / 30 }, // Day 1: at least 1 session paid
    { bySession: 10, minCumPct: 0.50   }, // By session 10: 50%
    { bySession: 20, minCumPct: 0.75   }, // By session 20: 75% cumulative
    { bySession: 25, minCumPct: 1.0    }, // By session 25: 100%
  ],
}

/**
 * Returns the minimum cumulative payment fraction (0–1) that must be
 * verified before the physio can complete session `sessionOrdinal`.
 *
 * For non-plan single-session bookings (sessionsCount === 1): full payment
 * is required. For any other sessionsCount not in PLAN_MILESTONES: no gate.
 */
export function getRequiredPctForSession(sessionsCount, sessionOrdinal) {
  const milestones = PLAN_MILESTONES[sessionsCount]
  if (!milestones) {
    return sessionsCount === 1 ? 1.0 : 0
  }
  const applicable = milestones.filter((m) => m.bySession <= sessionOrdinal)
  if (!applicable.length) return 0
  return Math.max(...applicable.map((m) => m.minCumPct))
}

/**
 * Returns a human-readable description of the next unmet milestone, or null
 * if all milestones are met or no milestones apply to this plan.
 *
 * @param {number} sessionsCount
 * @param {number} paidPct  — fraction already paid (0–1)
 * @param {number} totalAmount
 */
export function getNextMilestoneHint(sessionsCount, paidPct, totalAmount) {
  const milestones = PLAN_MILESTONES[sessionsCount]
  if (!milestones) return null
  const unmet = milestones.find((m) => paidPct + 1e-6 < m.minCumPct)
  if (!unmet) return null
  const amtNeeded = Math.max(0, Math.round((unmet.minCumPct - paidPct) * totalAmount * 100) / 100)
  return {
    bySession: unmet.bySession,
    minCumPct: unmet.minCumPct,
    amtNeeded,
    label: `By session ${unmet.bySession}: pay ${Math.round(unmet.minCumPct * 100)}% (₹${amtNeeded} more)`,
  }
}
