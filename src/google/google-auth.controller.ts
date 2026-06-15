import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppLogger } from '../logger/logger.service';
import { GoogleAuthService } from './google-auth.service';
import { google } from 'googleapis';

@Controller('auth/google')
export class GoogleAuthController {
  private readonly logger = new AppLogger('GoogleAuthController');

  constructor(private readonly auth: GoogleAuthService) {}

  @Get()
  redirect(@Res() res: Response): void {
    res.redirect(this.auth.generateAuthUrl());
  }

  /** Quick liveness check: is a Google refresh token stored and does it still work?
   *  Open in a browser to verify the connection without reading server logs. */
  @Get('status')
  async status(): Promise<{ connected: boolean; error?: string }> {
    const authorized = await this.auth.isAuthorized();
    if (!authorized) return { connected: false, error: 'No token stored. Visit /auth/google to connect.' };
    try {
      const client = await this.auth.getAuthorizedClient();
      // Probe with a scope we actually hold (tasks). We never request a
      // userinfo/email scope, so oauth2.userinfo.get() would 401 and report a
      // false "disconnected" even when calendar/tasks work fine.
      const tasks = google.tasks({ version: 'v1', auth: client });
      await tasks.tasklists.list({ maxResults: 1 });
      return { connected: true };
    } catch (e) {
      return { connected: false, error: (e as Error).message };
    }
  }

  @Get('callback')
  async callback(@Query('code') code: string, @Res() res: Response): Promise<void> {
    if (!code) {
      res.status(400).send('Missing authorization code');
      return;
    }
    try {
      await this.auth.handleCallback(code);
      res.send('Google account connected. You can close this window.');
    } catch (e) {
      this.logger.error('Google OAuth callback failed', { error: (e as Error).message });
      res.status(500).send('Failed to connect Google account. Check server logs.');
    }
  }
}
