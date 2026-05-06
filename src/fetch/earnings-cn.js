/**
 * Fetch A-share (CN) earnings disclosure dates from cninfo.com.cn
 * and HK stock earnings from EastMoney.
 *
 * Data source: cninfo.com.cn (巨潮资讯) — same as akshare's stock_report_disclosure()
 * Writes per-date JSON files to data/earnings/ in the same format as Nasdaq data.
 */

import { fetchWithRetry, sleep } from '../lib/http.js';
import { writeJSON, readJSONIfExists } from '../lib/fs.js';
import { earningsCacheFile } from '../lib/paths.js';

const CNINFO_URL = 'https://www.cninfo.com.cn/new/information/getPrbookInfo';

// Reporting periods to fetch: current year ± 1
function getPeriods() {
  const now = new Date();
  const year = now.getFullYear();
  const periods = [];
  for (const y of [year - 1, year, year + 1]) {
    periods.push(
      { label: `${y}一季`, date: `${y}-03-31` },
      { label: `${y}半年报`, date: `${y}-06-30` },
      { label: `${y}三季`, date: `${y}-09-30` },
      { label: `${y}年报`, date: `${y}-12-31` },
    );
  }
  return periods;
}

function parseTimestamp(ts) {
  if (!ts || ts === '-' || ts === '0') return null;
  if (typeof ts === 'number') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function fetchOnePeriod(period) {
  const params = new URLSearchParams({
    sectionTime: period.date,
    firstTime: '',
    lastTime: '',
    market: 'szsh',
    stockCode: '',
    orderClos: '',
    isDesc: '',
    pagesize: '10000',
    pagenum: '1',
  });

  const res = await fetchWithRetry(`${CNINFO_URL}?${params}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      Origin: 'https://www.cninfo.com.cn',
      Referer: 'https://www.cninfo.com.cn/new/commonUrl?url=data/yypl',
    },
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`cninfo JSON parse failed: ${text.slice(0, 200)}`);
  }

  // prbookinfos: array of objects with keys:
  //   seccode, secname, f002d_0102(首次预约), f006d_0102(实际披露),
  //   f003d_0102(初次变更), f004d_0102(二次变更), f005d_0102(三次变更),
  //   f001d_0102(报告期), latest_time, orgId
  const rows = json.prbookinfos ?? [];
  return rows.map((row) => ({
    symbol: row.seccode,
    companyName: row.secname,
    firstSchedule: row.f002d_0102 || null,
    actualDate: row.f006d_0102 || null,
    change1: row.f003d_0102 || null,
    change2: row.f004d_0102 || null,
    change3: row.f005d_0102 || null,
    reportPeriod: row.f001d_0102 || '',
  }));
}

/**
 * Match stock code against target list, handling leading-zero variants.
 * e.g. '003816' matches '3816', '600089' matches '600089'
 */
function matchesTarget(code, targets) {
  const normalized = code.replace(/^0+/, '') || '0';
  return targets.some((t) => {
    const tNorm = t.replace(/^0+/, '') || '0';
    return tNorm === normalized || t === code;
  });
}

/**
 * Normalize CN stock data into the same shape as Nasdaq earnings data.
 */
function toEarningsEvent(row) {
  const date = row.actualDate || row.change3 || row.change2 || row.change1 || row.firstSchedule;
  if (!date) return null;

  return {
    symbol: row.symbol,
    date,
    companyName: row.companyName,
    fiscalQuarterEnding: row.reportPeriod,
    time: '',
    epsForecast: null,
    marketCap: 'N/A',
    marketCapValue: null,
    industry: '',
    market: 'cn',
  };
}

/**
 * Fetch A-share earnings disclosure dates and merge into data/earnings/.
 * @param {string[]} stockCodes - e.g. ['600089', '600900', '003816']
 */
export async function fetchCNEarnings(stockCodes) {
  if (!stockCodes || stockCodes.length === 0) {
    console.log('[earnings-cn] no stock codes, skipping');
    return { saved: 0, failed: 0, events: 0 };
  }

  const periods = getPeriods();
  const allRows = [];
  const results = { saved: 0, failed: 0, events: 0 };

  for (const period of periods) {
    try {
      const rows = await fetchOnePeriod(period);
      allRows.push(...rows);
      console.log(`[earnings-cn] ${period.label}: ${rows.length} rows`);
    } catch (err) {
      console.warn(`[earnings-cn] ${period.label} failed: ${err.message}`);
      results.failed++;
    }
    await sleep(300);
  }

  // Filter to target stocks and convert (skip rows with missing symbol)
  const events = allRows
    .filter((r) => r.symbol && matchesTarget(r.symbol, stockCodes))
    .map(toEarningsEvent)
    .filter(Boolean);

  // Group by date and merge into existing earnings cache
  const byDate = new Map();
  for (const event of events) {
    if (!byDate.has(event.date)) byDate.set(event.date, []);
    byDate.get(event.date).push(event);
  }

  for (const [date, dateEvents] of byDate) {
    const cacheFile = earningsCacheFile(date);
    const existing = await readJSONIfExists(cacheFile);
    const existingRows = existing?.data ?? [];

    // Remove old CN entries for these stocks, add fresh ones
    const stockSet = new Set(stockCodes);
    const filtered = existingRows.filter(
      (r) => !(r.market === 'cn' && matchesTarget(r.symbol, stockCodes))
    );
    const merged = [...filtered, ...dateEvents];

    await writeJSON(cacheFile, { date, data: merged });
    results.saved++;
    results.events += dateEvents.length;
    console.log(`[earnings-cn] ${date}: ${dateEvents.length} CN events`);
  }

  console.log(`[earnings-cn] done — ${results.events} events across ${results.saved} dates`);
  return results;
}

/**
 * Fetch HK stock earnings. Uses a static config file (data/hk-earnings.json)
 * since HKEX doesn't have a simple API for disclosure schedules.
 *
 * The JSON format is: [{ "symbol": "01816", "companyName": "中广核电力", "date": "2026-03-XX", "reportPeriod": "2025年报" }]
 */
export async function fetchHKEarnings(stockCodes) {
  if (!stockCodes || stockCodes.length === 0) {
    console.log('[earnings-hk] no stock codes, skipping');
    return { saved: 0, events: 0 };
  }

  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const { ROOT } = await import('../lib/paths.js');
  const configPath = resolve(ROOT, 'data', 'hk-earnings.json');

  let hkData;
  try {
    const raw = await readFile(configPath, 'utf-8');
    hkData = JSON.parse(raw);
  } catch {
    console.warn('[earnings-hk] data/hk-earnings.json not found or invalid, skipping');
    return { saved: 0, events: 0 };
  }

  const results = { saved: 0, events: 0 };

  for (const entry of hkData) {
    if (!matchesTarget(entry.symbol, stockCodes)) continue;
    if (!entry.date) continue;

    const event = {
      symbol: entry.symbol,
      date: entry.date,
      companyName: entry.companyName || entry.symbol,
      fiscalQuarterEnding: entry.reportPeriod || '',
      time: '',
      epsForecast: null,
      marketCap: 'N/A',
      marketCapValue: null,
      industry: '',
      market: 'hk',
    };

    const cacheFile = earningsCacheFile(entry.date);
    const existing = await readJSONIfExists(cacheFile);
    const existingRows = existing?.data ?? [];
    const filtered = existingRows.filter(
      (r) => !(r.market === 'hk' && r.symbol === entry.symbol)
    );
    const merged = [...filtered, event];

    await writeJSON(cacheFile, { date: entry.date, data: merged });
    results.saved++;
    results.events++;
    console.log(`[earnings-hk] ${entry.date}: ${entry.symbol} ${entry.companyName}`);
  }

  console.log(`[earnings-hk] done — ${results.events} events`);
  return results;
}
