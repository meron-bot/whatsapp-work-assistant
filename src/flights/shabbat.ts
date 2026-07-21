import { Injectable } from '@nestjs/common';
import { AppLogger } from '../logger/logger.service';

/**
 * Shabbat safety for flight itineraries.
 *
 * The owner is shomer Shabbat, so an itinerary is disqualified if ANY part of
 * the journey — a flight segment or a layover on the ground — overlaps Shabbat.
 * Two design rules follow from "a false 'kosher' is much worse than a false
 * reject":
 *
 *  1. The forbidden window is the UNION of the Shabbat windows at BOTH ends of
 *     the route. Zanzibar sits near the equator on the same UTC+3 clock as
 *     Israel, so its Shabbat starts ~74 min EARLIER (18:06 vs 19:20) and ends
 *     ~73 min earlier (19:07 vs 20:20). Taking min(start) and max(end) means we
 *     are never permissive wherever the owner actually is.
 *  2. An airport we cannot place on the absolute timeline (no timezone known)
 *     makes the whole itinerary UNVERIFIABLE, never "safe". Those are reported
 *     to the owner as a count so the table below can be extended, rather than
 *     silently dropped.
 *
 * Times come from Hebcal (free, no API key, CC-BY): candle lighting 18 min
 * before sunset, havdalah 42 min after sundown — the common Israeli stringency.
 */

const HEBCAL_BASE = 'https://www.hebcal.com/shabbat';

/** Both ends of the route, used to build the union window. */
const ROUTE_ENDS = [
  { name: 'TLV', latitude: 32.0117, longitude: 34.8867, tzid: 'Asia/Jerusalem' },
  { name: 'ZNZ', latitude: -6.2224, longitude: 39.2249, tzid: 'Africa/Dar_es_Salaam' },
];

/**
 * Airports plausibly on a TLV↔ZNZ itinerary → IANA timezone. Google Flights
 * reports each time as wall-clock LOCAL to its airport with no offset, so
 * without this map a segment cannot be placed on the absolute timeline at all.
 * IANA names (not fixed offsets) so DST is handled for TLV/IST/CAI/AMM.
 */
const AIRPORT_TZ: Record<string, string> = {
  TLV: 'Asia/Jerusalem',
  ZNZ: 'Africa/Dar_es_Salaam',
  DAR: 'Africa/Dar_es_Salaam',
  JRO: 'Africa/Dar_es_Salaam',
  NBO: 'Africa/Nairobi',
  ADD: 'Africa/Addis_Ababa',
  EBB: 'Africa/Kampala',
  KGL: 'Africa/Kigali',
  MBA: 'Africa/Nairobi',
  IST: 'Europe/Istanbul',
  SAW: 'Europe/Istanbul',
  DXB: 'Asia/Dubai',
  SHJ: 'Asia/Dubai',
  AUH: 'Asia/Dubai',
  DOH: 'Asia/Qatar',
  MCT: 'Asia/Muscat',
  RUH: 'Asia/Riyadh',
  JED: 'Asia/Riyadh',
  AMM: 'Asia/Amman',
  CAI: 'Africa/Cairo',
  SEZ: 'Indian/Mahe',
  ATH: 'Europe/Athens',
  LCA: 'Asia/Nicosia',
};

/** One absolute Shabbat interval (union across the route's endpoints). */
export interface ShabbatWindow {
  start: Date;
  end: Date;
}

/** A single flown leg, as returned by the flights client. */
export interface Segment {
  departureAirport: string;
  /** Wall-clock local to `departureAirport`, "YYYY-MM-DD HH:mm". */
  departureTime: string;
  arrivalAirport: string;
  /** Wall-clock local to `arrivalAirport`, "YYYY-MM-DD HH:mm". */
  arrivalTime: string;
}

export type ShabbatVerdict =
  | { status: 'safe' }
  | { status: 'conflict'; reason: string }
  | { status: 'unverifiable'; reason: string };

interface HebcalItem {
  category?: string;
  date?: string;
}

/**
 * Fetches and caches Shabbat windows. Instances are long-lived (one per
 * process); entries never expire because the Shabbat times for a given date do
 * not change.
 */
@Injectable()
export class ShabbatCalendar {
  private readonly logger = new AppLogger('Shabbat');
  /** key: `${place}|${YYYY-MM-DD of the Friday}` → window at that single place. */
  private readonly cache = new Map<string, ShabbatWindow | null>();

  /**
   * Every Shabbat window that overlaps [from, to], as absolute instants.
   * Returns [] only if Hebcal is unreachable — callers MUST treat an empty
   * result as "cannot verify" rather than "no Shabbat in range".
   */
  async windows(from: Date, to: Date): Promise<ShabbatWindow[]> {
    const out: ShabbatWindow[] = [];
    // Walk Fridays from the Friday of (or before) `from` until past `to`.
    for (const friday of fridaysBetween(from, to)) {
      const perPlace: ShabbatWindow[] = [];
      for (const place of ROUTE_ENDS) {
        const w = await this.windowAt(place, friday);
        if (w) perPlace.push(w);
      }
      // Missing either end means we cannot build a trustworthy union.
      if (perPlace.length !== ROUTE_ENDS.length) continue;
      out.push({
        start: new Date(Math.min(...perPlace.map((w) => w.start.getTime()))),
        end: new Date(Math.max(...perPlace.map((w) => w.end.getTime()))),
      });
    }
    return out;
  }

  private async windowAt(
    place: (typeof ROUTE_ENDS)[number],
    friday: Date,
  ): Promise<ShabbatWindow | null> {
    const day = isoDate(friday);
    const key = `${place.name}|${day}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const [y, m, d] = day.split('-');
    const url =
      `${HEBCAL_BASE}?cfg=json&latitude=${place.latitude}&longitude=${place.longitude}` +
      `&tzid=${encodeURIComponent(place.tzid)}&gy=${y}&gm=${Number(m)}&gd=${Number(d)}` +
      `&b=18&m=42&M=off&leyning=off`;

    let window: ShabbatWindow | null = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = ((await res.json()) as { items?: HebcalItem[] }).items ?? [];
      // Hebcal returns these as ISO strings WITH offset, so Date parses them to
      // the correct absolute instant without any timezone maths on our side.
      const candles = items.find((i) => i.category === 'candles')?.date;
      const havdalah = items.find((i) => i.category === 'havdalah')?.date;
      if (candles && havdalah) {
        window = { start: new Date(candles), end: new Date(havdalah) };
      }
    } catch (e) {
      this.logger.warn('Hebcal lookup failed', {
        place: place.name,
        day,
        error: (e as Error).message,
      });
      return null; // NOT cached — a transient failure must be retried next run.
    }

    this.cache.set(key, window);
    return window;
  }
}

/**
 * Verdict for a whole trip: every segment (in the air) and every layover (on the
 * ground between connecting segments) must clear every Shabbat window.
 *
 * Each journey is passed SEPARATELY — `[outboundLegs, returnLegs]` — because
 * layovers only exist WITHIN a journey. Flattening the two halves into one list
 * would make the week in Zanzibar look like a connection at ZNZ, and since that
 * "layover" spans the intervening Shabbat it would reject every round trip.
 * Time spent at the destination is a holiday, not a transit.
 */
export function checkShabbat(journeys: Segment[][], windows: ShabbatWindow[]): ShabbatVerdict {
  if (!windows.length) {
    return { status: 'unverifiable', reason: 'לא הצלחתי לקבל זמני שבת' };
  }

  const unknown = new Set<string>();
  const intervals: { from: Date; to: Date; label: string }[] = [];

  for (const segments of journeys) {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const dep = toInstant(s.departureTime, s.departureAirport, unknown);
      const arr = toInstant(s.arrivalTime, s.arrivalAirport, unknown);
      if (dep && arr) {
        intervals.push({ from: dep, to: arr, label: `${s.departureAirport}→${s.arrivalAirport}` });
      }

      // Layover: on the ground at this airport until the next leg of the SAME
      // journey departs it.
      const next = segments[i + 1];
      if (next && next.departureAirport === s.arrivalAirport) {
        const out = toInstant(next.departureTime, next.departureAirport, unknown);
        if (arr && out && out.getTime() > arr.getTime()) {
          intervals.push({ from: arr, to: out, label: `עצירה ב-${s.arrivalAirport}` });
        }
      }
    }
  }

  if (unknown.size) {
    return {
      status: 'unverifiable',
      reason: `אין לי אזור זמן לשדה ${[...unknown].join(', ')}`,
    };
  }

  for (const w of windows) {
    for (const iv of intervals) {
      if (overlaps(iv.from, iv.to, w.start, w.end)) {
        return { status: 'conflict', reason: `${iv.label} חופף לשבת` };
      }
    }
  }
  return { status: 'safe' };
}

/** Half-open overlap: touching endpoints (landing exactly at candle lighting)
 *  is treated as clear, which matches how the times are already stringent. */
function overlaps(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): boolean {
  return aFrom.getTime() < bTo.getTime() && bFrom.getTime() < aTo.getTime();
}

/** "2026-07-29 07:15" local to `airport` → absolute instant. */
function toInstant(local: string, airport: string, unknown: Set<string>): Date | null {
  const tz = AIRPORT_TZ[airport?.toUpperCase()];
  if (!tz) {
    unknown.add(airport || '?');
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(local?.trim() ?? '');
  if (!match) {
    unknown.add(airport);
    return null;
  }
  const [, y, mo, d, h, mi] = match;
  // Read the wall clock as if it were UTC, then subtract the zone's offset at
  // that moment. The second pass fixes the rare case where the first guess
  // lands on the other side of a DST transition.
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  let instant = new Date(asUtc - tzOffsetMs(new Date(asUtc), tz));
  const settled = tzOffsetMs(instant, tz);
  if (settled !== tzOffsetMs(new Date(asUtc), tz)) instant = new Date(asUtc - settled);
  return instant;
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return local - at.getTime();
}

/** Every Friday whose Shabbat could overlap [from, to] (one day of slack). */
function fridaysBetween(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const cursor = new Date(from.getTime() - 86_400_000);
  cursor.setUTCHours(12, 0, 0, 0);
  // Rewind to the most recent Friday (UTC day 5) at or before the start.
  while (cursor.getUTCDay() !== 5) cursor.setUTCDate(cursor.getUTCDate() - 1);
  const limit = to.getTime() + 86_400_000;
  while (cursor.getTime() <= limit) {
    out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
