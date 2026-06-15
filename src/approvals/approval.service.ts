import { Injectable } from '@nestjs/common';
import { Prisma, RiskLevel } from '@prisma/client';
import { env } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { OpenLoopService } from '../open-loops/open-loop.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalView, WhatsAppService } from '../whatsapp/whatsapp.service';

// Whole-word tokens (matched on word boundaries, NOT substrings — substring
// matching on 2-letter Hebrew tokens like כן/לא is dangerous for an approve/
// reject gate, e.g. "לכן"/"תשלח" must NOT count as כן/שלח).
const APPROVE_TOKENS = ['אשר', 'מאשר', 'שלח', 'כן', 'תבצע', 'אישור', 'מאשרת', 'אשרי'];
const REJECT_TOKENS = ['לא', 'בטל', 'עצור', 'בטלי'];
// Multi-word phrases checked as phrases; explicit rejections win over any
// approve token they may contain (e.g. "לא מאשר" contains "מאשר").
const EXPLICIT_REJECT_PHRASES = ['אל תשלח', 'לא מאשר', 'אל תבצע', 'לא לשלוח'];
const APPROVE_PHRASES = ['כן תאשר', 'כן לאשר', 'אפשר לשלוח'];

export type ApprovalDecision = 'approved' | 'rejected' | 'ambiguous';

export interface CreateApprovalInput {
  actionType: string;
  description: string;
  riskLevel: RiskLevel;
  proposedPayload: Prisma.InputJsonValue;
  sourceMessageId?: string | null;
  view: ApprovalView;
}

/**
 * Owns the pending-approval lifecycle. High-risk actions are never executed
 * until the owner explicitly approves; the executor is invoked by the caller
 * after `decide` returns "approved".
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly audit: AuditService,
    private readonly openLoops: OpenLoopService,
  ) {}

  async create(input: CreateApprovalInput) {
    const approval = await this.prisma.approval.create({
      data: {
        actionType: input.actionType,
        description: input.description,
        riskLevel: input.riskLevel,
        proposedPayload: input.proposedPayload,
        sourceMessageId: input.sourceMessageId ?? null,
        status: 'pending',
      },
    });

    const messageId = await this.whatsapp.sendApprovalRequest(
      env().OWNER_WHATSAPP_NUMBER,
      input.view,
    );

    await this.prisma.approval.update({
      where: { id: approval.id },
      data: { approvalMessageId: messageId },
    });

    await this.audit.success('approval.created', { id: approval.id, actionType: input.actionType }, {
      entityType: 'Approval',
      entityId: approval.id,
    });

    return approval;
  }

  async findOldestPending() {
    return this.prisma.approval.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Classify a free-text/voice answer as approve / reject / ambiguous. */
  classifyResponse(text: string): ApprovalDecision {
    const normalized = text.trim().toLowerCase();
    // Tokenize on whitespace/punctuation so we match whole words only.
    const tokens = normalized.split(/[\s,.!?؛;:()"'־–—-]+/).filter(Boolean);

    // Explicit rejection phrases win outright.
    if (EXPLICIT_REJECT_PHRASES.some((p) => normalized.includes(p))) return 'rejected';
    const hasApprovePhrase = APPROVE_PHRASES.some((p) => normalized.includes(p));

    const hasApprove = hasApprovePhrase || tokens.some((t) => APPROVE_TOKENS.includes(t));
    const hasReject = tokens.some((t) => REJECT_TOKENS.includes(t));

    if (hasApprove && !hasReject) return 'approved';
    if (hasReject && !hasApprove) return 'rejected';
    // Anything mixed or undecided fails safe to ambiguous (never auto-approves).
    return 'ambiguous';
  }

  async markApproved(id: string, ownerResponseMessageId?: string | null) {
    const updated = await this.prisma.approval.update({
      where: { id },
      data: {
        status: 'approved',
        decidedAt: new Date(),
        ownerResponseMessageId: ownerResponseMessageId ?? null,
      },
    });
    // The work is no longer waiting on the owner — close its open loop so the
    // follow-up watcher stops re-nudging about something already decided.
    await this.openLoops.closeByApproval(id, 'done');
    await this.audit.success('approval.approved', { id }, { entityType: 'Approval', entityId: id });
    return updated;
  }

  async markRejected(id: string, ownerResponseMessageId?: string | null) {
    const updated = await this.prisma.approval.update({
      where: { id },
      data: {
        status: 'rejected',
        decidedAt: new Date(),
        ownerResponseMessageId: ownerResponseMessageId ?? null,
      },
    });
    // Rejected -> the work is abandoned; close its open loop as ignored.
    await this.openLoops.closeByApproval(id, 'ignored');
    await this.audit.success('approval.rejected', { id }, { entityType: 'Approval', entityId: id });
    return updated;
  }
}
