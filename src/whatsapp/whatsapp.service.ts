import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import * as crypto from 'crypto';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  NormalizedIncomingMessage,
  WhatsAppIncomingRaw,
  WhatsAppWebhookPayload,
} from './whatsapp.types';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

/** Sender marker stored on outbound (assistant) rows in WhatsAppMessage. It has
 *  no digits, so isFromOwner() classifies it as NOT the owner — i.e. as פליי. */
const ASSISTANT_SENDER = 'assistant';

export interface ApprovalView {
  actionType: string;
  description: string;
  recipient?: string | null;
  details?: string | null;
  riskReason: string;
}

export interface ClarificationView {
  question: string;
  options?: string[] | null;
}

/**
 * WhatsApp Business Cloud API integration. Owns webhook parsing, signature
 * verification, media download and all outbound messaging.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new AppLogger('WhatsAppService');

  constructor(private readonly prisma: PrismaService) {}

  // ----- Inbound -----

  /** Verify the X-Hub-Signature-256 header against META_APP_SECRET. */
  verifySignature(rawBody: Buffer, signatureHeader?: string): boolean {
    const secret = env().META_APP_SECRET;
    if (!secret) return true; // optional in dev
    if (!signatureHeader) return false;
    const expected =
      'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /** Extract all messages from a webhook payload (usually 0 or 1). */
  parseIncomingMessage(payload: WhatsAppWebhookPayload): NormalizedIncomingMessage[] {
    const out: NormalizedIncomingMessage[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const toNumber = value?.metadata?.display_phone_number ?? '';
        for (const m of value?.messages ?? []) {
          out.push(this.normalize(m, toNumber));
        }
      }
    }
    return out;
  }

  private normalize(m: WhatsAppIncomingRaw, toNumber: string): NormalizedIncomingMessage {
    const base = {
      whatsappMessageId: m.id,
      fromNumber: m.from,
      toNumber,
      timestamp: m.timestamp,
      raw: m,
      text: null as string | null,
      mediaId: null as string | null,
      mimeType: null as string | null,
      filename: null as string | null,
    };
    switch (m.type) {
      case 'text':
        return { ...base, type: 'text', text: m.text?.body ?? null };
      case 'audio':
        return { ...base, type: 'audio', mediaId: m.audio?.id ?? null, mimeType: m.audio?.mime_type ?? null };
      case 'image':
        return { ...base, type: 'image', text: m.image?.caption ?? null, mediaId: m.image?.id ?? null, mimeType: m.image?.mime_type ?? null };
      case 'video':
        return { ...base, type: 'video', text: m.video?.caption ?? null, mediaId: m.video?.id ?? null, mimeType: m.video?.mime_type ?? null };
      case 'document':
        return { ...base, type: 'document', text: m.document?.caption ?? null, mediaId: m.document?.id ?? null, mimeType: m.document?.mime_type ?? null, filename: m.document?.filename ?? null };
      default:
        return { ...base, type: 'unknown' };
    }
  }

  isFromOwner(fromNumber: string): boolean {
    const owner = env().OWNER_WHATSAPP_NUMBER.replace(/\D/g, '');
    return fromNumber.replace(/\D/g, '') === owner;
  }

  // ----- Media -----

  async getMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string }> {
    const res = await axios.get(`${GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${env().WHATSAPP_ACCESS_TOKEN}` },
    });
    return { url: res.data.url, mimeType: res.data.mime_type };
  }

  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const { url, mimeType } = await this.getMediaUrl(mediaId);
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${env().WHATSAPP_ACCESS_TOKEN}` },
    });
    return { buffer: Buffer.from(res.data), mimeType };
  }

  // ----- Outbound -----

  private async post(body: Record<string, unknown>): Promise<string | null> {
    try {
      const res = await axios.post(
        `${GRAPH_BASE}/${env().WHATSAPP_PHONE_NUMBER_ID}/messages`,
        { messaging_product: 'whatsapp', ...body },
        { headers: { Authorization: `Bearer ${env().WHATSAPP_ACCESS_TOKEN}` } },
      );
      return res.data?.messages?.[0]?.id ?? null;
    } catch (e) {
      // Never surface internal errors to WhatsApp; just log.
      this.logger.error('Failed to send WhatsApp message', {
        error: axios.isAxiosError(e) ? e.response?.data : (e as Error).message,
      });
      return null;
    }
  }

  async sendText(to: string, body: string): Promise<string | null> {
    const messageId = await this.post({ to, type: 'text', text: { preview_url: false, body } });
    await this.recordOutbound(to, body, messageId);
    return messageId;
  }

  /**
   * Persist an outbound reply so the planner can later replay BOTH sides of the
   * conversation. Without this, the assistant only ever saw the owner's latest
   * message and kept re-asking for details already provided. Best-effort: a
   * logging failure must never block messaging, and a message that was never
   * delivered (no id back from the API) is not part of the visible thread.
   */
  private async recordOutbound(
    to: string,
    body: string,
    messageId: string | null,
  ): Promise<void> {
    if (!messageId) return;
    try {
      await this.prisma.whatsAppMessage.create({
        data: {
          whatsappMessageId: messageId,
          fromNumber: ASSISTANT_SENDER,
          toNumber: to,
          messageType: 'text',
          rawPayload: {} as Prisma.InputJsonValue,
          textContent: body,
          status: 'processed',
          processedAt: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn('Failed to record outbound message for conversation history', {
        error: (e as Error).message,
      });
    }
  }

  async sendTemplate(
    to: string,
    templateName: string,
    parameters: string[] = [],
    languageCode = 'he',
  ): Promise<string | null> {
    return this.post({
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: parameters.length
          ? [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    });
  }

  async markMessageAsRead(messageId: string): Promise<void> {
    await this.post({ status: 'read', message_id: messageId });
  }

  async sendApprovalRequest(to: string, approval: ApprovalView): Promise<string | null> {
    const lines = [
      'נדרש אישור:',
      approval.description,
    ];
    if (approval.recipient) lines.push(`נמען: ${approval.recipient}`);
    if (approval.details) lines.push(approval.details);
    lines.push(`פעולה: ${approval.actionType}`);
    lines.push(`סיבה: ${approval.riskReason}`);
    lines.push('');
    lines.push("כתוב או הקלט: 'אשר' / 'בטל' / 'שנה את הטקסט'");
    return this.sendText(to, lines.join('\n'));
  }

  async sendClarificationQuestion(to: string, c: ClarificationView): Promise<string | null> {
    const lines = [c.question];
    if (c.options?.length) {
      c.options.forEach((opt, i) => lines.push(`${i + 1}. ${opt}`));
    }
    return this.sendText(to, lines.join('\n'));
  }
}
