import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { GoogleAuthService } from '../google/google-auth.service';
import { GoogleCalendarService } from '../google/google-calendar.service';
import { GoogleTasksService } from '../google/google-tasks.service';
import { ClarificationService } from '../clarifications/clarification.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReminderService } from '../reminders/reminder.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { isWithinActiveHours, isWorkday } from './quiet-hours';

/**
 * Scheduled WhatsApp briefings + the per-minute reminder dispatcher. Times are
 * configured via env; the cron expressions below are evaluated in the owner's
 * timezone (Asia/Jerusalem by default).
 */
@Injectable()
export class DailyPlanningService {
  private readonly logger = new AppLogger('DailyPlanning');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly reminders: ReminderService,
    private readonly calendar: GoogleCalendarService,
    private readonly googleAuth: GoogleAuthService,
    private readonly tasks: GoogleTasksService,
    private readonly clarifications: ClarificationService,
  ) {}

  @Cron('30 7 * * *', { timeZone: 'Asia/Jerusalem' })
  async morningPlan(): Promise<void> {
    if (!isWorkday()) return; // quiet-hours gate: no proactive briefings on Fri/Sat
    const lines: string[] = ['בוקר טוב. תכנון להיום:'];

    const meetings = await this.todaysMeetings();
    lines.push(meetings.length ? `פגישות היום:\n${meetings.join('\n')}` : 'אין פגישות היום.');

    // Source of truth = the owner's Google Tasks (same list `tasks_list` reads),
    // NOT the internal Prisma mirror — that mirror never learns about tasks the
    // owner completes directly in the Google Tasks app (sync is one-way), so it
    // accumulates ghost rows and the briefing used to surface tasks that no
    // longer exist.
    const open = await this.openTasks();
    const main = this.sortByDue(open).slice(0, 5);
    if (main.length) lines.push('משימות עיקריות:\n' + main.map((t) => `• ${t.title ?? ''}`).join('\n'));

    const today = this.ymd(new Date());
    const overdue = open.filter((t) => {
      const d = this.dueYmd(t);
      return d !== null && d < today;
    });
    if (overdue.length) lines.push(`באיחור: ${overdue.length} משימות.`);

    const approvals = await this.prisma.approval.count({ where: { status: 'pending' } });
    const clarifications = await this.prisma.pendingClarification.count({ where: { status: 'pending' } });
    if (approvals) lines.push(`ממתינים לאישור: ${approvals}.`);
    if (clarifications) lines.push(`ממתינים להבהרה: ${clarifications}.`);

    // "Open loops" are an INTERNAL tracking mechanism — never surface the raw
    // count to the owner. He found it meaningless ("I don't understand what this
    // is"); the follow-up watcher (followUpScan) already nudges about the real,
    // by-name waiting items, which is the useful half.

    await this.notify(lines.join('\n\n'));
  }

  @Cron('0 13 * * *', { timeZone: 'Asia/Jerusalem' })
  async middayCheckin(): Promise<void> {
    if (!isWorkday()) return; // quiet-hours gate
    // Google Tasks has no priority field, so "pressing" = overdue or due today.
    const today = this.ymd(new Date());
    const pressing = this.sortByDue(
      (await this.openTasks()).filter((t) => {
        const d = this.dueYmd(t);
        return d !== null && d <= today;
      }),
    );
    const lines = ['צ׳ק-אין צהריים. מה הספקת עד עכשיו?'];
    if (pressing.length) lines.push('דחוף להיום:\n' + pressing.map((t) => `• ${t.title ?? ''}`).join('\n'));
    lines.push('האם השתנו סדרי העדיפויות?');
    await this.notify(lines.join('\n\n'));
  }

  @Cron('30 18 * * *', { timeZone: 'Asia/Jerusalem' })
  async endOfDay(): Promise<void> {
    if (!isWorkday()) return; // quiet-hours gate
    const done = await this.completedTodayCount();
    const open = (await this.openTasks()).length;
    const approvals = await this.prisma.approval.count({ where: { status: 'pending' } });
    // No "open loops" count here either — it is internal jargon the owner asked
    // never to see again.
    const lines = [
      'סיכום יום:',
      `הושלמו היום: ${done} משימות.`,
      `נותרו פתוחות: ${open}.`,
      approvals ? `ממתינים לאישור: ${approvals}.` : '',
      'מה לסגור ומה להעביר למחר?',
    ].filter(Boolean);
    await this.notify(lines.join('\n'));
  }

  /**
   * Deadline-risk watcher (spec חלק ד׳ — "שומר דדליינים"). One consolidated daily
   * nudge about tasks that are overdue or due within the next day, so nothing
   * slips. Persistent by design: it re-nudges each working day until the task is
   * closed. Gated by the quiet-hours window (Sun–Thu, working hours).
   */
  @Cron('0 9 * * *', { timeZone: 'Asia/Jerusalem' })
  async deadlineRiskScan(now: Date = new Date()): Promise<void> {
    if (!isWithinActiveHours(now)) return;
    const today = this.ymd(now);
    const tomorrow = this.ymd(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    const atRisk = this.sortByDue(
      (await this.openTasks()).filter((t) => {
        const d = this.dueYmd(t);
        return d !== null && d <= tomorrow;
      }),
    ).slice(0, 10);
    if (!atRisk.length) return;
    const lines = ['⏰ דדליינים שדורשים תשומת לב:'];
    for (const t of atRisk) {
      const d = this.dueYmd(t);
      const overdue = d !== null && d < today;
      const when = d ? this.fmtDate(new Date(d)) : '';
      lines.push(`• ${t.title ?? ''} — ${overdue ? `באיחור (${when})` : `עד ${when}`}`);
    }
    await this.notify(lines.join('\n'));
  }

  /**
   * Follow-up watcher (spec חלק ד׳ — "שומר follow-up"). Nudges about open loops
   * that are waiting on the owner or someone else once their nextCheckAt is due
   * (defaulting to two days after the loop opened). Persistent: it bumps
   * nextCheckAt forward a day so it re-nudges daily — never giving up silently —
   * until the loop is closed. Gated by the quiet-hours window.
   */
  @Cron('0 10 * * *', { timeZone: 'Asia/Jerusalem' })
  async followUpScan(now: Date = new Date()): Promise<void> {
    if (!isWithinActiveHours(now)) return;
    const waiting = await this.prisma.openLoop.findMany({
      where: { status: { in: ['waiting_for_owner', 'waiting_for_other'] } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    const due = waiting.filter((l) => {
      const checkAt = l.nextCheckAt ?? new Date(l.createdAt.getTime() + 2 * 24 * 60 * 60 * 1000);
      return checkAt <= now;
    });
    if (!due.length) return;
    const lines = ['🔁 ממתין למעקב/סגירה:'];
    for (const l of due) lines.push(`• ${l.title}`);
    await this.notify(lines.join('\n'));
    // Bump nextCheckAt so it re-nudges tomorrow (not on every scan) until closed.
    await this.prisma.openLoop.updateMany({
      where: { id: { in: due.map((l) => l.id) } },
      data: { nextCheckAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
    });
  }

  /**
   * Reconcile open loops with reality: close any still-open loop whose linked
   * item is already resolved — a task marked done/cancelled (e.g. completed
   * directly in Google Tasks) or a calendar event that was cancelled or has
   * already ended. Without this, a past meeting or an externally-finished task
   * lingers as an "open loop" forever and keeps inflating the daily count and
   * the follow-up nudges. Internal cleanup — sends no message, so it isn't gated
   * by quiet hours. Runs before the morning plan so its count is accurate.
   */
  @Cron('0 6 * * *', { timeZone: 'Asia/Jerusalem' })
  async reconcileOpenLoops(now: Date = new Date()): Promise<void> {
    const loops = await this.prisma.openLoop.findMany({
      where: {
        status: { in: ['open', 'waiting_for_owner', 'waiting_for_other'] },
        OR: [{ linkedTaskId: { not: null } }, { linkedEventId: { not: null } }],
      },
      select: { id: true, linkedTaskId: true, linkedEventId: true },
    });
    if (!loops.length) return;

    const taskIds = loops.map((l) => l.linkedTaskId).filter((x): x is string => !!x);
    const eventIds = loops.map((l) => l.linkedEventId).filter((x): x is string => !!x);
    const [doneTasks, doneEvents] = await Promise.all([
      taskIds.length
        ? this.prisma.task.findMany({
            where: { id: { in: taskIds }, status: { in: ['done', 'cancelled'] } },
            select: { id: true },
          })
        : Promise.resolve([] as { id: string }[]),
      eventIds.length
        ? this.prisma.calendarEvent.findMany({
            where: { id: { in: eventIds }, OR: [{ status: 'cancelled' }, { endTime: { lt: now } }] },
            select: { id: true },
          })
        : Promise.resolve([] as { id: string }[]),
    ]);

    const resolvedTasks = new Set(doneTasks.map((t) => t.id));
    const resolvedEvents = new Set(doneEvents.map((e) => e.id));
    const toClose = loops
      .filter(
        (l) =>
          (l.linkedTaskId && resolvedTasks.has(l.linkedTaskId)) ||
          (l.linkedEventId && resolvedEvents.has(l.linkedEventId)),
      )
      .map((l) => l.id);
    if (!toClose.length) return;

    const res = await this.prisma.openLoop.updateMany({
      where: { id: { in: toClose } },
      data: { status: 'done' },
    });
    if (res.count) this.logger.log('Reconciled open loops (closed resolved items)', { count: res.count });
  }

  /** Expire stale pending clarifications (default 3-day TTL) so the oldest-pending
   *  matcher never routes a reply to a dead question. Internal cleanup — no
   *  message is sent, so it isn't gated by quiet hours. */
  @Cron('0 2 * * *', { timeZone: 'Asia/Jerusalem' })
  async expireClarifications(): Promise<void> {
    try {
      const res = await this.clarifications.expireStale();
      if (res.count) this.logger.log('Expired stale clarifications', { count: res.count });
    } catch (e) {
      this.logger.warn('Clarification expiry failed', { error: (e as Error).message });
    }
  }

  /** Reminder dispatcher — runs every minute. */
  @Cron(CronExpression.EVERY_MINUTE)
  async dispatchReminders(): Promise<void> {
    try {
      const sent = await this.reminders.dispatchDue();
      if (sent) this.logger.log('Dispatched reminders', { count: sent });
    } catch (e) {
      this.logger.error('Reminder dispatch failed', { error: (e as Error).message });
    }
  }

  /** Send a proactive message to the owner. Centralizes the owner-number lookup
   *  so every briefing and watcher notifies through one place. */
  private notify(body: string): Promise<string | null> {
    return this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, body);
  }

  /** The owner's open Google Tasks (the real to-do list `tasks_list` reads).
   *  Empty if Google isn't connected or the call fails — the briefing simply
   *  omits the section then rather than falling back to the stale Prisma mirror. */
  private async openTasks(): Promise<Array<{ title?: string | null; due?: string | null }>> {
    if (!(await this.googleAuth.isAuthorized())) return [];
    try {
      return await this.tasks.listOpen();
    } catch (e) {
      this.logger.warn('Could not load Google Tasks for briefing', { error: (e as Error).message });
      return [];
    }
  }

  /** How many tasks the owner completed today (for the end-of-day summary). */
  private async completedTodayCount(): Promise<number> {
    if (!(await this.googleAuth.isAuthorized())) return 0;
    try {
      return (await this.tasks.listCompletedSince(this.startOfToday())).length;
    } catch (e) {
      this.logger.warn('Could not load completed tasks for end-of-day', { error: (e as Error).message });
      return 0;
    }
  }

  /** A Google task's due DATE as YYYY-MM-DD (its `due` carries only a date), or
   *  null when it has none. Compared as strings against ymd(...). */
  private dueYmd(t: { due?: string | null }): string | null {
    return t.due ? t.due.slice(0, 10) : null;
  }

  /** A date as YYYY-MM-DD in the owner's timezone (en-CA => ISO ordering). */
  private ymd(d: Date): string {
    return d.toLocaleDateString('en-CA', { timeZone: env().OWNER_TIMEZONE });
  }

  /** Tasks soonest-due first; undated tasks sort last. */
  private sortByDue<T extends { due?: string | null }>(items: T[]): T[] {
    return [...items].sort((a, b) => (a.due ?? '9999-99-99').localeCompare(b.due ?? '9999-99-99'));
  }

  private async todaysMeetings(): Promise<string[]> {
    if (!(await this.googleAuth.isAuthorized())) return [];
    try {
      const events = await this.calendar.listForDay(new Date());
      return events.map((e) => {
        const start = e.start?.dateTime ?? e.start?.date ?? '';
        // Localize a dateTime to a readable HH:mm; all-day events (date only)
        // have no time, so show them as-is.
        const label = e.start?.dateTime ? this.fmtTime(start) : start;
        return `• ${label} ${e.summary ?? ''}`.trim();
      });
    } catch (e) {
      this.logger.warn('Could not load calendar for daily plan', { error: (e as Error).message });
      return [];
    }
  }

  /** Readable local time (HH:mm) in the owner's timezone. */
  private fmtTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString('he-IL', {
      timeZone: env().OWNER_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** Readable local date in the owner's timezone. */
  private fmtDate(d: Date): string {
    return d.toLocaleDateString('he-IL', { timeZone: env().OWNER_TIMEZONE });
  }

  private startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
}
