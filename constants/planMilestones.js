/**
 * Default milestone schedules — runtime reads PlatformSettings via pricingConfig.js.
 * @deprecated Import DEFAULT_PLAN_MILESTONES from constants/pricingDefaults.js for defaults only.
 */
export { DEFAULT_PLAN_MILESTONES as PLAN_MILESTONES } from './pricingDefaults.js';

export {
  getPlanMilestonesSync,
  getRequiredPctForSessionSync as getRequiredPctForSession,
  getNextMilestoneHintSync as getNextMilestoneHint,
} from '../utils/pricingConfig.js';
