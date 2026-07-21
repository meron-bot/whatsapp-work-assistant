import { Segment, ShabbatWindow, checkShabbat } from '../src/flights/shabbat';

process.env.DATABASE_URL = 'postgresql://x';

/**
 * The real union window for Fri 2026-07-31, taken from Hebcal:
 *   ZNZ candles 18:06+03:00 → 15:06Z   (earliest start of the two)
 *   TLV havdalah Sat 20:20+03:00 → 17:20Z (latest end of the two)
 * Both ends of the route sit on UTC+3, so Zanzibar's equatorial sunset opens
 * the window and Israel's later nightfall closes it.
 */
const WINDOWS: ShabbatWindow[] = [
  {
    start: new Date('2026-07-31T15:06:00Z'),
    end: new Date('2026-08-01T17:20:00Z'),
  },
];

function seg(
  departureAirport: string,
  departureTime: string,
  arrivalAirport: string,
  arrivalTime: string,
): Segment {
  return { departureAirport, departureTime, arrivalAirport, arrivalTime };
}

describe('checkShabbat', () => {
  it('clears an early-Friday departure that lands well before candle lighting', () => {
    // TLV 07:00 (04:00Z) → ZNZ 13:00 (10:00Z); window opens 15:06Z.
    const legs = [seg('TLV', '2026-07-31 07:00', 'ZNZ', '2026-07-31 13:00')];
    expect(checkShabbat([legs], WINDOWS)).toEqual({ status: 'safe' });
  });

  it('rejects a Friday-evening departure that flies into Shabbat', () => {
    // TLV 18:00 (15:00Z) → ZNZ 23:55 (20:55Z) straddles the 15:06Z opening.
    const legs = [seg('TLV', '2026-07-31 18:00', 'ZNZ', '2026-07-31 23:55')];
    const v = checkShabbat([legs], WINDOWS);
    expect(v.status).toBe('conflict');
  });

  it('rejects a flight wholly inside Shabbat', () => {
    const legs = [seg('TLV', '2026-08-01 09:00', 'ZNZ', '2026-08-01 15:00')];
    expect(checkShabbat([legs], WINDOWS).status).toBe('conflict');
  });

  it('allows a motzaei-Shabbat departure after havdalah', () => {
    // TLV Sat 21:00 (18:00Z) — window closed at 17:20Z.
    const legs = [seg('TLV', '2026-08-01 21:00', 'ZNZ', '2026-08-02 02:55')];
    expect(checkShabbat([legs], WINDOWS)).toEqual({ status: 'safe' });
  });

  it('rejects a layover that sits on the ground through Shabbat', () => {
    // Each leg is individually clear — leg 1 lands 12:00Z (before the 15:06Z
    // opening), leg 2 departs 17:30Z (after the 17:20Z close). Only the wait in
    // Istanbul between them crosses Shabbat, so this isolates layover handling.
    const legs = [
      seg('TLV', '2026-07-31 12:00', 'IST', '2026-07-31 15:00'),
      seg('IST', '2026-08-01 20:30', 'ZNZ', '2026-08-02 03:30'),
    ];
    const v = checkShabbat([legs], WINDOWS);
    expect(v.status).toBe('conflict');
    expect(v.status === 'conflict' && v.reason).toContain('IST');
  });

  it('treats an airport with no known timezone as unverifiable, never safe', () => {
    const legs = [seg('TLV', '2026-07-29 07:00', 'QQQ', '2026-07-29 13:00')];
    const v = checkShabbat([legs], WINDOWS);
    expect(v.status).toBe('unverifiable');
    expect(v.status === 'unverifiable' && v.reason).toContain('QQQ');
  });

  it('is unverifiable when no Shabbat times could be fetched', () => {
    const legs = [seg('TLV', '2026-07-29 07:00', 'ZNZ', '2026-07-29 13:00')];
    expect(checkShabbat([legs], []).status).toBe('unverifiable');
  });

  it('does not treat the stay at the destination as a layover', () => {
    // Regression: flattening outbound + return into one list made the week in
    // Zanzibar look like a connection at ZNZ spanning Shabbat, which rejected
    // every round trip. Passing them as separate journeys is the fix.
    const outbound = [seg('TLV', '2026-07-27 07:00', 'ZNZ', '2026-07-27 13:00')];
    const back = [seg('ZNZ', '2026-08-02 10:00', 'TLV', '2026-08-02 17:00')];
    expect(checkShabbat([outbound, back], WINDOWS)).toEqual({ status: 'safe' });
  });

  it('clears a mid-week itinerary far from any window', () => {
    const legs = [
      seg('TLV', '2026-07-29 06:00', 'DXB', '2026-07-29 10:30'),
      seg('DXB', '2026-07-29 13:00', 'ZNZ', '2026-07-29 17:45'),
    ];
    expect(checkShabbat([legs], WINDOWS)).toEqual({ status: 'safe' });
  });

  it('places each airport in its own zone rather than assuming UTC+3', () => {
    // Dubai is UTC+4, so landing at 19:00 local is 15:00Z — six minutes before
    // the window opens, and therefore clear. Reading DXB as UTC+3 (like the
    // rest of the route) would put it at 16:00Z and wrongly reject the leg.
    const legs = [seg('AMM', '2026-07-31 16:00', 'DXB', '2026-07-31 19:00')];
    expect(checkShabbat([legs], WINDOWS)).toEqual({ status: 'safe' });
  });
});
