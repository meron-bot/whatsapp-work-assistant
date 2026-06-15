import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { calendar_v3 } from 'googleapis';
import { env } from '../config/env';
import { GoogleAuthService } from '../google/google-auth.service';
import { GoogleCalendarService } from '../google/google-calendar.service';
import { GoogleGmailService } from '../google/google-gmail.service';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { isWithinActiveHours } from './quiet-hours';

/** AgentMemory key holding the Google event ids already briefed. */
const NOTIFIED_KEY = 'meetingPrep.notifiedIds';
const MAX_REMEMBERED = 100;

/** Brief for events starting in (5, 35] minutes: early enough to prepare, and
 *  together with the 10-minute cron + the id dedup each event fires once. */
const MIN_LEAD_MS = 5 * 60_000;
const MAX_LEAD_MS = 35 * 60_000;

/** Hebrew/English noise words that don't identify a meeting's topic. */
const STOP_WORDS = new Set(['פגישה', 'שיחה', 'עם', 'של', 'על', 'meeting', 'call', 'with', 'sync']);

/**
 * The meeting-prep sub-agent: shortly before each calendar event it pushes a
 * WhatsApp brief — who is coming, the latest mail exchanged with them, open
 * tasks that look related, and the Meet link — so the owner walks in prepared
 * instead of scrambling. Assembled deterministically (no AI call): cheap,
 * fast, and nothing to hallucinate.
 *
 * Every failure path is silent-but-logged; a prep hiccup never pages the owner.
 */
@Injectable()
export class MeetingPrepService {
  private readonly logger = new AppLogger('MeetingPrep');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly calendar: GoogleCalendarService,
    private readonly gmail: GoogleGmailService,
    private readonly googleAuth: GoogleAuthService,
  ) {}

  @Cron('*/10 * * * *', { timeZone: 'Asia/Jerusalem' })
  async scheduledScan(): Promise<void> {
    await this.scan(new Date());
  }

  async scan(now: Date): Promise<void> {
    if (!env().MEETING_PREP_ENABLED) return;
    if (!isWithinActiveHours(now)) return; // quiet-hours gate
    if (!(await this.googleAuth.isAuthorized())) return;

    let events: calendar_v3.Schema$Event[];
    try {
      events = await this.calendar.listUpcoming(10);
    } catch (e) {
      this.logger.warn('Upcoming-events lookup failed', { error: (e as Error).message });
      return;
    }

    const seen = await this.loadNotified();
    const upcoming = events.filter((e) => {
      if (!e.id || seen.includes(e.id)) return false;
      const startStr = e.start?.dateTime; // all-day events (date only) get no prep
      if (!startStr) return false;
      const lead = new Date(startStr).getTime() - now.getTime();
      return lead > MIN_LEAD_MS && lead <= MAX_LEAD_MS;
    });
    if (!upcoming.length) return;

    await this.saveNotified([...seen, ...upcoming.map((e) => e.id as string)]);
    for (const event of upcoming) {
      await this.sendBrief(event, now);
    }
  }

  private async sendBrief(event: calendar_v3.Schema$Event, now: Date): Promise<void> {
    const start = new Date(event.start!.dateTime!);
    const minutes = Math.round((start.getTime() - now.getTime()) / 60_000);
    const title = event.summary ?? '(ללא כותרת)';
    const lines = [`🗓️ עוד ${minutes} דק׳: ${title} (${this.fmtTime(start)})`];

    const others = (event.attendees ?? []).filter((a) => !a.self && a.email);
    if (others.length) {
      lines.push(`משתתפים: ${others.map((a) => a.displayName || a.email).join(', ')}`);
    }

    // The latest mail exchanged with up to two attendees — the "what's the
    // state with them" part of the brief. Best-effort per attendee.
    for (const a of others.slice(0, 2)) {
      try {
        const hits = await this.gmail.search(`from:${a.email} OR to:${a.email}`, 2);
        if (hits.length) {
          const who = a.displayName || a.email;
          lines.push(`✉️ אחרון עם ${who}: "${hits[0].subject}" — ${hits[0].snippet.slice(0, 120)}`);
        }
      } catch (e) {
        this.logger.warn('Attendee mail lookup failed', { error: (e as Error).message });
      }
    }

    // Open tasks whose title shares a meaningful word with the meeting title.
    try {
      const open = await this.prisma.task.findMany({
        where: { status: { in: ['open', 'in_progress', 'waiting'] } },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });
      const words = (title.match(/[\p{L}\d]{3,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w.toLowerCase()));
      const related = open.filter((t) => words.some((w) => t.title.includes(w))).slice(0, 3);
      if (related.length) {
        lines.push('משימות פתוחות קשורות:');
        for (const t of related) lines.push(`• ${t.title}`);
      }
    } catch (e) {
      this.logger.warn('Related-tasks lookup failed', { error: (e as Error).message });
    }

    if (event.hangoutLink) lines.push(`🔗 ${event.hangoutLink}`);
    if (event.location) lines.push(`📍 ${event.location}`);

    await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, lines.join('\n'));
  }

  private fmtTime(d: Date): string {
    return d.toLocaleTimeString('he-IL', {
      timeZone: env().OWNER_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private async loadNotified(): Promise<string[]> {
    const row = await this.prisma.agentMemory.findUnique({ where: { key: NOTIFIED_KEY } });
    const ids = (row?.value as { ids?: unknown })?.ids;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  }

  private async saveNotified(ids: string[]): Promise<void> {
    const value = { ids: ids.slice(-MAX_REMEMBERED) };
    await this.prisma.agentMemory.upsert({
      where: { key: NOTIFIED_KEY },
      create: { key: NOTIFIED_KEY, value, source: 'meeting-prep' },
      update: { value },
    });
  }
}
