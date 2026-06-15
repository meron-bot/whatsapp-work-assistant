import { MeetingPrepService } from '../src/scheduler/meeting-prep.service';

process.env.DATABASE_URL = 'postgresql://x';
process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.OWNER_TIMEZONE = 'Asia/Jerusalem';

// Mon 2026-06-08 10:00 Israel (UTC+3) → inside the active window.
const ACTIVE = new Date('2026-06-08T07:00:00Z');
// Sat → outside the window.
const QUIET = new Date('2026-06-13T07:00:00Z');

/** An event starting `minutes` after ACTIVE. */
function event(id: string, minutes: number, overrides: any = {}) {
  return {
    id,
    summary: 'פגישה עם עומרי על אברטו',
    start: { dateTime: new Date(ACTIVE.getTime() + minutes * 60_000).toISOString() },
    ...overrides,
  };
}

function makeDeps() {
  const prisma = {
    agentMemory: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    task: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const whatsapp = { sendText: jest.fn().mockResolvedValue('wamid.out') };
  const calendar = { listUpcoming: jest.fn().mockResolvedValue([]) };
  const gmail = { search: jest.fn().mockResolvedValue([]) };
  const googleAuth = { isAuthorized: jest.fn().mockResolvedValue(true) };
  const svc = new MeetingPrepService(
    prisma as any,
    whatsapp as any,
    calendar as any,
    gmail as any,
    googleAuth as any,
  );
  return { svc, prisma, whatsapp, calendar, gmail, googleAuth };
}

describe('MeetingPrepService', () => {
  it('stays silent outside the active window', async () => {
    const { svc, calendar, whatsapp } = makeDeps();
    await svc.scan(QUIET);
    expect(calendar.listUpcoming).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('does nothing when Google is not connected', async () => {
    const { svc, calendar, googleAuth } = makeDeps();
    googleAuth.isAuthorized.mockResolvedValue(false);
    await svc.scan(ACTIVE);
    expect(calendar.listUpcoming).not.toHaveBeenCalled();
  });

  it('briefs an upcoming meeting with attendee mail context and related tasks', async () => {
    const { svc, calendar, gmail, prisma, whatsapp } = makeDeps();
    calendar.listUpcoming.mockResolvedValue([
      event('ev1', 30, {
        attendees: [
          { email: 'me@x.com', self: true },
          { email: 'omri@client.com', displayName: 'עומרי' },
        ],
        hangoutLink: 'https://meet.google.com/abc',
      }),
    ]);
    gmail.search.mockResolvedValue([
      { id: 'g1', from: 'עומרי <omri@client.com>', to: 'me@x.com', subject: 'הצעת מחיר', snippet: 'מחכה לגרסה המעודכנת', date: '' },
    ]);
    prisma.task.findMany.mockResolvedValue([
      { title: 'לסיים הצעת מחיר לאברטו', status: 'open' },
      { title: 'משהו לא קשור בכלל', status: 'open' },
    ]);

    await svc.scan(ACTIVE);

    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    const body = whatsapp.sendText.mock.calls[0][1] as string;
    expect(body).toContain('עוד 30 דק׳');
    expect(body).toContain('פגישה עם עומרי');
    expect(body).toContain('עומרי');
    expect(body).toContain('הצעת מחיר');
    expect(body).toContain('לסיים הצעת מחיר לאברטו');
    expect(body).not.toContain('משהו לא קשור בכלל');
    expect(body).toContain('https://meet.google.com/abc');
    // The event id is remembered so the brief fires exactly once.
    expect(prisma.agentMemory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ value: { ids: ['ev1'] } }),
      }),
    );
  });

  it('skips events already briefed and events outside the lead window', async () => {
    const { svc, calendar, prisma, whatsapp } = makeDeps();
    prisma.agentMemory.findUnique.mockResolvedValue({ value: { ids: ['ev-done'] } });
    calendar.listUpcoming.mockResolvedValue([
      event('ev-done', 30), // already briefed
      event('ev-far', 120), // too far ahead
      event('ev-now', 2), // already starting — too late to prep
      { id: 'ev-allday', summary: 'יום עיון', start: { date: '2026-06-08' } }, // all-day
    ]);

    await svc.scan(ACTIVE);

    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(prisma.agentMemory.upsert).not.toHaveBeenCalled();
  });
});
