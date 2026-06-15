import { ClarificationService } from '../src/clarifications/clarification.service';

process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.DATABASE_URL = 'postgresql://x';
process.env.WHATSAPP_ACCESS_TOKEN = 'x';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'x';
process.env.WHATSAPP_VERIFY_TOKEN = 'v';

describe('ClarificationService', () => {
  let prisma: any;
  let whatsapp: any;
  let audit: any;
  let openLoops: any;
  let svc: ClarificationService;

  beforeEach(() => {
    prisma = {
      pendingClarification: {
        create: jest.fn().mockResolvedValue({ id: 'c1', question: 'q' }),
        update: jest.fn().mockResolvedValue({ id: 'c1', status: 'answered' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'c1', question: 'q' }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    whatsapp = { sendClarificationQuestion: jest.fn().mockResolvedValue('wamid.q') };
    audit = { success: jest.fn().mockResolvedValue(undefined) };
    openLoops = { closeByClarification: jest.fn().mockResolvedValue(1) };
    svc = new ClarificationService(prisma, whatsapp, audit, openLoops);
  });

  // (5) Pending clarification creation — sends the question and records it
  it('creates a pending clarification and sends the WhatsApp question', async () => {
    await svc.create({
      question: 'עם איזה דני לקבוע?',
      reason: 'ambiguous contact',
      suggestedOptions: ['דני כהן', 'דני לוי'],
    });
    expect(prisma.pendingClarification.create).toHaveBeenCalled();
    expect(whatsapp.sendClarificationQuestion).toHaveBeenCalledWith('972500000000', {
      question: 'עם איזה דני לקבוע?',
      options: ['דני כהן', 'דני לוי'],
    });
    // (20) audit logging
    expect(audit.success).toHaveBeenCalledWith(
      'clarification.created',
      expect.any(Object),
      expect.any(Object),
    );
  });

  // (6) Owner answering clarification by text
  it('marks a clarification answered with the owner text', async () => {
    await svc.markAnswered('c1', 'רמת גן', 'wamid.ans');
    expect(prisma.pendingClarification.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({ status: 'answered', answerText: 'רמת גן' }),
    });
    // The open loop tracking this question is closed so the watcher stops nagging.
    expect(openLoops.closeByClarification).toHaveBeenCalledWith('c1', 'done');
  });

  it('finds the oldest pending clarification to route an answer to', async () => {
    const found = await svc.findOldestPending();
    expect(found).toEqual({ id: 'c1', question: 'q' });
    expect(prisma.pendingClarification.findFirst).toHaveBeenCalledWith({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
  });
});
