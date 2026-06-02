import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWebhookPayload } from './whatsapp.types';

@Controller('webhooks/whatsapp')
export class WhatsAppController {
  private readonly logger = new AppLogger('WhatsAppController');

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Meta webhook verification handshake. */
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    if (mode === 'subscribe' && token === env().WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send('Forbidden');
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Body() body: WhatsAppWebhookPayload,
    @Headers('x-hub-signature-256') signature: string,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ status: string }> {
    // Signature verification (optional in dev, enforced if META_APP_SECRET set).
    if (req.rawBody && !this.whatsapp.verifySignature(req.rawBody, signature)) {
      this.logger.warn('Invalid webhook signature, ignoring payload');
      return { status: 'ignored' };
    }

    const messages = this.whatsapp.parseIncomingMessage(body);
    for (const msg of messages) {
      // Owner allowlist: only the owner can drive the private assistant.
      if (!this.whatsapp.isFromOwner(msg.fromNumber)) {
        this.logger.warn('Ignoring message from non-owner', { from: msg.fromNumber });
        continue;
      }

      // Idempotency by WhatsApp message id.
      try {
        await this.prisma.whatsAppMessage.create({
          data: {
            whatsappMessageId: msg.whatsappMessageId,
            fromNumber: msg.fromNumber,
            toNumber: msg.toNumber,
            messageType: msg.type,
            rawPayload: msg.raw as Prisma.InputJsonValue,
            textContent: msg.text,
            mediaId: msg.mediaId,
            status: 'queued',
          },
        });
      } catch (e) {
        // Unique violation -> already received this message; skip silently.
        if ((e as { code?: string }).code === 'P2002') {
          this.logger.debug('Duplicate message ignored', { id: msg.whatsappMessageId });
          continue;
        }
        throw e;
      }

      await this.queue.enqueueMessage({ whatsappMessageId: msg.whatsappMessageId });
    }

    return { status: 'ok' };
  }
}
