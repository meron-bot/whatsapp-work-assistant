import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AppLogger } from '../logger/logger.service';
import { ApprovalService } from '../approvals/approval.service';
import { ClarificationService } from '../clarifications/clarification.service';
import { DocumentAgentService, DocumentType } from '../documents/document-agent.service';
import { GoogleTasksService } from '../google/google-tasks.service';
import { GoogleAuthService } from '../google/google-auth.service';
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
  | { type: 'task'; id: string }
  | { type: 'reminder'; id: string }
  | { type: 'document'; id: string; missingFacts: string[] }
  | { type: 'clarification'; id: string }
  | { type: 'approval'; id: string }
  | { type: 'ignored'; reason: string };

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
    private readonly googleAuth: GoogleAuthService,
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
      case 'draft_document':
        return this.createDocumentDraft(action, ctx);
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
    const task = await this.prisma.task.create({
      data: {
        title: action.title,
        description: action.description,
        priority: action.priority ?? 'medium',
        dueDate: action.dueDate ? new Date(action.dueDate) : null,
        sourceMessageId: ctx.sourceMessageId,
      },
    });

    // Best-effort sync to Google Tasks (never blocks the local task).
    if (await this.googleAuth.isAuthorized()) {
      try {
        const googleTaskId = await this.tasks.createTask(
          action.title,
          action.description,
          action.dueDate,
        );
        await this.prisma.task.update({ where: { id: task.id }, data: { googleTaskId } });
      } catch (e) {
        this.logger.warn('Google Tasks sync failed', { error: (e as Error).message });
      }
    }

    await this.openLoops.create({
      title: action.title,
      status: 'open',
      priority: action.priority ?? 'medium',
      dueDate: action.dueDate ? new Date(action.dueDate) : null,
      linkedTaskId: task.id,
      sourceMessageId: ctx.sourceMessageId,
    });
    await this.audit.success('task.created', { taskId: task.id }, {
      entityType: 'Task',
      entityId: task.id,
    });
    return { type: 'task', id: task.id };
  }

  private async createReminder(
    action: PlannerAction,
    ctx: ExecuteContext,
  ): Promise<ExecutionResult> {
    const when = action.dueDate ?? action.startTime;
    const reminder = await this.reminders.create({
      title: action.title,
      description: action.description,
      remindAt: new Date(when as string),
      sourceMessageId: ctx.sourceMessageId,
    });
    await this.audit.success('reminder.created', { reminderId: reminder.id }, {
      entityType: 'Reminder',
      entityId: reminder.id,
    });
    return { type: 'reminder', id: reminder.id };
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
    await this.audit.success('document.drafted', { docId: draft.id }, {
      entityType: 'DocumentDraft',
      entityId: draft.id,
    });
    return { type: 'document', id: draft.id, missingFacts: draft.missingFacts };
  }

  private describeProposed(action: PlannerAction): string {
    const parts: string[] = [];
    if (action.startTime) parts.push(`מתי: ${action.startTime}`);
    if (action.participants.length) parts.push(`משתתפים: ${action.participants.join(', ')}`);
    if (action.project) parts.push(`פרויקט: ${action.project}`);
    if (action.client) parts.push(`לקוח: ${action.client}`);
    return parts.join('\n');
  }
}
