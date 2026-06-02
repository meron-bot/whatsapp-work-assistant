import { Injectable } from '@nestjs/common';
import { Prisma, RiskLevel } from '@prisma/client';
import { env } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalView, WhatsAppService } from '../whatsapp/whatsapp.service';

const APPROVE_WORDS = ['אשר', 'מאשר', 'כן תאשר', 'שלח', 'כן', 'תבצע', 'אישור'];
const REJECT_WORDS = ['אל תשלח', 'לא מאשר', 'בטל', 'עצור', 'לא'];
// Unambiguous rejection phrases that win even if they contain an approve substring
// (e.g. "לא מאשר" contains "מאשר").
const EXPLICIT_REJECT = ['אל תשלח', 'לא מאשר', 'בטל', 'עצור'];

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
    if (EXPLICIT_REJECT.some((w) => normalized.includes(w.toLowerCase()))) return 'rejected';
    const hasApprove = APPROVE_WORDS.some((w) => normalized.includes(w.toLowerCase()));
    const hasReject = REJECT_WORDS.some((w) => normalized.includes(w.toLowerCase()));
    if (hasApprove && !hasReject) return 'approved';
    if (hasReject && !hasApprove) return 'rejected';
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
    await this.audit.success('approval.rejected', { id }, { entityType: 'Approval', entityId: id });
    return updated;
  }
}
