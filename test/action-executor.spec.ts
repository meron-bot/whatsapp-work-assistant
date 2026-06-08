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
      gmail: { sendEmail: jest.fn(), findContactEmail: jest.fn() },
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
      deps.gmail,
      deps.audit,
    );
  });

  // (16) Task creation policy + (20) audit + open loop
  it('creates a private task and an open loop for a high-confidence task', async () => {
    const results = await svc.executePlan({
      sourceMessageId: 'm1',
      plannerOutput: plan(action({ confidence: 0.95 })),
    });
    // Google not connected (isAuthorized=false) -> saved locally, googleSynced=false.
    expect(results[0]).toEqual({ type: 'task', id: 't1', googleSynced: false });
    expect(deps.prisma.task.create).toHaveBeenCalled();
    expect(deps.tasks.createTask).not.toHaveBeenCalled();
    expect(deps.openLoops.create).toHaveBeenCalled();
    expect(deps.audit.success).toHaveBeenCalledWith('task.created', expect.any(Object), expect.any(Object));
  });

  // Honesty: when Google IS connected and the sync succeeds, the result reports
  // googleSynced=true and the local task is linked to its Google Tasks id.
  it('syncs a task to Google Tasks and reports googleSynced=true when connected', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(true);
    deps.tasks.createTask.mockResolvedValue('gtask-1');

    const results = await svc.executePlan({
      sourceMessageId: 'm1',
      plannerOutput: plan(action({ confidence: 0.95 })),
    });

    expect(deps.tasks.createTask).toHaveBeenCalled();
    expect(deps.prisma.task.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { googleTaskId: 'gtask-1' },
    });
    expect(results[0]).toEqual({ type: 'task', id: 't1', googleSynced: true });
  });

  // Honesty: a Google Tasks API failure must NOT be reported as synced — the
  // local task is still created, but googleSynced stays false so the reply can
  // tell the owner it never reached Google.
  it('reports googleSynced=false when the Google Tasks sync throws', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(true);
    deps.tasks.createTask.mockRejectedValue(new Error('token revoked'));

    const results = await svc.executePlan({
      sourceMessageId: 'm1',
      plannerOutput: plan(action({ confidence: 0.95 })),
    });

    expect(results[0]).toEqual({ type: 'task', id: 't1', googleSynced: false });
  });

  // (17) Calendar approval policy -> an OUTWARD-FACING event (flagged by the
  // planner) becomes an approval, not an event. Internal events auto-execute
  // under the graduated policy, so the trigger is requiresApproval, not the mere
  // presence of participants.
  it('creates a pending approval for a calendar event flagged for approval', async () => {
    const results = await svc.executePlan({
      sourceMessageId: 'm2',
      plannerOutput: plan(
        action({
          type: 'create_calendar_event',
          startTime: '2026-06-03T09:30:00+03:00',
          participants: ['client@external.com'],
          requiresApproval: true,
          approvalReason: 'external invite',
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

  // Outbound email is always gated: even with requiresApproval=false, a send_email
  // becomes a pending approval and nothing is sent.
  it('routes send_email through approval instead of sending immediately', async () => {
    const results = await svc.executePlan({
      sourceMessageId: 'm5',
      plannerOutput: plan(
        action({
          type: 'send_email',
          title: 'עדכון ללקוח',
          participants: ['dana@client.com'],
          requiresApproval: false,
        }),
      ),
    });
    expect(results[0]).toEqual({ type: 'approval', id: 'a1' });
    expect(deps.gmail.sendEmail).not.toHaveBeenCalled();
  });

  // Honesty: an approved email is only reported sent when the Gmail API confirms.
  it('sends an approved email and reports sent=true when connected', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(true);
    deps.gmail.sendEmail.mockResolvedValue('msg-1');

    const result = await svc.runLowRisk(
      action({
        type: 'send_email',
        title: 'נושא',
        description: 'גוף',
        participants: ['dana@client.com'],
      }),
      { sourceMessageId: 'm6', plannerOutput: plan(action({})) },
    );

    expect(deps.gmail.sendEmail).toHaveBeenCalledWith({
      to: 'dana@client.com',
      subject: 'נושא',
      body: 'גוף',
    });
    expect(result).toEqual({ type: 'email', sent: true, to: 'dana@client.com' });
  });

  // Honesty: if Gmail is not connected, an approved email must NOT be reported as
  // sent — sent=false with reason so the reply tells the truth.
  it('reports sent=false when Gmail is not connected', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(false);

    const result = await svc.runLowRisk(
      action({ type: 'send_email', participants: ['dana@client.com'] }),
      { sourceMessageId: 'm7', plannerOutput: plan(action({})) },
    );

    expect(deps.gmail.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ type: 'email', sent: false, to: 'dana@client.com', reason: 'not_connected' });
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
