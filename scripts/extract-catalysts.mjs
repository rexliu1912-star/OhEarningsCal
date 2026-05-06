#!/usr/bin/env node
/**
 * extract-catalysts.mjs
 *
 * Scans portfolio research reports, extracts dated catalysts from
 * "催化剂" sections, writes data/catalysts.json for ICS generation.
 *
 * Usage: node scripts/extract-catalysts.mjs [--research-dir PATH]
 *
 * Reads portfolio symbols from env: CUSTOM_STOCKS, CN_STOCKS, HK_STOCKS
 * Falls back to hardcoded defaults if not set.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

// --- Config ---

const RESEARCH_DIR = process.argv.includes('--research-dir')
  ? process.argv[process.argv.indexOf('--research-dir') + 1]
  : process.env.RESEARCH_DIR ||
    join(process.env.HOME, 'clawd/output/research/investment-strategy');

const OUTPUT_FILE = process.env.CATALYSTS_OUTPUT ||
  join(process.env.HOME, 'OhEarningsCal/data/catalysts.json');

// Portfolio symbols (same as earnings-cn.js)
const US_SYMBOLS = (process.env.CUSTOM_STOCKS || 'AAPL,CEG,TSLA,LNG').split(',').map(s => s.trim().toUpperCase());
const CN_SYMBOLS = (process.env.CN_STOCKS || '600089,600900,003816').split(',').map(s => s.trim());
const HK_SYMBOLS = (process.env.HK_STOCKS || '01816').split(',').map(s => s.trim());
const ALL_SYMBOLS = [...US_SYMBOLS, ...CN_SYMBOLS, ...HK_SYMBOLS];

// --- Symbol ↔ filename mapping ---

const SYMBOL_ALIASES = {
  'AAPL': ['apple', 'aapl'],
  'CEG':  ['constellation', 'ceg'],
  'TSLA': ['tesla', 'tsla'],
  'LNG':  ['cheniere', 'lng'],
  '600089': ['特变电工', '600089'],
  '600900': ['长江电力', '600900'],
  '003816': ['中国广核', '003816'],
  '01816':  ['中广核电力', '01816'],
};

function filenameMatchesSymbol(filename, symbol) {
  const lower = filename.toLowerCase();
  const aliases = SYMBOL_ALIASES[symbol] || [symbol.toLowerCase()];
  return aliases.some(a => lower.includes(a));
}

// --- Date parsing ---

function parseDateToken(raw) {
  // Normalize: remove spaces around separators
  let s = raw.replace(/\s+/g, ' ').trim();

  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return { date: `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`, precision: 'day' };
  }

  // YYYY/MM/DD
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    return { date: `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`, precision: 'day' };
  }

  // YYYY-MM (month precision)
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    return { date: `${m[1]}-${m[2].padStart(2,'0')}-01`, precision: 'month' };
  }

  // YYYYH1 / YYYYH2 (half-year)
  m = s.match(/^(\d{4})[Hh]([12])$/);
  if (m) {
    const month = m[2] === '1' ? '01' : '07';
    return { date: `${m[1]}-${month}-01`, precision: 'half' };
  }

  // YYYYQ1-Q4 (quarter)
  m = s.match(/^(\d{4})[Qq]([1-4])$/);
  if (m) {
    const month = String((parseInt(m[2]) - 1) * 3 + 1).padStart(2, '0');
    return { date: `${m[1]}-${month}-01`, precision: 'quarter' };
  }

  // YYYY (year only)
  m = s.match(/^(\d{4})$/);
  if (m) {
    return { date: `${m[1]}-01-01`, precision: 'year' };
  }

  // YYYY 年 ... (Chinese year reference)
  m = s.match(/^(\d{4})\s*年/);
  if (m) {
    if (s.includes('年末')) return { date: `${m[1]}-12-01`, precision: 'half' };
    if (s.includes('年中')) return { date: `${m[1]}-06-01`, precision: 'half' };
    return { date: `${m[1]}-01-01`, precision: 'year' };
  }

  // YYYY 下半年 (Chinese half-year)
  m = s.match(/^(\d{4})\s*下半年/);
  if (m) return { date: `${m[1]}-07-01`, precision: 'half' };

  // YYYY 上半年
  m = s.match(/^(\d{4})\s*上半年/);
  if (m) return { date: `${m[1]}-01-01`, precision: 'half' };

  // YYYY Qn-Qm (quarter range → first quarter)
  m = s.match(/^(\d{4})\s*[Qq]([1-4])\s*[-–]\s*[Qq]([1-4])$/);
  if (m) {
    const month = String((parseInt(m[2]) - 1) * 3 + 1).padStart(2, '0');
    return { date: `${m[1]}-${month}-01`, precision: 'quarter' };
  }

  // YYYY Qn (quarter)
  m = s.match(/^(\d{4})\s*[Qq]([1-4])$/);
  if (m) {
    const month = String((parseInt(m[2]) - 1) * 3 + 1).padStart(2, '0');
    return { date: `${m[1]}-${month}-01`, precision: 'quarter' };
  }

  return null;
}

// --- Catalyst extraction ---

function extractCatalysts(content, symbol) {
  const events = [];
  const lines = content.split('\n');

  // Find catalyst section(s)
  let inSection = false;
  let sectionDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect catalyst section header
    if (/#{2,4}\s+.*催化剂/.test(line)) {
      inSection = true;
      sectionDepth = (line.match(/^#+/) || [''])[0].length;
      continue;
    }

    // Exit section when hitting same or higher-level header
    if (inSection && /^#{2,4}\s+/.test(line)) {
      const depth = (line.match(/^#+/) || [''])[0].length;
      if (depth <= sectionDepth) {
        inSection = false;
        continue;
      }
    }

    if (!inSection) continue;

    // Extract **DATE TITLE** patterns
    // Match: **2026-04-30 Q2 FY26 财报** or **2026H2 iPhone 18**
    const boldMatches = line.matchAll(/\*\*(.+?)\*\*/g);
    for (const bm of boldMatches) {
      const inner = bm[1];

      // Try to find a date token at the start of the bold text
      // Patterns: "2026-04-30 Q2...", "2026H2 iPhone...", "2026-06 WWDC"
      const datePatterns = [
        /^(\d{4}-\d{1,2}-\d{1,2})\s+(.+)$/,           // YYYY-MM-DD TITLE
        /^(\d{4}\/\d{1,2}\/\d{1,2})\s+(.+)$/,          // YYYY/MM/DD TITLE
        /^(\d{4}-\d{1,2})\s+(.+)$/,                     // YYYY-MM TITLE
        /^(\d{4}-[HhQq][12])\s+(.+)$/,                  // YYYY-Hn / YYYY-Qn TITLE
        /^(\d{4}[Hh][12])\s+(.+)$/,                     // YYYYHn TITLE
        /^(\d{4}[Qq][1-4])\s+(.+)$/,                    // YYYYQn TITLE
        /^(\d{4})\s+[Qq]([1-4])\s*[-–]\s*[Qq]([1-4])\s+(.+)$/, // YYYY Qn-Qm TITLE
        /^(\d{4})\s+[Qq]([1-4])\s+(.+)$/,               // YYYY Qn TITLE
        /^(\d{4})\s*下半年\s*(.+)$/,                     // YYYY 下半年 TITLE
        /^(\d{4})\s*上半年\s*(.+)$/,                     // YYYY 上半年 TITLE
        /^(\d{4})\s+年[末中]?\s*(.+)$/,                  // YYYY 年... TITLE
        /^(\d{4})\s+(.+)$/,                              // YYYY TITLE
      ];

      for (const pat of datePatterns) {
        const dm = inner.match(pat);
        if (dm) {
          // Reconstruct date token from capture groups
          // For YYYY Qn-Qm pattern (groups: year, q1, q2, title), build "YYYY Q1-Q2"
          let dateToken = dm[1];
          let titleIdx = 2;
          if (pat.source.includes('\\s+[Qq]([1-4])\\s*[-–]')) {
            // YYYY Qn-Qm TITLE: groups are [full, year, q1, q2, title]
            dateToken = `${dm[1]} Q${dm[2]}-Q${dm[3]}`;
            titleIdx = 4;
          } else if (pat.source.includes('\\s+[Qq]([1-4])\\s+')) {
            // YYYY Qn TITLE: groups are [full, year, q, title]
            dateToken = `${dm[1]} Q${dm[2]}`;
            titleIdx = 3;
          } else if (pat.source.includes('下半年') || pat.source.includes('上半年')) {
            // YYYY 下半年 TITLE: groups are [full, year, title]
            dateToken = `${dm[1]} ${inner.match(/(下半年|上半年)/)[0]}`;
            titleIdx = 2;
          }

          const parsed = parseDateToken(dateToken);
          if (parsed) {
            const title = dm[titleIdx].trim();
            // Extract description from after the bold text
            const afterBold = line.split(bm[0])[1] || '';
            const descMatch = afterBold.match(/[—–-]+\s*(.+)/);
            const description = descMatch ? descMatch[1].trim().slice(0, 200) : '';

            events.push({
              symbol,
              date: parsed.date,
              precision: parsed.precision,
              title,
              description,
              source: 'research',
            });
            break;
          }
        }
      }
    }
  }

  return events;
}

// --- Main ---

function main() {
  console.log(`[catalyst-extract] scanning ${RESEARCH_DIR}`);
  console.log(`[catalyst-extract] portfolio: ${ALL_SYMBOLS.join(', ')}`);

  if (!existsSync(RESEARCH_DIR)) {
    console.error(`[catalyst-extract] ERROR: research dir not found: ${RESEARCH_DIR}`);
    process.exit(1);
  }

  // Recursively find all .md files
  function findMdFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMdFiles(fullPath));
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const allFiles = findMdFiles(RESEARCH_DIR);
  console.log(`[catalyst-extract] found ${allFiles.length} .md files`);

  // Match files to portfolio symbols
  const allEvents = [];
  let matchedFiles = 0;

  for (const symbol of ALL_SYMBOLS) {
    const matchingFiles = allFiles.filter(f => filenameMatchesSymbol(basename(f), symbol));

    if (matchingFiles.length === 0) {
      console.log(`[catalyst-extract] ${symbol}: no research files found`);
      continue;
    }

    for (const filePath of matchingFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const events = extractCatalysts(content, symbol);
      if (events.length > 0) {
        matchedFiles++;
        console.log(`[catalyst-extract] ${symbol}: ${events.length} catalysts from ${basename(filePath)}`);
        allEvents.push(...events);
      }
    }
  }

  // Dedup by (symbol, date, title)
  const seen = new Set();
  const deduped = allEvents.filter(e => {
    const key = `${e.symbol}|${e.date}|${e.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date
  deduped.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  // Write output
  writeFileSync(OUTPUT_FILE, JSON.stringify(deduped, null, 2) + '\n');
  console.log(`[catalyst-extract] done — ${deduped.length} catalysts from ${matchedFiles} files → ${OUTPUT_FILE}`);
}

main();
