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
  sourceMessageId?: string | null;
}

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
        sourceMessageId: input.sourceMessageId ?? null,
      },
    });
  }

  listOpen() {
    return this.prisma.openLoop.findMany({
      where: { status: { in: ['open', 'waiting_for_owner', 'waiting_for_other'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  close(id: string) {
    return this.prisma.openLoop.update({ where: { id }, data: { status: 'done' } });
  }
}
