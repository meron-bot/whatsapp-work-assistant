import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Last auto-registration outcome, surfaced at /status for browser-based diagnosis. */
export interface WebhookRegistrationStatus {
  attempted: boolean;
  subscriptionOk: boolean;
  wabaSubscribeOk: boolean;
  callbackUrl: string | null;
  skippedReason: string | null;
  error: string | null;
  ranAt: string | null;
}

/**
 * Registers this deployment's webhook with Meta automatically on startup, so the
 * owner never has to touch the Meta dashboard or run a script. Safe + idempotent:
 * it only runs when fully configured over HTTPS, and never throws (failures are
 * logged and the app keeps running).
 */
@Injectable()
export class WebhookRegistrarService {
  private readonly logger = new AppLogger('WebhookRegistrar');

  private status: WebhookRegistrationStatus = {
    attempted: false,
    subscriptionOk: false,
    wabaSubscribeOk: false,
    callbackUrl: null,
    skippedReason: null,
    error: null,
    ranAt: null,
  };

  /** Latest registration result (for /status). */
  getStatus(): WebhookRegistrationStatus {
    return this.status;
  }

  async registerIfConfigured(): Promise<void> {
    const e = env();
    const base = e.APP_BASE_URL;
    this.status.ranAt = new Date().toISOString();

    if (!base.startsWith('https://')) {
      this.status.skippedReason = 'APP_BASE_URL is not https';
      this.logger.warn('Skipping webhook auto-register (APP_BASE_URL is not https)', { base });
      return;
    }
    // The /{app-id}/subscriptions endpoint requires an APP access token
    // (`{app-id}|{app-secret}`) — the WhatsApp access token is not authorised for
    // app-level webhook subscriptions, so META_APP_SECRET is required here.
    if (
      !e.META_APP_ID ||
      !e.META_APP_SECRET ||
      !e.WHATSAPP_ACCESS_TOKEN ||
      !e.WHATSAPP_VERIFY_TOKEN
    ) {
      this.status.skippedReason =
        'missing META_APP_ID / META_APP_SECRET / WHATSAPP_ACCESS_TOKEN / WHATSAPP_VERIFY_TOKEN';
      this.logger.warn(
        'Skipping webhook auto-register (missing META_APP_ID / META_APP_SECRET / access token / verify token)',
      );
      return;
    }

    this.status.attempted = true;
    const callbackUrl = `${base.replace(/\/$/, '')}/webhooks/whatsapp`;
    this.status.callbackUrl = callbackUrl;

    // 1. Point the app's webhook at this deployment and subscribe to messages.
    //    Uses an APP access token, which is what this endpoint requires.
    const appToken = `${e.META_APP_ID}|${e.META_APP_SECRET}`;
    try {
      await axios.post(
        `${GRAPH}/${e.META_APP_ID}/subscriptions`,
        null,
        {
          params: {
            object: 'whatsapp_business_account',
            callback_url: callbackUrl,
            verify_token: e.WHATSAPP_VERIFY_TOKEN,
            fields: 'messages',
            access_token: appToken,
          },
        },
      );
      this.status.subscriptionOk = true;
      this.logger.log('Webhook subscription registered', { callbackUrl });
    } catch (err) {
      this.status.error = this.describeError(err);
      this.logger.error('Webhook subscription failed (non-fatal)', { error: this.status.error });
    }

    // 2. Subscribe the WhatsApp Business Account to this app. This acts on the
    //    WABA, so it correctly uses the WhatsApp (system-user) access token.
    if (e.WHATSAPP_BUSINESS_ACCOUNT_ID) {
      try {
        await axios.post(`${GRAPH}/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`, null, {
          headers: { Authorization: `Bearer ${e.WHATSAPP_ACCESS_TOKEN}` },
        });
        this.status.wabaSubscribeOk = true;
        this.logger.log('WABA subscribed to app');
      } catch (err) {
        const msg = this.describeError(err);
        this.status.error = this.status.error ? `${this.status.error}; ${msg}` : msg;
        this.logger.error('WABA subscription failed (non-fatal)', { error: msg });
      }
    }
  }

  private describeError(err: unknown): string {
    const data = axios.isAxiosError(err) ? err.response?.data : undefined;
    if (data) return JSON.stringify(data).slice(0, 300);
    return (err as Error).message.slice(0, 300);
  }
}
