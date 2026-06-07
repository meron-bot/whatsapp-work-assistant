import { MessageProcessorService } from '../src/processing/message-processor.service';

process.env.DATABASE_URL = 'postgresql://x';
process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.OWNER_TIMEZONE = 'Asia/Jerusalem';

function baseRow(overrides: any = {}) {
  return {
    id: 'row1',
    whatsappMessageId: 'wamid.1',
    fromNumber: '972500000000',
    toNumber: '972511111111',
    messageType: 'text',
    rawPayload: {},
    textContent: 'רמת גן',
    mediaId: null,
    receivedAt: new Date(),
    status: 'queued',
    ...overrides,
  };
}

function emptyPlan(overrides: any = {}) {
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
    actions: [],
    replyToUser: '',
    ...overrides,
  };
}

function makeDeps(row: any, claimCount = 1) {
  const prisma = {
    whatsAppMessage: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
      update: jest.fn().mockResolvedValue({}),
    },
    project: { findMany: jest.fn().mockResolvedValue([]) },
    approval: { findUnique: jest.fn() },
  };
  const whatsapp = { sendText: jest.fn().mockResolvedValue('wamid.out') };
  const media = { ingest: jest.fn() };
  const planner = { plan: jest.fn().mockResolvedValue(emptyPlan()) };
  const executor = { executePlan: jest.fn().mockResolvedValue([]), runLowRisk: jest.fn() };
  const clarifications = {
    findOldestPending: jest.fn().mockResolvedValue(null),
    markAnswered: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({ id: 'c2' }),
  };
  const approvals = {
    findOldestPending: jest.fn().mockResolvedValue(null),
    classifyResponse: jest.fn(),
    markApproved: jest.fn(),
    markRejected: jest.fn(),
  };
  const audit = { success: jest.fn().mockResolvedValue(undefined) };
  const svc = new MessageProcessorService(
    prisma as any,
    whatsapp as any,
    media as any,
    planner as any,
    executor as any,
    clarifications as any,
    approvals as any,
    audit as any,
  );
  return { svc, prisma, whatsapp, media, planner, executor, clarifications, approvals, audit };
}

describe('MessageProcessorService', () => {
  // (2) Idempotency: an already-claimed/processed message is skipped (CAS count=0)
  it('skips when the message is already claimed (atomic CAS returns 0)', async () => {
    const { svc, prisma, planner } = makeDeps(baseRow({ status: 'processed' }), 0);
    await svc.process('wamid.1');
    expect(prisma.whatsAppMessage.updateMany).toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
  });

  // (6) Owner answering a clarification by TEXT is routed to the pending item
  it('routes a text answer to the oldest pending clarification', async () => {
    const d = makeDeps(baseRow({ textContent: 'רמת גן' }));
    d.clarifications.findOldestPending.mockResolvedValue({
      id: 'c1',
      question: 'לאיזה פרויקט לשייך?',
      missingFields: ['project'],
    });
    d.planner.plan.mockResolvedValue(
      emptyPlan({ isAnswerToPendingClarification: true, replyToUser: 'שייכתי לפרויקט רמת גן.' }),
    );

    await d.svc.process('wamid.1');

    expect(d.clarifications.markAnswered).toHaveBeenCalledWith('c1', 'רמת גן', 'row1');
    expect(d.executor.executePlan).toHaveBeenCalled();
    expect(d.whatsapp.sendText).toHaveBeenCalledWith('972500000000', 'שייכתי לפרויקט רמת גן.');
  });

  // (7) Owner answering a clarification by VOICE transcript (reliable)
  it('routes a reliable voice-note transcript to the pending clarification', async () => {
    const d = makeDeps(
      baseRow({ messageType: 'audio', textContent: null, mediaId: 'media-1', rawPayload: { audio: { mime_type: 'audio/ogg' } } }),
    );
    d.media.ingest.mockResolvedValue({
      mediaAssetId: 'a1',
      transcript: 'רמת גן',
      transcriptConfidence: 0.9,
      transcriptReliable: true,
      extractedText: null,
      aiSummary: null,
      classification: null,
      degradedNote: null,
    });
    d.clarifications.findOldestPending.mockResolvedValue({
      id: 'c1',
      question: 'לאיזה פרויקט?',
      missingFields: ['project'],
    });
    d.planner.plan.mockResolvedValue(
      emptyPlan({ isAnswerToPendingClarification: true, replyToUser: 'שייכתי.' }),
    );

    await d.svc.process('wamid.1');

    expect(d.media.ingest).toHaveBeenCalled();
    expect(d.clarifications.markAnswered).toHaveBeenCalledWith('c1', 'רמת גן', 'row1');
    expect(d.executor.executePlan).toHaveBeenCalled();
  });

  // Anti-hallucination: an UNRELIABLE transcript is not acted on
  it('does not plan on an unreliable (low-confidence) transcript', async () => {
    const d = makeDeps(
      baseRow({ messageType: 'audio', textContent: null, mediaId: 'm2', rawPayload: { audio: { mime_type: 'audio/ogg' } } }),
    );
    d.media.ingest.mockResolvedValue({
      mediaAssetId: 'a2',
      transcript: 'אולי משהו',
      transcriptConfidence: 0.2,
      transcriptReliable: false,
      extractedText: null,
      aiSummary: null,
      classification: null,
      degradedNote: 'שמעתי בערך: "אולי משהו". לא בטוח שהבנתי נכון.',
    });

    await d.svc.process('wamid.1');

    expect(d.whatsapp.sendText).toHaveBeenCalledWith('972500000000', expect.stringContaining('שמעתי בערך'));
    expect(d.planner.plan).not.toHaveBeenCalled(); // no content to act on
  });

  // (9) Approval by text -> approve + execute the held action, truthful reply
  it('approves and executes a held action when the owner says אשר', async () => {
    const d = makeDeps(baseRow({ textContent: 'אשר' }));
    d.approvals.findOldestPending.mockResolvedValue({ id: 'a1', description: 'send email', status: 'pending' });
    d.approvals.classifyResponse.mockReturnValue('approved');
    d.prisma.approval.findUnique.mockResolvedValue({
      id: 'a1',
      sourceMessageId: 'row0',
      proposedPayload: {
        action: {
          type: 'create_task', title: 'send email', description: null, confidence: 0.9,
          priority: 'medium', dueDate: null, startTime: null, endTime: null, participants: [],
          project: null, client: null, requiresApproval: true, approvalReason: 'external',
          missingFields: [], toolPayload: {},
        },
      },
    });
    d.executor.runLowRisk.mockResolvedValue({ type: 'task', id: 't9' });

    await d.svc.process('wamid.1');

    expect(d.approvals.markApproved).toHaveBeenCalledWith('a1', 'row1');
    expect(d.executor.runLowRisk).toHaveBeenCalled();
    expect(d.whatsapp.sendText).toHaveBeenCalledWith('972500000000', expect.stringContaining('אושר'));
  });

  // (11) Rejection by text
  it('rejects and does not execute when the owner says בטל', async () => {
    const d = makeDeps(baseRow({ textContent: 'בטל' }));
    d.approvals.findOldestPending.mockResolvedValue({ id: 'a1', description: 'send email', status: 'pending' });
    d.approvals.classifyResponse.mockReturnValue('rejected');

    await d.svc.process('wamid.1');

    expect(d.approvals.markRejected).toHaveBeenCalledWith('a1', 'row1');
    expect(d.executor.runLowRisk).not.toHaveBeenCalled();
    expect(d.whatsapp.sendText).toHaveBeenCalledWith('972500000000', expect.stringContaining('בוטל'));
  });

  // (10) Ambiguous response the planner thinks IS about the approval -> ask again
  it('asks again on an ambiguous approval response', async () => {
    const d = makeDeps(baseRow({ textContent: 'אולי' }));
    d.approvals.findOldestPending.mockResolvedValue({ id: 'a1', description: 'send email', status: 'pending' });
    d.approvals.classifyResponse.mockReturnValue('ambiguous');
    d.planner.plan.mockResolvedValue(emptyPlan({ isAnswerToPendingApproval: true }));

    await d.svc.process('wamid.1');

    expect(d.approvals.markApproved).not.toHaveBeenCalled();
    expect(d.approvals.markRejected).not.toHaveBeenCalled();
    expect(d.whatsapp.sendText).toHaveBeenCalledWith('972500000000', expect.stringContaining('אשר'));
  });

  // (B2) A NEW request that arrives while an approval is pending is NOT dropped
  it('processes a new request during a pending approval instead of dropping it', async () => {
    const d = makeDeps(baseRow({ textContent: 'תזכיר לי מחר להתקשר לרופא' }));
    d.approvals.findOldestPending.mockResolvedValue({ id: 'a1', description: 'send email', status: 'pending' });
    d.approvals.classifyResponse.mockReturnValue('ambiguous');
    // planner says this is NOT an answer to the approval -> treat as fresh request
    d.planner.plan.mockResolvedValue(
      emptyPlan({ isAnswerToPendingApproval: false, replyToUser: 'קבעתי תזכורת.' }),
    );

    await d.svc.process('wamid.1');

    // approval stays pending; the new request is executed and acknowledged
    expect(d.approvals.markApproved).not.toHaveBeenCalled();
    expect(d.executor.executePlan).toHaveBeenCalled();
    expect(d.whatsapp.sendText).toHaveBeenCalledWith('972500000000', 'קבעתי תזכורת.');
  });

  // (B5) When the planner's action is gated to approval/clarification, the
  // optimistic "done" reply is suppressed (no contradicting message)
  it('suppresses the planner reply when an action was gated to approval', async () => {
    const d = makeDeps(baseRow({ textContent: 'שלח מייל ללקוח' }));
    d.planner.plan.mockResolvedValue(emptyPlan({ replyToUser: 'שלחתי את המייל.' }));
    d.executor.executePlan.mockResolvedValue([{ type: 'approval', id: 'a1' }]);

    await d.svc.process('wamid.1');

    expect(d.whatsapp.sendText).not.toHaveBeenCalledWith('972500000000', 'שלחתי את המייל.');
  });
});
