import { ActionExecutorService } from '../src/actions/action-executor.service';
import { PlannerAction, PlannerOutput } from '../src/planner/planner.schema';

process.env.DATABASE_URL = 'postgresql://x';
process.env.OWNER_WHATSAPP_NUMBER = '972500000000';

function action(overrides: Partial<PlannerAction>): PlannerAction {
  return {
    type: 'create_task',
    title: 'Test task',
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

function plan(a: PlannerAction): PlannerOutput {
  return {
    summary: '',
    confidence: 0.9,
    language: 'he',
    isAnswerToPendingClarification: false,
    isAnswerToPendingApproval: false,
    detectedProject: null,
    detectedClient: null,
    missingInformation: [],
    needsClarification: false,
    clarificationQuestion: null,
    toolRequests: [],
    assumptions: [],
    actions: [a],
    memoryWrites: [],
    replyToUser: '',
  };
}

describe('ActionExecutorService', () => {
  let deps: any;
  let svc: ActionExecutorService;

  beforeEach(() => {
    deps = {
      prisma: {
        task: { create: jest.fn().mockResolvedValue({ id: 't1' }), update: jest.fn() },
        approval: { findUnique: jest.fn() },
      },
      clarifications: { create: jest.fn().mockResolvedValue({ id: 'c1' }) },
      approvals: { create: jest.fn().mockResolvedValue({ id: 'a1' }) },
      reminders: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
      openLoops: { create: jest.fn().mockResolvedValue({ id: 'l1' }) },
      documents: { draft: jest.fn() },
      tasks: { createTask: jest.fn() },
      calendar: { createEvent: jest.fn() },
      googleAuth: { isAuthorized: jest.fn().mockResolvedValue(false) },
      audit: {
        success: jest.fn().mockResolvedValue(undefined),
        skipped: jest.fn().mockResolvedValue(undefined),
        failed: jest.fn().mockResolvedValue(undefined),
      },
    };
    svc = new ActionExecutorService(
      deps.prisma,
      deps.clarifications,
      deps.approvals,
      deps.reminders,
      deps.openLoops,
      deps.documents,
      deps.tasks,
      deps.calendar,
      deps.googleAuth,
      deps.audit,
    );
  });

  // (16) Task creation policy + (20) audit + open loop
  it('creates a private task and an open loop for a high-confidence task', async () => {
    const results = await svc.executePlan({
      sourceMessageId: 'm1',
      plannerOutput: plan(action({ confidence: 0.95 })),
    });
    expect(results[0]).toEqual({ type: 'task', id: 't1' });
    expect(deps.prisma.task.create).toHaveBeenCalled();
    expect(deps.openLoops.create).toHaveBeenCalled();
    expect(deps.audit.success).toHaveBeenCalledWith('task.created', expect.any(Object), expect.any(Object));
  });

  // (17) Calendar approval policy -> creates an approval, not an event
  it('creates a pending approval for a calendar event with participants', async () => {
    const results = await svc.executePlan({
      sourceMessageId: 'm2',
      plannerOutput: plan(
        action({
          type: 'create_calendar_event',
          startTime: '2026-06-03T09:30:00+03:00',
          participants: ['yossi@example.com'],
        }),
      ),
    });
    expect(results[0]).toEqual({ type: 'approval', id: 'a1' });
    expect(deps.approvals.create).toHaveBeenCalled();
    expect(deps.prisma.task.create).not.toHaveBeenCalled();
  });

  // (13/14/15) Missing info -> clarification + open loop, no execution
  it('creates a pending clarification when fields are missing', async () => {
    const results = await svc.executePlan({
      sourceMessageId: 'm3',
      plannerOutput: plan(action({ missingFields: ['dueDate'] })),
    });
    expect(results[0]).toEqual({ type: 'clarification', id: 'c1' });
    expect(deps.clarifications.create).toHaveBeenCalled();
    expect(deps.openLoops.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'waiting_for_owner' }),
    );
  });

  it('ignores non-actionable actions and audits the skip', async () => {
    const results = await svc.executePlan({
      sourceMessageId: 'm4',
      plannerOutput: plan(action({ type: 'ignore', description: 'greeting' })),
    });
    expect(results[0]).toEqual({ type: 'ignored', reason: 'greeting' });
    expect(deps.audit.skipped).toHaveBeenCalled();
  });
});
