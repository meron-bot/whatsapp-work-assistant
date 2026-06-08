import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

export interface CreateClarificationInput {
  question: string;
  reason: string;
  missingFields?: unknown[];
  suggestedOptions?: string[] | null;
  sourceMessageId?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  plannerContext?: Prisma.InputJsonValue;
  expiresAt?: Date | null;
}

/** Clarifications auto-expire after this many days if never answered, so the
 *  oldest-pending matcher never gets stuck routing replies to a dead question. */
const DEFAULT_TTL_DAYS = 3;

/**
 * Owns the pending-clarification lifecycle: create + send the question, find the
 * open clarification a new message is answering, and record the answer.
 */
@Injectable()
export class ClarificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateClarificationInput) {
    // Default a 3-day TTL when the caller didn't specify one (undefined). An
    // explicit null is honoured as "never expires".
    const expiresAt =
      input.expiresAt === undefined
        ? new Date(Date.now() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000)
        : input.expiresAt;
    const clarification = await this.prisma.pendingClarification.create({
      data: {
        question: input.question,
        reason: input.reason,
        missingFields: (input.missingFields ?? []) as Prisma.InputJsonValue,
        suggestedOptions: (input.suggestedOptions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        sourceMessageId: input.sourceMessageId ?? null,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        plannerContext: (input.plannerContext ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        expiresAt,
        status: 'pending',
      },
    });

    await this.whatsapp.sendClarificationQuestion(env().OWNER_WHATSAPP_NUMBER, {
      question: input.question,
      options: input.suggestedOptions ?? null,
    });

    await this.audit.success('clarification.created', { id: clarification.id }, {
      entityType: 'PendingClarification',
      entityId: clarification.id,
    });

    return clarification;
  }

  /** The oldest still-pending clarification, if any. */
  async findOldestPending() {
    return this.prisma.pendingClarification.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
  }

  async markAnswered(id: string, answerText: string, answerMessageId?: string | null) {
    const updated = await this.prisma.pendingClarification.update({
      where: { id },
      data: {
        status: 'answered',
        answerText,
        answerMessageId: answerMessageId ?? null,
        answeredAt: new Date(),
      },
    });
    await this.audit.success('clarification.answered', { id, answerText }, {
      entityType: 'PendingClarification',
      entityId: id,
    });
    return updated;
  }

  async expireStale(now = new Date()) {
    return this.prisma.pendingClarification.updateMany({
      where: { status: 'pending', expiresAt: { not: null, lt: now } },
      data: { status: 'expired' },
    });
  }
}
