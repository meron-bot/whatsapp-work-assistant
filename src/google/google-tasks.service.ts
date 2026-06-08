import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { GoogleAuthService } from './google-auth.service';

@Injectable()
export class GoogleTasksService {
  constructor(private readonly auth: GoogleAuthService) {}

  private async api() {
    const client = await this.auth.getAuthorizedClient();
    return google.tasks({ version: 'v1', auth: client });
  }

  async createTask(title: string, notes?: string | null, due?: string | null): Promise<string> {
    const tasks = await this.api();
    const res = await tasks.tasks.insert({
      tasklist: '@default',
      requestBody: { title, notes: notes ?? undefined, due: this.toTasksDue(due) },
    });
    return res.data.id ?? '';
  }

  /**
   * Google Tasks' `due` field only records the DATE (the time of day is
   * discarded), and the API rejects RFC 3339 timestamps that carry sub-second
   * precision — `new Date().toISOString()` produces `...T00:00:00.000Z`, whose
   * `.000` milliseconds trigger a 400 "Request contains an invalid argument".
   * (Google Calendar tolerates the same value, which is why events synced but
   * tasks silently didn't.) Normalize to a clean midnight-UTC RFC 3339 string
   * with no milliseconds, e.g. `2026-06-08T00:00:00Z`.
   */
  private toTasksDue(due?: string | null): string | undefined {
    if (!due) return undefined;
    const d = new Date(due);
    if (Number.isNaN(d.getTime())) return undefined;
    return `${d.toISOString().slice(0, 10)}T00:00:00Z`;
  }

  async completeTask(taskId: string): Promise<void> {
    const tasks = await this.api();
    await tasks.tasks.patch({
      tasklist: '@default',
      task: taskId,
      requestBody: { status: 'completed' },
    });
  }

  async listOpen() {
    const tasks = await this.api();
    const res = await tasks.tasks.list({ tasklist: '@default', showCompleted: false });
    return res.data.items ?? [];
  }
}
