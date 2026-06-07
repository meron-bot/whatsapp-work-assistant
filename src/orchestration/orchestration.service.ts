import { Injectable } from '@nestjs/common';
import { env } from '../config/env';
import { GoogleAuthService } from '../google/google-auth.service';
import { GoogleCalendarService } from '../google/google-calendar.service';
import { GoogleGmailService } from '../google/google-gmail.service';
import { AppLogger } from '../logger/logger.service';
import { LearnedFactService } from '../memory/learned-fact.service';
import { ToolRequest } from '../planner/planner.schema';

/**
 * The sub-agent layer. Runs the tools/sub-agents the planner requested (calendar
 * availability, calendar agenda, Gmail contact lookup, Gmail search, web
 * research) and returns short text findings that are fed back into the planner
 * for a second pass — this is what lets the assistant resolve missing context on
 * its own before ever asking the owner.
 *
 * Contract: resolve() NEVER throws. A tool that fails (not connected, API error)
 * becomes a finding the planner can react to (assume / ask), so one broken tool
 * never breaks message processing.
 */
@Injectable()
export class OrchestrationService {
  private readonly logger = new AppLogger('Orchestration');

  constructor(
    private readonly calendar: GoogleCalendarService,
    private readonly gmail: GoogleGmailService,
    private readonly googleAuth: GoogleAuthService,
    private readonly memory: LearnedFactService,
  ) {}

  async resolve(requests: ToolRequest[], sourceMessageId?: string): Promise<string[]> {
    const out: string[] = [];
    for (const r of requests) {
      try {
        out.push(await this.resolveOne(r, sourceMessageId));
      } catch (e) {
        this.logger.warn('Tool failed', { tool: r.tool, error: (e as Error).message });
        out.push(`[${r.tool} "${r.query}"] failed: ${(e as Error).message}`);
      }
    }
    return out;
  }

  private async resolveOne(r: ToolRequest, sourceMessageId?: string): Promise<string> {
    switch (r.tool) {
      case 'calendar_freebusy':
        return this.freebusy(r.query);
      case 'calendar_agenda':
        return this.agenda(r.query);
      case 'gmail_find_contact':
        return this.findContact(r.query, sourceMessageId);
      case 'gmail_search':
        return this.gmailSearch(r.query);
      case 'web_research':
        return `[web_research "${r.query}"] לא זמין כרגע — הסתמך על הקשר, הנח הנחה סבירה, או שאל את מירון.`;
      default:
        return `[${(r as ToolRequest).tool}] כלי לא מוכר.`;
    }
  }

  // --- calendar ---

  private async freebusy(query: string): Promise<string> {
    if (!(await this.googleAuth.isAuthorized())) return this.notConnected();
    const { min, max } = this.parseRange(query);
    const busy = await this.calendar.checkFreeBusy(min.toISOString(), max.toISOString());
    const label = `${this.fmt(min)}–${this.fmt(max)}`;
    if (!busy.length) {
      return `[זמינות ${label}] כל הטווח פנוי (אין אירועים חופפים). שעות עבודה מקובלות: 08:00–19:00.`;
    }
    const lines = busy.map((b) => `  תפוס: ${this.fmt(new Date(b.start))}–${this.fmt(new Date(b.end))}`);
    return `[זמינות ${label}] שעות עבודה 08:00–19:00. החלונות התפוסים:\n${lines.join('\n')}`;
  }

  private async agenda(query: string): Promise<string> {
    if (!(await this.googleAuth.isAuthorized())) return this.notConnected();
    const day = this.parseDay(query);
    const events = day ? await this.calendar.listForDay(day) : await this.calendar.listUpcoming(10);
    const scope = day ? this.fmtDate(day) : 'הקרובים';
    if (!events.length) return `[יומן ${scope}] אין אירועים.`;
    const lines = events.map((e) => {
      const start = e.start?.dateTime ?? e.start?.date ?? '';
      const when = start ? this.fmt(new Date(start)) : '';
      return `  ${when} — ${e.summary ?? '(ללא כותרת)'}`;
    });
    return `[יומן ${scope}]\n${lines.join('\n')}`;
  }

  // --- gmail ---

  private async findContact(name: string, sourceMessageId?: string): Promise<string> {
    if (!(await this.googleAuth.isAuthorized())) return this.notConnected();
    const found = await this.gmail.findContactEmail(name);
    if (!found) {
      return `[איש קשר "${name}"] לא נמצאה כתובת מייל ב-Gmail. שאל את מירון פעם אחת מה הכתובת.`;
    }
    // Remember the contact so we never have to look it up (or ask) again.
    await this.memory.applyWrites(
      [
        {
          type: 'contact',
          subject: found.displayName || name,
          content: `${found.displayName || name}: ${found.email}`,
          confidence: 0.6,
        },
      ],
      sourceMessageId ?? null,
    );
    return `[איש קשר "${name}"] כתובת מייל: ${found.email}${
      found.displayName ? ` (${found.displayName})` : ''
    }. נשמר לזיכרון.`;
  }

  private async gmailSearch(query: string): Promise<string> {
    if (!(await this.googleAuth.isAuthorized())) return this.notConnected();
    const hits = await this.gmail.search(query, 5);
    if (!hits.length) return `[חיפוש מייל "${query}"] לא נמצאו תוצאות.`;
    const lines = hits.map(
      (h) => `  מאת ${h.from} | ${h.subject}\n    ${h.snippet}`,
    );
    return `[חיפוש מייל "${query}"]\n${lines.join('\n')}`;
  }

  // --- helpers ---

  private notConnected(): string {
    return 'Google עדיין לא מחובר — אי אפשר לחפש ביומן/מייל. אם צריך, בקש ממירון לחבר חשבון.';
  }

  /** Parse a query into a {min,max} range. Accepts "startISO/endISO", a single
   *  ISO date, or empty (= next 7 days). */
  private parseRange(query: string): { min: Date; max: Date } {
    const q = (query || '').trim();
    if (q.includes('/')) {
      const [a, b] = q.split('/');
      const min = new Date(a);
      const max = new Date(b);
      if (!Number.isNaN(min.getTime()) && !Number.isNaN(max.getTime())) return { min, max };
    }
    const day = this.parseDay(q);
    if (day) {
      const min = new Date(day);
      min.setHours(0, 0, 0, 0);
      const max = new Date(day);
      max.setHours(23, 59, 59, 999);
      return { min, max };
    }
    return { min: new Date(), max: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };
  }

  /** Parse a single day from a query; null if not a date. */
  private parseDay(query: string): Date | null {
    const q = (query || '').trim();
    if (!q || q.includes('/')) return null;
    const d = new Date(q);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private fmt(d: Date): string {
    return d.toLocaleString('he-IL', {
      timeZone: env().OWNER_TIMEZONE,
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  private fmtDate(d: Date): string {
    return d.toLocaleDateString('he-IL', { timeZone: env().OWNER_TIMEZONE });
  }
}
