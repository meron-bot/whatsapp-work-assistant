import { ApprovalService } from '../src/approvals/approval.service';

process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.DATABASE_URL = 'postgresql://x';
process.env.WHATSAPP_ACCESS_TOKEN = 'x';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'x';
process.env.WHATSAPP_VERIFY_TOKEN = 'v';

describe('ApprovalService lifecycle', () => {
  let prisma: any;
  let whatsapp: any;
  let audit: any;
  let svc: ApprovalService;

  beforeEach(() => {
    prisma = {
      approval: {
        create: jest.fn().mockResolvedValue({ id: 'a1' }),
        update: jest.fn().mockResolvedValue({ id: 'a1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'a1', status: 'pending' }),
      },
    };
    whatsapp = { sendApprovalRequest: jest.fn().mockResolvedValue('wamid.appr') };
    audit = { success: jest.fn().mockResolvedValue(undefined) };
    svc = new ApprovalService(prisma, whatsapp, audit);
  });

  // (8) Pending approval creation
  it('creates a pending approval and sends the approval request', async () => {
    await svc.create({
      actionType: 'send_email',
      description: 'Send proposal to Avi',
      riskLevel: 'high',
      proposedPayload: { to: 'avi@example.com' },
      view: {
        actionType: 'send_email',
        description: 'שליחת מייל לאבי כהן',
        recipient: 'avi@example.com',
        riskReason: 'external email',
      },
    });
    expect(prisma.approval.create).toHaveBeenCalled();
    expect(whatsapp.sendApprovalRequest).toHaveBeenCalled();
    expect(audit.success).toHaveBeenCalledWith(
      'approval.created',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('marks approvals approved/rejected and audits them', async () => {
    await svc.markApproved('a1', 'wamid.yes');
    expect(prisma.approval.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: expect.objectContaining({ status: 'approved' }),
    });
    await svc.markRejected('a1', 'wamid.no');
    expect(prisma.approval.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: expect.objectContaining({ status: 'rejected' }),
    });
  });
});
