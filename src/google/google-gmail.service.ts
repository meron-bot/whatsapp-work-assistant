import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { GoogleAuthService } from './google-auth.service';

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
}

@Injectable()
export class GoogleGmailService {
  constructor(private readonly auth: GoogleAuthService) {}

  private async api() {
    const client = await this.auth.getAuthorizedClient();
    return google.gmail({ version: 'v1', auth: client });
  }

  private encodeMessage(input: DraftInput): string {
    const lines = [
      `To: ${input.to}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      `Subject: ${input.subject}`,
      '',
      input.body,
    ];
    return Buffer.from(lines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /** Create a draft only. Never sends. */
  async createDraft(input: DraftInput): Promise<string> {
    const gmail = await this.api();
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: this.encodeMessage(input) } },
    });
    return res.data.id ?? '';
  }

  /** Send an existing draft. MUST only be called after explicit approval. */
  async sendDraft(draftId: string): Promise<string> {
    const gmail = await this.api();
    const res = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
    return res.data.id ?? '';
  }
}
