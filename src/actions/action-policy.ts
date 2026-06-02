import { PlannerAction } from '../planner/planner.schema';

export type PolicyDecision =
  | { kind: 'execute' }
  | { kind: 'clarify'; reason: string }
  | { kind: 'approval'; riskLevel: 'medium' | 'high'; reason: string }
  | { kind: 'ignore'; reason: string };

export const CONFIDENCE_EXECUTE = 0.85;
export const CONFIDENCE_CLARIFY = 0.6;

const LOW_RISK_TYPES = new Set(['create_task', 'create_reminder', 'save_file']);

/**
 * Pure decision function: given a planner action, decide whether to execute it,
 * request approval, ask clarification, or ignore. No side effects -> easy to
 * unit test, and the single source of truth for the safety policy.
 */
export function decideAction(action: PlannerAction): PolicyDecision {
  if (action.type === 'ignore') {
    return { kind: 'ignore', reason: action.description ?? 'non-actionable' };
  }

  if (action.type === 'ask_clarification') {
    return { kind: 'clarify', reason: action.approvalReason ?? 'missing information' };
  }

  // Explicit high-risk flag from the planner always wins.
  if (action.requiresApproval || action.participants.length > 0) {
    return {
      kind: 'approval',
      riskLevel: 'high',
      reason: action.approvalReason ?? 'external or sensitive action',
    };
  }

  // Any high-importance missing field forces clarification.
  if (action.missingFields.length > 0) {
    return {
      kind: 'clarify',
      reason: `missing fields: ${action.missingFields.join(', ')}`,
    };
  }

  // Confidence gating.
  if (action.confidence < CONFIDENCE_CLARIFY) {
    return { kind: 'clarify', reason: 'confidence below 0.60' };
  }

  if (action.type === 'create_task' || action.type === 'create_reminder') {
    if (action.type === 'create_reminder' && !action.dueDate && !action.startTime) {
      return { kind: 'clarify', reason: 'reminder has no time' };
    }
    if (action.confidence >= CONFIDENCE_EXECUTE) return { kind: 'execute' };
    return { kind: 'clarify', reason: 'confidence below 0.85 for auto-execute' };
  }

  if (action.type === 'save_file') {
    return action.confidence >= CONFIDENCE_EXECUTE
      ? { kind: 'execute' }
      : { kind: 'clarify', reason: 'unclear file destination' };
  }

  if (action.type === 'create_calendar_event') {
    // No external participants here (handled above). Need an explicit time.
    if (!action.startTime) {
      return { kind: 'clarify', reason: 'event time is not explicit' };
    }
    // Calendar events are medium-risk: confirm before creating.
    return { kind: 'approval', riskLevel: 'medium', reason: 'create calendar event' };
  }

  if (action.type === 'draft_document') {
    // Private draft is allowed; officialization/sharing handled separately.
    return action.confidence >= CONFIDENCE_CLARIFY
      ? { kind: 'execute' }
      : { kind: 'clarify', reason: 'not enough information to draft' };
  }

  if (action.type === 'request_approval') {
    return {
      kind: 'approval',
      riskLevel: 'high',
      reason: action.approvalReason ?? 'explicit approval requested',
    };
  }

  // Default to the safe side.
  return { kind: 'clarify', reason: 'no policy match' };
}

export function isLowRisk(action: PlannerAction): boolean {
  return LOW_RISK_TYPES.has(action.type) && !action.requiresApproval;
}
