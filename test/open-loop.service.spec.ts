import { OpenLoopService } from '../src/open-loops/open-loop.service';

describe('OpenLoopService close-by-resolution', () => {
  let prisma: any;
  let svc: OpenLoopService;

  beforeEach(() => {
    prisma = {
      openLoop: {
        create: jest.fn().mockResolvedValue({ id: 'l1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    svc = new OpenLoopService(prisma);
  });

  it('closes only the unfinished loops tied to an approval, as done', async () => {
    const closed = await svc.closeByApproval('a1', 'done');
    expect(closed).toBe(2);
    expect(prisma.openLoop.updateMany).toHaveBeenCalledWith({
      where: {
        linkedApprovalId: 'a1',
        status: { in: ['open', 'waiting_for_owner', 'waiting_for_other'] },
      },
      data: { status: 'done' },
    });
  });

  it('closes a rejected approval’s loops as ignored', async () => {
    await svc.closeByApproval('a1', 'ignored');
    expect(prisma.openLoop.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ignored' } }),
    );
  });

  it('closes the loop tied to an answered clarification as done by default', async () => {
    await svc.closeByClarification('c1');
    expect(prisma.openLoop.updateMany).toHaveBeenCalledWith({
      where: {
        linkedClarificationId: 'c1',
        status: { in: ['open', 'waiting_for_owner', 'waiting_for_other'] },
      },
      data: { status: 'done' },
    });
  });
});
