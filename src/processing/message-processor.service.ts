import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActionExecutorService, ExecutionResult } from '../actions/action-executor.service';
import { ApprovalService } from '../approvals/approval.service';
import { AuditService } from '../audit/audit.service';
import { ClarificationService } from '../clarifications/clarification.service';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { LearnedFactService } from '../memory/learned-fact.service';
import { MediaService } from '../media/media.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { PlannerContextInput } from '../planner/planner.prompt';
import { PlannerService } from '../planner/planner.service';
import { PlannerAction, PlannerOutput, plannerActionSchema } from '../planner/planner.schema';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NormalizedIncomingMessage } from '../whatsapp/whatsapp.types';

/**
 * The orchestrator invoked by the queue worker for each stored WhatsApp message.
 *
 * Order of operations (per spec):
 *   1. Resolve the message content (transcribe voice / process media).
 *   2. If a pending approval or clarification exists, try to route the message
 *      to it FIRST.
 *   3. Otherwise plan a fresh action and execute under policy.
 *   4. Always reply to the owner. Never invent. Never drop actionable input.
 */
/** Max resolve-before-ask rounds: each round runs the planner's requested tools
 *  and re-plans. Bounds cost/latency while letting the assistant chain a couple
 *  of lookups (e.g. find a contact, then check availability). */
const MAX_RESOLUTION_ROUNDS = 2;

/** How many recent conversation turns (both directions) to replay to the planner
 *  as context, so it combines what the owner already said instead of re-asking. */
const HISTORY_TURNS = 16;

@Injectable()
export class MessageProcessorService {
  private readonly logger = new AppLogger('MessageProcessor');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly media: MediaService,
    private readonly planner: PlannerService,
    private readonly executor: ActionExecutorService,
    private readonly clarifications: ClarificationService,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
    private readonly memory: LearnedFactService,
    private readonly orchestrator: OrchestrationService,
  ) {}

  async process(whatsappMessageId: string): Promise<void> {
    const row = await this.prisma.whatsAppMessage.findUnique({
      where: { whatsappMessageId },
    });
    if (!row) {
      this.logger.warn('Message row not found', { whatsappMessageId });
      return;
    }

    // Atomic claim (compare-and-swap): only one worker may move the message into
    // 'processing'. Prevents double-execution on webhook retries / job re-delivery.
    const claim = await this.prisma.whatsAppMessage.updateMany({
      where: { id: row.id, status: { in: ['received', 'queued', 'failed'] } },
      data: { status: 'processing' },
    });
    if (claim.count === 0) {
      this.logger.debug('Message already claimed/processed (idempotent skip)', {
        whatsappMessageId,
        status: row.status,
      });
      return;
    }

    const msg = this.toNormalized(row.rawPayload, row);

    try {
      // 1. Resolve content (media / voice). Unreliable transcripts are NOT used.
      const { text, transcript, mediaSummary, degradedNote } = await this.resolveContent(
        msg,
        row.id,
      );
      if (degradedNote) {
        await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, degradedNote);
      }

      const ownerText = [text, transcript].filter(Boolean).join(' ').trim() || null;

      // Nothing usable (e.g. unintelligible voice note) — the degraded note has
      // already asked the owner to resend; do not invent an action.
      if (!ownerText && !mediaSummary) {
        await this.finalize(row.id, 'processed');
        return;
      }

      // 1b. Deterministic memory commands ("what do you remember" / "forget …").
      // Handled WITHOUT any AI call — pure cost saving.
      if (ownerText && (await this.handleMemoryCommand(ownerText))) {
        await this.finalize(row.id, 'processed');
        return;
      }

      // 2. Plan ONCE, giving the planner any pending approval/clarification so it
      // can tell us whether this message answers them.
      const pendingApproval = await this.approvals.findOldestPending();
      const pendingClarification = await this.clarifications.findOldestPending();
      const memories = await this.memory.retrieveForPrompt(ownerText ?? mediaSummary ?? '');
      const recentContext = await this.buildRecentContext(row);

      const plannerCtx: PlannerContextInput = {
        text,
        transcript,
        mediaSummary,
        sender: row.fromNumber,
        timestamp: row.receivedAt.toISOString(),
        timezone: env().OWNER_TIMEZONE,
        ownerName: env().OWNER_NAME,
        knownProjects: await this.knownProjects(),
        memories,
        recentContext,
        pendingApproval: pendingApproval
          ? { id: pendingApproval.id, description: pendingApproval.description }
          : null,
        pendingClarification: pendingClarification
          ? {
              id: pendingClarification.id,
              question: pendingClarification.question,
              missingFields: pendingClarification.missingFields,
            }
          : null,
      };

      // Plan once, then run the resolve-before-ask loop: if the planner asked
      // for tools/sub-agents (calendar, Gmail, web), run them, feed the findings
      // back, and re-plan — so it resolves context on its own before asking.
      let plan = await this.planner.plan(plannerCtx);
      const findings: string[] = [];
      for (let round = 0; plan.toolRequests.length && round < MAX_RESOLUTION_ROUNDS; round++) {
        const newFindings = await this.orchestrator.resolve(plan.toolRequests, row.id);
        findings.push(...newFindings);
        plan = await this.planner.plan({ ...plannerCtx, toolFindings: [...findings] });
      }

      await this.audit.success(
        'planner.plan',
        { summary: plan.summary, confidence: plan.confidence },
        { entityType: 'WhatsAppMessage', entityId: row.id },
      );

      // Persist anything the planner learned (zero extra AI cost — by-product of
      // the call above). Runs regardless of how the message is routed below.
      if (plan.memoryWrites.length) {
        await this.memory.applyWrites(plan.memoryWrites, row.id);
      }

      // 3a. Is this a response to a pending approval?
      if (pendingApproval && ownerText) {
        const decision = this.approvals.classifyResponse(ownerText);
        if (decision === 'approved') {
          await this.approvals.markApproved(pendingApproval.id, row.id);
          const result = await this.executeApprovedAction(pendingApproval.id);
          const reply = this.approvedReply(result);
          if (reply) await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, reply);
          await this.finalize(row.id, 'processed');
          return;
        }
        if (decision === 'rejected') {
          await this.approvals.markRejected(pendingApproval.id, row.id);
          await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, 'בוטל. לא בוצעה הפעולה.');
          await this.finalize(row.id, 'processed');
          return;
        }
        // Ambiguous words. Only treat as an approval reply if the planner thinks
        // it is one; otherwise fall through and handle it as a NEW request so the
        // message is never dropped (the approval stays pending).
        if (plan.isAnswerToPendingApproval) {
          await this.whatsapp.sendText(
            env().OWNER_WHATSAPP_NUMBER,
            "לא בטוח שהבנתי אם לאשר או לבטל. לענות בבקשה: 'אשר' או 'בטל'.",
          );
          await this.finalize(row.id, 'processed');
          return;
        }
      }

      // 3b. Is this an answer to a pending clarification?
      if (pendingClarification && plan.isAnswerToPendingClarification) {
        await this.clarifications.markAnswered(
          pendingClarification.id,
          ownerText ?? mediaSummary ?? '',
          row.id,
        );
        await this.runPlan(plan, row.id);
        await this.finalize(row.id, 'processed');
        return;
      }

      // 3c. Fresh request.
      await this.runPlan(plan, row.id);
      await this.finalize(row.id, 'processed');
    } catch (e) {
      this.logger.error('Processing failed', { whatsappMessageId, error: (e as Error).message });
      await this.prisma.whatsAppMessage.update({
        where: { id: row.id },
        data: { status: 'failed', error: (e as Error).message },
      });
      throw e; // surface to BullMQ for retry / dead-letter
    }
  }

  /**
   * Execute a (non-approval) plan and reply truthfully: if the plan needs
   * clarification or any action was gated to approval/clarification, those paths
   * send their own message — we do NOT also send an optimistic "done" reply.
   */
  private async runPlan(plan: PlannerOutput, sourceRowId: string): Promise<void> {
    if (plan.needsClarification && plan.clarificationQuestion) {
      await this.clarifications.create({
        question: plan.clarificationQuestion,
        reason: plan.missingInformation.map((m) => m.field).join(', ') || 'missing information',
        missingFields: plan.missingInformation,
        sourceMessageId: sourceRowId,
        plannerContext: plan as unknown as Prisma.InputJsonValue,
      });
      return;
    }

    const results = await this.executor.executePlan({
      sourceMessageId: sourceRowId,
      plannerOutput: plan,
    });

    // If anything became a pending approval/clarification, that path already
    // messaged the owner — don't send a contradicting "done" reply.
    const gated = results.some((r) => r.type === 'approval' || r.type === 'clarification');
    if (!gated && plan.replyToUser) {
      // Truthfulness: if a task or calendar event was saved locally but never
      // reached Google, don't let the optimistic "קבעתי"/"הוספתי" stand alone.
      const notes = this.notSyncedNotes(results);
      const reply = notes ? `${plan.replyToUser}\n\n${notes}` : plan.replyToUser;
      await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, reply);
    }
  }

  /** Build honest "didn't actually reach Google" notes for any results that were
   *  saved locally but not synced, so the owner is never misled into thinking a
   *  task is in Google Tasks or an event is in their calendar. Returns '' when
   *  everything synced (or there was nothing to sync). */
  private notSyncedNotes(results: ExecutionResult[]): string {
    const notes: string[] = [];
    if (results.some((r) => r.type === 'task' && !r.googleSynced)) {
      notes.push(this.tasksNotSyncedNote());
    }
    if (results.some((r) => r.type === 'calendar' && !r.googleSynced)) {
      notes.push(this.calendarNotSyncedNote());
    }
    return notes.join('\n\n');
  }

  /** Honest note appended when a task was saved locally but Google Tasks is not
   *  connected, so the owner is not misled into thinking it's in Google Tasks. */
  private tasksNotSyncedNote(): string {
    return `⚠️ שמרתי את המשימה אצלי, אבל Google Tasks לא מחובר — המשימה לא נכנסה ל-Google Tasks שלך בפועל. לחיבור: ${env().APP_BASE_URL}/auth/google`;
  }

  /** Honest note appended when an event was saved locally but Google Calendar is
   *  not connected, so the owner is not misled into thinking it's in their calendar. */
  private calendarNotSyncedNote(): string {
    return `⚠️ שמרתי את זה אצלי, אבל יומן Google לא מחובר — האירוע לא נכנס ליומן שלך בפועל. לחיבור: ${env().APP_BASE_URL}/auth/google`;
  }

  private async executeApprovedAction(approvalId: string): Promise<ExecutionResult | null> {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval) return null;
    const payload = approval.proposedPayload as { action?: unknown };
    const parsed = plannerActionSchema.safeParse(payload.action);
    if (!parsed.success) {
      this.logger.warn('Approved payload could not be parsed', { approvalId });
      return null;
    }
    // The approval has been granted, so the action may now run its real side
    // effect — but keep participants so e.g. calendar invites are created.
    const action: PlannerAction = { ...parsed.data, requiresApproval: false };
    return this.executor.runLowRisk(action, {
      sourceMessageId: approval.sourceMessageId ?? '',
      plannerOutput: {
        summary: '',
        confidence: 1,
        language: 'he',
        isAnswerToPendingClarification: false,
        isAnswerToPendingApproval: true,
        detectedProject: null,
        detectedClient: null,
        missingInformation: [],
        needsClarification: false,
        clarificationQuestion: null,
        toolRequests: [],
        assumptions: [],
        actions: [action],
        memoryWrites: [],
        replyToUser: '',
      },
    });
  }

  /**
   * Deterministic owner commands for the learning layer — handled without any AI
   * call. Returns true if the message was a memory command and has been handled.
   *   • recall: "מה אתה זוכר", "מה אתה יודע עליי", "מה למדת"
   *   • forget: "תשכח ...", "שכח ..."
   */
  private async handleMemoryCommand(ownerText: string): Promise<boolean> {
    const t = ownerText.trim();

    if (/^(מה אתה זוכר|מה אתה יודע|מה למדת)/.test(t)) {
      const facts = await this.memory.listActive();
      const reply = facts.length
        ? 'מה שאני זוכר עליך:\n' + facts.map((f) => `• ${f.content}`).join('\n')
        : 'עדיין לא שמרתי עליך שום דבר.';
      await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, reply);
      return true;
    }

    const forget = t.match(/^(?:תשכח|שכח)\s+(?:ש)?(.+)$/s);
    if (forget) {
      const count = await this.memory.forget(forget[1]);
      const reply = count
        ? `מחקתי מהזיכרון (${count}).`
        : 'לא מצאתי משהו תואם בזיכרון למחיקה.';
      await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, reply);
      return true;
    }

    return false;
  }

  /** Truthful confirmation for an approved action's actual outcome. */
  private approvedReply(result: ExecutionResult | null): string {
    switch (result?.type) {
      case 'task':
        return result && result.type === 'task' && !result.googleSynced
          ? `אושר. יצרתי את המשימה אצלי, אבל Google Tasks לא מחובר אז היא לא נכנסה ל-Google Tasks בפועל.\n${this.tasksNotSyncedNote()}`
          : 'אושר. יצרתי את המשימה ב-Google Tasks.';
      case 'reminder':
        return 'אושר. קבעתי תזכורת.';
      case 'calendar':
        return result && result.type === 'calendar' && !result.googleSynced
          ? `אושר, אבל יומן Google לא מחובר אז האירוע לא נכנס ליומן בפועל.\n${this.calendarNotSyncedNote()}`
          : 'אושר. יצרתי את האירוע ביומן.';
      case 'document':
        return 'אושר. הכנתי את הטיוטה.';
      case 'email':
        if (result.type !== 'email') return '';
        if (result.sent) return `אושר. שלחתי את המייל ל-${result.to}.`;
        return result.reason === 'not_connected'
          ? `אישרת, אבל Gmail לא מחובר אז המייל לא נשלח. לחיבור: ${env().APP_BASE_URL}/auth/google`
          : 'אישרת, אבל לא הצלחתי לשלוח את המייל. בדוק את הלוג או נסה שוב.';
      case 'clarification':
        return ''; // a clarification question was already sent
      default:
        return 'אישרת, אבל לא הצלחתי להשלים את הפעולה. בדוק את הלוג או נסה שוב.';
    }
  }

  // --- helpers ---

  private async resolveContent(msg: NormalizedIncomingMessage, rowId: string) {
    let text = msg.text;
    let transcript: string | null = null;
    let mediaSummary: string | null = null;
    let degradedNote: string | null = null;

    if (msg.mediaId) {
      const processed = await this.media.ingest(msg, rowId);
      if (processed) {
        // Only act on a transcript we trust; unreliable ones become a degraded
        // note asking the owner to confirm/resend (handled by the caller).
        transcript = processed.transcriptReliable ? processed.transcript : null;
        degradedNote = processed.degradedNote;
        if (processed.aiSummary || processed.extractedText || processed.classification) {
          mediaSummary = [
            processed.classification ? `type: ${processed.classification}` : null,
            processed.aiSummary,
            processed.extractedText ? `text: ${processed.extractedText}` : null,
          ]
            .filter(Boolean)
            .join('\n');
        }
      }
    }

    return { text, transcript, mediaSummary, degradedNote };
  }

  private async knownProjects(): Promise<string[]> {
    const projects = await this.prisma.project.findMany({ select: { name: true } });
    return projects.map((p) => p.name);
  }

  /**
   * Replay the last few conversation turns (both directions) as a plain
   * transcript so the planner can see what the owner ALREADY said across earlier
   * messages — the fix for the assistant re-asking the same questions. Inbound
   * (owner) and outbound (assistant) messages both live in WhatsAppMessage; we
   * tell them apart by the sender number. Voice-only turns (no textContent) are
   * skipped. Returns undefined when there is no prior text.
   */
  private async buildRecentContext(current: {
    id: string;
    receivedAt: Date;
  }): Promise<string | undefined> {
    const rows = await this.prisma.whatsAppMessage.findMany({
      where: {
        id: { not: current.id },
        receivedAt: { lte: current.receivedAt },
        textContent: { not: null },
      },
      orderBy: { receivedAt: 'desc' },
      take: HISTORY_TURNS,
    });
    if (!rows.length) return undefined;

    const ownerDigits = env().OWNER_WHATSAPP_NUMBER.replace(/\D/g, '');
    const ownerName = env().OWNER_NAME || 'הבעלים';
    return rows
      .reverse() // oldest first, so the transcript reads top-to-bottom
      .map((r) => {
        const who = r.fromNumber.replace(/\D/g, '') === ownerDigits ? ownerName : 'פליי';
        return `${who}: ${r.textContent}`;
      })
      .join('\n');
  }

  private toNormalized(rawPayload: unknown, row: { fromNumber: string; toNumber: string; whatsappMessageId: string; messageType: string; textContent: string | null; mediaId: string | null; receivedAt: Date }): NormalizedIncomingMessage {
    const raw = rawPayload as { mime_type?: string; document?: { mime_type?: string; filename?: string }; audio?: { mime_type?: string }; image?: { mime_type?: string }; video?: { mime_type?: string } };
    const mimeType =
      raw.audio?.mime_type ?? raw.image?.mime_type ?? raw.video?.mime_type ?? raw.document?.mime_type ?? null;
    return {
      whatsappMessageId: row.whatsappMessageId,
      fromNumber: row.fromNumber,
      toNumber: row.toNumber,
      type: row.messageType as NormalizedIncomingMessage['type'],
      text: row.textContent,
      mediaId: row.mediaId,
      mimeType,
      filename: raw.document?.filename ?? null,
      timestamp: row.receivedAt.toISOString(),
      raw: rawPayload,
    };
  }

  private async finalize(rowId: string, status: 'processed') {
    await this.prisma.whatsAppMessage.update({
      where: { id: rowId },
      data: { status, processedAt: new Date() },
    });
  }
}
