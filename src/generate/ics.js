import { createEvents } from 'ics';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { icsFile } from '../lib/paths.js';

function buildEvent(entry) {
  const [y, m, d] = entry.date.split('-').map(Number);
  const timeSuffix = entry.time ? ` (${entry.time})` : '';
  const isCatalyst = entry.fiscalQuarterEnding?.startsWith('[催化剂]');
  const catalystTitle = isCatalyst ? entry.fiscalQuarterEnding.replace('[催化剂] ', '') : '';

  const description = isCatalyst
    ? [
        `🔥 催化剂事件`,
        `📊 ${entry.symbol}`,
        catalystTitle,
        entry.marketCap && entry.marketCap !== 'N/A' ? `\n${entry.marketCap}` : null,
        '',
        '— — —',
        'OhEarningsCal · https://rexliu1912-star.github.io/OhEarningsCal/',
      ].filter((line) => line !== null).join('\n')
    : [
        `🏢 ${entry.companyName}`,
        `📊 Symbol: ${entry.symbol}`,
        entry.industry ? `🏭 Industry: ${entry.industry}` : null,
        entry.fiscalQuarterEnding ? `📅 Fiscal quarter: ${entry.fiscalQuarterEnding}` : null,
        entry.epsForecast ? `💵 EPS forecast: ${entry.epsForecast}` : null,
        entry.marketCap && entry.marketCap !== 'N/A' ? `💰 Market cap: ${entry.marketCap}` : null,
        entry.time ? `⏰ Reporting: ${entry.time}` : null,
        '',
        `📱 Open in Stocks app: stocks://?symbol=${entry.symbol}`,
        `🌐 Yahoo Finance: https://finance.yahoo.com/quote/${entry.symbol}`,
        '',
        '— — —',
        'OhEarningsCal · https://rexliu1912-star.github.io/OhEarningsCal/',
      ].filter((line) => line !== null).join('\n');

  return {
    title: isCatalyst
      ? `🔥 ${entry.symbol} ${catalystTitle}`
      : `${entry.symbol} ${entry.companyName}${timeSuffix} earnings`,
    description,
    start: [y, m, d],
    startInputType: 'utc',
    status: 'CONFIRMED',
    busyStatus: 'FREE',
    alarms: [
      { action: 'display', description: isCatalyst ? '催化剂提醒' : 'Earnings reminder', trigger: { hours: 2, minutes: 0, before: true } },
    ],
  };
}

function buildIcs(events, slug, label) {
  return new Promise((resolve, reject) => {
    createEvents(
      events.map(buildEvent),
      {
        productId: `oh-earnings-cal/${slug}`,
        calName: `${label} Earnings Calendar`,
        method: 'PUBLISH',
      },
      (err, value) => (err ? reject(err) : resolve(value)),
    );
  });
}

export async function writeIcsFile({ slug, label, events }) {
  const content = await buildIcs(events, slug, label);
  const file = icsFile(slug);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  console.log(`[ics] wrote ${slug}.ics — ${events.length} events`);
  return file;
}
