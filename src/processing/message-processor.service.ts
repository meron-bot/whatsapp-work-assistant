import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActionExecutorService } from '../actions/action-executor.service';
import { ApprovalService } from '../approvals/approval.service';
import { AuditService } from '../audit/audit.service';
import { ClarificationService } from '../clarifications/clarification.service';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { MediaService } from '../media/media.service';
import { PlannerService } from '../planner/planner.service';
import { PlannerAction, plannerActionSchema } from '../planner/planner.schema';
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
    if (row.status === 'processed') {
      this.logger.debug('Message already processed (idempotent skip)', { whatsappMessageId });
      return;
    }

    await this.prisma.whatsAppMessage.update({
      where: { id: row.id },
      data: { status: 'processing' },
    });

    const msg = this.toNormalized(row.rawPayload, row);

    try {
      // 1. Resolve content (media / voice).
      const { text, transcript, mediaSummary, degradedNote } = await this.resolveContent(
        msg,
        row.id,
      );

      if (degradedNote) {
        await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, degradedNote);
      }

      const ownerText = [text, transcript].filter(Boolean).join(' ').trim() || null;

      // 2. Route to a pending item first.
      const handled = await this.tryHandlePending(ownerText, mediaSummary, row.id);
      if (handled) {
        await this.finalize(row.id, 'processed');
        return;
      }

      // 3. Fresh planning.
      const plan = await this.planner.plan({
        text,
        transcript,
        mediaSummary,
        sender: row.fromNumber,
        timestamp: row.receivedAt.toISOString(),
        timezone: env().OWNER_TIMEZONE,
        knownProjects: await this.knownProjects(),
      });

      await this.audit.success('planner.plan', { summary: plan.summary, confidence: plan.confidence }, {
        entityType: 'WhatsAppMessage',
        entityId: row.id,
      });

      if (plan.needsClarification && plan.clarificationQuestion) {
        await this.clarifications.create({
          question: plan.clarificationQuestion,
          reason: plan.missingInformation.map((m) => m.field).join(', ') || 'missing information',
          missingFields: plan.missingInformation,
          sourceMessageId: row.id,
          plannerContext: plan as unknown as Prisma.InputJsonValue,
        });
        await this.finalize(row.id, 'processed');
        return;
      }

      await this.executor.executePlan({ sourceMessageId: row.id, plannerOutput: plan });

      // 4. Reply to the owner (planner-authored Hebrew reply).
      if (plan.replyToUser) {
        await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, plan.replyToUser);
      }

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

  // --- pending-item routing ---

  private async tryHandlePending(
    ownerText: string | null,
    mediaSummary: string | null,
    sourceRowId: string,
  ): Promise<boolean> {
    if (!ownerText && !mediaSummary) return false;

    // Approvals take priority — a high-risk action is blocked on it.
    const approval = await this.approvals.findOldestPending();
    if (approval && ownerText) {
      const decision = this.approvals.classifyResponse(ownerText);
      if (decision === 'approved') {
        await this.approvals.markApproved(approval.id, sourceRowId);
        await this.executeApprovedAction(approval.id);
        await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, 'אושר ובוצע.');
        return true;
      }
      if (decision === 'rejected') {
        await this.approvals.markRejected(approval.id, sourceRowId);
        await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, 'בוטל. לא בוצעה הפעולה.');
        return true;
      }
      // ambiguous -> ask again, keep approval open
      await this.whatsapp.sendText(
        env().OWNER_WHATSAPP_NUMBER,
        "לא בטוח שהבנתי אם לאשר או לבטל. לענות בבקשה: 'אשר' או 'בטל'.",
      );
      return true;
    }

    const clarification = await this.clarifications.findOldestPending();
    if (clarification && (ownerText || mediaSummary)) {
      const answer = ownerText ?? mediaSummary ?? '';
      await this.clarifications.markAnswered(clarification.id, answer, sourceRowId);

      // Re-plan using the original context + the new answer so the previously
      // blocked action can proceed.
      const plan = await this.planner.plan({
        text: answer,
        transcript: null,
        mediaSummary,
        sender: env().OWNER_WHATSAPP_NUMBER,
        timestamp: new Date().toISOString(),
        timezone: env().OWNER_TIMEZONE,
        knownProjects: await this.knownProjects(),
        pendingClarification: {
          id: clarification.id,
          question: clarification.question,
          missingFields: clarification.missingFields,
        },
      });

      if (plan.needsClarification && plan.clarificationQuestion) {
        await this.clarifications.create({
          question: plan.clarificationQuestion,
          reason: 'still missing information',
          missingFields: plan.missingInformation,
          sourceMessageId: sourceRowId,
        });
        return true;
      }

      await this.executor.executePlan({ sourceMessageId: sourceRowId, plannerOutput: plan });
      if (plan.replyToUser) {
        await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, plan.replyToUser);
      }
      return true;
    }

    return false;
  }

  private async executeApprovedAction(approvalId: string): Promise<void> {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval) return;
    const payload = approval.proposedPayload as { action?: unknown };
    const parsed = plannerActionSchema.safeParse(payload.action);
    if (!parsed.success) {
      this.logger.warn('Approved payload could not be parsed', { approvalId });
      return;
    }
    const action: PlannerAction = { ...parsed.data, requiresApproval: false, participants: [] };
    await this.executor.runLowRisk(action, {
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

  // --- helpers ---

  private async resolveContent(msg: NormalizedIncomingMessage, rowId: string) {
    let text = msg.text;
    let transcript: string | null = null;
    let mediaSummary: string | null = null;
    let degradedNote: string | null = null;

    if (msg.mediaId) {
      const processed = await this.media.ingest(msg, rowId);
      if (processed) {
        transcript = processed.transcript;
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
