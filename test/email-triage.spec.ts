import { EmailTriageService } from '../src/scheduler/email-triage.service';

process.env.DATABASE_URL = 'postgresql://x';
process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.OWNER_TIMEZONE = 'Asia/Jerusalem';

// Mon 2026-06-08 10:00 Israel (UTC+3) → inside the active window.
const ACTIVE = new Date('2026-06-08T07:00:00Z');
// Sat 2026-06-13 10:00 Israel → outside the window (weekend).
const QUIET = new Date('2026-06-13T07:00:00Z');

function hit(id: string, from: string, subject: string, snippet = '') {
  return { id, from, to: 'me@x.com', subject, snippet, date: '' };
}

function makeDeps() {
  const prisma = {
    agentMemory: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const whatsapp = { sendText: jest.fn().mockResolvedValue('wamid.out') };
  const gmail = { search: jest.fn().mockResolvedValue([]) };
  const googleAuth = { isAuthorized: jest.fn().mockResolvedValue(true) };
  const ai = { complete: jest.fn() };
  const svc = new EmailTriageService(
    prisma as any,
    whatsapp as any,
    gmail as any,
    googleAuth as any,
    ai as any,
  );
  return { svc, prisma, whatsapp, gmail, googleAuth, ai };
}

describe('EmailTriageService', () => {
  it('stays silent outside the active window', async () => {
    const { svc, gmail, whatsapp } = makeDeps();
    await svc.scan(QUIET);
    expect(gmail.search).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('does nothing when Google is not connected', async () => {
    const { svc, gmail, googleAuth } = makeDeps();
    googleAuth.isAuthorized.mockResolvedValue(false);
    await svc.scan(ACTIVE);
    expect(gmail.search).not.toHaveBeenCalled();
  });

  it('notifies about an important email and remembers its id', async () => {
    const { svc, gmail, ai, whatsapp, prisma } = makeDeps();
    gmail.search.mockResolvedValue([
      hit('m1', 'אשר קופר <asher@avertto.com>', 'אישור פרוטוקול', 'צריך את האישור שלך עד מחר'),
      hit('m2', 'Newsletter <no-reply@spam.com>', 'Weekly deals!'),
    ]);
    ai.complete.mockResolvedValue(
      JSON.stringify({
        verdicts: [
          { index: 0, important: true, summary: 'אשר מבקש אישור על הפרוטוקול עד מחר' },
          { index: 1, important: false, summary: 'ניוזלטר' },
        ],
      }),
    );

    await svc.scan(ACTIVE);

    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    const body = whatsapp.sendText.mock.calls[0][1] as string;
    expect(body).toContain('אשר קופר');
    expect(body).toContain('אשר מבקש אישור על הפרוטוקול עד מחר');
    expect(body).not.toContain('Weekly deals');
    // Both ids are remembered so neither is re-classified next scan.
    expect(prisma.agentMemory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ value: { ids: ['m1', 'm2'] } }),
      }),
    );
  });

  it('skips messages already triaged and stays silent when nothing is new', async () => {
    const { svc, gmail, ai, whatsapp, prisma } = makeDeps();
    prisma.agentMemory.findUnique.mockResolvedValue({ value: { ids: ['m1'] } });
    gmail.search.mockResolvedValue([hit('m1', 'a@x.com', 'old')]);

    await svc.scan(ACTIVE);

    expect(ai.complete).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('stays silent when nothing is important (but still remembers the ids)', async () => {
    const { svc, gmail, ai, whatsapp, prisma } = makeDeps();
    gmail.search.mockResolvedValue([hit('m9', 'shop@spam.com', 'SALE')]);
    ai.complete.mockResolvedValue(
      JSON.stringify({ verdicts: [{ index: 0, important: false, summary: 'פרסומת' }] }),
    );

    await svc.scan(ACTIVE);

    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(prisma.agentMemory.upsert).toHaveBeenCalled();
  });

  it('does not mark messages as seen when classification fails (retried next scan)', async () => {
    const { svc, gmail, ai, whatsapp, prisma } = makeDeps();
    gmail.search.mockResolvedValue([hit('m5', 'client@x.com', 'urgent')]);
    ai.complete.mockResolvedValue('not json at all');

    await svc.scan(ACTIVE);

    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(prisma.agentMemory.upsert).not.toHaveBeenCalled();
  });
});
