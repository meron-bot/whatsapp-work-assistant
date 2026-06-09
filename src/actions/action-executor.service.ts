import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AppLogger } from '../logger/logger.service';
import { ApprovalService } from '../approvals/approval.service';
import { ClarificationService } from '../clarifications/clarification.service';
import { DocumentAgentService, DocumentType } from '../documents/document-agent.service';
import { GoogleTasksService } from '../google/google-tasks.service';
import { GoogleCalendarService } from '../google/google-calendar.service';
import { GoogleAuthService } from '../google/google-auth.service';
import { GoogleGmailService } from '../google/google-gmail.service';
import { GoogleDocsService } from '../google/google-docs.service';
import { ContactService } from '../contacts/contact.service';
import { OpenLoopService } from '../open-loops/open-loop.service';
import { PlannerAction, PlannerOutput } from '../planner/planner.schema';
import { PrismaService } from '../prisma/prisma.service';
import { ReminderService } from '../reminders/reminder.service';
import { decideAction } from './action-policy';

export interface ExecuteContext {
  sourceMessageId: string;
  plannerOutput: PlannerOutput;
}

export type ExecutionResult =
  // googleSynced=false means we saved a local record but it did NOT reach the
  // owner's Google account (not connected / API error) — the reply must say so,
  // instead of letting the planner's optimistic "added to Google Tasks" stand.
  | { type: 'task'; id: string; googleSynced: boolean }
  | { type: 'reminder'; id: string }
  // googleSynced=false means we saved a local record but it did NOT reach the
  // owner's Google Calendar (not connected / API error) — the reply must say so.
  // conflict=true means the slot overlaps an existing calendar event; meetLink is
  // the Google Meet URL when one was created. Both are surfaced to the owner.
  | { type: 'calendar'; id: string; googleSynced: boolean; conflict?: boolean; meetLink?: string | null }
  // content is the drafted body; googleDocUrl is the editable Doc link when Google
  // is connected (null otherwise). Both let the reply actually DELIVER the draft.
  | { type: 'document'; id: string; missingFacts: string[]; content: string; googleDocUrl: string | null }
  // sent=false means the approved email did NOT go out (Gmail not connected or
  // the API failed) — the reply MUST say so instead of claiming "נשלח".
  | { type: 'email'; sent: boolean; to: string | null; reason?: 'not_connected' | 'send_failed' }
  | { type: 'clarification'; id: string }
  | { type: 'approval'; id: string }
  | { type: 'ignored'; reason: string };

/** Parse an ISO datetime string; returns null for missing or unparseable values
 *  (anti-hallucination: never persist an Invalid Date or a guessed time). */
function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Receives validated planner actions and executes them according to the safety
 * policy. Low-risk private actions run immediately; medium/high-risk actions
 * become pending approvals; anything missing important info becomes a pending
 * clarification. Every outcome is audited and unfinished work gets an open loop.
 */
@Injectable()
export class ActionExecutorService {
  private readonly logger = new AppLogger('ActionExecutorService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly clarifications: ClarificationService,
    private readonly approvals: ApprovalService,
    private readonly reminders: ReminderService,
    private readonly openLoops: OpenLoopService,
    private readonly documents: DocumentAgentService,
    private readonly tasks: GoogleTasksService,
    private readonly calendar: GoogleCalendarService,
    private readonly googleAuth: GoogleAuthService,
    private readonly gmail: GoogleGmailService,
    private readonly docs: GoogleDocsService,
    private readonly contacts: ContactService,
    private readonly audit: AuditService,
  ) {}

  async executePlan(ctx: ExecuteContext): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    for (const action of ctx.plannerOutput.actions) {
      results.push(await this.executeAction(action, ctx));
    }
    return results;
  }

  private async executeAction(
    action: PlannerAction,
    ctx: ExecuteContext,
  ): Promise<ExecutionResult> {
    const decision = decideAction(action);

    if (decision.kind === 'ignore') {
      await this.audit.skipped('action.ignore', { action }, decision.reason);
      return { type: 'ignored', reason: decision.reason };
    }

    if (decision.kind === 'clarify') {
      const clarification = await this.clarifications.create({
        question:
          ctx.plannerOutput.clarificationQuestion ??
          `חסר לי מידע כדי לבצע: ${action.title}. תוכל להבהיר?`,
        reason: decision.reason,
        missingFields: action.missingFields,
        sourceMessageId: ctx.sourceMessageId,
        plannerContext: { action } as Prisma.InputJsonValue,
      });
      // Unfinished work -> open loop.
      await this.openLoops.create({
        title: action.title,
        description: `Waiting for clarification: ${decision.reason}`,
        status: 'waiting_for_owner',
        sourceMessageId: ctx.sourceMessageId,
      });
      return { type: 'clarification', id: clarification.id };
    }

    if (decision.kind === 'approval') {
      const approval = await this.approvals.create({
        actionType: action.type,
        description: action.title + (action.description ? ` — ${action.description}` : ''),
        riskLevel: decision.riskLevel,
        proposedPayload: { action } as Prisma.InputJsonValue,
        sourceMessageId: ctx.sourceMessageId,
        view: {
          actionType: action.type,
          description: action.title,
          recipient: action.participants[0] ?? null,
          details: this.describeProposed(action),
          riskReason: decision.reason,
        },
      });
      await this.openLoops.create({
        title: action.title,
        description: `Waiting for approval: ${decision.reason}`,
        status: 'waiting_for_owner',
        linkedDocumentId: null,
        sourceMessageId: ctx.sourceMessageId,
      });
      return { type: 'approval', id: approval.id };
    }

    // decision.kind === 'execute'
    return this.runLowRisk(action, ctx);
  }

  /** Execute an approved/low-risk action's real side effect. */
  async runLowRisk(action: PlannerAction, ctx: ExecuteContext): Promise<ExecutionResult> {
    switch (action.type) {
      case 'create_task':
        return this.createTask(action, ctx);
      case 'create_reminder':
        return this.createReminder(action, ctx);
      case 'create_calendar_event':
        return this.createCalendarEvent(action, ctx);
      case 'draft_document':
        return this.createDocumentDraft(action, ctx);
      case 'send_email':
        return this.sendEmail(action, ctx);
      case 'save_file':
        // Media is already persisted on ingest; just acknowledge + audit.
        await this.audit.success('action.save_file', { action }, {
          entityType: 'MediaAsset',
        });
        return { type: 'ignored', reason: 'file already saved on ingest' };
      default:
        await this.audit.skipped('action.execute', { action }, `no executor for ${action.type}`);
        return { type: 'ignored', reason: `no executor for ${action.type}` };
    }
  }

  private async createTask(action: PlannerAction, ctx: ExecuteContext): Promise<ExecutionResult> {
    const dueDate = parseIso(action.dueDate);
    const task = await this.prisma.task.create({
      data: {
        title: action.title,
        description: action.description,
        priority: action.priority ?? 'medium',
        dueDate,
        sourceMessageId: ctx.sourceMessageId,
      },
    });

    // Best-effort sync to Google Tasks (never blocks the local task). We track
    // whether it actually landed in Google so the reply can be truthful instead
    // of claiming "added to Google Tasks" when only a local row was written.
    let googleSynced = false;
    if (await this.googleAuth.isAuthorized()) {
      try {
        const googleTaskId = await this.tasks.createTask(
          action.title,
          action.description,
          // Google Tasks needs an RFC 3339 timestamp; send the parsed date (or
          // nothing) rather than an unvalidated string that would 400 silently.
          dueDate ? dueDate.toISOString() : null,
        );
        await this.prisma.task.update({ where: { id: task.id }, data: { googleTaskId } });
        googleSynced = true;
      } catch (e) {
        // Surface the Google API's field-level detail (not just the generic
        // "Request contains an invalid argument") so any future rejection names
        // the exact offending field in the logs instead of being a black box.
        const detail =
          (e as { response?: { data?: { error?: unknown } } })?.response?.data?.error ??
          (e as { errors?: unknown })?.errors ??
          null;
        this.logger.warn('Google Tasks sync failed', {
          error: (e as Error).message,
          detail: detail ? JSON.stringify(detail) : undefined,
        });
      }
    }

    await this.openLoops.create({
      title: action.title,
      status: 'open',
      priority: action.priority ?? 'medium',
      dueDate,
      linkedTaskId: task.id,
      sourceMessageId: ctx.sourceMessageId,
    });
    await this.audit.success('task.created', { taskId: task.id, googleSynced }, {
      entityType: 'Task',
      entityId: task.id,
    });
    return { type: 'task', id: task.id, googleSynced };
  }

  private async createReminder(
    action: PlannerAction,
    ctx: ExecuteContext,
  ): Promise<ExecutionResult> {
    const when = parseIso(action.dueDate ?? action.startTime);
    if (!when) {
      // No valid time -> don't guess; ask for it.
      return this.askForMissing(action, ctx, 'מתי להזכיר לך? (תאריך ושעה)');
    }
    const reminder = await this.reminders.create({
      title: action.title,
      description: action.description,
      remindAt: when,
      sourceMessageId: ctx.sourceMessageId,
    });
    await this.audit.success('reminder.created', { reminderId: reminder.id }, {
      entityType: 'Reminder',
      entityId: reminder.id,
    });
    return { type: 'reminder', id: reminder.id };
  }

  private async createCalendarEvent(
    action: PlannerAction,
    ctx: ExecuteContext,
  ): Promise<ExecutionResult> {
    const start = parseIso(action.startTime);
    if (!start) {
      return this.askForMissing(action, ctx, 'באיזה תאריך ושעה לקבוע את הפגישה?');
    }
    // Default to a 60-minute event when no explicit end time is given.
    const end = parseIso(action.endTime) ?? new Date(start.getTime() + 60 * 60 * 1000);

    const event = await this.prisma.calendarEvent.create({
      data: {
        title: action.title,
        description: action.description,
        startTime: start,
        endTime: end,
        participants: action.participants as unknown as Prisma.InputJsonValue,
        status: 'created',
        sourceMessageId: ctx.sourceMessageId,
      },
    });

    // Best-effort sync to Google Calendar (never blocks the local record). We
    // track whether it actually landed in Google so the reply can be truthful
    // instead of claiming "done" when only a local row was written.
    let googleSynced = false;
    let conflict = false;
    let meetLink: string | null = null;
    if (await this.googleAuth.isAuthorized()) {
      // Conflict watch: warn (but still book) when the slot overlaps an existing
      // event, so the owner can decide rather than double-booking silently.
      conflict = await this.hasConflict(start, end);
      try {
        const { id: googleEventId, meetLink: link } = await this.calendar.createEvent({
          title: action.title,
          description: action.description,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          attendees: action.participants,
        });
        meetLink = link;
        await this.prisma.calendarEvent.update({
          where: { id: event.id },
          data: { googleEventId },
        });
        googleSynced = true;
      } catch (e) {
        this.logger.warn('Google Calendar sync failed', { error: (e as Error).message });
      }
    }

    await this.openLoops.create({
      title: action.title,
      status: 'open',
      dueDate: start,
      linkedEventId: event.id,
      sourceMessageId: ctx.sourceMessageId,
    });
    await this.audit.success('calendar_event.created', { eventId: event.id, googleSynced, conflict }, {
      entityType: 'CalendarEvent',
      entityId: event.id,
    });
    return { type: 'calendar', id: event.id, googleSynced, conflict, meetLink };
  }

  /** True when [start,end) overlaps an existing busy slot on the primary calendar.
   *  Best-effort: a free/busy lookup failure is treated as "no known conflict"
   *  (never blocks booking). */
  private async hasConflict(start: Date, end: Date): Promise<boolean> {
    try {
      const busy = await this.calendar.checkFreeBusy(start.toISOString(), end.toISOString());
      return busy.some((b) => {
        const bs = new Date(b.start).getTime();
        const be = new Date(b.end).getTime();
        return bs < end.getTime() && be > start.getTime();
      });
    } catch (e) {
      this.logger.warn('Free/busy conflict check failed', { error: (e as Error).message });
      return false;
    }
  }

  /** Fall back to a clarification when a required value is missing/unparseable. */
  private async askForMissing(
    action: PlannerAction,
    ctx: ExecuteContext,
    question: string,
  ): Promise<ExecutionResult> {
    const clarification = await this.clarifications.create({
      question,
      reason: 'missing or unparseable required value',
      missingFields: action.missingFields,
      sourceMessageId: ctx.sourceMessageId,
      plannerContext: { action } as Prisma.InputJsonValue,
    });
    await this.openLoops.create({
      title: action.title,
      description: 'Waiting for clarification',
      status: 'waiting_for_owner',
      sourceMessageId: ctx.sourceMessageId,
    });
    return { type: 'clarification', id: clarification.id };
  }

  private async createDocumentDraft(
    action: PlannerAction,
    ctx: ExecuteContext,
  ): Promise<ExecutionResult> {
    const docType = (action.toolPayload?.documentType as DocumentType) ?? 'Internal Memo';
    const source =
      (action.toolPayload?.sourceMaterial as string) ?? action.description ?? action.title;
    const draft = await this.documents.draft({
      documentType: docType,
      title: action.title,
      sourceMaterial: source,
      project: action.project,
      client: action.client,
      sourceMessageId: ctx.sourceMessageId,
    });

    // Deliver the draft. When Google is connected, push it to a Google Doc so the
    // owner gets an editable link; otherwise the reply carries the body inline.
    // Either way the draft never just sits invisibly in the database.
    let googleDocUrl: string | null = null;
    if (await this.googleAuth.isAuthorized()) {
      try {
        const { id: googleDocId, url } = await this.docs.createDocument(action.title, draft.content);
        googleDocUrl = url;
        await this.prisma.documentDraft.update({
          where: { id: draft.id },
          data: { googleDocId, googleDriveUrl: url },
        });
      } catch (e) {
        this.logger.warn('Google Docs export failed', { error: (e as Error).message });
      }
    }

    await this.audit.success('document.drafted', { docId: draft.id, googleDocUrl }, {
      entityType: 'DocumentDraft',
      entityId: draft.id,
    });
    return {
      type: 'document',
      id: draft.id,
      missingFacts: draft.missingFacts,
      content: draft.content,
      googleDocUrl,
    };
  }

  /**
   * Actually send an approved email. Reaching here means the owner already
   * approved (policy forces send_email through approval). We resolve a real
   * recipient, and only report success if the Gmail API confirmed the send —
   * never claim "נשלח" on a local no-op (truthful reporting).
   */
  private async sendEmail(action: PlannerAction, ctx: ExecuteContext): Promise<ExecutionResult> {
    if (!(await this.googleAuth.isAuthorized())) {
      await this.audit.failed('email.send', { action }, 'gmail not connected');
      return { type: 'email', sent: false, to: action.participants[0] ?? null, reason: 'not_connected' };
    }

    const to = await this.resolveRecipient(action);
    if (!to) {
      // No verified address — don't guess one; ask the owner for it.
      return this.askForMissing(action, ctx, 'למי לשלוח את המייל? אני צריך כתובת אימייל מדויקת.');
    }

    const subject = (action.toolPayload?.subject as string) ?? action.title;
    const body =
      (action.toolPayload?.body as string) ?? action.description ?? action.title;
    try {
      const id = await this.gmail.sendEmail({ to, subject, body });
      await this.audit.success('email.sent', { id, to }, { entityType: 'Email', entityId: id });
      return { type: 'email', sent: true, to };
    } catch (e) {
      this.logger.warn('Email send failed', { error: (e as Error).message });
      await this.audit.failed('email.send', { action, to }, (e as Error).message);
      return { type: 'email', sent: false, to, reason: 'send_failed' };
    }
  }

  /** Resolve a real email address for the first participant: use it directly if
   *  it's already an address, otherwise look it up in the owner's mail. Returns
   *  null when nothing convincing is found (caller asks the owner). */
  private async resolveRecipient(action: PlannerAction): Promise<string | null> {
    const first = action.participants[0]?.trim();
    if (!first) return null;
    if (first.includes('@')) return first;
    // Prefer a stored contact (no Gmail round-trip), then a live Gmail lookup.
    const stored = await this.contacts.findEmail(first);
    if (stored) return stored;
    const found = await this.gmail.findContactEmail(first);
    return found?.email ?? null;
  }

  private describeProposed(action: PlannerAction): string {
    const parts: string[] = [];
    if (action.type === 'send_email') {
      const subject = (action.toolPayload?.subject as string) ?? action.title;
      const body = (action.toolPayload?.body as string) ?? action.description ?? '';
      parts.push(`נושא: ${subject}`);
      if (body) parts.push(`תוכן:\n${body}`);
    }
    if (action.startTime) parts.push(`מתי: ${action.startTime}`);
    if (action.participants.length) parts.push(`משתתפים: ${action.participants.join(', ')}`);
    if (action.project) parts.push(`פרויקט: ${action.project}`);
    if (action.client) parts.push(`לקוח: ${action.client}`);
    return parts.join('\n');
  }
}
