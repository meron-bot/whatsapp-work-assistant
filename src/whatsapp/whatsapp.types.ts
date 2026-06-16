export type IncomingMessageType =
  | 'text'
  | 'audio'
  | 'image'
  | 'video'
  | 'document'
  | 'unknown';

export interface NormalizedIncomingMessage {
  whatsappMessageId: string;
  fromNumber: string;
  toNumber: string;
  type: IncomingMessageType;
  text: string | null;
  mediaId: string | null;
  mimeType: string | null;
  filename: string | null;
  timestamp: string;
  raw: unknown;
}

// --- Minimal subset of the Meta WhatsApp Cloud API webhook payload ---

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  id?: string;
  changes?: WhatsAppChange[];
}

export interface WhatsAppChange {
  field?: string;
  value?: {
    messaging_product?: string;
    metadata?: { display_phone_number?: string; phone_number_id?: string };
    contacts?: { profile?: { name?: string }; wa_id?: string }[];
    messages?: WhatsAppIncomingRaw[];
    statuses?: unknown[];
  };
}

export interface WhatsAppIncomingRaw {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  /** Present when the owner used WhatsApp's "reply" on a specific earlier
   *  message; `id` is that quoted message's whatsappMessageId. Lets the assistant
   *  resolve "this/it/that" against the exact message being replied to. */
  context?: { id?: string; from?: string };
  text?: { body: string };
  audio?: { id: string; mime_type: string; voice?: boolean };
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
}
