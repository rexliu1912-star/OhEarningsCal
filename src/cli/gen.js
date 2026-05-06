import { readJSONIfExists } from '../lib/fs.js';
import { indexFile } from '../lib/paths.js';
import { processEarnings } from '../process/earnings.js';
import { writeIcsFile } from '../generate/ics.js';
import { INDICES, CUSTOM_SLUG, SELECTED_SLUG, ALL_SLUG, MARKETCAP_TIERS } from '../config/indices.js';
import { env } from '../config/env.js';

async function loadIndex(slug) {
  const rows = await readJSONIfExists(indexFile(slug));
  if (!rows) {
    console.warn(`[gen] missing data/indices/${slug}.json — run 'npm run fetch:indices' first`);
    return [];
  }
  return rows;
}

async function buildCustomWatchlist(allIndexRows) {
  const lookup = new Map(allIndexRows.map((r) => [r.symbol.toUpperCase(), r]));
  const combined = [
    ...env.customStocks,
    ...env.cnStocks,
    ...env.hkStocks,
  ];

  if (combined.length === 0) return null;

  return combined.map((sym) => {
    const hit = lookup.get(sym);
    return hit ?? { symbol: sym, companyName: sym, industry: '' };
  });
}

async function genForList(slug, label, watchlist) {
  const events = await processEarnings({ watchlist });
  await writeIcsFile({ slug, label, events });
  return events;
}

async function main() {
  // 1. Load each index's constituents and write their ics.
  const allIndexRows = [];
  for (const meta of INDICES) {
    const rows = await loadIndex(meta.slug);
    allIndexRows.push(...rows);
    await genForList(meta.slug, meta.label, rows);
  }

  // 2. Custom watchlist (US + CN + HK stocks from env vars).
  const customWatchlist = await buildCustomWatchlist(allIndexRows);
  if (customWatchlist) {
    await genForList(CUSTOM_SLUG, 'Custom Watchlist', customWatchlist);
  } else {
    console.log('[gen] no CUSTOM_STOCKS/CN_STOCKS/HK_STOCKS — skipping customstock.ics');
  }

  // 3. CN-only ics
  if (env.cnStocks.length > 0) {
    const cnWatchlist = env.cnStocks.map((sym) => ({ symbol: sym, companyName: sym, industry: '' }));
    await genForList('cn', 'A-Share', cnWatchlist);
  }

  // 4. HK-only ics
  if (env.hkStocks.length > 0) {
    const hkWatchlist = env.hkStocks.map((sym) => ({ symbol: sym, companyName: sym, industry: '' }));
    await genForList('hk', 'HK Stock', hkWatchlist);
  }

  // 5. selected = union of all indices + custom (de-dup by symbol).
  if (env.shouldGenSelected) {
    const seen = new Set();
    const selected = [];
    for (const r of [...allIndexRows, ...(customWatchlist ?? [])]) {
      const sym = r.symbol.toUpperCase();
      if (seen.has(sym)) continue;
      seen.add(sym);
      selected.push(r);
    }
    await genForList(SELECTED_SLUG, 'Selected (Indices + Custom)', selected);
  }

  // 6. all + market-cap tiers — both derived from the unfiltered full set.
  const allEvents = await processEarnings({ watchlist: null });
  if (env.shouldGenAll) {
    await writeIcsFile({ slug: ALL_SLUG, label: 'All Earnings', events: allEvents });
  }
  for (const tier of MARKETCAP_TIERS) {
    const events = allEvents.filter(
      (e) => e.marketCapValue !== null && e.marketCapValue >= tier.min && e.marketCapValue < tier.max,
    );
    await writeIcsFile({ slug: tier.slug, label: tier.label, events });
  }

  console.log('[gen] done.');
}

await main();
