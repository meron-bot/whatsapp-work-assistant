import { PlannerAction } from '../planner/planner.schema';

export type PolicyDecision =
  | { kind: 'execute' }
  | { kind: 'clarify'; reason: string }
  | { kind: 'approval'; riskLevel: 'medium' | 'high'; reason: string }
  | { kind: 'ignore'; reason: string };

export const CONFIDENCE_EXECUTE = 0.7;
export const CONFIDENCE_CLARIFY = 0.5;

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

  // Outbound email is the most sensitive action and is ALWAYS gated by approval,
  // regardless of whether the planner remembered to set requiresApproval. The
  // real send only happens after the owner approves (runLowRisk -> sendEmail).
  if (action.type === 'send_email') {
    return {
      kind: 'approval',
      riskLevel: 'high',
      reason: action.approvalReason ?? 'outbound email',
    };
  }

  // Graduated policy: the planner marks outward-facing / risky actions
  // requiresApproval=true (external email, inviting clients, money, deletions).
  // Internal/reversible actions — including inviting people the owner already
  // works with — are left requiresApproval=false and execute with a report. We
  // trust that flag instead of gating on the mere presence of participants.
  if (action.requiresApproval) {
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

  // Mutations of the owner's own items ("move the meeting", "done with X",
  // "cancel the reminder") were explicitly requested — the request itself is the
  // authorization. requiresApproval=true (external participants get notified)
  // was already handled above; the confidence gate above filters shaky reads.
  if (
    action.type === 'update_task' ||
    action.type === 'complete_task' ||
    action.type === 'update_calendar_event' ||
    action.type === 'cancel_calendar_event' ||
    action.type === 'cancel_reminder'
  ) {
    if (action.confidence >= CONFIDENCE_EXECUTE) return { kind: 'execute' };
    return { kind: 'clarify', reason: 'not confident which item to change' };
  }

  if (action.type === 'save_file') {
    return action.confidence >= CONFIDENCE_EXECUTE
      ? { kind: 'execute' }
      : { kind: 'clarify', reason: 'unclear file destination' };
  }

  if (action.type === 'create_calendar_event') {
    // Need an explicit time to place the event.
    if (!action.startTime) {
      return { kind: 'clarify', reason: 'event time is not explicit' };
    }
    // requiresApproval was handled above; reaching here means the planner judged
    // this safe to auto-create (a personal hold, or an invite to known people).
    // Create it and report — Google sends invites to any attendees.
    return { kind: 'execute' };
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
