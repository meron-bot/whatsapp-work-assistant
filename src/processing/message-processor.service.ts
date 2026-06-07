import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActionExecutorService, ExecutionResult } from '../actions/action-executor.service';
import { ApprovalService } from '../approvals/approval.service';
import { AuditService } from '../audit/audit.service';
import { ClarificationService } from '../clarifications/clarification.service';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { MediaService } from '../media/media.service';
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

      // 2. Plan ONCE, giving the planner any pending approval/clarification so it
      // can tell us whether this message answers them.
      const pendingApproval = await this.approvals.findOldestPending();
      const pendingClarification = await this.clarifications.findOldestPending();

      const plan = await this.planner.plan({
        text,
        transcript,
        mediaSummary,
        sender: row.fromNumber,
        timestamp: row.receivedAt.toISOString(),
        timezone: env().OWNER_TIMEZONE,
        knownProjects: await this.knownProjects(),
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
      });

      await this.audit.success(
        'planner.plan',
        { summary: plan.summary, confidence: plan.confidence },
        { entityType: 'WhatsAppMessage', entityId: row.id },
      );

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
      await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, plan.replyToUser);
    }
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
        actions: [action],
        replyToUser: '',
      },
    });
  }

  /** Truthful confirmation for an approved action's actual outcome. */
  private approvedReply(result: ExecutionResult | null): string {
    switch (result?.type) {
      case 'task':
        return 'אושר. יצרתי את המשימה.';
      case 'reminder':
        return 'אושר. קבעתי תזכורת.';
      case 'calendar':
        return 'אושר. יצרתי את האירוע ביומן.';
      case 'document':
        return 'אושר. הכנתי את הטיוטה.';
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
