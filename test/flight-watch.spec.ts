// Env must be set before the service reads it (env() caches on first call).
process.env.FLIGHT_WATCH_ENABLED = 'true';
process.env.SERPAPI_API_KEY = 'test-key';
process.env.FLIGHT_WATCH_ORIGIN = 'TLV';
process.env.FLIGHT_WATCH_DESTINATION = 'ZNZ';
process.env.FLIGHT_WATCH_WINDOW_START = '2026-07-27';
process.env.FLIGHT_WATCH_WINDOW_END = '2026-07-28';
process.env.FLIGHT_WATCH_MIN_NIGHTS = '6';
process.env.FLIGHT_WATCH_MAX_NIGHTS = '6';
process.env.FLIGHT_WATCH_ADULTS = '2';
process.env.FLIGHT_WATCH_ALERT_TOTAL = '2400';

import { FlightWatchService } from '../src/scheduler/flight-watch.service';
import { ShabbatWindow } from '../src/flights/shabbat';

/** Union window for Fri 2026-07-31 (ZNZ candles → TLV havdalah). */
const WINDOWS: ShabbatWindow[] = [
  { start: new Date('2026-07-31T15:06:00Z'), end: new Date('2026-08-01T17:20:00Z') },
];

// Tue 2026-07-21, 12:00 Israel — daytime, so a normal deal may be sent.
const NOON = new Date('2026-07-21T09:00:00Z');
// Same day, 03:00 Israel — protected night hours.
const NIGHT = new Date('2026-07-21T00:00:00Z');

/** Mon 27.7 out, Sun 2.8 back — nowhere near the Shabbat window. */
const OUT_LEGS = [
  {
    departureAirport: 'TLV',
    departureTime: '2026-07-27 07:00',
    arrivalAirport: 'ZNZ',
    arrivalTime: '2026-07-27 13:00',
  },
];
const RETURN_LEGS = [
  {
    departureAirport: 'ZNZ',
    departureTime: '2026-08-02 10:00',
    arrivalAirport: 'TLV',
    arrivalTime: '2026-08-02 17:00',
  },
];

function option(price: number, segments = OUT_LEGS, withToken = true) {
  return {
    price,
    segments,
    airlines: ['Israir'],
    stops: 0,
    totalDurationMin: 360,
    ...(withToken ? { departureToken: 'tok' } : {}),
  };
}

function makeDeps() {
  let stored: unknown;
  const prisma = {
    agentMemory: {
      findUnique: jest.fn(async () => (stored ? { key: 'k', value: stored } : null)),
      upsert: jest.fn(async ({ create, update }: any) => {
        stored = update?.value ?? create?.value;
      }),
    },
  };
  const whatsapp = { sendText: jest.fn().mockResolvedValue('wamid.out') };
  const flights = {
    configured: true,
    searchOutbound: jest.fn().mockResolvedValue({
      options: [option(2300)],
      insights: { priceLevel: 'low', typicalRange: [2100, 3000] },
    }),
    searchReturns: jest.fn().mockResolvedValue([option(2300, RETURN_LEGS, false)]),
  };
  const shabbat = { windows: jest.fn().mockResolvedValue(WINDOWS) };
  const svc = new FlightWatchService(
    prisma as any,
    whatsapp as any,
    flights as any,
    shabbat as any,
  );
  /** Messages that are actual deal alerts, not the daily digest. */
  const deals = () =>
    whatsapp.sendText.mock.calls.filter(
      (c) => String(c[1]).includes('מתחת לתקציב') || String(c[1]).includes('מחיר חריג'),
    );
  return { svc, prisma, whatsapp, flights, shabbat, deals };
}

describe('FlightWatchService', () => {
  it('does nothing without a SerpApi key', async () => {
    const { svc, flights, whatsapp } = makeDeps();
    flights.configured = false;
    await svc.sweep(NOON);
    expect(flights.searchOutbound).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('skips the sweep when Shabbat times are unavailable', async () => {
    // Without them every result is unverifiable, so searching only burns quota.
    const { svc, flights, shabbat } = makeDeps();
    shabbat.windows.mockResolvedValue([]);
    await svc.sweep(NOON);
    expect(flights.searchOutbound).not.toHaveBeenCalled();
  });

  it('alerts on a verified round trip under the threshold', async () => {
    const { svc, whatsapp, flights, deals } = makeDeps();
    await svc.sweep(NOON);

    expect(flights.searchReturns).toHaveBeenCalled(); // phase 2 ran
    expect(deals()).toHaveLength(1);
    const body = String(whatsapp.sendText.mock.calls[0][1]);
    expect(body).toContain('$2,300');
    expect(body).toContain('$1,150'); // per person
    expect(body).toContain('ישירה');
    expect(body).toContain('שבת נבדקה');
  });

  it('never alerts on an itinerary whose return legs were not verified', async () => {
    const { svc, flights, deals } = makeDeps();
    flights.searchReturns.mockResolvedValue(null);
    await svc.sweep(NOON);
    expect(deals()).toHaveLength(0);
  });

  it('never alerts when the only return option falls on Shabbat', async () => {
    const { svc, flights, deals } = makeDeps();
    flights.searchReturns.mockResolvedValue([
      option(
        2300,
        [
          {
            departureAirport: 'ZNZ',
            departureTime: '2026-08-01 09:00',
            arrivalAirport: 'TLV',
            arrivalTime: '2026-08-01 16:00',
          },
        ],
        false,
      ),
    ]);
    await svc.sweep(NOON);
    expect(deals()).toHaveLength(0);
  });

  it('does not repeat the same alert at an unchanged price', async () => {
    const { svc, deals } = makeDeps();
    await svc.sweep(NOON);
    expect(deals()).toHaveLength(1);
    await svc.sweep(NOON);
    expect(deals()).toHaveLength(1); // still just the first one
  });

  it('alerts again once the price drops meaningfully', async () => {
    const { svc, flights, deals } = makeDeps();
    await svc.sweep(NOON);
    flights.searchOutbound.mockResolvedValue({
      options: [option(2100)],
      insights: { priceLevel: 'low' },
    });
    flights.searchReturns.mockResolvedValue([option(2100, RETURN_LEGS, false)]);
    await svc.sweep(NOON);
    expect(deals()).toHaveLength(2);
  });

  it('holds an ordinary deal through the night', async () => {
    const { svc, deals } = makeDeps();
    await svc.sweep(NIGHT);
    expect(deals()).toHaveLength(0);
  });

  it('breaks through the night for a deal far under budget', async () => {
    const { svc, flights, deals } = makeDeps();
    // 15%+ under $2,400 counts as urgent.
    flights.searchOutbound.mockResolvedValue({ options: [option(1900)] });
    flights.searchReturns.mockResolvedValue([option(1900, RETURN_LEGS, false)]);
    await svc.sweep(NIGHT);
    expect(deals()).toHaveLength(1);
    expect(String(deals()[0][1])).toContain('מחיר חריג');
  });

  it('ignores outbound options that fall on Shabbat', async () => {
    const { svc, flights, deals } = makeDeps();
    flights.searchOutbound.mockResolvedValue({
      options: [
        option(1500, [
          {
            departureAirport: 'TLV',
            departureTime: '2026-07-31 18:00',
            arrivalAirport: 'ZNZ',
            arrivalTime: '2026-07-31 23:55',
          },
        ]),
      ],
    });
    await svc.sweep(NOON);
    expect(flights.searchReturns).not.toHaveBeenCalled();
    expect(deals()).toHaveLength(0);
  });

  it('persists state so a restart does not re-alert', async () => {
    const { svc, prisma } = makeDeps();
    await svc.sweep(NOON);
    expect(prisma.agentMemory.upsert).toHaveBeenCalled();
    const saved = prisma.agentMemory.upsert.mock.calls[0][0] as any;
    const value = saved.update.value ?? saved.create.value;
    expect(value.combos['2026-07-27|6'].price).toBe(2300);
    expect(value.combos['2026-07-27|6'].alertedAt).toBe(2300);
  });
});

describe('candidate generation', () => {
  it('never searches a Saturday departure', async () => {
    const { svc, flights } = makeDeps();
    await svc.sweep(NOON);
    const dates = flights.searchOutbound.mock.calls.map((c: any[]) => c[0].outboundDate);
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) {
      expect(new Date(d).getUTCDay()).not.toBe(6);
    }
  });

  it('pairs each outbound with the configured trip length', async () => {
    const { svc, flights } = makeDeps();
    await svc.sweep(NOON);
    for (const [params] of flights.searchOutbound.mock.calls as any[][]) {
      const nights =
        (new Date(params.returnDate).getTime() - new Date(params.outboundDate).getTime()) /
        86_400_000;
      expect(nights).toBe(6);
      expect(params.adults).toBe(2);
    }
  });
});
