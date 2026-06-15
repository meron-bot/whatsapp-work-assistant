import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';
import { env } from '../config/env';
import { GoogleAuthService } from '../google/google-auth.service';
import { GmailHit, GoogleGmailService } from '../google/google-gmail.service';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { isWithinActiveHours } from './quiet-hours';

/** AgentMemory key holding the Gmail message ids already triaged (so a message
 *  is classified and reported at most once, across restarts). */
const NOTIFIED_KEY = 'emailTriage.notifiedIds';
/** Cap the remembered-id list; older ids age out of the unread query anyway. */
const MAX_REMEMBERED = 200;
/** How many unread messages to look at per scan. */
const SCAN_LIMIT = 10;

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int().min(0),
      important: z.boolean(),
      summary: z.string(),
    }),
  ),
});

const TRIAGE_SYSTEM = `You triage the owner's Gmail inbox for their WhatsApp assistant. Input: a JSON array of unread emails as {index, from, subject, snippet}.
Decide for EACH email whether it is IMPORTANT enough to interrupt the owner on WhatsApp.
IMPORTANT = a real person writing to the owner about their work or life: clients, partners, deadlines, money, contracts, meeting changes, a direct question, anything waiting on the owner's reply or action.
NOT important = newsletters, marketing, automated notifications, receipts, social-network updates, calendar robots, mass mailings.
When unsure, prefer NOT important — never spam the owner.
"summary" is ONE short Hebrew line saying who wants what (e.g. "אשר מבקש אישור על הפרוטוקול עד מחר").
Return ONLY a JSON object: {"verdicts":[{"index":number,"important":boolean,"summary":string}]} — one verdict per input email, no markdown.`;

/**
 * Proactive inbox watcher (the email-triage sub-agent): every 15 minutes inside
 * the owner's active window, scan unread primary-inbox mail, classify importance
 * with the cheap model, and push a short Hebrew digest of the important ones to
 * WhatsApp — so the owner never has to dig through the inbox to find what
 * actually needs them.
 *
 * Honesty/safety: it only ever NOTIFIES (read-only on Gmail); replying still
 * goes through the normal planner + approval flow. Every failure path is
 * silent-but-logged — a triage hiccup must never page the owner.
 */
@Injectable()
export class EmailTriageService {
  private readonly logger = new AppLogger('EmailTriage');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly gmail: GoogleGmailService,
    private readonly googleAuth: GoogleAuthService,
    private readonly ai: AiService,
  ) {}

  @Cron('*/15 * * * *', { timeZone: 'Asia/Jerusalem' })
  async scheduledScan(): Promise<void> {
    await this.scan(new Date());
  }

  async scan(now: Date): Promise<void> {
    if (!env().EMAIL_TRIAGE_ENABLED) return;
    if (!isWithinActiveHours(now)) return; // quiet-hours gate
    if (!(await this.googleAuth.isAuthorized())) return;

    let hits: GmailHit[];
    try {
      hits = await this.gmail.search('in:inbox is:unread category:primary newer_than:1d', SCAN_LIMIT);
    } catch (e) {
      this.logger.warn('Inbox scan failed', { error: (e as Error).message });
      return;
    }

    const seen = await this.loadNotified();
    const fresh = hits.filter((h) => h.id && !seen.includes(h.id));
    if (!fresh.length) return;

    // Classify BEFORE marking as seen: if the AI call fails we want the next
    // scan to retry these messages, not lose them forever.
    let verdicts: z.infer<typeof verdictSchema>['verdicts'];
    try {
      verdicts = await this.classify(fresh);
    } catch (e) {
      this.logger.warn('Triage classification failed', { error: (e as Error).message });
      return;
    }

    await this.saveNotified([...seen, ...fresh.map((h) => h.id)]);

    const important = verdicts.filter((v) => v.important && fresh[v.index]);
    if (!important.length) return;

    const lines = [important.length === 1 ? '📧 מייל חשוב בתיבה:' : '📧 מיילים חשובים בתיבה:'];
    for (const v of important) {
      lines.push(`• ${shortFrom(fresh[v.index].from)} — ${v.summary}`);
    }
    lines.push('');
    lines.push('רוצה שאנסח תשובה? תגיד לי לאיזה מהם.');
    await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, lines.join('\n'));
  }

  private async classify(emails: GmailHit[]) {
    const payload = emails.map((h, index) => ({
      index,
      from: h.from,
      subject: h.subject,
      snippet: h.snippet,
    }));
    const raw = await this.ai.complete({
      system: TRIAGE_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      jsonMode: true,
      temperature: 0,
      maxTokens: 1000,
      tier: 'light',
    });
    return verdictSchema.parse(safeParseJson(raw)).verdicts;
  }

  private async loadNotified(): Promise<string[]> {
    const row = await this.prisma.agentMemory.findUnique({ where: { key: NOTIFIED_KEY } });
    const ids = (row?.value as { ids?: unknown })?.ids;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  }

  private async saveNotified(ids: string[]): Promise<void> {
    const value = { ids: ids.slice(-MAX_REMEMBERED) };
    await this.prisma.agentMemory.upsert({
      where: { key: NOTIFIED_KEY },
      create: { key: NOTIFIED_KEY, value, source: 'email-triage' },
      update: { value },
    });
  }
}

/** "דנה כהן <dana@x.com>" → "דנה כהן"; bare addresses stay as-is. */
function shortFrom(from: string): string {
  const name = from.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  return name || from.trim();
}

/** Tolerant of stray markdown fences / surrounding prose; never of missing structure. */
function safeParseJson(raw: string): unknown {
  let cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }
  return JSON.parse(cleaned);
}
