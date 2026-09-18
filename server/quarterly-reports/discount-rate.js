/* ═══════════════════════════════════════════════════════════════════
   DISCOUNT RATE RESOLVER
   ───────────────────────────────────────────────────────────────────
   Resolves the rate used to discount cash flows for the NPV section of
   the quarterly report. There is no stable, free, machine-readable API
   for Bank of Ghana's Monetary Policy Rate (MPR) or 91-day Treasury
   bill rate — both are only published as web pages / PDFs that change
   layout over time. This module is therefore deliberately built as a
   best-effort chain, in priority order:

     1. MANUAL OVERRIDE  — if someone has set a rate via the config
        endpoint, that always wins. This is the escape hatch for when
        the scraper breaks after a BoG site redesign.
     2. LIVE FETCH        — attempt to scrape the current MPR and the
        91-day T-bill rate from bog.gov.gh. Uses a plain-text regex
        scan rather than CSS selectors, since selectors break on any
        markup change while "91-Day ... 27.50%" style text patterns
        tend to survive redesigns.
     3. CACHED FALLBACK    — if the live fetch fails, fall back to the
        last successfully-fetched value, however old, rather than
        blocking report generation.
     4. HARD DEFAULT       — if nothing has ever been fetched or set,
        fall back to a conservative documented default.

   Whichever path is used, the caller gets back a `source` and `asOf`
   so the PDF can print an honest provenance line (e.g. "91-day T-bill
   rate, live-fetched 03 Oct 2026" vs "manually set on 12 Sep 2026").
   Never present a discount rate to a business reader without saying
   where it came from.
   ═══════════════════════════════════════════════════════════════════ */

const axios = require('axios');
const cheerio = require('cheerio');

const CONFIG_KEY = 'ww_quarterly_report_config';
const BOG_CANDIDATE_URLS = [
  'https://www.bog.gov.gh/treasury-and-the-market/treasury-securities/',
  'https://www.bog.gov.gh/monetary-policy/monetary-policy-rate/',
  'https://www.bog.gov.gh/',
];

// Conservative hard default used only if nothing has ever been fetched
// or configured. Documented here rather than left as a magic number.
const HARD_DEFAULT_ANNUAL_RATE = 0.27; // 27% — broadly in line with Ghana's recent policy-rate range

function extractPercentFromText(text, keywords) {
  // Looks for the first "<number>%" that appears within ~120 characters
  // after any of the given keywords, case-insensitive. This survives
  // markup/redesigns far better than a CSS selector would.
  const lower = text.toLowerCase();
  for (const keyword of keywords) {
    const idx = lower.indexOf(keyword.toLowerCase());
    if (idx === -1) continue;
    const window = text.slice(idx, idx + 160);
    const match = window.match(/(\d{1,2}(?:\.\d{1,2})?)\s*%/);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100) return value / 100;
    }
  }
  return null;
}

async function scrapeBankOfGhanaRates() {
  for (const url of BOG_CANDIDATE_URLS) {
    try {
      const response = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WWWQuarterlyReportBot/1.0)' },
      });
      const $ = cheerio.load(response.data);
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

      const mpr = extractPercentFromText(bodyText, ['monetary policy rate', 'policy rate', 'mpr']);
      const tbill91 = extractPercentFromText(bodyText, ['91-day', '91 day', '91-Day Treasury bill', '91-day treasury']);

      if (mpr || tbill91) {
        return { monetaryPolicyRate: mpr, treasuryBill91Day: tbill91, sourceUrl: url };
      }
    } catch (_error) {
      // Try the next candidate URL; a single failure should never bubble up.
      continue;
    }
  }
  return null;
}

async function readConfig(AppData) {
  const doc = await AppData.findOne({ key: CONFIG_KEY }).lean();
  return (doc && doc.data && typeof doc.data === 'object') ? doc.data : {};
}

async function writeConfig(AppData, patch) {
  const existing = await readConfig(AppData);
  const next = { ...existing, ...patch };
  await AppData.updateOne({ key: CONFIG_KEY }, { key: CONFIG_KEY, data: next }, { upsert: true });
  return next;
}

/**
 * Resolves the annual discount rate to use for NPV this quarter.
 * @param {{AppData: object, nowIso: Function}} deps
 * @param {{preferredBenchmark?: 'tbill91'|'mpr'}} options
 * @returns {Promise<{rate: number, source: string, asOf: string, benchmark: string}>}
 */
async function resolveDiscountRate({ AppData, nowIso }, options = {}) {
  const preferredBenchmark = options.preferredBenchmark === 'mpr' ? 'mpr' : 'tbill91';
  const config = await readConfig(AppData);

  // 1. Manual override always wins.
  if (typeof config.discountRateManualOverride === 'number' && config.discountRateManualOverride > 0) {
    return {
      rate: config.discountRateManualOverride,
      source: 'manual',
      asOf: config.discountRateManualSetAt || 'unknown date',
      benchmark: 'manual override',
    };
  }

  // 2. Live fetch attempt.
  let scraped = null;
  try {
    scraped = await scrapeBankOfGhanaRates();
  } catch (_error) {
    scraped = null;
  }

  if (scraped) {
    const chosen = preferredBenchmark === 'mpr'
      ? (scraped.monetaryPolicyRate || scraped.treasuryBill91Day)
      : (scraped.treasuryBill91Day || scraped.monetaryPolicyRate);

    if (chosen) {
      const nowStamp = nowIso();
      await writeConfig(AppData, {
        discountRateCacheAnnual: chosen,
        discountRateCacheAt: nowStamp,
        discountRateCacheSourceUrl: scraped.sourceUrl,
        discountRateCacheBenchmark: preferredBenchmark === 'mpr' ? 'Monetary Policy Rate' : '91-day Treasury bill rate',
      });
      return {
        rate: chosen,
        source: 'live',
        asOf: nowStamp,
        benchmark: preferredBenchmark === 'mpr' ? 'Monetary Policy Rate (live)' : '91-day Treasury bill rate (live)',
      };
    }
  }

  // 3. Cached fallback — use whatever was last fetched, however old.
  if (typeof config.discountRateCacheAnnual === 'number' && config.discountRateCacheAnnual > 0) {
    return {
      rate: config.discountRateCacheAnnual,
      source: 'cached-fallback',
      asOf: config.discountRateCacheAt || 'unknown date',
      benchmark: `${config.discountRateCacheBenchmark || 'Bank of Ghana rate'} (stale — live fetch failed this run)`,
    };
  }

  // 4. Hard, documented default — last resort only.
  return {
    rate: HARD_DEFAULT_ANNUAL_RATE,
    source: 'default-fallback',
    asOf: nowIso(),
    benchmark: 'Documented conservative default (no live or cached rate available)',
  };
}

async function setManualOverride(AppData, nowIso, rate) {
  const numericRate = Number(rate);
  if (!Number.isFinite(numericRate) || numericRate <= 0 || numericRate >= 1) {
    throw new Error('Rate must be a decimal fraction between 0 and 1 (e.g. 0.27 for 27%)');
  }
  return writeConfig(AppData, {
    discountRateManualOverride: numericRate,
    discountRateManualSetAt: nowIso(),
  });
}

async function clearManualOverride(AppData) {
  return writeConfig(AppData, {
    discountRateManualOverride: null,
    discountRateManualSetAt: null,
  });
}

module.exports = {
  CONFIG_KEY,
  resolveDiscountRate,
  setManualOverride,
  clearManualOverride,
  readConfig,
  writeConfig,
};