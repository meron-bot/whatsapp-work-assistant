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

function makeDeps(row: any) {
  const prisma = {
    whatsAppMessage: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({}),
    },
    project: { findMany: jest.fn().mockResolvedValue([]) },
    approval: { findUnique: jest.fn() },
  };
  const whatsapp = { sendText: jest.fn().mockResolvedValue('wamid.out') };
  const media = { ingest: jest.fn() };
  const planner = { plan: jest.fn() };
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
  // (2) Idempotency: already-processed messages are skipped
  it('skips a message already marked processed', async () => {
    const { svc, prisma, planner } = makeDeps(baseRow({ status: 'processed' }));
    await svc.process('wamid.1');
    expect(planner.plan).not.toHaveBeenCalled();
    // No status flip to processing for an already-processed message.
    expect(prisma.whatsAppMessage.update).not.toHaveBeenCalled();
  });

  // (6) Owner answering a clarification by TEXT is routed to the pending item
  it('routes a text answer to the oldest pending clarification (re-plans, does not create a new task blindly)', async () => {
    const d = makeDeps(baseRow({ textContent: 'רמת גן' }));
    d.clarifications.findOldestPending.mockResolvedValue({
      id: 'c1',
      question: 'לאיזה פרויקט לשייך?',
      missingFields: ['project'],
    });
    d.planner.plan.mockResolvedValue({
      summary: 'assign project',
      confidence: 0.9,
      language: 'he',
      isAnswerToPendingClarification: true,
      isAnswerToPendingApproval: false,
      detectedProject: 'רמת גן',
      detectedClient: null,
      missingInformation: [],
      needsClarification: false,
      clarificationQuestion: null,
      actions: [],
      replyToUser: 'שייכתי לפרויקט רמת גן.',
    });

    await d.svc.process('wamid.1');

    expect(d.clarifications.markAnswered).toHaveBeenCalledWith('c1', 'רמת גן', 'row1');
    expect(d.executor.executePlan).toHaveBeenCalled();
    expect(d.whatsapp.sendText).toHaveBeenCalledWith('972500000000', 'שייכתי לפרויקט רמת גן.');
  });

  // (7) Owner answering a clarification by VOICE transcript
  it('routes a voice-note answer (transcript) to the pending clarification', async () => {
    const d = makeDeps(
      baseRow({ messageType: 'audio', textContent: null, mediaId: 'media-1', rawPayload: { audio: { mime_type: 'audio/ogg' } } }),
    );
    d.media.ingest.mockResolvedValue({
      mediaAssetId: 'a1',
      transcript: 'רמת גן',
      transcriptConfidence: 0.9,
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
    d.planner.plan.mockResolvedValue({
      summary: '', confidence: 0.9, language: 'he',
      isAnswerToPendingClarification: true, isAnswerToPendingApproval: false,
      detectedProject: 'רמת גן', detectedClient: null, missingInformation: [],
      needsClarification: false, clarificationQuestion: null, actions: [],
      replyToUser: 'שייכתי לפרויקט רמת גן.',
    });

    await d.svc.process('wamid.1');

    expect(d.media.ingest).toHaveBeenCalled();
    expect(d.clarifications.markAnswered).toHaveBeenCalledWith('c1', 'רמת גן', 'row1');
    expect(d.executor.executePlan).toHaveBeenCalled();
  });

  // (9) Approval by text -> approve + execute the held action
  it('approves and executes a held action when the owner says אשר', async () => {
    const d = makeDeps(baseRow({ textContent: 'אשר' }));
    d.approvals.findOldestPending.mockResolvedValue({ id: 'a1', status: 'pending' });
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

    await d.svc.process('wamid.1');

    expect(d.approvals.markApproved).toHaveBeenCalledWith('a1', 'row1');
    expect(d.executor.runLowRisk).toHaveBeenCalled();
    expect(d.whatsapp.sendText).toHaveBeenCalledWith('972500000000', 'אושר ובוצע.');
  });

  // (10) Ambiguous approval -> ask again, keep pending
  it('asks again on an ambiguous approval response', async () => {
    const d = makeDeps(baseRow({ textContent: 'אולי' }));
    d.approvals.findOldestPending.mockResolvedValue({ id: 'a1', status: 'pending' });
    d.approvals.classifyResponse.mockReturnValue('ambiguous');

    await d.svc.process('wamid.1');

    expect(d.approvals.markApproved).not.toHaveBeenCalled();
    expect(d.approvals.markRejected).not.toHaveBeenCalled();
    expect(d.whatsapp.sendText).toHaveBeenCalledWith(
      '972500000000',
      expect.stringContaining('אשר'),
    );
  });
});
