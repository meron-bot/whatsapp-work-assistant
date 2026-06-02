import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppLogger } from '../logger/logger.service';
import { GoogleAuthService } from './google-auth.service';

@Controller('auth/google')
export class GoogleAuthController {
  private readonly logger = new AppLogger('GoogleAuthController');

  constructor(private readonly auth: GoogleAuthService) {}

  @Get()
  redirect(@Res() res: Response): void {
    res.redirect(this.auth.generateAuthUrl());
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
