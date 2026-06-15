import { Injectable } from '@nestjs/common';
import { OpenLoopStatus, Priority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateOpenLoopInput {
  title: string;
  description?: string | null;
  status?: OpenLoopStatus;
  priority?: Priority;
  dueDate?: Date | null;
  nextCheckAt?: Date | null;
  linkedTaskId?: string | null;
  linkedEventId?: string | null;
  linkedDocumentId?: string | null;
  linkedMediaId?: string | null;
  linkedApprovalId?: string | null;
  linkedClarificationId?: string | null;
  sourceMessageId?: string | null;
}

/** The not-yet-finished statuses a loop can be closed from. */
const UNFINISHED: OpenLoopStatus[] = ['open', 'waiting_for_owner', 'waiting_for_other'];

/**
 * Open loops guarantee that nothing actionable disappears: any unfinished work
 * has a tracked loop until it is closed.
 */
@Injectable()
export class OpenLoopService {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateOpenLoopInput) {
    return this.prisma.openLoop.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? 'open',
        priority: input.priority ?? 'medium',
        dueDate: input.dueDate ?? null,
        nextCheckAt: input.nextCheckAt ?? null,
        linkedTaskId: input.linkedTaskId ?? null,
        linkedEventId: input.linkedEventId ?? null,
        linkedDocumentId: input.linkedDocumentId ?? null,
        linkedMediaId: input.linkedMediaId ?? null,
        linkedApprovalId: input.linkedApprovalId ?? null,
        linkedClarificationId: input.linkedClarificationId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
      },
    });
  }

  listOpen() {
    return this.prisma.openLoop.findMany({
      where: { status: { in: UNFINISHED } },
      orderBy: { createdAt: 'desc' },
    });
  }

  close(id: string) {
    return this.prisma.openLoop.update({ where: { id }, data: { status: 'done' } });
  }

  /** Close every unfinished loop tied to an approval once it is decided: 'done'
   *  when the action was approved (and will/just ran), 'ignored' when rejected.
   *  Returns the number of loops closed. */
  closeByApproval(approvalId: string, status: 'done' | 'ignored' = 'done') {
    return this.prisma.openLoop
      .updateMany({
        where: { linkedApprovalId: approvalId, status: { in: UNFINISHED } },
        data: { status },
      })
      .then((r) => r.count);
  }

  /** Close every unfinished loop tied to a clarification once it is answered
   *  ('done') or has expired without an answer ('ignored'). */
  closeByClarification(clarificationId: string, status: 'done' | 'ignored' = 'done') {
    return this.prisma.openLoop
      .updateMany({
        where: { linkedClarificationId: clarificationId, status: { in: UNFINISHED } },
        data: { status },
      })
      .then((r) => r.count);
  }
}
