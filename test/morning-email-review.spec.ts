import { MorningEmailReviewService } from '../src/scheduler/morning-email-review.service';

process.env.DATABASE_URL = 'postgresql://x';
process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.OWNER_TIMEZONE = 'Asia/Jerusalem';
process.env.MORNING_EMAIL_REVIEW_ENABLED = 'true';

// Mon 2026-06-08 08:00 Israel (UTC+3) → a work-day morning.
const WORKDAY = new Date('2026-06-08T05:00:00Z');
// Sat 2026-06-13 08:00 Israel → weekend (off).
const WEEKEND = new Date('2026-06-13T05:00:00Z');

function hit(id: string, from: string, subject: string, body = '') {
  return { id, from, to: 'me@x.com', subject, snippet: body.slice(0, 80), date: '', body };
}

function makeDeps() {
  const whatsapp = { sendText: jest.fn().mockResolvedValue('wamid.out') };
  const gmail = { searchDetailed: jest.fn().mockResolvedValue([]) };
  const googleAuth = { isAuthorized: jest.fn().mockResolvedValue(true) };
  const ai = { complete: jest.fn() };
  const svc = new MorningEmailReviewService(
    whatsapp as any,
    gmail as any,
    googleAuth as any,
    ai as any,
  );
  return { svc, whatsapp, gmail, googleAuth, ai };
}

describe('MorningEmailReviewService', () => {
  it('stays silent on the weekend', async () => {
    const { svc, gmail, whatsapp } = makeDeps();
    await svc.review(WEEKEND);
    expect(gmail.searchDetailed).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('does nothing when Google is not connected', async () => {
    const { svc, gmail, googleAuth } = makeDeps();
    googleAuth.isAuthorized.mockResolvedValue(false);
    await svc.review(WORKDAY);
    expect(gmail.searchDetailed).not.toHaveBeenCalled();
  });

  it('scans exactly yesterday and stays silent when the inbox was empty', async () => {
    const { svc, gmail, ai, whatsapp } = makeDeps();
    await svc.review(WORKDAY);
    // Yesterday = Sun 2026-06-07, today = Mon 2026-06-08 (owner timezone).
    expect(gmail.searchDetailed).toHaveBeenCalledWith(
      'in:inbox category:primary after:2026/06/07 before:2026/06/08',
      expect.any(Number),
    );
    expect(ai.complete).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('sends ONE numbered list of tasks + events for the owner to approve', async () => {
    const { svc, gmail, ai, whatsapp } = makeDeps();
    gmail.searchDetailed.mockResolvedValue([
      hit('m1', 'אשר קופר <asher@avertto.com>', 'פרוטוקול', 'צריך שתאשר את הפרוטוקול'),
      hit('m2', 'דנה לוי <dana@x.com>', 'פגישה', 'נקבע ל-11.6 בעשר'),
    ]);
    ai.complete.mockResolvedValue(
      JSON.stringify({
        tasks: [{ title: 'לאשר לאשר את הפרוטוקול', due: null, from: 'אשר קופר' }],
        events: [{ title: 'פגישה עם דנה', when: '2026-06-11T10:00:00+03:00', from: 'דנה לוי' }],
      }),
    );

    await svc.review(WORKDAY);

    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    const body = whatsapp.sendText.mock.calls[0][1] as string;
    expect(body).toContain('המיילים של אתמול');
    // Continuous numbering across both sections.
    expect(body).toContain('1. לאשר לאשר את הפרוטוקול');
    expect(body).toContain('2. פגישה עם דנה');
    expect(body).toContain('אשר קופר');
    expect(body).toContain('דנה לוי');
    expect(body).toContain('הכל'); // the approve instruction
  });

  it('stays silent when nothing actionable was found', async () => {
    const { svc, gmail, ai, whatsapp } = makeDeps();
    gmail.searchDetailed.mockResolvedValue([hit('m9', 'shop@spam.com', 'SALE', 'buy now')]);
    ai.complete.mockResolvedValue(JSON.stringify({ tasks: [], events: [] }));

    await svc.review(WORKDAY);

    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('stays silent (no crash) when the model returns junk', async () => {
    const { svc, gmail, ai, whatsapp } = makeDeps();
    gmail.searchDetailed.mockResolvedValue([hit('m5', 'client@x.com', 'urgent', 'please reply')]);
    ai.complete.mockResolvedValue('not json at all');

    await svc.review(WORKDAY);

    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });
});
