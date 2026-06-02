import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

/**
 * Minimal admin UI. A single HTML dashboard plus JSON endpoints backing each
 * panel (recent messages, pending clarifications/approvals, open loops, tasks,
 * calendar proposals, documents, media, failed jobs, action logs).
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  async dashboard(@Res() res: Response): Promise<void> {
    const [
      messages,
      clarifications,
      approvals,
      loops,
      tasks,
      events,
      documents,
      media,
      logs,
    ] = await Promise.all([
      this.prisma.whatsAppMessage.count(),
      this.prisma.pendingClarification.count({ where: { status: 'pending' } }),
      this.prisma.approval.count({ where: { status: 'pending' } }),
      this.prisma.openLoop.count({ where: { status: { not: 'done' } } }),
      this.prisma.task.count({ where: { status: { in: ['open', 'in_progress'] } } }),
      this.prisma.calendarEvent.count({ where: { status: 'proposed' } }),
      this.prisma.documentDraft.count(),
      this.prisma.mediaAsset.count(),
      this.prisma.actionLog.count(),
    ]);

    const card = (label: string, value: number, href: string) =>
      `<a class="card" href="${href}"><div class="num">${value}</div><div>${label}</div></a>`;

    res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><title>Work Assistant — Admin</title>
<style>
body{font-family:system-ui,Arial;margin:24px;background:#0f172a;color:#e2e8f0}
h1{font-size:20px}
.grid{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;min-width:150px;color:#e2e8f0;text-decoration:none;display:block}
.card:hover{border-color:#6366f1}
.num{font-size:28px;font-weight:700}
a{color:#93c5fd}
</style></head><body>
<h1>WhatsApp Work Assistant — Admin</h1>
<div class="grid">
${card('הודעות', messages, '/admin/messages')}
${card('הבהרות ממתינות', clarifications, '/admin/clarifications')}
${card('אישורים ממתינים', approvals, '/admin/approvals')}
${card('לולאות פתוחות', loops, '/admin/open-loops')}
${card('משימות', tasks, '/admin/tasks')}
${card('הצעות יומן', events, '/admin/calendar')}
${card('מסמכים', documents, '/admin/documents')}
${card('קבצי מדיה', media, '/admin/media')}
${card('Action logs', logs, '/admin/logs')}
${card('Failed jobs', 0, '/admin/failed-jobs')}
</div>
</body></html>`);
  }

  @Get('messages')
  messages() {
    return this.prisma.whatsAppMessage.findMany({ orderBy: { receivedAt: 'desc' }, take: 50 });
  }

  @Get('clarifications')
  clarifications() {
    return this.prisma.pendingClarification.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  @Get('approvals')
  approvals() {
    return this.prisma.approval.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  @Get('open-loops')
  openLoops() {
    return this.prisma.openLoop.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Get('tasks')
  tasks() {
    return this.prisma.task.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Get('calendar')
  calendar() {
    return this.prisma.calendarEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  @Get('documents')
  documents() {
    return this.prisma.documentDraft.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  @Get('media')
  media() {
    return this.prisma.mediaAsset.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  @Get('logs')
  logs() {
    return this.prisma.actionLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Get('failed-jobs')
  async failedJobs() {
    const jobs = await this.queue.getFailedJobs();
    return jobs.map((j) => ({
      id: j.id,
      name: j.name,
      attemptsMade: j.attemptsMade,
      failedReason: j.failedReason,
      data: j.data,
    }));
  }
}
