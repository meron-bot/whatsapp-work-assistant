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

  it('clarifies medium-confidence task (0.60-0.84) instead of auto-executing', () => {
    const d = decideAction(action({ confidence: 0.7 }));
    expect(d.kind).toBe('clarify');
  });

  // (17) Calendar approval policy — with participants => high-risk approval
  it('requires approval for a calendar event with participants', () => {
    const d = decideAction(
      action({ type: 'create_calendar_event', startTime: '2026-06-03T09:30:00+03:00', participants: ['yossi@example.com'] }),
    );
    expect(d).toMatchObject({ kind: 'approval', riskLevel: 'high' });
  });

  it('requires medium approval for a calendar event without participants', () => {
    const d = decideAction(
      action({ type: 'create_calendar_event', startTime: '2026-06-03T09:30:00+03:00' }),
    );
    expect(d).toMatchObject({ kind: 'approval', riskLevel: 'medium' });
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

  it('ignores non-actionable actions with a reason', () => {
    const d = decideAction(action({ type: 'ignore', description: 'small talk' }));
    expect(d).toEqual({ kind: 'ignore', reason: 'small talk' });
  });
});
