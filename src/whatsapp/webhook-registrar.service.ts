import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Registers this deployment's webhook with Meta automatically on startup, so the
 * owner never has to touch the Meta dashboard or run a script. Safe + idempotent:
 * it only runs when fully configured over HTTPS, and never throws (failures are
 * logged and the app keeps running).
 */
@Injectable()
export class WebhookRegistrarService {
  private readonly logger = new AppLogger('WebhookRegistrar');

  async registerIfConfigured(): Promise<void> {
    const e = env();
    const base = e.APP_BASE_URL;
    if (!base.startsWith('https://')) {
      this.logger.warn('Skipping webhook auto-register (APP_BASE_URL is not https)', { base });
      return;
    }
    if (!e.META_APP_ID || !e.WHATSAPP_ACCESS_TOKEN || !e.WHATSAPP_VERIFY_TOKEN) {
      this.logger.warn('Skipping webhook auto-register (missing META_APP_ID / token / verify token)');
      return;
    }

    const callbackUrl = `${base.replace(/\/$/, '')}/webhooks/whatsapp`;
    const auth = { Authorization: `Bearer ${e.WHATSAPP_ACCESS_TOKEN}` };

    // 1. Point the app's webhook at this deployment and subscribe to messages.
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
          },
          headers: auth,
        },
      );
      this.logger.log('Webhook subscription registered', { callbackUrl });
    } catch (err) {
      this.logger.error('Webhook subscription failed (non-fatal)', {
        error: axios.isAxiosError(err) ? err.response?.data : (err as Error).message,
      });
    }

    // 2. Subscribe the WhatsApp Business Account to this app.
    if (e.WHATSAPP_BUSINESS_ACCOUNT_ID) {
      try {
        await axios.post(`${GRAPH}/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`, null, {
          headers: auth,
        });
        this.logger.log('WABA subscribed to app');
      } catch (err) {
        this.logger.error('WABA subscription failed (non-fatal)', {
          error: axios.isAxiosError(err) ? err.response?.data : (err as Error).message,
        });
      }
    }
  }
}
