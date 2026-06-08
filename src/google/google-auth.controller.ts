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
  async status(): Promise<{ connected: boolean; email?: string; error?: string }> {
    const authorized = await this.auth.isAuthorized();
    if (!authorized) return { connected: false, error: 'No token stored. Visit /auth/google to connect.' };
    try {
      const client = await this.auth.getAuthorizedClient();
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const info = await oauth2.userinfo.get();
      return { connected: true, email: info.data.email ?? undefined };
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
