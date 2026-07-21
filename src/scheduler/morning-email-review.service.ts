import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';
import { env } from '../config/env';
import { GoogleAuthService } from '../google/google-auth.service';
import { GmailDetailedHit, GoogleGmailService } from '../google/google-gmail.service';
import { AppLogger } from '../logger/logger.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { isWorkday } from './quiet-hours';

/** How many of yesterday's emails to read per morning (bounds cost + prompt size). */
const SCAN_LIMIT = 20;
/** Cap the surfaced list so the morning message stays scannable on a phone. */
const MAX_ITEMS = 12;

const reviewSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        due: z.string().nullish(),
        from: z.string().nullish(),
      }),
    )
    .default([]),
  events: z
    .array(
      z.object({
        title: z.string().min(1),
        when: z.string().nullish(),
        from: z.string().nullish(),
      }),
    )
    .default([]),
});

type Review = z.infer<typeof reviewSchema>;

const REVIEW_SYSTEM = `You read the owner's emails from YESTERDAY and pull out ONLY concrete, actionable items the owner should handle. Input: a JSON array of emails as {index, from, subject, body}.
Extract two kinds of items:
- "tasks": a concrete to-do the owner must DO themselves (reply, send, prepare, review, pay, call, sign...). Each: {"title": short Hebrew imperative, "due": ISO date or null, "from": sender name}.
- "events": a meeting/appointment/deadline that has a DATE or TIME (a לו"ז). Each: {"title": short Hebrew, "when": ISO datetime/date or null, "from": sender name}.
Rules:
- Owner-owned action items ONLY. IGNORE newsletters, marketing, receipts, automated notifications, FYI-only mail, and anything that doesn't require the owner to act.
- NEVER invent a date — if no clear date/time is stated, use null. Do not guess names or facts.
- Titles are short, plain Hebrew that say WHAT to do (e.g. "לאשר לאשר קופר את הפרוטוקול").
- When unsure, leave it out. A short accurate list beats a long noisy one. It is fine to return empty arrays.
Return ONLY a JSON object: {"tasks":[...],"events":[...]} — no markdown.`;

/**
 * Morning email review (the owner's explicit ask): each work-day morning, right
 * after the daily plan, read YESTERDAY's primary inbox, extract candidate tasks
 * and schedule items (לו"זים), and send ONE numbered Hebrew list for the owner
 * to approve. Nothing is created here — the owner replies "הכל" / "1, 3" and the
 * normal planner (which sees this message in the conversation history) creates
 * exactly the chosen items. This keeps the real task list clean: no auto-added
 * noise, one decision per morning.
 *
 * Read-only on Gmail; every failure path is silent-but-logged so a hiccup never
 * pages the owner.
 */
@Injectable()
export class MorningEmailReviewService {
  private readonly logger = new AppLogger('MorningEmailReview');

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly gmail: GoogleGmailService,
    private readonly googleAuth: GoogleAuthService,
    private readonly ai: AiService,
  ) {}

  // 07:35 — just after the 07:30 daily plan, so the owner gets the plan first and
  // this focused "from yesterday's mail" follow-up second.
  @Cron('35 7 * * *', { timeZone: 'Asia/Jerusalem' })
  async scheduledReview(): Promise<void> {
    await this.review(new Date());
  }

  async review(now: Date): Promise<void> {
    if (!env().MORNING_EMAIL_REVIEW_ENABLED) return;
    if (!isWorkday(now)) return; // no proactive briefings on Fri/Sat
    if (!(await this.googleAuth.isAuthorized())) return;

    let hits: GmailDetailedHit[];
    try {
      hits = await this.gmail.searchDetailed(this.yesterdayQuery(now), SCAN_LIMIT);
    } catch (e) {
      this.logger.warn("Yesterday's inbox scan failed", { error: (e as Error).message });
      return;
    }
    if (!hits.length) return;

    let review: Review;
    try {
      review = await this.extract(hits);
    } catch (e) {
      this.logger.warn('Email extraction failed', { error: (e as Error).message });
      return;
    }

    const message = this.compose(review);
    if (!message) return; // nothing actionable found — stay silent
    await this.whatsapp.sendText(env().OWNER_WHATSAPP_NUMBER, message);
  }

  /** Gmail query bounding the search to YESTERDAY (owner's timezone), primary inbox. */
  private yesterdayQuery(now: Date): string {
    const ymd = (d: Date) =>
      d.toLocaleDateString('en-CA', { timeZone: env().OWNER_TIMEZONE }).replace(/-/g, '/');
    const today = ymd(now);
    const yesterday = ymd(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    // after: is inclusive of that day, before: is exclusive → exactly yesterday.
    return `in:inbox category:primary after:${yesterday} before:${today}`;
  }

  private async extract(emails: GmailDetailedHit[]): Promise<Review> {
    const payload = emails.map((h, index) => ({
      index,
      from: h.from,
      subject: h.subject,
      body: h.body,
    }));
    const raw = await this.ai.complete({
      system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      jsonMode: true,
      temperature: 0,
      maxTokens: 1200,
      // Default (heavy) model: extraction is harder than the triage's yes/no call,
      // and this runs only once per morning, so accuracy beats the cheap tier.
    });
    return reviewSchema.parse(safeParseJson(raw));
  }

  /** Build the numbered approval message, or '' when there is nothing to add.
   *  Numbering is CONTINUOUS across both sections so a reply like "1, 3" is
   *  unambiguous. */
  private compose(review: Review): string {
    const tasks = review.tasks.slice(0, MAX_ITEMS);
    const events = review.events.slice(0, MAX_ITEMS - tasks.length);
    if (!tasks.length && !events.length) return '';

    const lines: string[] = ['📥 עברתי על המיילים של אתמול. הנה מה שאולי כדאי להוסיף:'];
    let n = 1;

    if (tasks.length) {
      lines.push('');
      lines.push('משימות:');
      for (const t of tasks) {
        const due = t.due ? ` (עד ${this.fmt(t.due)})` : '';
        const who = t.from ? ` — ${shortFrom(t.from)}` : '';
        lines.push(`${n}. ${t.title}${due}${who}`);
        n++;
      }
    }

    if (events.length) {
      lines.push('');
      lines.push('לו"ז (פגישות/דדליינים):');
      for (const ev of events) {
        const when = ev.when ? ` — ${this.fmt(ev.when)}` : '';
        const who = ev.from ? ` — ${shortFrom(ev.from)}` : '';
        lines.push(`${n}. ${ev.title}${when}${who}`);
        n++;
      }
    }

    lines.push('');
    lines.push('רוצה שאוסיף? ענה "הכל", או מספרים (למשל: 1, 3). אם לא רלוונטי — פשוט תתעלם.');
    return lines.join('\n');
  }

  /** Readable Hebrew date/time for an ISO string; returns it as-is if unparseable
   *  (anti-hallucination: never drop a value just because it isn't clean ISO). */
  private fmt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // Date-only (no time component) → show just the date.
    const hasTime = /\d{2}:\d{2}/.test(iso);
    return d.toLocaleString('he-IL', {
      timeZone: env().OWNER_TIMEZONE,
      dateStyle: 'short',
      ...(hasTime ? { timeStyle: 'short' } : {}),
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
