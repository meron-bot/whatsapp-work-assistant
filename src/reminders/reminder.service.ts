import { Injectable } from '@nestjs/common';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

export interface CreateReminderInput {
  title: string;
  description?: string | null;
  remindAt: Date;
  taskId?: string | null;
  sourceMessageId?: string | null;
}

@Injectable()
export class ReminderService {
  private readonly logger = new AppLogger('ReminderService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  create(input: CreateReminderInput) {
    return this.prisma.reminder.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        remindAt: input.remindAt,
        taskId: input.taskId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
      },
    });
  }

  /** Dispatch all due reminders. Called by the per-minute scheduler. */
  async dispatchDue(now = new Date()): Promise<number> {
    const due = await this.prisma.reminder.findMany({
      where: { status: 'pending', remindAt: { lte: now } },
    });
    let sent = 0;
    for (const r of due) {
      const body = `תזכורת: ${r.title}${r.description ? `\n${r.description}` : ''}`;
      const messageId = await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, body);
      await this.prisma.reminder.update({
        where: { id: r.id },
        data: { status: messageId ? 'sent' : 'pending' },
      });
      if (messageId) sent++;
    }
    return sent;
  }
}
