import * as crypto from 'crypto';
import { WhatsAppService } from '../src/whatsapp/whatsapp.service';
import { WhatsAppWebhookPayload } from '../src/whatsapp/whatsapp.types';

process.env.META_APP_SECRET = 'test_secret';
process.env.OWNER_WHATSAPP_NUMBER = '972500000000';
process.env.WHATSAPP_ACCESS_TOKEN = 'x';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'x';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify';
process.env.DATABASE_URL = 'postgresql://x';

describe('WhatsAppService', () => {
  const svc = new WhatsAppService();

  // (1) Webhook verification building block + (signature) — verifySignature
  it('verifies a valid HMAC signature and rejects an invalid one', () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const good =
      'sha256=' + crypto.createHmac('sha256', 'test_secret').update(body).digest('hex');
    expect(svc.verifySignature(body, good)).toBe(true);
    expect(svc.verifySignature(body, 'sha256=deadbeef')).toBe(false);
    expect(svc.verifySignature(body, undefined)).toBe(false);
  });

  // (3) Text message parsing
  it('parses an incoming text message', () => {
    const payload: WhatsAppWebhookPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: '972511111111' },
                messages: [
                  { id: 'wamid.1', from: '972500000000', timestamp: '1700000000', type: 'text', text: { body: 'שלום' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const [msg] = svc.parseIncomingMessage(payload);
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('שלום');
    expect(msg.whatsappMessageId).toBe('wamid.1');
  });

  // (4) Audio message parsing (pipeline entry)
  it('parses an incoming audio (voice note) message', () => {
    const payload: WhatsAppWebhookPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: '972511111111' },
                messages: [
                  { id: 'wamid.2', from: '972500000000', timestamp: '1700000001', type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg', voice: true } },
                ],
              },
            },
          ],
        },
      ],
    };
    const [msg] = svc.parseIncomingMessage(payload);
    expect(msg.type).toBe('audio');
    expect(msg.mediaId).toBe('media-1');
    expect(msg.mimeType).toBe('audio/ogg');
  });

  it('enforces the owner allowlist', () => {
    expect(svc.isFromOwner('972500000000')).toBe(true);
    expect(svc.isFromOwner('+972-50-000-0000')).toBe(true);
    expect(svc.isFromOwner('972599999999')).toBe(false);
  });
});
