import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { GoogleAuthService } from '../google/google-auth.service';
import { GoogleCalendarService } from '../google/google-calendar.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReminderService } from '../reminders/reminder.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

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
  ) {}

  @Cron('30 7 * * *', { timeZone: 'Asia/Jerusalem' })
  async morningPlan(): Promise<void> {
    const lines: string[] = ['בוקר טוב. תכנון להיום:'];

    const meetings = await this.todaysMeetings();
    lines.push(meetings.length ? `פגישות היום:\n${meetings.join('\n')}` : 'אין פגישות היום.');

    const tasks = await this.prisma.task.findMany({
      where: { status: { in: ['open', 'in_progress'] } },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      take: 5,
    });
    if (tasks.length) lines.push('משימות עיקריות:\n' + tasks.map((t) => `• ${t.title}`).join('\n'));

    const overdue = await this.prisma.task.findMany({
      where: { status: { in: ['open', 'in_progress'] }, dueDate: { lt: new Date() } },
    });
    if (overdue.length) lines.push(`באיחור: ${overdue.length} משימות.`);

    const approvals = await this.prisma.approval.count({ where: { status: 'pending' } });
    const clarifications = await this.prisma.pendingClarification.count({ where: { status: 'pending' } });
    if (approvals) lines.push(`ממתינים לאישור: ${approvals}.`);
    if (clarifications) lines.push(`ממתינים להבהרה: ${clarifications}.`);

    const loops = await this.prisma.openLoop.count({
      where: { status: { in: ['open', 'waiting_for_owner', 'waiting_for_other'] } },
    });
    if (loops) lines.push(`לולאות פתוחות: ${loops}.`);

    await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, lines.join('\n\n'));
  }

  @Cron('0 13 * * *', { timeZone: 'Asia/Jerusalem' })
  async middayCheckin(): Promise<void> {
    const urgent = await this.prisma.task.findMany({
      where: { status: { in: ['open', 'in_progress'] }, priority: 'urgent' },
    });
    const lines = ['צ׳ק-אין צהריים. מה הספקת עד עכשיו?'];
    if (urgent.length) lines.push('דחוף ופתוח:\n' + urgent.map((t) => `• ${t.title}`).join('\n'));
    lines.push('האם השתנו סדרי העדיפויות?');
    await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, lines.join('\n\n'));
  }

  @Cron('30 18 * * *', { timeZone: 'Asia/Jerusalem' })
  async endOfDay(): Promise<void> {
    const done = await this.prisma.task.count({
      where: { status: 'done', updatedAt: { gte: this.startOfToday() } },
    });
    const open = await this.prisma.task.count({ where: { status: { in: ['open', 'in_progress'] } } });
    const approvals = await this.prisma.approval.count({ where: { status: 'pending' } });
    const loops = await this.prisma.openLoop.count({
      where: { status: { in: ['open', 'waiting_for_owner', 'waiting_for_other'] } },
    });
    const lines = [
      'סיכום יום:',
      `הושלמו היום: ${done} משימות.`,
      `נותרו פתוחות: ${open}.`,
      approvals ? `ממתינים לאישור: ${approvals}.` : '',
      loops ? `לולאות פתוחות: ${loops}.` : '',
      'מה לסגור ומה להעביר למחר?',
    ].filter(Boolean);
    await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, lines.join('\n'));
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

  private async todaysMeetings(): Promise<string[]> {
    if (!(await this.googleAuth.isAuthorized())) return [];
    try {
      const events = await this.calendar.listForDay(new Date());
      return events.map((e) => {
        const start = e.start?.dateTime ?? e.start?.date ?? '';
        return `• ${start} ${e.summary ?? ''}`.trim();
      });
    } catch (e) {
      this.logger.warn('Could not load calendar for daily plan', { error: (e as Error).message });
      return [];
    }
  }

  private startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
}
