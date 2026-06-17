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
        task: {
          create: jest.fn().mockResolvedValue({ id: 't1' }),
          update: jest.fn().mockResolvedValue({ id: 't1', title: 'Test task' }),
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        calendarEvent: {
          update: jest.fn().mockResolvedValue({ id: 'e1', title: 'פגישה עם עומרי' }),
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        reminder: {
          update: jest.fn().mockResolvedValue({ id: 'r1', title: 'תזכורת' }),
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        openLoop: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        approval: { findUnique: jest.fn() },
        documentDraft: { update: jest.fn() },
      },
      clarifications: { create: jest.fn().mockResolvedValue({ id: 'c1' }) },
      approvals: { create: jest.fn().mockResolvedValue({ id: 'a1' }) },
      reminders: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
      openLoops: { create: jest.fn().mockResolvedValue({ id: 'l1' }) },
      documents: { draft: jest.fn() },
      tasks: {
        createTask: jest.fn(),
        completeTask: jest.fn(),
        updateTask: jest.fn(),
        listOpen: jest.fn().mockResolvedValue([]),
      },
      calendar: { createEvent: jest.fn(), updateEvent: jest.fn(), cancelEvent: jest.fn() },
      googleAuth: { isAuthorized: jest.fn().mockResolvedValue(false) },
      gmail: { sendEmail: jest.fn(), findContactEmail: jest.fn() },
      docs: { createDocument: jest.fn() },
      contacts: { findEmail: jest.fn().mockResolvedValue(null), remember: jest.fn() },
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
      deps.docs,
      deps.contacts,
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

  // Documents must actually be DELIVERED: the result carries the body + missing
  // facts so the reply can show them, and Google export is skipped when offline.
  it('drafts a document, returns body + missing facts, skips Google when offline', async () => {
    deps.documents.draft.mockResolvedValue({ id: 'd1', content: 'BODY', missingFacts: ['client name'] });
    const results = await svc.executePlan({
      sourceMessageId: 'm8',
      plannerOutput: plan(action({ type: 'draft_document', title: 'Meeting Summary', confidence: 0.9 })),
    });
    expect(results[0]).toEqual({
      type: 'document',
      id: 'd1',
      missingFacts: ['client name'],
      content: 'BODY',
      googleDocUrl: null,
    });
    expect(deps.docs.createDocument).not.toHaveBeenCalled();
  });

  it('exports the draft to Google Docs and returns the link when connected', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(true);
    deps.documents.draft.mockResolvedValue({ id: 'd2', content: 'BODY', missingFacts: [] });
    deps.docs.createDocument.mockResolvedValue({
      id: 'gd1',
      url: 'https://docs.google.com/document/d/gd1/edit',
    });
    const result = await svc.runLowRisk(
      action({ type: 'draft_document', title: 'Report', confidence: 0.9 }),
      { sourceMessageId: 'm9', plannerOutput: plan(action({})) },
    );
    expect(deps.docs.createDocument).toHaveBeenCalledWith('Report', 'BODY');
    expect(result).toEqual({
      type: 'document',
      id: 'd2',
      missingFacts: [],
      content: 'BODY',
      googleDocUrl: 'https://docs.google.com/document/d/gd1/edit',
    });
    expect(deps.prisma.documentDraft.update).toHaveBeenCalled();
  });

  // Contact model: an approved email to a NAME resolves from the stored contact
  // first — no live Gmail lookup needed.
  it('resolves an email recipient from a stored contact without hitting Gmail', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(true);
    deps.contacts.findEmail.mockResolvedValue('dana@stored.com');
    deps.gmail.sendEmail.mockResolvedValue('m-1');

    const result = await svc.runLowRisk(
      action({ type: 'send_email', title: 'נושא', description: 'גוף', participants: ['דנה'] }),
      { sourceMessageId: 'm10', plannerOutput: plan(action({})) },
    );

    expect(deps.contacts.findEmail).toHaveBeenCalledWith('דנה');
    expect(deps.gmail.findContactEmail).not.toHaveBeenCalled();
    expect(deps.gmail.sendEmail).toHaveBeenCalledWith({ to: 'dana@stored.com', subject: 'נושא', body: 'גוף' });
    expect(result).toEqual({ type: 'email', sent: true, to: 'dana@stored.com' });
  });

  // --- mutations of existing items ---

  // "סיימתי עם X" → the open task is found by title, marked done locally,
  // completed in Google Tasks, and its open loop is closed.
  it('completes a task by title match, syncs Google, and closes its open loop', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(true);
    deps.prisma.task.findMany.mockResolvedValue([
      { id: 't7', title: 'להתקשר לספק', status: 'open', googleTaskId: 'g7' },
    ]);

    const result = await svc.runLowRisk(
      action({ type: 'complete_task', title: 'להתקשר לספק' }),
      { sourceMessageId: 'm20', plannerOutput: plan(action({})) },
    );

    expect(deps.prisma.task.update).toHaveBeenCalledWith({
      where: { id: 't7' },
      data: { status: 'done' },
    });
    expect(deps.tasks.completeTask).toHaveBeenCalledWith('g7');
    expect(deps.prisma.openLoop.updateMany).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'mutation', op: 'completed', entity: 'task', id: 't7',
      title: 'להתקשר לספק', googleSynced: true,
    });
  });

  // The morning briefing and tasks_list read straight from Google Tasks, so the
  // owner may close a task that has NO Prisma mirror row. It must still complete
  // in Google — the reported bug was "לא מצאתי משימה פתוחה בשם X".
  it('completes a Google-native task (no Prisma row) by title, via Google', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(true);
    deps.prisma.task.findMany.mockResolvedValue([]); // nothing in the internal mirror
    deps.tasks.listOpen.mockResolvedValue([{ id: 'g9', title: 'סיים את האלגוריתם' }]);

    const result = await svc.runLowRisk(
      action({ type: 'complete_task', title: 'סיים את האלגוריתם' }),
      { sourceMessageId: 'm23', plannerOutput: plan(action({})) },
    );

    expect(deps.tasks.completeTask).toHaveBeenCalledWith('g9');
    expect(deps.prisma.task.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'mutation', op: 'completed', entity: 'task', id: 'g9',
      title: 'סיים את האלגוריתם', googleSynced: true,
    });
  });

  // "תזיז את הפגישה" with a targetId from the recent-actions digest → the new
  // start keeps the original duration and the change is patched into Google.
  it('moves a calendar event by targetId, keeping its duration', async () => {
    deps.googleAuth.isAuthorized.mockResolvedValue(true);
    deps.calendar.checkFreeBusy = jest.fn().mockResolvedValue([]);
    deps.prisma.calendarEvent.findUnique.mockResolvedValue({
      id: 'e1',
      title: 'פגישה עם עומרי',
      googleEventId: 'ge1',
      startTime: new Date('2026-06-11T11:00:00Z'),
      endTime: new Date('2026-06-11T11:30:00Z'), // 30-minute meeting
    });

    const result = await svc.runLowRisk(
      action({
        type: 'update_calendar_event',
        title: 'פגישה עם עומרי',
        startTime: '2026-06-11T14:00:00Z',
        toolPayload: { targetId: 'e1' },
      }),
      { sourceMessageId: 'm21', plannerOutput: plan(action({})) },
    );

    expect(deps.prisma.calendarEvent.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: {
        startTime: new Date('2026-06-11T14:00:00Z'),
        endTime: new Date('2026-06-11T14:30:00Z'),
      },
    });
    expect(deps.calendar.updateEvent).toHaveBeenCalledWith('ge1', {
      description: null,
      startTime: '2026-06-11T14:00:00.000Z',
      endTime: '2026-06-11T14:30:00.000Z',
    });
    expect(result).toMatchObject({ type: 'mutation', op: 'updated', entity: 'calendar_event', googleSynced: true });
  });

  // An unknown target never guesses — it becomes a clarification question.
  it('asks which item is meant when a mutation target cannot be found', async () => {
    const result = await svc.runLowRisk(
      action({ type: 'cancel_reminder', title: 'תזכורת שלא קיימת' }),
      { sourceMessageId: 'm22', plannerOutput: plan(action({})) },
    );

    expect(result).toEqual({ type: 'clarification', id: 'c1' });
    expect(deps.clarifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ question: expect.stringContaining('לא מצאתי') }),
    );
    expect(deps.prisma.reminder.update).not.toHaveBeenCalled();
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
