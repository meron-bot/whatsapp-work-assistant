import { decideAction } from '../src/actions/action-policy';
import { PlannerAction } from '../src/planner/planner.schema';

function action(overrides: Partial<PlannerAction>): PlannerAction {
  return {
    type: 'create_task',
    title: 'Test',
    description: null,
    confidence: 0.95,
    priority: 'medium',
    dueDate: null,
    startTime: null,
    endTime: null,
    participants: [],
    project: null,
    client: null,
    requiresApproval: false,
    approvalReason: null,
    missingFields: [],
    toolPayload: {},
    ...overrides,
  };
}

describe('action policy', () => {
  // (16) Task creation policy
  it('executes a high-confidence private task', () => {
    expect(decideAction(action({ type: 'create_task', confidence: 0.9 }))).toEqual({
      kind: 'execute',
    });
  });

  // (12) Low-confidence planner output -> clarify
  it('asks clarification when confidence < 0.60', () => {
    const d = decideAction(action({ confidence: 0.4 }));
    expect(d.kind).toBe('clarify');
  });

  it('clarifies a task below 0.70 but auto-executes at/above it', () => {
    // Graduated policy: reversible tasks execute once confidence reaches
    // CONFIDENCE_EXECUTE (0.70); below that (but >= 0.50) we clarify.
    expect(decideAction(action({ confidence: 0.6 })).kind).toBe('clarify');
    expect(decideAction(action({ confidence: 0.7 })).kind).toBe('execute');
  });

  // (17) Calendar approval policy — presence of participants alone does NOT gate;
  // we trust the planner's requiresApproval flag (set for external/client invites).
  it('auto-executes a calendar event with participants unless flagged for approval', () => {
    const internal = decideAction(
      action({ type: 'create_calendar_event', startTime: '2026-06-03T09:30:00+03:00', participants: ['yossi@example.com'] }),
    );
    expect(internal).toEqual({ kind: 'execute' });

    const external = decideAction(
      action({
        type: 'create_calendar_event',
        startTime: '2026-06-03T09:30:00+03:00',
        participants: ['client@external.com'],
        requiresApproval: true,
        approvalReason: 'external invite',
      }),
    );
    expect(external).toMatchObject({ kind: 'approval', riskLevel: 'high' });
  });

  it('auto-executes a private calendar event with an explicit time', () => {
    const d = decideAction(
      action({ type: 'create_calendar_event', startTime: '2026-06-03T09:30:00+03:00' }),
    );
    expect(d).toEqual({ kind: 'execute' });
  });

  it('clarifies a calendar event with no explicit time', () => {
    const d = decideAction(action({ type: 'create_calendar_event', startTime: null }));
    expect(d.kind).toBe('clarify');
  });

  // (13/14/15) Missing fields force clarification
  it('clarifies when high-importance fields are missing', () => {
    const d = decideAction(action({ missingFields: ['date'] }));
    expect(d.kind).toBe('clarify');
  });

  it('clarifies a reminder with no time', () => {
    const d = decideAction(action({ type: 'create_reminder', dueDate: null, startTime: null }));
    expect(d.kind).toBe('clarify');
  });

  it('executes a reminder that has a time', () => {
    const d = decideAction(
      action({ type: 'create_reminder', dueDate: '2026-06-03T09:00:00+03:00' }),
    );
    expect(d).toEqual({ kind: 'execute' });
  });

  it('always requires approval when requiresApproval is set', () => {
    const d = decideAction(action({ type: 'draft_document', requiresApproval: true }));
    expect(d).toMatchObject({ kind: 'approval', riskLevel: 'high' });
  });

  // Outbound email is ALWAYS gated, even if the planner forgot requiresApproval.
  it('always requires approval for send_email regardless of the flag', () => {
    expect(decideAction(action({ type: 'send_email', requiresApproval: false }))).toMatchObject({
      kind: 'approval',
      riskLevel: 'high',
    });
  });

  // Mutations of existing items: explicitly requested → auto-execute, unless
  // the planner flagged external participants for approval.
  it('auto-executes high-confidence mutations of the owner’s own items', () => {
    for (const type of [
      'update_task',
      'complete_task',
      'update_calendar_event',
      'cancel_calendar_event',
      'cancel_reminder',
    ] as const) {
      expect(decideAction(action({ type, confidence: 0.9 }))).toEqual({ kind: 'execute' });
    }
  });

  it('clarifies a mutation when not confident which item is meant', () => {
    expect(decideAction(action({ type: 'complete_task', confidence: 0.65 })).kind).toBe('clarify');
  });

  it('gates a mutation to approval when the planner flags external participants', () => {
    const d = decideAction(
      action({ type: 'cancel_calendar_event', requiresApproval: true, approvalReason: 'external attendees' }),
    );
    expect(d.kind).toBe('approval');
  });

  it('ignores non-actionable actions with a reason', () => {
    const d = decideAction(action({ type: 'ignore', description: 'small talk' }));
    expect(d).toEqual({ kind: 'ignore', reason: 'small talk' });
  });
});
