import { Injectable } from '@nestjs/common';
import { ActionResultStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actionType: string;
  entityType?: string | null;
  entityId?: string | null;
  payload: Prisma.InputJsonValue;
  result?: Prisma.InputJsonValue | null;
  status: ActionResultStatus;
  error?: string | null;
}

/**
 * Append-only audit log. Every action the assistant takes (or skips) is
 * recorded here so the owner can reconstruct exactly what happened and why.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry) {
    return this.prisma.actionLog.create({
      data: {
        actionType: entry.actionType,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        payload: entry.payload,
        result: entry.result ?? Prisma.JsonNull,
        status: entry.status,
        error: entry.error ?? null,
      },
    });
  }

  async success(actionType: string, payload: Prisma.InputJsonValue, opts?: Partial<AuditEntry>) {
    return this.record({ actionType, payload, status: 'success', ...opts });
  }

  async failed(actionType: string, payload: Prisma.InputJsonValue, error: string, opts?: Partial<AuditEntry>) {
    return this.record({ actionType, payload, status: 'failed', error, ...opts });
  }

  async skipped(actionType: string, payload: Prisma.InputJsonValue, reason: string, opts?: Partial<AuditEntry>) {
    return this.record({ actionType, payload, status: 'skipped', error: reason, ...opts });
  }
}
