import { DailyPlanningService } from '../src/scheduler/daily-planning.service';

process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.OWNER_TIMEZONE = 'Asia/Jerusalem';

// Mon 2026-06-08 10:00 Israel (UTC+3) → inside the active window.
const ACTIVE = new Date('2026-06-08T07:00:00Z');
// Sat 2026-06-13 10:00 Israel → outside the window (weekend).
const QUIET = new Date('2026-06-13T07:00:00Z');

function makeDeps() {
  const prisma = {
    task: { findMany: jest.fn().mockResolvedValue([]) },
    calendarEvent: { findMany: jest.fn().mockResolvedValue([]) },
    openLoop: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({}) },
  };
  const whatsapp = { sendText: jest.fn().mockResolvedValue('wamid.out') };
  const reminders = { dispatchDue: jest.fn() };
  const calendar = { listForDay: jest.fn() };
  const googleAuth = { isAuthorized: jest.fn().mockResolvedValue(false) };
  const tasks = {
    listOpen: jest.fn().mockResolvedValue([]),
    listCompletedSince: jest.fn().mockResolvedValue([]),
  };
  const clarifications = { expireStale: jest.fn().mockResolvedValue({ count: 0 }) };
  const svc = new DailyPlanningService(
    prisma as any,
    whatsapp as any,
    reminders as any,
    calendar as any,
    googleAuth as any,
    tasks as any,
    clarifications as any,
  );
  return { svc, prisma, whatsapp, googleAuth, tasks, clarifications };
}

describe('DailyPlanningService — proactive watchers', () => {
  describe('deadlineRiskScan', () => {
    it('stays silent outside the quiet-hours window', async () => {
      const { svc, tasks, whatsapp } = makeDeps();
      await svc.deadlineRiskScan(QUIET);
      expect(tasks.listOpen).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it('stays silent when nothing is at risk', async () => {
      const { svc, whatsapp } = makeDeps();
      await svc.deadlineRiskScan(ACTIVE);
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it('nudges once, flagging overdue vs upcoming tasks', async () => {
      const { svc, googleAuth, tasks, whatsapp } = makeDeps();
      googleAuth.isAuthorized.mockResolvedValue(true);
      // Google Tasks' `due` carries only a date (YYYY-MM-DD at midnight UTC).
      tasks.listOpen.mockResolvedValue([
        { title: 'להגיש דוח', due: '2026-06-07T00:00:00.000Z' }, // before today → overdue
        { title: 'להתקשר לספק', due: '2026-06-08T00:00:00.000Z' }, // due today → upcoming
      ]);
      await svc.deadlineRiskScan(ACTIVE);
      expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
      const body = whatsapp.sendText.mock.calls[0][1] as string;
      expect(body).toContain('להגיש דוח');
      expect(body).toContain('באיחור');
      expect(body).toContain('להתקשר לספק');
    });
  });

  describe('followUpScan', () => {
    it('stays silent outside the quiet-hours window', async () => {
      const { svc, prisma, whatsapp } = makeDeps();
      await svc.followUpScan(QUIET);
      expect(prisma.openLoop.findMany).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it('nudges about due loops and bumps their nextCheckAt forward', async () => {
      const { svc, prisma, whatsapp } = makeDeps();
      prisma.openLoop.findMany.mockResolvedValue([
        // nextCheckAt already due
        { id: 'l1', title: 'מחכה לתשובה מדנה', nextCheckAt: new Date('2026-06-08T05:00:00Z'), createdAt: ACTIVE },
        // no nextCheckAt, created >2 days ago → due via the default threshold
        { id: 'l2', title: 'אישור מהלקוח', nextCheckAt: null, createdAt: new Date('2026-06-01T07:00:00Z') },
        // no nextCheckAt, created today → NOT due yet
        { id: 'l3', title: 'חדש', nextCheckAt: null, createdAt: ACTIVE },
      ]);
      await svc.followUpScan(ACTIVE);
      const body = whatsapp.sendText.mock.calls[0][1] as string;
      expect(body).toContain('מחכה לתשובה מדנה');
      expect(body).toContain('אישור מהלקוח');
      expect(body).not.toContain('חדש');
      expect(prisma.openLoop.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['l1', 'l2'] } } }),
      );
    });
  });

  describe('reconcileOpenLoops', () => {
    it('does nothing when there are no linked open loops', async () => {
      const { svc, prisma } = makeDeps();
      await svc.reconcileOpenLoops(ACTIVE);
      expect(prisma.openLoop.updateMany).not.toHaveBeenCalled();
    });

    it('closes loops whose linked task is done or calendar event has ended', async () => {
      const { svc, prisma } = makeDeps();
      prisma.openLoop.findMany.mockResolvedValue([
        { id: 'l1', linkedTaskId: 't-done', linkedEventId: null },
        { id: 'l2', linkedTaskId: null, linkedEventId: 'e-past' },
        { id: 'l3', linkedTaskId: 't-open', linkedEventId: null }, // still open → kept
      ]);
      prisma.task.findMany.mockResolvedValue([{ id: 't-done' }]);
      prisma.calendarEvent.findMany.mockResolvedValue([{ id: 'e-past' }]);

      await svc.reconcileOpenLoops(ACTIVE);

      expect(prisma.openLoop.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['l1', 'l2'] } },
        data: { status: 'done' },
      });
    });
  });

  describe('expireClarifications', () => {
    it('delegates to clarifications.expireStale', async () => {
      const { svc, clarifications } = makeDeps();
      await svc.expireClarifications();
      expect(clarifications.expireStale).toHaveBeenCalled();
    });
  });
});
