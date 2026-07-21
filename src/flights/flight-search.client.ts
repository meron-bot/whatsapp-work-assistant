import { Injectable } from '@nestjs/common';
import { env } from '../config/env';
import { AppLogger } from '../logger/logger.service';
import { Segment } from './shabbat';

/**
 * Google Flights data via SerpApi.
 *
 * Cost shape drives the whole design, so it is worth stating plainly: a
 * round-trip query returns the OUTBOUND options, each already carrying the
 * ROUND-TRIP total price plus a `departure_token`. The matching return legs
 * cost a SECOND request. That gives us a cheap wide phase and an expensive
 * narrow one:
 *
 *   phase 1 (`searchOutbound`)  — one request per date pair. Enough to price
 *                                 the trip and to disqualify an itinerary whose
 *                                 OUTBOUND hits Shabbat.
 *   phase 2 (`searchReturns`)   — only for date pairs that survived phase 1 and
 *                                 are actually in alerting range. Confirms the
 *                                 return legs before we tell the owner anything.
 *
 * We never alert on a half-verified itinerary; we just avoid paying to verify
 * itineraries that were never going to be alerted.
 */

const SERPAPI_URL = 'https://serpapi.com/search.json';

export interface FlightOption {
  /** Total for the whole booking (all passengers, both directions). */
  price: number;
  segments: Segment[];
  airlines: string[];
  stops: number;
  totalDurationMin: number;
  /** Feeds phase 2. Absent on return-leg results. */
  departureToken?: string;
}

export interface PriceInsights {
  lowestPrice?: number;
  /** Google's own verdict: 'low' | 'typical' | 'high'. */
  priceLevel?: string;
  typicalRange?: [number, number];
}

export interface OutboundSearch {
  options: FlightOption[];
  insights?: PriceInsights;
}

export interface SearchParams {
  outboundDate: string; // YYYY-MM-DD
  returnDate: string; // YYYY-MM-DD
  adults: number;
  /** SerpApi `stops`: 0 any, 1 nonstop only, 2 ≤1 stop, 3 ≤2 stops. */
  stops: number;
}

interface RawFlight {
  departure_airport?: { id?: string; time?: string };
  arrival_airport?: { id?: string; time?: string };
  airline?: string;
}

interface RawOption {
  flights?: RawFlight[];
  price?: number;
  total_duration?: number;
  departure_token?: string;
}

@Injectable()
export class FlightSearchClient {
  private readonly logger = new AppLogger('FlightSearch');

  get configured(): boolean {
    return Boolean(env().SERPAPI_API_KEY);
  }

  /** Phase 1 — outbound options carrying the round-trip total price. */
  async searchOutbound(p: SearchParams): Promise<OutboundSearch | null> {
    const raw = await this.call({
      departure_id: env().FLIGHT_WATCH_ORIGIN,
      arrival_id: env().FLIGHT_WATCH_DESTINATION,
      outbound_date: p.outboundDate,
      return_date: p.returnDate,
      type: '1', // round trip
      travel_class: '1', // economy
      adults: String(p.adults),
      stops: String(p.stops),
      sort_by: '2', // price
      currency: env().FLIGHT_WATCH_CURRENCY,
      hl: 'en',
      gl: 'il',
    });
    if (!raw) return null;

    return {
      options: parseOptions(raw),
      insights: parseInsights(raw),
    };
  }

  /** Phase 2 — the return legs that pair with one phase-1 outbound. */
  async searchReturns(p: SearchParams, departureToken: string): Promise<FlightOption[] | null> {
    const raw = await this.call({
      departure_id: env().FLIGHT_WATCH_ORIGIN,
      arrival_id: env().FLIGHT_WATCH_DESTINATION,
      outbound_date: p.outboundDate,
      return_date: p.returnDate,
      type: '1',
      travel_class: '1',
      adults: String(p.adults),
      stops: String(p.stops),
      sort_by: '2',
      currency: env().FLIGHT_WATCH_CURRENCY,
      hl: 'en',
      gl: 'il',
      departure_token: departureToken,
    });
    if (!raw) return null;
    return parseOptions(raw);
  }

  private async call(params: Record<string, string>): Promise<Record<string, unknown> | null> {
    const key = env().SERPAPI_API_KEY;
    if (!key) return null;

    const qs = new URLSearchParams({ ...params, engine: 'google_flights', api_key: key });
    try {
      const res = await fetch(`${SERPAPI_URL}?${qs.toString()}`, {
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok || body.error) {
        // Quota exhaustion is the common case and must not page the owner —
        // it degrades to "no new data this run".
        this.logger.warn('SerpApi request failed', {
          status: res.status,
          error: String(body.error ?? '').slice(0, 200),
        });
        return null;
      }
      return body;
    } catch (e) {
      this.logger.warn('SerpApi request threw', { error: (e as Error).message });
      return null;
    }
  }
}

function parseOptions(raw: Record<string, unknown>): FlightOption[] {
  const best = Array.isArray(raw.best_flights) ? (raw.best_flights as RawOption[]) : [];
  const other = Array.isArray(raw.other_flights) ? (raw.other_flights as RawOption[]) : [];
  const out: FlightOption[] = [];

  for (const opt of [...best, ...other]) {
    const legs = Array.isArray(opt.flights) ? opt.flights : [];
    if (!legs.length || typeof opt.price !== 'number') continue;

    const segments: Segment[] = [];
    const airlines = new Set<string>();
    let malformed = false;

    for (const leg of legs) {
      const depId = leg.departure_airport?.id;
      const depTime = leg.departure_airport?.time;
      const arrId = leg.arrival_airport?.id;
      const arrTime = leg.arrival_airport?.time;
      if (!depId || !depTime || !arrId || !arrTime) {
        malformed = true;
        break;
      }
      segments.push({
        departureAirport: depId,
        departureTime: depTime,
        arrivalAirport: arrId,
        arrivalTime: arrTime,
      });
      if (leg.airline) airlines.add(leg.airline);
    }
    // A segment we cannot read is a segment we cannot Shabbat-check, so the
    // whole option is dropped rather than partially trusted.
    if (malformed) continue;

    out.push({
      price: opt.price,
      segments,
      airlines: [...airlines],
      stops: Math.max(0, segments.length - 1),
      totalDurationMin: typeof opt.total_duration === 'number' ? opt.total_duration : 0,
      departureToken: typeof opt.departure_token === 'string' ? opt.departure_token : undefined,
    });
  }
  return out;
}

function parseInsights(raw: Record<string, unknown>): PriceInsights | undefined {
  const pi = raw.price_insights as Record<string, unknown> | undefined;
  if (!pi || typeof pi !== 'object') return undefined;

  const range = pi.typical_price_range;
  const typicalRange =
    Array.isArray(range) && range.length === 2 && range.every((n) => typeof n === 'number')
      ? ([range[0], range[1]] as [number, number])
      : undefined;

  return {
    lowestPrice: typeof pi.lowest_price === 'number' ? pi.lowest_price : undefined,
    priceLevel: typeof pi.price_level === 'string' ? pi.price_level : undefined,
    typicalRange,
  };
}

/**
 * A Google Flights link the owner can open and book from. SerpApi's
 * `booking_token` would need yet another billed request, and Google parses this
 * natural-language query reliably — so this costs nothing and lands on the same
 * search the agent priced.
 */
export function googleFlightsLink(outboundDate: string, returnDate: string, adults: number): string {
  const q =
    `Flights from ${env().FLIGHT_WATCH_ORIGIN} to ${env().FLIGHT_WATCH_DESTINATION} ` +
    `on ${outboundDate} through ${returnDate} for ${adults} adults`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}
