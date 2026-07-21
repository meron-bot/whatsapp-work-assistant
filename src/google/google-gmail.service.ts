import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { GoogleAuthService } from './google-auth.service';

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
}

export interface GmailHit {
  /** Gmail message id — stable, used to dedupe triage notifications. */
  id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
}

export interface GmailDetailedHit extends GmailHit {
  /** Decoded plain-text body (best-effort; falls back to the snippet). Used by
   *  the morning email review, which needs the actual content to extract tasks
   *  and schedule items — a 100-char snippet is not enough. */
  body: string;
}

@Injectable()
export class GoogleGmailService {
  constructor(private readonly auth: GoogleAuthService) {}

  private async api() {
    const client = await this.auth.getAuthorizedClient();
    return google.gmail({ version: 'v1', auth: client });
  }

  private encodeMessage(input: DraftInput): string {
    const lines = [
      `To: ${input.to}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      `Subject: ${input.subject}`,
      '',
      input.body,
    ];
    return Buffer.from(lines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /** Create a draft only. Never sends. */
  async createDraft(input: DraftInput): Promise<string> {
    const gmail = await this.api();
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: this.encodeMessage(input) } },
    });
    return res.data.id ?? '';
  }

  /** Send an email directly. MUST only be called after explicit owner approval.
   *  Returns the sent message id. */
  async sendEmail(input: DraftInput): Promise<string> {
    const gmail = await this.api();
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: this.encodeMessage(input) },
    });
    return res.data.id ?? '';
  }

  /** Send an existing draft. MUST only be called after explicit approval. */
  async sendDraft(draftId: string): Promise<string> {
    const gmail = await this.api();
    const res = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
    return res.data.id ?? '';
  }

  /** Read-only search over the owner's mail. Returns header/snippet summaries. */
  async search(query: string, maxResults = 5): Promise<GmailHit[]> {
    const gmail = await this.api();
    const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
    const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
    const hits: GmailHit[] = [];
    for (const id of ids) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      const headers = msg.data.payload?.headers ?? [];
      const h = (name: string) =>
        headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
      hits.push({
        id,
        from: h('From'),
        to: h('To'),
        subject: h('Subject'),
        snippet: msg.data.snippet ?? '',
        date: h('Date'),
      });
    }
    return hits;
  }

  /**
   * Like search(), but also fetches and decodes each message's plain-text body.
   * Costs one extra 'full'-format GET per message, so it is used only where the
   * body actually matters (the morning email review), never on the hot triage
   * path. The body is truncated per message to keep the downstream prompt bounded.
   */
  async searchDetailed(query: string, maxResults = 15, maxBodyChars = 1500): Promise<GmailDetailedHit[]> {
    const gmail = await this.api();
    const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
    const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
    const hits: GmailDetailedHit[] = [];
    for (const id of ids) {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = msg.data.payload?.headers ?? [];
      const h = (name: string) =>
        headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
      const snippet = msg.data.snippet ?? '';
      const body = (
        extractPlainText(msg.data.payload as MessagePart | null | undefined) || snippet
      ).slice(0, maxBodyChars);
      hits.push({
        id,
        from: h('From'),
        to: h('To'),
        subject: h('Subject'),
        snippet,
        date: h('Date'),
        body,
      });
    }
    return hits;
  }

  /**
   * Best-effort lookup of a person's email address by name. Searches recent mail
   * involving the name and returns the address whose display-name or local-part
   * matches it, preferring the most frequently seen one. Returns null if nothing
   * convincing is found (caller then asks the owner once).
   */
  async findContactEmail(name: string): Promise<{ email: string; displayName: string } | null> {
    const term = name.trim();
    if (!term) return null;
    const hits = await this.search(term, 10);
    const lower = term.toLowerCase();
    const counts = new Map<string, { email: string; displayName: string; n: number }>();

    for (const hit of hits) {
      for (const field of [hit.from, hit.to]) {
        for (const parsed of parseAddresses(field)) {
          const matches =
            parsed.displayName.toLowerCase().includes(lower) ||
            parsed.email.toLowerCase().includes(lower);
          if (!matches) continue;
          const key = parsed.email.toLowerCase();
          const prev = counts.get(key);
          counts.set(key, {
            email: parsed.email,
            displayName: parsed.displayName || prev?.displayName || '',
            n: (prev?.n ?? 0) + 1,
          });
        }
      }
    }

    let best: { email: string; displayName: string; n: number } | null = null;
    for (const c of counts.values()) if (!best || c.n > best.n) best = c;
    return best ? { email: best.email, displayName: best.displayName } : null;
  }
}

/** Gmail message part shape we care about (a subset of the API type). */
interface MessagePart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: MessagePart[] | null;
}

/** base64url → utf-8 text. */
function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

/**
 * Walk a Gmail message payload and return its readable plain text. Prefers a
 * text/plain part; falls back to a tag-stripped text/html part; '' if neither
 * exists. Recurses through multipart containers (multipart/alternative, /mixed).
 */
function extractPlainText(payload: MessagePart | null | undefined): string {
  if (!payload) return '';
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) return decodeB64Url(plain.body.data).trim();
  const html = findPart(payload, 'text/html');
  if (html?.body?.data) {
    return decodeB64Url(html.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
  return '';
}

/** Depth-first search for the first part whose mimeType matches. */
function findPart(part: MessagePart, mimeType: string): MessagePart | null {
  if (part.mimeType === mimeType) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

/** Parse an RFC-ish address header ("Name" <a@b>, a@b, Name <a@b>, comma list). */
function parseAddresses(header: string): { displayName: string; email: string }[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const angle = part.match(/<([^>]+)>/);
      if (angle) {
        const email = angle[1].trim();
        const displayName = part.slice(0, angle.index).replace(/["']/g, '').trim();
        return { displayName, email };
      }
      const bare = part.trim().match(/[^\s<>]+@[^\s<>]+/);
      return bare ? { displayName: '', email: bare[0] } : null;
    })
    .filter((x): x is { displayName: string; email: string } => !!x && /@/.test(x.email));
}
