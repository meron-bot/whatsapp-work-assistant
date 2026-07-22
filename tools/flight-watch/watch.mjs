#!/usr/bin/env node
/**
 * Zanzibar flight watcher — standalone.
 *
 * Deliberately a single dependency-free ESM file: it runs under plain `node`
 * with no npm install and no TypeScript build, so it can never trip the
 * heavy-build problem on this machine. Everything it needs is in Node 20+
 * (global fetch) and Windows itself (PowerShell for the toast).
 *
 *   node watch.mjs             one sweep
 *   node watch.mjs --self-test Shabbat logic only, no API key needed
 *   node watch.mjs --report    rebuild report.html from saved state
 *
 * State lives in state.json next to this file, so a run knows what the previous
 * run already found and never re-alerts the same price.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.json');
const STATE_PATH = join(HERE, 'state.json');
const REPORT_PATH = join(HERE, 'report.html');

/** A deal this far under the threshold is worth an immediate, loud alert. */
const URGENT_MARGIN = 0.15;
/** Re-alerting the same date pair needs at least this much further improvement. */
const RE_ALERT_DROP = 0.03;

// ---------------------------------------------------------------------------
// Shabbat
// ---------------------------------------------------------------------------

/**
 * Airports plausibly on a TLV<->ZNZ itinerary -> IANA timezone. Google Flights
 * reports every time as wall-clock local to its own airport with no offset, so
 * without this an itinerary cannot be placed on the absolute timeline at all.
 * IANA names (not fixed offsets) so DST is handled for TLV/IST/CAI/AMM.
 */
const AIRPORT_TZ = {
  TLV: 'Asia/Jerusalem',
  ZNZ: 'Africa/Dar_es_Salaam',
  DAR: 'Africa/Dar_es_Salaam',
  JRO: 'Africa/Dar_es_Salaam',
  NBO: 'Africa/Nairobi',
  MBA: 'Africa/Nairobi',
  ADD: 'Africa/Addis_Ababa',
  EBB: 'Africa/Kampala',
  KGL: 'Africa/Kigali',
  IST: 'Europe/Istanbul',
  SAW: 'Europe/Istanbul',
  ATH: 'Europe/Athens',
  LCA: 'Asia/Nicosia',
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
};

/** Both ends of the route. The forbidden window is the UNION of the two. */
const ROUTE_ENDS = [
  { name: 'TLV', latitude: 32.0117, longitude: 34.8867, tzid: 'Asia/Jerusalem' },
  { name: 'ZNZ', latitude: -6.2224, longitude: 39.2249, tzid: 'Africa/Dar_es_Salaam' },
];

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(at, tz) {
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
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at.getTime();
}

/** "2026-07-29 07:15" local to `airport` -> absolute instant. */
function toInstant(local, airport, unknown) {
  const tz = AIRPORT_TZ[String(airport || '').toUpperCase()];
  if (!tz) {
    unknown.add(airport || '?');
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(local || '').trim());
  if (!m) {
    unknown.add(airport);
    return null;
  }
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const first = tzOffsetMs(new Date(asUtc), tz);
  let instant = new Date(asUtc - first);
  const settled = tzOffsetMs(instant, tz);
  if (settled !== first) instant = new Date(asUtc - settled);
  return instant;
}

function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom.getTime() < bTo.getTime() && bFrom.getTime() < aTo.getTime();
}

/**
 * Verdict for a whole trip. Each journey is passed SEPARATELY —
 * [outboundLegs, returnLegs] — because layovers only exist WITHIN a journey.
 * Flattening the halves would make the week in Zanzibar look like a connection
 * at ZNZ, and since that "layover" spans the intervening Shabbat it would
 * reject every round trip. Time at the destination is a holiday, not transit.
 */
function checkShabbat(journeys, windows) {
  if (!windows.length) return { status: 'unverifiable', reason: 'no Shabbat times' };

  const unknown = new Set();
  const intervals = [];

  for (const segments of journeys) {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const dep = toInstant(s.departureTime, s.departureAirport, unknown);
      const arr = toInstant(s.arrivalTime, s.arrivalAirport, unknown);
      if (dep && arr) {
        intervals.push({ from: dep, to: arr, label: `${s.departureAirport}->${s.arrivalAirport}` });
      }
      const next = segments[i + 1];
      if (next && next.departureAirport === s.arrivalAirport) {
        const out = toInstant(next.departureTime, next.departureAirport, unknown);
        if (arr && out && out.getTime() > arr.getTime()) {
          intervals.push({ from: arr, to: out, label: `layover ${s.arrivalAirport}` });
        }
      }
    }
  }

  // An airport we cannot place makes the itinerary UNVERIFIABLE, never "safe".
  if (unknown.size) {
    return { status: 'unverifiable', reason: `unknown airport ${[...unknown].join(', ')}` };
  }
  for (const w of windows) {
    for (const iv of intervals) {
      if (overlaps(iv.from, iv.to, w.start, w.end)) {
        return { status: 'conflict', reason: `${iv.label} overlaps Shabbat` };
      }
    }
  }
  return { status: 'safe' };
}

/** Every Friday whose Shabbat could overlap [from, to]. */
function fridaysBetween(from, to) {
  const out = [];
  const cursor = new Date(from.getTime() - 86400000);
  cursor.setUTCHours(12, 0, 0, 0);
  while (cursor.getUTCDay() !== 5) cursor.setUTCDate(cursor.getUTCDate() - 1);
  const limit = to.getTime() + 86400000;
  while (cursor.getTime() <= limit) {
    out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

/**
 * Shabbat windows as absolute instants, from Hebcal (free, no key, CC-BY).
 * Candle lighting 18 min before sunset, havdalah 42 min after sundown.
 * Zanzibar sits near the equator on the same UTC+3 clock as Israel, so its
 * Shabbat opens ~74 min EARLIER and closes ~73 min earlier; taking min(start)
 * and max(end) is never permissive wherever we actually are.
 */
async function shabbatWindows(from, to) {
  const out = [];
  for (const friday of fridaysBetween(from, to)) {
    const day = friday.toISOString().slice(0, 10);
    const [y, m, d] = day.split('-');
    const perPlace = [];
    for (const place of ROUTE_ENDS) {
      const url =
        `https://www.hebcal.com/shabbat?cfg=json&latitude=${place.latitude}` +
        `&longitude=${place.longitude}&tzid=${encodeURIComponent(place.tzid)}` +
        `&gy=${y}&gm=${Number(m)}&gd=${Number(d)}&b=18&m=42&M=off&leyning=off`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items = (await res.json()).items || [];
        // Hebcal returns ISO strings WITH offset, so Date parses them to the
        // correct instant with no timezone maths on our side.
        const candles = items.find((i) => i.category === 'candles')?.date;
        const havdalah = items.find((i) => i.category === 'havdalah')?.date;
        if (candles && havdalah) {
          perPlace.push({ start: new Date(candles), end: new Date(havdalah) });
        }
      } catch (e) {
        console.warn(`  ! Hebcal ${place.name} ${day}: ${e.message}`);
      }
    }
    if (perPlace.length !== ROUTE_ENDS.length) continue;
    out.push({
      start: new Date(Math.min(...perPlace.map((w) => w.start.getTime()))),
      end: new Date(Math.max(...perPlace.map((w) => w.end.getTime()))),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SerpApi (Google Flights)
// ---------------------------------------------------------------------------

/**
 * A round-trip query returns the OUTBOUND options, each already carrying the
 * ROUND-TRIP total price plus a departure_token; the matching return legs cost
 * a SECOND request. Hence phase 1 (cheap, wide) and phase 2 (paid, narrow).
 */
async function serpApi(cfg, extra) {
  const qs = new URLSearchParams({
    engine: 'google_flights',
    api_key: cfg.serpApiKey,
    departure_id: cfg.origin,
    arrival_id: cfg.destination,
    type: '1',
    travel_class: '1',
    adults: String(cfg.adults),
    stops: String(cfg.maxStops),
    sort_by: '2',
    currency: cfg.currency || 'USD',
    hl: 'en',
    gl: 'il',
    ...extra,
  });
  try {
    const res = await fetch(`https://serpapi.com/search.json?${qs}`, {
      signal: AbortSignal.timeout(40000),
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      console.warn(`  ! SerpApi: ${String(body.error || res.status).slice(0, 160)}`);
      return null;
    }
    return body;
  } catch (e) {
    console.warn(`  ! SerpApi request failed: ${e.message}`);
    return null;
  }
}

function parseOptions(raw) {
  const all = [...(raw.best_flights || []), ...(raw.other_flights || [])];
  const out = [];
  for (const opt of all) {
    const legs = opt.flights || [];
    if (!legs.length || typeof opt.price !== 'number') continue;
    const segments = [];
    const airlines = new Set();
    let malformed = false;
    for (const leg of legs) {
      const dep = leg.departure_airport || {};
      const arr = leg.arrival_airport || {};
      if (!dep.id || !dep.time || !arr.id || !arr.time) {
        malformed = true;
        break;
      }
      segments.push({
        departureAirport: dep.id,
        departureTime: dep.time,
        arrivalAirport: arr.id,
        arrivalTime: arr.time,
        // Extra fields for the schedule display; checkShabbat ignores them.
        airline: leg.airline,
        flightNumber: leg.flight_number,
        durationMin: typeof leg.duration === 'number' ? leg.duration : undefined,
      });
      if (leg.airline) airlines.add(leg.airline);
    }
    // A segment we cannot read is a segment we cannot Shabbat-check.
    if (malformed) continue;
    out.push({
      price: opt.price,
      segments,
      airlines: [...airlines],
      stops: Math.max(0, segments.length - 1),
      durationMin: opt.total_duration || 0,
      departureToken: opt.departure_token,
    });
  }
  return out;
}

function parseInsights(raw) {
  const pi = raw.price_insights;
  if (!pi || typeof pi !== 'object') return undefined;
  const r = pi.typical_price_range;
  return {
    priceLevel: typeof pi.price_level === 'string' ? pi.price_level : undefined,
    typicalRange: Array.isArray(r) && r.length === 2 ? r : undefined,
  };
}

function googleFlightsLink(cfg, outbound, back) {
  const q =
    `Flights from ${cfg.origin} to ${cfg.destination} on ${outbound} ` +
    `through ${back} for ${cfg.adults} adults`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

const addDays = (d, n) => {
  const o = new Date(d);
  o.setUTCDate(o.getUTCDate() + n);
  return o;
};
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Every (outbound date, trip length) pair in the window. Saturday departures
 * and returns are dropped here rather than searched: essentially nothing on a
 * Saturday clears Shabbat, so paying to discover that wastes ~2/7 of the quota.
 * Friday IS still searched — an early-morning Friday flight landing well before
 * candle lighting is legitimate, and the per-segment check decides.
 */
function candidateCombos(cfg, now) {
  const start = new Date(cfg.windowStart);
  const end = new Date(cfg.windowEnd);
  const floor = new Date(Math.max(start.getTime(), addDays(now, 1).getTime()));
  const out = [];
  for (let d = new Date(floor); d <= end; d = addDays(d, 1)) {
    if (d.getUTCDay() === 6) continue;
    for (let n = cfg.minNights; n <= cfg.maxNights; n++) {
      const back = addDays(d, n);
      if (back.getUTCDay() === 6) continue;
      out.push({ key: `${iso(d)}|${n}`, outbound: iso(d), back: iso(back), nights: n });
    }
  }
  return out;
}

/** Current price leaders (catch a drop fast) + least-recently-checked (rotate). */
function pickBatch(cfg, combos, state, budget) {
  const priced = combos
    .filter((c) => typeof state.combos[c.key]?.candidatePrice === 'number')
    .sort((a, b) => effEntry(cfg, state.combos[a.key]) - effEntry(cfg, state.combos[b.key]));
  const chosen = new Map(priced.slice(0, Math.min(3, Math.floor(budget / 3))).map((c) => [c.key, c]));
  const stale = [...combos].sort(
    (a, b) => checkedMs(state, a.key) - checkedMs(state, b.key),
  );
  for (const c of stale) {
    if (chosen.size >= budget) break;
    chosen.set(c.key, c);
  }
  return [...chosen.values()];
}

const checkedMs = (state, key) =>
  state.combos[key]?.checkedAt ? new Date(state.combos[key].checkedAt).getTime() : 0;

/**
 * Preferred-airline advantage. The owner is willing to pay `preferredBonusUsd`
 * extra to fly one of `preferredAirlines`, so a preferred itinerary competes as
 * if it were that much cheaper — in ranking, in "best" selection, and in the
 * alert threshold. The REAL price is always what gets displayed; the bonus only
 * shifts comparisons. Match is a case-insensitive substring, so "Arkia" catches
 * "Arkia", "Arkia Israel Airlines", etc.
 */
function isPreferred(cfg, airlines) {
  const prefs = (cfg.preferredAirlines || []).map((s) => String(s).toLowerCase());
  if (!prefs.length) return false;
  return (airlines || []).some((a) => prefs.some((p) => String(a).toLowerCase().includes(p)));
}

/** Effective price of a freshly parsed option (has .price and .airlines). */
function effOpt(cfg, opt) {
  return opt.price - (isPreferred(cfg, opt.airlines) ? cfg.preferredBonusUsd || 0 : 0);
}

/** Effective price of a stored combo entry, verified or candidate-only. */
function effEntry(cfg, e) {
  const price = e.price ?? e.candidatePrice ?? Infinity;
  const pref = e.price !== undefined ? e.preferred : e.candidatePreferred;
  return price - (pref ? cfg.preferredBonusUsd || 0 : 0);
}

/** True if a stored entry's itinerary is on a preferred airline. */
function entryPreferred(e) {
  return e.price !== undefined ? Boolean(e.preferred) : Boolean(e.candidatePreferred);
}

function bestCombo(cfg, state) {
  let best = null;
  let bestEff = Infinity;
  for (const [key, e] of Object.entries(state.combos)) {
    if (typeof e.price !== 'number') continue;
    const eff = effEntry(cfg, e);
    if (eff < bestEff) {
      best = { key, entry: e };
      bestEff = eff;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** undefined = not verified yet, so no stop count is known. */
function stopsLabel(stops) {
  if (stops === 0) return 'ישירה';
  if (stops === 1) return 'עצירה אחת';
  return typeof stops === 'number' ? `${stops} עצירות` : '—';
}

function fmtDate(isoDay) {
  const names = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const d = new Date(`${isoDay}T12:00:00Z`);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1} (${names[d.getUTCDay()]}')`;
}

/** "2026-07-31 07:15" → "31.7 07:15" (date kept so overnight legs are clear). */
function fmtTime(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(local || ''));
  return m ? `${+m[3]}.${+m[2]} ${m[4]}:${m[5]}` : String(local || '');
}

/** minutes → "5ש 55ד" / "12ש" / "40ד". */
function hoursMin(min) {
  if (min == null || min < 0) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}ש ${m}ד` : h ? `${h}ש` : `${m}ד`;
}

/** Naive local minutes between two wall-clock strings at the SAME airport (so
 *  the timezone cancels) — used for layover length. */
function layoverMin(arrLocal, depLocal) {
  const p = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  };
  const a = p(arrLocal);
  const b = p(depLocal);
  return a != null && b != null ? Math.round((b - a) / 60000) : null;
}

/** Flight length: prefer SerpApi's per-leg duration; else compute tz-correctly
 *  from the two airports' zones (departure and arrival differ). */
function legDurationMin(seg) {
  if (typeof seg.durationMin === 'number') return seg.durationMin;
  const u = new Set();
  const d = toInstant(seg.departureTime, seg.departureAirport, u);
  const a = toInstant(seg.arrivalTime, seg.arrivalAirport, u);
  return d && a ? Math.round((a.getTime() - d.getTime()) / 60000) : null;
}

/** One journey's schedule as HTML: a line per flight leg, plus a layover line
 *  between consecutive legs at the same airport. */
function renderItinerary(labelHe, segments) {
  if (!segments || !segments.length) return '';
  let rows = '';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const flightNo = [s.airline, s.flightNumber].filter(Boolean).join(' ');
    const dur = hoursMin(legDurationMin(s));
    rows +=
      `<div class="leg">✈ ${flightNo ? flightNo + ' · ' : ''}` +
      `המראה ${s.departureAirport} ${fmtTime(s.departureTime)} · ` +
      `נחיתה ${s.arrivalAirport} ${fmtTime(s.arrivalTime)}${dur ? ` · (${dur})` : ''}</div>`;
    const next = segments[i + 1];
    if (next && next.departureAirport === s.arrivalAirport) {
      const lay = hoursMin(layoverMin(s.arrivalTime, next.departureTime));
      rows += `<div class="lay">⏱ המתנה ב-${s.arrivalAirport}${lay ? `: ${lay}` : ''}</div>`;
    }
  }
  return `<div class="itin"><div class="itin-h">${labelHe}</div>${rows}</div>`;
}

/** Windows toast. Best-effort: the HTML report is the alert that always works. */
function toast(title, body) {
  const esc = (s) => String(s).replace(/[&<>']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;' }[c]),
  );
  const ps = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${esc(title)}</text><text id="2">${esc(body)}</text></binding></visual></toast>')
  $t = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($t)
} catch { exit 1 }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], () => resolve());
  });
}

function openInBrowser(path) {
  return new Promise((resolve) => {
    execFile('cmd.exe', ['/c', 'start', '', path], () => resolve());
  });
}

function writeReport(cfg, state, now) {
  // Rank by EFFECTIVE price so a preferred airline surfaces above a marginally
  // cheaper rival, matching how "best" and alerts treat it.
  const rows = Object.entries(state.combos)
    .filter(([, e]) => typeof e.price === 'number' || typeof e.candidatePrice === 'number')
    .sort((a, b) => effEntry(cfg, a[1]) - effEntry(cfg, b[1]));

  const body = rows.length
    ? rows
        .map(([key, e]) => {
          const [outbound, nights] = key.split('|');
          const back = iso(addDays(new Date(outbound), Number(nights)));
          const price = e.price ?? e.candidatePrice;
          const verified = typeof e.price === 'number';
          const under = effEntry(cfg, e) <= cfg.alertTotalUsd;
          const pref = entryPreferred(e);
          const airlines = (e.airlines || []).join(', ') + (pref ? ' <span class="star">★</span>' : '');
          const sched = renderItinerary('הלוך', e.outbound) + renderItinerary('חזור', e.returnLegs);
          const detail = sched ? `<tr class="sched"><td colspan="8">${sched}</td></tr>` : '';
          return `<tr class="${under ? 'good' : ''}${pref ? ' pref' : ''}">
      <td>${fmtDate(outbound)} → ${fmtDate(back)}</td>
      <td>${nights}</td>
      <td class="p">${money(price)}</td>
      <td>${money(price / cfg.adults)}</td>
      <td>${stopsLabel(e.stops)}</td>
      <td>${airlines}</td>
      <td>${verified ? '✅ שבת נבדקה' : '⏳ הלוך בלבד'}</td>
      <td><a href="${googleFlightsLink(cfg, outbound, back)}" target="_blank">הזמנה</a></td>
    </tr>${detail}`;
        })
        .join('\n')
    : '<tr><td colspan="8">עוד לא נמצאה אפשרות ששומרת שבת.</td></tr>';

  const best = bestCombo(cfg, state);
  const prefName = (cfg.preferredAirlines || []).join(', ');
  const html = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
<title>זנזיבר — מעקב טיסות</title>
<style>
 body{font:16px/1.6 system-ui,Segoe UI,sans-serif;margin:2rem auto;max-width:1000px;padding:0 1rem;
      background:#fbfaf8;color:#1a1a1a}
 h1{font-size:1.5rem;margin:0 0 .25rem}
 .sub{color:#666;margin:0 0 1.5rem}
 .card{background:#fff;border:1px solid #e5e2dd;border-radius:12px;padding:1rem 1.25rem;margin-bottom:1.5rem}
 .big{font-size:2rem;font-weight:600}
 table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e5e2dd;border-radius:12px;overflow:hidden}
 th,td{padding:.6rem .75rem;text-align:right;border-bottom:1px solid #f0ede8}
 th{background:#f6f4f1;font-weight:600;font-size:.85rem;color:#555}
 tr.good .p{color:#0a7d34;font-weight:700}
 tr.pref{background:#fff8ea}
 .star{color:#c8890f;font-weight:700}
 tr:last-child td{border-bottom:0}
 a{color:#0b5cad}
 tr.sched td{background:#faf8f3;padding-top:.2rem;font-size:.88rem}
 .itin{margin:.3rem 0}
 .itin-h{font-weight:600;color:#666;font-size:.8rem;margin-bottom:.15rem}
 .leg{color:#222;direction:rtl}
 .lay{color:#9a6a00;margin:.1rem 1.2rem}
 @media(prefers-color-scheme:dark){
  body{background:#141414;color:#eee} .card,table{background:#1e1e1e;border-color:#333}
  th{background:#262626;color:#bbb} th,td{border-color:#2c2c2c} a{color:#6fb3f2}
  tr.good .p{color:#4ade80} tr.pref{background:#2a2515} .star{color:#e8b23a}
  tr.sched td{background:#191919} .itin-h{color:#aaa} .leg{color:#ddd} .lay{color:#e8b23a}}
</style>
<h1>זנזיבר — מעקב טיסות</h1>
<p class="sub">עודכן ${now.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })} ·
 ${cfg.origin}→${cfg.destination} · ${cfg.adults} נוסעים · תקציב ${money(cfg.alertTotalUsd)}</p>
<div class="card">
 <div>הכי זול שנמצא (שבת נבדקה):</div>
 <div class="big">${best ? money(best.entry.price) : '—'}${best && entryPreferred(best.entry) ? ' <span class="star">★</span>' : ''}</div>
 <div>${best ? buyAdvice(cfg, best.entry, state, now) : 'עוד אין מספיק נתונים.'}</div>
</div>
<table><thead><tr><th>תאריכים</th><th>לילות</th><th>סה"כ</th><th>לאדם</th>
<th>עצירות</th><th>חברה</th><th>סטטוס</th><th></th></tr></thead>
<tbody>${body}</tbody></table>
${prefName ? `<p class="sub" style="margin-top:1rem"><span class="star">★</span> = חברה מועדפת (${prefName}). מקבלת יתרון של ${money(cfg.preferredBonusUsd || 0)} בדירוג ובהתראות — המחיר המוצג הוא האמיתי.</p>` : ''}
<p class="sub" style="margin-top:.5rem">זמני שבת מ-Hebcal. נפסלת כל טיסה או עצירה בין
 כניסת שבת (המוקדמת מבין תל אביב וזנזיבר) ליציאתה (המאוחרת מביניהן).</p>
</html>`;
  writeFileSync(REPORT_PATH, html, 'utf8');
}

/**
 * "Should I buy?" Near departure the honest answer is almost always "lock it
 * in": fares on this route climb into the last fortnight, so waiting for a dip
 * that historically does not come is the expensive mistake.
 */
function buyAdvice(cfg, entry, state, now) {
  const days = Math.ceil((new Date(cfg.windowStart).getTime() - now.getTime()) / 86400000);
  const prices = (state.history || []).map((h) => h[1]);
  const seenMin = prices.length ? Math.min(...prices) : undefined;
  const isBest = seenMin === undefined || entry.price <= seenMin;

  if (days <= 21) {
    return isBest
      ? '🟢 לסגור. זה הזול ביותר שראיתי, ופחות מ-3 שבועות ליציאה — מכאן המחירים בדרך כלל רק עולים.'
      : '🟡 לסגור בקרוב. פחות מ-3 שבועות ליציאה — זה החלון שבו מחירים מטפסים ולא יורדים.';
  }
  if (entry.priceLevel === 'low') return '🟢 לסגור. גוגל מסמן את המחיר כנמוך לקו הזה.';
  if (entry.priceLevel === 'high') return '🔴 לחכות. גוגל מסמן את המחיר כגבוה.';
  if (entry.typicalRange) {
    return `🟡 הטווח הרגיל בקו: ${money(entry.typicalRange[0])}–${money(entry.typicalRange[1])}.`;
  }
  return '🟡 עוד אין מספיק היסטוריה כדי לקבוע אם זה זול.';
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    // Strip a UTF-8 BOM: Notepad and PowerShell's Set-Content both write one by
    // default on Windows, and JSON.parse rejects it outright.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    console.warn(`  ! could not read ${path}: ${e.message}`);
    return fallback;
  }
}

async function sweep(cfg, now) {
  const combos = candidateCombos(cfg, now);
  if (!combos.length) {
    console.log('אין תאריכים בחלון שביקשת (אולי החלון כבר עבר).');
    return;
  }

  console.log(`חלון: ${cfg.windowStart}..${cfg.windowEnd} · ${combos.length} שילובי תאריכים`);
  const windows = await shabbatWindows(
    new Date(cfg.windowStart),
    addDays(new Date(cfg.windowEnd), cfg.maxNights),
  );
  if (!windows.length) {
    // Without Shabbat times every result is unverifiable, so searching would
    // only burn quota. Better to skip and try next run.
    console.error('לא הצלחתי לקבל זמני שבת מ-Hebcal — מדלג על הסריקה הזו.');
    return;
  }
  console.log(`זמני שבת: ${windows.length} שבתות בטווח`);

  const state = loadJson(STATE_PATH, { combos: {}, history: [] });
  state.combos ||= {};
  state.history ||= [];

  const batch = pickBatch(cfg, combos, state, cfg.searchesPerRun);
  let spent = 0;

  // ---- phase 1: price each pair, keep only Shabbat-clean outbounds ---------
  for (const combo of batch) {
    const raw = await serpApi(cfg, { outbound_date: combo.outbound, return_date: combo.back });
    spent++;
    const prev = state.combos[combo.key] || {};
    if (!raw) {
      state.combos[combo.key] = { ...prev, checkedAt: now.toISOString() };
      continue;
    }
    const insights = parseInsights(raw);
    const clean = parseOptions(raw).filter((o) => checkShabbat([o.segments], windows).status === 'safe');
    // Leader by EFFECTIVE price: a preferred-airline outbound that is a little
    // pricier still wins, so its return legs are the ones we pay to verify.
    const cheapest = clean.length
      ? clean.reduce((a, b) => (effOpt(cfg, a) <= effOpt(cfg, b) ? a : b))
      : null;
    const candPref = cheapest ? isPreferred(cfg, cheapest.airlines) : undefined;

    state.combos[combo.key] = {
      ...prev,
      checkedAt: now.toISOString(),
      candidatePrice: cheapest?.price,
      candidatePreferred: candPref,
      outbound: cheapest?.segments, // schedule of the outbound half
      priceLevel: insights?.priceLevel ?? prev.priceLevel,
      typicalRange: insights?.typicalRange ?? prev.typicalRange,
      // A verified price is stale once the candidate moves.
      price: cheapest?.price === prev.candidatePrice ? prev.price : undefined,
    };
    if (cheapest?.departureToken) combo.leader = cheapest;

    const tag = cheapest ? money(cheapest.price) + (candPref ? ' ★' : '') : 'אין אפשרות ששומרת שבת';
    console.log(`  ${combo.outbound}→${combo.back} (${combo.nights}ל): ${tag}`);
  }

  // ---- phase 2: verify return legs only where it could matter -------------
  const best = bestCombo(cfg, state);
  const bestPrice = best ? best.entry.price : Infinity;
  const toVerify = batch
    .filter((c) => c.leader)
    .filter((c) => c.leader.price <= cfg.alertTotalUsd * 1.15 || c.leader.price <= bestPrice * 1.02)
    .sort((a, b) => a.leader.price - b.leader.price)
    .slice(0, cfg.verifyPerRun);

  for (const combo of toVerify) {
    const raw = await serpApi(cfg, {
      outbound_date: combo.outbound,
      return_date: combo.back,
      departure_token: combo.leader.departureToken,
    });
    spent++;
    if (!raw) continue;
    const clean = parseOptions(raw).filter(
      // Outbound and return as separate journeys — see checkShabbat.
      (o) => checkShabbat([combo.leader.segments, o.segments], windows).status === 'safe',
    );
    if (!clean.length) {
      console.log(`  ${combo.outbound}: כל טיסות החזור נופלות על שבת`);
      continue;
    }
    // Winner by effective TOTAL, where a leg on a preferred airline (outbound or
    // return) makes the whole itinerary preferred.
    const airlinesOf = (o) => [...new Set([...combo.leader.airlines, ...o.airlines])];
    const effReturn = (o) =>
      o.price - (isPreferred(cfg, airlinesOf(o)) ? cfg.preferredBonusUsd || 0 : 0);
    const winner = clean.reduce((a, b) => (effReturn(a) <= effReturn(b) ? a : b));
    const airlines = airlinesOf(winner);
    const preferred = isPreferred(cfg, airlines);
    state.combos[combo.key] = {
      ...state.combos[combo.key],
      // The return result carries the true total, which can exceed the phase-1
      // headline when the cheapest return hits Shabbat.
      price: winner.price,
      airlines,
      preferred,
      stops: Math.max(combo.leader.stops, winner.stops),
      outbound: combo.leader.segments, // both halves' schedules, for the report
      returnLegs: winner.segments,
    };
    console.log(
      `  ✅ ${combo.outbound}→${combo.back}: ${money(winner.price)}${preferred ? ' ★' : ''} (שבת נבדקה)`,
    );
  }

  const final = bestCombo(cfg, state);
  if (final) state.history.push([now.toISOString(), final.entry.price]);
  state.history = state.history.slice(-200);

  writeReport(cfg, state, now);

  // ---- alert --------------------------------------------------------------
  if (final) {
    const price = final.entry.price; // real, always what we show
    const eff = effEntry(cfg, final.entry); // effective, drives the decision
    const already = final.entry.alertedAt; // stored as effective too
    const improved = already === undefined || eff <= already * (1 - RE_ALERT_DROP);
    if (eff <= cfg.alertTotalUsd && improved) {
      const urgent = eff <= cfg.alertTotalUsd * (1 - URGENT_MARGIN);
      const [outbound, nights] = final.key.split('|');
      const back = iso(addDays(new Date(outbound), Number(nights)));
      const title = urgent ? '🚨 מחיר חריג לזנזיבר' : '✈️ טיסה מתחת לתקציב';
      const pref = entryPreferred(final.entry) ? ' · ★ ארקיע' : '';
      const line = `${money(price)} לשניים${pref} · ${fmtDate(outbound)}→${fmtDate(back)}`;
      console.log(`\n${title}: ${line}`);
      await toast(title, line);
      await openInBrowser(REPORT_PATH); // impossible to miss if you're at the machine
      state.combos[final.key].alertedAt = eff;
    } else {
      const mark = entryPreferred(final.entry) ? ' (★ ארקיע)' : '';
      console.log(`\nהכי זול כרגע: ${money(price)}${mark} (הסף: ${money(cfg.alertTotalUsd)})`);
    }
  } else {
    console.log('\nעוד לא נמצאה אפשרות מאומתת ששומרת שבת.');
  }

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log(`\nבקשות API בסריקה הזו: ${spent} · דוח: ${REPORT_PATH}`);
}

// ---------------------------------------------------------------------------
// self-test — proves the Shabbat logic without spending an API call
// ---------------------------------------------------------------------------

async function selfTest() {
  console.log('בודק זמני שבת מול Hebcal...');
  const windows = await shabbatWindows(new Date('2026-07-27'), new Date('2026-08-10'));
  if (!windows.length) {
    console.error('נכשל: לא התקבלו זמני שבת.');
    process.exitCode = 1;
    return;
  }
  for (const w of windows) {
    console.log(`  שבת: ${w.start.toISOString()} → ${w.end.toISOString()}`);
  }

  const seg = (da, dt, aa, at) => ({
    departureAirport: da,
    departureTime: dt,
    arrivalAirport: aa,
    arrivalTime: at,
  });
  const cases = [
    ['שישי מוקדם, נוחת לפני הדלקת נרות', [[seg('TLV', '2026-07-31 07:00', 'ZNZ', '2026-07-31 13:00')]], 'safe'],
    ['שישי בערב, טס לתוך שבת', [[seg('TLV', '2026-07-31 18:00', 'ZNZ', '2026-07-31 23:55')]], 'conflict'],
    ['מוצאי שבת אחרי הבדלה', [[seg('TLV', '2026-08-01 21:00', 'ZNZ', '2026-08-02 02:55')]], 'safe'],
    [
      'עצירת ביניים שיושבת על כל השבת',
      [[seg('TLV', '2026-07-31 12:00', 'IST', '2026-07-31 15:00'), seg('IST', '2026-08-01 20:30', 'ZNZ', '2026-08-02 03:30')]],
      'conflict',
    ],
    [
      'הלוך+חזור תקין (השהות בזנזיבר אינה עצירת ביניים)',
      [[seg('TLV', '2026-07-27 07:00', 'ZNZ', '2026-07-27 13:00')], [seg('ZNZ', '2026-08-02 10:00', 'TLV', '2026-08-02 17:00')]],
      'safe',
    ],
    ['שדה לא מוכר = לא ניתן לאמת', [[seg('TLV', '2026-07-29 07:00', 'QQQ', '2026-07-29 13:00')]], 'unverifiable'],
  ];

  let failed = 0;
  for (const [name, journeys, expected] of cases) {
    const got = checkShabbat(journeys, windows).status;
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`  ${ok ? '✅' : '❌'} ${name} → ${got}${ok ? '' : ` (ציפיתי ${expected})`}`);
  }

  // Preferred-airline advantage (pure logic, no API call).
  console.log('\nבודק את היתרון לחברה מועדפת (ארקיע $150):');
  const pcfg = { preferredAirlines: ['Arkia'], preferredBonusUsd: 150 };
  const prefCases = [
    ['מזהה ארקיע בשם מלא', isPreferred(pcfg, ['Arkia Israel Airlines']) === true],
    ['לא מזהה חברה אחרת', isPreferred(pcfg, ['flydubai']) === false],
    ['ארקיע $2,540 מנצחת רגילה $2,456', effOpt(pcfg, { price: 2540, airlines: ['Arkia'] }) < effOpt(pcfg, { price: 2456, airlines: ['flydubai'] })],
    ['אבל ארקיע $2,700 לא מנצחת $2,456', effOpt(pcfg, { price: 2700, airlines: ['Arkia'] }) > effOpt(pcfg, { price: 2456, airlines: ['flydubai'] })],
    ['מחיר אפקטיבי מוריד רק את הבונוס', effEntry(pcfg, { price: 2540, preferred: true }) === 2390],
  ];
  for (const [name, ok] of prefCases) {
    if (!ok) failed++;
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  }

  console.log(failed ? `\n${failed} בדיקות נכשלו.` : '\nכל הבדיקות עברו.');
  if (failed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  if (!existsSync(CONFIG_PATH)) {
    console.error(`חסר config.json. העתק את config.example.json ל-config.json ומלא מפתח SerpApi.`);
    process.exitCode = 1;
    return;
  }
  const cfg = loadJson(CONFIG_PATH, null);
  if (!cfg) {
    process.exitCode = 1;
    return;
  }

  const state = loadJson(STATE_PATH, { combos: {}, history: [] });
  if (args.includes('--report')) {
    writeReport(cfg, state, new Date());
    console.log(REPORT_PATH);
    if (!args.includes('--no-open')) await openInBrowser(REPORT_PATH);
    return;
  }

  if (!cfg.serpApiKey) {
    console.error('חסר serpApiKey ב-config.json — בלי מפתח אין מה לבדוק.');
    process.exitCode = 1;
    return;
  }
  await sweep(cfg, new Date());
}

main().catch((e) => {
  console.error(`שגיאה: ${e.stack || e.message}`);
  process.exitCode = 1;
});
