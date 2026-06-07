import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { decrypt, encrypt } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN_KEY = 'google:refresh_token';

// Least-privilege scopes for the features we use.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  // Read access is required to search mail and resolve contact emails.
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
];

/**
 * Google OAuth. The refresh token is stored encrypted in AgentMemory. An
 * authorized OAuth2 client is produced on demand for the per-API services.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new AppLogger('GoogleAuthService');

  constructor(private readonly prisma: PrismaService) {}

  private baseClient(): OAuth2Client {
    return new google.auth.OAuth2(
      env().GOOGLE_CLIENT_ID,
      env().GOOGLE_CLIENT_SECRET,
      env().GOOGLE_REDIRECT_URI,
    );
  }

  generateAuthUrl(): string {
    return this.baseClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_SCOPES,
    });
  }

  async handleCallback(code: string): Promise<void> {
    const client = this.baseClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('No refresh_token returned. Re-consent with prompt=consent.');
    }
    await this.prisma.agentMemory.upsert({
      where: { key: TOKEN_KEY },
      create: { key: TOKEN_KEY, value: { enc: encrypt(tokens.refresh_token) }, source: 'oauth' },
      update: { value: { enc: encrypt(tokens.refresh_token) } },
    });
    this.logger.log('Stored encrypted Google refresh token');
  }

  async isAuthorized(): Promise<boolean> {
    const row = await this.prisma.agentMemory.findUnique({ where: { key: TOKEN_KEY } });
    return !!row;
  }

  /** Returns an authorized client or throws if Google is not connected. */
  async getAuthorizedClient(): Promise<OAuth2Client> {
    const row = await this.prisma.agentMemory.findUnique({ where: { key: TOKEN_KEY } });
    if (!row) throw new Error('Google account not connected. Visit /auth/google.');
    const enc = (row.value as { enc: string }).enc;
    const client = this.baseClient();
    client.setCredentials({ refresh_token: decrypt(enc) });
    return client;
  }
}
