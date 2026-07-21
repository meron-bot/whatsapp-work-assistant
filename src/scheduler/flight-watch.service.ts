import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { env } from '../config/env';
import {
  FlightOption,
  FlightSearchClient,
  googleFlightsLink,
} from '../flights/flight-search.client';
import { ShabbatCalendar, checkShabbat } from '../flights/shabbat';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

const STATE_KEY = 'flightWatch.state';
/** Keep the observed-price series bounded; it only feeds "is this cheap?". */
const MAX_HISTORY = 200;
/** A deal this far under the threshold is worth waking the owner for. */
const URGENT_MARGIN = 0.15;
/** Re-alerting the same combo needs at least this much further improvement. */
const RE_ALERT_DROP = 0.03;

// Type aliases (not interfaces) so these stay structurally assignable to
// Prisma's Json input type when the state is persisted.
type ComboState = {
  checkedAt: string;
  /** Cheapest total whose OUTBOUND cleared Shabbat (phase 1 only). */
  candidatePrice?: number;
  /** Cheapest total with BOTH directions Shabbat-verified (phase 2). */
  price?: number;
  airlines?: string[];
  stops?: number;
  priceLevel?: string;
  typicalRange?: [number, number];
  /** Price at which we last told the owner about this combo. */
  alertedAt?: number;
};

type WatchState = {
  combos: Record<string, ComboState>;
  history: [string, number][];
  lastDigestOn?: string;
  unknownAirports?: string[];
};

/**
 * The flight-deal sub-agent: watches TLV↔ZNZ for a Shabbat-safe round trip for
 * two, and pushes a WhatsApp alert the moment something genuinely good appears.
 *
 * Three ideas carry the whole design:
 *
 *  1. **Budget beats brute force.** The search space (every outbound date ×
 *     6–8 nights) is far larger than the API quota, so each run spends a fixed
 *     number of requests: mostly on the least-recently-checked combos, always
 *     including the current price leaders so a drop on a live favourite is
 *     caught within one cycle rather than one full rotation.
 *  2. **Never alert on an unverified itinerary.** Phase 1 prices a date pair and
 *     kills Shabbat-conflicting outbounds cheaply; only combos that would
 *     actually trigger an alert pay for phase-2 return-leg verification.
 *  3. **Interrupt in proportion to the find.** A deal far under budget rings
 *     through the night; an ordinary drop waits for a civilised hour. Missing a
 *     mistake fare and being woken for a $30 wobble are both failures.
 *
 * The agent only ever NOTIFIES — booking stays with the owner.
 */
@Injectable()
export class FlightWatchService {
  private readonly logger = new AppLogger('FlightWatch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly flights: FlightSearchClient,
    private readonly shabbat: ShabbatCalendar,
  ) {}

  @Cron('7 */3 * * *', { timeZone: 'Asia/Jerusalem' })
  async scheduledSweep(): Promise<void> {
    await this.sweep(new Date());
  }

  async sweep(now: Date): Promise<void> {
    const cfg = env();
    if (!cfg.FLIGHT_WATCH_ENABLED) return;
    if (!this.flights.configured) {
      this.logger.warn('SERPAPI_API_KEY missing — flight watch idle');
      return;
    }

    const combos = candidateCombos(now);
    if (!combos.length) return;

    const windows = await this.shabbat.windows(
      new Date(cfg.FLIGHT_WATCH_WINDOW_START),
      addDays(new Date(cfg.FLIGHT_WATCH_WINDOW_END), cfg.FLIGHT_WATCH_MAX_NIGHTS),
    );
    if (!windows.length) {
      // Without Shabbat times every result would be "unverifiable", so a sweep
      // would burn quota and produce nothing. Skip and retry next cycle.
      this.logger.warn('No Shabbat windows available — skipping sweep');
      return;
    }

    const state = await this.loadState();
    const batch = pickBatch(combos, state, cfg.FLIGHT_WATCH_SEARCHES_PER_RUN);
    const unknown = new Set(state.unknownAirports ?? []);

    // ---- phase 1: price each combo, keep only Shabbat-clean outbounds --------
    for (const combo of batch) {
      const params = {
        outboundDate: combo.outbound,
        returnDate: combo.return,
        adults: cfg.FLIGHT_WATCH_ADULTS,
        stops: cfg.FLIGHT_WATCH_MAX_STOPS,
      };
      const res = await this.flights.searchOutbound(params);
      const prev = state.combos[combo.key] ?? { checkedAt: new Date(0).toISOString() };
      if (!res) {
        state.combos[combo.key] = { ...prev, checkedAt: now.toISOString() };
        continue;
      }

      const clean = res.options.filter((o) => {
        const v = checkShabbat([o.segments], windows);
        if (v.status === 'unverifiable') collectUnknown(v.reason, unknown);
        return v.status === 'safe';
      });
      const cheapest = clean.length ? clean.reduce((a, b) => (a.price <= b.price ? a : b)) : null;

      state.combos[combo.key] = {
        ...prev,
        checkedAt: now.toISOString(),
        candidatePrice: cheapest?.price,
        priceLevel: res.insights?.priceLevel ?? prev.priceLevel,
        typicalRange: res.insights?.typicalRange ?? prev.typicalRange,
        // A verified price from an earlier run is stale once the candidate
        // moves, so clear it and let phase 2 re-establish it.
        price: cheapest?.price === prev.candidatePrice ? prev.price : undefined,
      };

      if (cheapest?.departureToken) {
        // Stash for phase 2 without persisting the (large, short-lived) token.
        combo.leader = cheapest;
      }
    }

    // ---- phase 2: verify return legs, only where it could matter ------------
    const threshold = cfg.FLIGHT_WATCH_ALERT_TOTAL;
    const worthVerifying = batch
      .filter((c) => c.leader && typeof c.leader.price === 'number')
      .filter((c) => {
        const p = c.leader!.price;
        return p <= threshold * 1.15 || p <= bestVerified(state) * 1.02;
      })
      .sort((a, b) => a.leader!.price - b.leader!.price)
      .slice(0, cfg.FLIGHT_WATCH_VERIFY_PER_RUN);

    for (const combo of worthVerifying) {
      const returns = await this.flights.searchReturns(
        {
          outboundDate: combo.outbound,
          returnDate: combo.return,
          adults: cfg.FLIGHT_WATCH_ADULTS,
          stops: cfg.FLIGHT_WATCH_MAX_STOPS,
        },
        combo.leader!.departureToken!,
      );
      if (!returns?.length) continue;

      const clean = returns.filter((o) => {
        // Outbound and return as separate journeys — see checkShabbat.
        const v = checkShabbat([combo.leader!.segments, o.segments], windows);
        if (v.status === 'unverifiable') collectUnknown(v.reason, unknown);
        return v.status === 'safe';
      });
      if (!clean.length) continue;

      const winner = clean.reduce((a, b) => (a.price <= b.price ? a : b));
      const entry = state.combos[combo.key];
      state.combos[combo.key] = {
        ...entry,
        // The return-leg result carries the true total for the pair, which can
        // exceed the phase-1 headline when the cheapest return hits Shabbat.
        price: winner.price,
        airlines: [...new Set([...combo.leader!.airlines, ...winner.airlines])],
        stops: Math.max(combo.leader!.stops, winner.stops),
      };
    }

    state.unknownAirports = [...unknown].slice(0, 10);
    const best = bestCombo(state);
    if (best) {
      state.history.push([now.toISOString(), best.entry.price!]);
      state.history = state.history.slice(-MAX_HISTORY);
    }

    await this.notify(now, state, best);
    await this.saveState(state);
  }

  /** Decides whether this sweep is worth interrupting the owner for. */
  private async notify(
    now: Date,
    state: WatchState,
    best: { key: string; entry: ComboState } | null,
  ): Promise<void> {
    const cfg = env();
    const today = ownerDate(now);

    if (best?.entry.price !== undefined) {
      const price = best.entry.price;
      const threshold = cfg.FLIGHT_WATCH_ALERT_TOTAL;
      const previouslyAlerted = best.entry.alertedAt;
      const improvedEnough =
        previouslyAlerted === undefined || price <= previouslyAlerted * (1 - RE_ALERT_DROP);

      if (price <= threshold && improvedEnough) {
        const urgent = price <= threshold * (1 - URGENT_MARGIN);
        if (urgent || withinWakingHours(now)) {
          await this.whatsapp.sendText(
            cfg.OWNER_WHATSAPP_NUMBER,
            dealMessage(best.key, best.entry, state, urgent, now),
          );
          state.combos[best.key] = { ...best.entry, alertedAt: price };
          return; // one message per sweep — never stack an alert and a digest
        }
      }
    }

    // Daily digest: one orientation message a day, even when nothing hit the
    // threshold, so the owner can see the trend instead of only the extremes.
    if (state.lastDigestOn !== today && ownerHour(now) >= cfg.FLIGHT_WATCH_DIGEST_HOUR) {
      state.lastDigestOn = today;
      await this.whatsapp.sendText(cfg.OWNER_WHATSAPP_NUMBER, digestMessage(state, now));
    }
  }

  private async loadState(): Promise<WatchState> {
    const row = await this.prisma.agentMemory.findUnique({ where: { key: STATE_KEY } });
    const v = row?.value as unknown as Partial<WatchState> | undefined;
    return {
      combos: v?.combos && typeof v.combos === 'object' ? v.combos : {},
      history: Array.isArray(v?.history) ? v.history : [],
      lastDigestOn: v?.lastDigestOn,
      unknownAirports: v?.unknownAirports,
    };
  }

  private async saveState(state: WatchState): Promise<void> {
    await this.prisma.agentMemory.upsert({
      where: { key: STATE_KEY },
      create: { key: STATE_KEY, value: state, source: 'flight-watch' },
      update: { value: state },
    });
  }
}

// ---------------------------------------------------------------------------
// candidate generation + batching
// ---------------------------------------------------------------------------

interface Combo {
  key: string;
  outbound: string;
  return: string;
  /** Cheapest phase-1 option with a Shabbat-clean outbound, pending phase 2. */
  leader?: FlightOption;
}

/**
 * Every (outbound date, trip length) pair in the configured window. Saturday
 * departures and returns are dropped here rather than searched: on this route
 * essentially nothing on a Saturday clears Shabbat, so paying to find that out
 * would waste roughly two sevenths of the quota. Friday IS still searched — an
 * early-morning Friday departure that lands well before candle lighting is
 * legitimate, and the per-segment check decides.
 */
function candidateCombos(now: Date): Combo[] {
  const cfg = env();
  const start = new Date(cfg.FLIGHT_WATCH_WINDOW_START);
  const end = new Date(cfg.FLIGHT_WATCH_WINDOW_END);
  // Never search a date that has already passed.
  const floor = new Date(Math.max(start.getTime(), addDays(now, 1).getTime()));
  const out: Combo[] = [];

  for (let d = new Date(floor); d <= end; d = addDays(d, 1)) {
    if (d.getUTCDay() === 6) continue; // Saturday departure
    for (let nights = cfg.FLIGHT_WATCH_MIN_NIGHTS; nights <= cfg.FLIGHT_WATCH_MAX_NIGHTS; nights++) {
      const back = addDays(d, nights);
      if (back.getUTCDay() === 6) continue; // Saturday return
      const outbound = iso(d);
      const ret = iso(back);
      out.push({ key: `${outbound}|${nights}`, outbound, return: ret });
    }
  }
  return out;
}

/**
 * Which combos to spend this run's requests on: the current price leaders
 * (so a drop on a live favourite is caught within one cycle) plus the
 * least-recently-checked (so the whole window keeps rotating).
 */
function pickBatch(combos: Combo[], state: WatchState, budget: number): Combo[] {
  const priced = combos
    .filter((c) => typeof state.combos[c.key]?.candidatePrice === 'number')
    .sort(
      (a, b) =>
        state.combos[a.key].candidatePrice! - state.combos[b.key].candidatePrice!,
    );
  const leaders = priced.slice(0, Math.min(3, Math.floor(budget / 3)));

  const chosen = new Map(leaders.map((c) => [c.key, c]));
  const stale = [...combos].sort(
    (a, b) => checkedMs(state, a.key) - checkedMs(state, b.key),
  );
  for (const c of stale) {
    if (chosen.size >= budget) break;
    chosen.set(c.key, c);
  }
  return [...chosen.values()];
}

function checkedMs(state: WatchState, key: string): number {
  const at = state.combos[key]?.checkedAt;
  return at ? new Date(at).getTime() : 0;
}

function bestCombo(state: WatchState): { key: string; entry: ComboState } | null {
  let best: { key: string; entry: ComboState } | null = null;
  for (const [key, entry] of Object.entries(state.combos)) {
    if (typeof entry.price !== 'number') continue;
    if (!best || entry.price < best.entry.price!) best = { key, entry };
  }
  return best;
}

function bestVerified(state: WatchState): number {
  const b = bestCombo(state);
  return b?.entry.price ?? Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

function dealMessage(
  key: string,
  entry: ComboState,
  state: WatchState,
  urgent: boolean,
  now: Date,
): string {
  const cfg = env();
  const [outbound, nights] = key.split('|');
  const back = iso(addDays(new Date(outbound), Number(nights)));
  const perPerson = Math.round(entry.price! / cfg.FLIGHT_WATCH_ADULTS);

  const lines = [
    urgent ? '🚨 מחיר חריג לזנזיבר — שווה לסגור עכשיו' : '✈️ נמצאה טיסה מתחת לתקציב',
    '',
    `${fmtDate(outbound)} → ${fmtDate(back)}  (${nights} לילות)`,
    `${entry.stops === 0 ? 'ישירה' : `${entry.stops} עצירות`} · ${entry.airlines?.join(', ') ?? ''}`,
    '',
    `💵 ${money(entry.price!)} לשני הכרטיסים`,
    `   (${money(perPerson)} לאדם)`,
    '',
    buyAdvice(entry, state, now),
    '',
    `🔗 ${googleFlightsLink(outbound, back, cfg.FLIGHT_WATCH_ADULTS)}`,
    '',
    'שבת נבדקה — אין קטע טיסה או עצירה בין כניסת שבת לצאתה.',
  ];
  return lines.join('\n');
}

function digestMessage(state: WatchState, now: Date): string {
  const cfg = env();
  const ranked = Object.entries(state.combos)
    .filter(([, e]) => typeof e.price === 'number' || typeof e.candidatePrice === 'number')
    .sort((a, b) => shownPrice(a[1]) - shownPrice(b[1]))
    .slice(0, 3);

  if (!ranked.length) {
    return 'זנזיבר: עוד לא מצאתי אפשרות ששומרת שבת בחלון שביקשת. ממשיך לבדוק.';
  }

  const lines = ['✈️ זנזיבר — מצב מחירים', ''];
  for (const [key, entry] of ranked) {
    const [outbound, nights] = key.split('|');
    const back = iso(addDays(new Date(outbound), Number(nights)));
    const tag = entry.price !== undefined ? '' : ' (הלוך בלבד נבדק)';
    lines.push(
      `${fmtDate(outbound)}→${fmtDate(back)} · ${money(shownPrice(entry))}${tag}`,
    );
  }

  const best = bestCombo(state);
  lines.push('', `התקציב שלך: ${money(cfg.FLIGHT_WATCH_ALERT_TOTAL)} לשניים.`);
  if (best) lines.push('', buyAdvice(best.entry, state, now));
  if (state.unknownAirports?.length) {
    lines.push('', `שים לב: דילגתי על מסלולים דרך ${state.unknownAirports.join(', ')} — אין לי אזור זמן שלהם לבדיקת שבת.`);
  }
  return lines.join('\n');
}

function shownPrice(e: ComboState): number {
  return e.price ?? e.candidatePrice ?? Number.POSITIVE_INFINITY;
}

/**
 * "Should I buy?" — Google's own price level, our observed series, and how
 * close the departure is. Near departure the honest answer is almost always
 * "lock it in": fares on this route climb into the last fortnight, so waiting
 * for a dip that historically does not come is the expensive mistake.
 */
function buyAdvice(entry: ComboState, state: WatchState, now: Date): string {
  const cfg = env();
  const days = daysUntil(cfg.FLIGHT_WATCH_WINDOW_START, now);
  const prices = state.history.map(([, p]) => p);
  const seenMin = prices.length ? Math.min(...prices) : undefined;
  const isBestSoFar = entry.price !== undefined && (seenMin === undefined || entry.price <= seenMin);

  if (days <= 21) {
    return isBestSoFar
      ? '🟢 המלצה: לסגור. זה הזול ביותר שראיתי, ופחות מ-3 שבועות ליציאה — מכאן המחירים בדרך כלל רק עולים.'
      : '🟡 המלצה: לסגור בקרוב. פחות מ-3 שבועות ליציאה, וזה החלון שבו מחירים מטפסים ולא יורדים.';
  }
  if (entry.priceLevel === 'low') {
    return '🟢 המלצה: לסגור. גוגל מסמן את המחיר הזה כנמוך ביחס לקו הזה.';
  }
  if (entry.priceLevel === 'high') {
    return '🔴 המלצה: לחכות. גוגל מסמן את המחיר כגבוה — יש עוד זמן, אמשיך לעקוב.';
  }
  if (entry.typicalRange) {
    return `🟡 הטווח הרגיל בקו הזה: ${money(entry.typicalRange[0])}–${money(entry.typicalRange[1])}. אמשיך לעקוב.`;
  }
  return '🟡 עוד אין לי מספיק היסטוריה כדי להגיד אם זה זול. אמשיך לעקוב.';
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Deal alerts deliberately do NOT use the work-hours gate: a fare that lands
 *  on a Friday evening is still worth having, and 20:00 is not an intrusion.
 *  Only genuine night hours are protected — and an urgent deal overrides even
 *  those, because a mistake fare rarely survives until morning. */
function withinWakingHours(now: Date): boolean {
  const h = ownerHour(now);
  return h >= 7 && h < 23;
}

function ownerHour(now: Date): number {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: env().OWNER_TIMEZONE,
    hour: 'numeric',
    hour12: false,
  }).format(now);
  const n = parseInt(h, 10);
  return Number.isNaN(n) || n === 24 ? 0 : n;
}

function ownerDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env().OWNER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function collectUnknown(reason: string, into: Set<string>): void {
  const m = /לשדה (.+)$/.exec(reason);
  if (m) for (const code of m[1].split(', ')) into.add(code.trim());
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-');
  const names = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const wd = names[new Date(`${y}-${m}-${d}T12:00:00Z`).getUTCDay()];
  return `${Number(d)}.${Number(m)} (${wd}')`;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function daysUntil(isoDay: string, now: Date): number {
  return Math.ceil((new Date(isoDay).getTime() - now.getTime()) / 86_400_000);
}
