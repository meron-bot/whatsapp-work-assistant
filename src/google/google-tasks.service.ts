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
      requestBody: { title, notes: notes ?? undefined, due: due ?? undefined },
    });
    return res.data.id ?? '';
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
