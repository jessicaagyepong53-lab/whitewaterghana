/* ═══════════════════════════════════════════════════════════════════
   PERIOD ANALYSIS ENGINE  (quarterly + annual)
   ───────────────────────────────────────────────────────────────────
   Reads straight from the AppData key-value buckets (the app's source
   of truth) so the report always matches what the Reports page shows.

   One engine serves both report types: buildQuarterlyAnalysis() and
   buildAnnualAnalysis() only differ in which months they pass in.

   What changed versus the first version (and why):
   - SUPPLY was always 0 because it only read ww_production_batches
     (manual batches). The Production page also derives output from
     the daily production log and Inventory finished products, so this
     engine reads all of them and uses the most complete source per
     month.
   - Customer names are normalised ("Wisdom"/"WISDOM", "Charlotte /
     GN 4627 25" -> "Charlotte", walk-ins pooled) before the BCG matrix.
   - BCG growth is measured on AVERAGE MONTHLY revenue so a partial
     prior period (e.g. only March existed before Q2) does not make
     every customer look "new".
   - Adds: price/volume decomposition, weekly + weekday patterns,
     seasonality diagnosis, cost structure, break-even, DuPont ROI,
     regression-based marginal analysis, NPV scenarios + discount-rate
     sensitivity, a forward outlook range, and plain-language commentary.

   Nothing here is an audited statement. Every assumption is stored in
   the output so the PDF can print it next to the number it affects.
   ═══════════════════════════════════════════════════════════════════ */

const SALES_MONTHS_KEY = 'ww_sales_months';
const ACCOUNTING_KEY = 'ww_accounting_data_v2';
const PRODUCTION_KEY = 'ww_production_batches';
const DAILY_PRODUCTION_KEY = 'ww_daily_production';
const FINISHED_PRODUCTS_KEY = 'ww_finished_products';

const NON_DEMAND_STATUSES = new Set(['pending_approval', 'cancelled', 'canceled', 'void', 'voided', 'rejected', 'draft']);
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ── Quarter / year helpers (exports kept from the previous version) ── */

function quarterMonths(year, quarter) {
  const startMonth = (quarter - 1) * 3 + 1;
  return [0, 1, 2].map((offset) => `${year}-${String(startMonth + offset).padStart(2, '0')}`);
}

function previousQuarter(year, quarter) {
  if (quarter === 1) return { year: year - 1, quarter: 4 };
  return { year, quarter: quarter - 1 };
}

function justCompletedQuarter(now = new Date()) {
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  if (month <= 3) return { year: year - 1, quarter: 4 };
  if (month <= 6) return { year, quarter: 1 };
  if (month <= 9) return { year, quarter: 2 };
  return { year, quarter: 3 };
}

function quarterLabel(year, quarter) {
  return `Q${quarter} ${year}`;
}

// Used by the cron that fires on the LAST day of a quarter.
function quarterEndingToday(now = new Date()) {
  const month = now.getMonth() + 1;
  return { year: now.getFullYear(), quarter: Math.ceil(month / 3) };
}

function yearMonths(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

function yearLabel(year) {
  return String(year);
}

function justCompletedYear(now = new Date()) {
  return { year: now.getFullYear() - 1 };
}

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Human-readable time frame for a set of 'YYYY-MM' months, used by the PDF
// header, running page headers and the email body.
function describePeriod(months) {
  if (!months || !months.length) return null;
  const first = months[0];
  const last = months[months.length - 1];
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
  const startText = `1 ${MONTH_FULL[fm - 1]} ${fy}`;
  const endText = `${lastDay} ${MONTH_FULL[lm - 1]} ${ly}`;
  return {
    start: `${first}-01`,
    end: `${last}-${String(lastDay).padStart(2, '0')}`,
    startText,
    endText,
    rangeText: `${startText} – ${endText}`,
    shortText: fy === ly ? `${MONTH_SHORT[fm - 1]} – ${MONTH_SHORT[lm - 1]} ${ly}` : `${MONTH_SHORT[fm - 1]} ${fy} – ${MONTH_SHORT[lm - 1]} ${ly}`,
    monthNames: months.map((m) => MONTH_FULL[Number(m.slice(5, 7)) - 1]),
    monthKeys: months.slice(),
    year: ly,
  };
}

/* ── Period availability (has the period ended yet?) ─────────────── */
// A report is available from the day AFTER its period closes, so it always
// contains complete data. (The automatic send still fires at 23:55 on the
// final day, which is why the message mentions it.) Ghana observes GMT all
// year with no daylight saving, so UTC dates equal Ghana dates.

function utcDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function fmtLongDate(d) {
  return `${d.getUTCDate()} ${MONTH_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function checkPeriodAvailability({ periodType, year, quarter }, now = new Date()) {
  const months = periodType === 'quarter' ? quarterMonths(year, quarter) : yearMonths(year);
  const period = describePeriod(months);
  const lastDay = new Date(`${period.end}T00:00:00Z`);
  const opensOn = new Date(lastDay.getTime() + 24 * 60 * 60 * 1000);
  const today = utcDateOnly(now);
  const available = today.getTime() >= opensOn.getTime();
  const daysUntil = available ? 0 : Math.ceil((opensOn.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  const label = periodType === 'quarter' ? quarterLabel(year, quarter) : yearLabel(year);
  const noun = periodType === 'quarter' ? 'quarterly' : 'annual';
  const inProgress = today.getTime() >= new Date(`${period.start}T00:00:00Z`).getTime();

  let message = '';
  if (!available) {
    const when = daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`;
    message = inProgress
      ? `The ${label} ${noun} report can't be generated yet. ${periodType === 'quarter' ? 'This quarter' : 'This year'} is still in progress and runs from ${period.startText} to ${period.endText}. Please come back from ${fmtLongDate(opensOn)} (${when}), once the period has closed, so the report covers complete figures. It will also be generated and sent automatically ${periodType === 'quarter' ? `at 23:55 on ${period.endText}` : `at 00:15 on ${fmtLongDate(opensOn)}`}.`
      : `The ${label} ${noun} report can't be generated yet. ${periodType === 'quarter' ? 'This quarter' : 'This year'} hasn't started: it runs from ${period.startText} to ${period.endText}. Please come back from ${fmtLongDate(opensOn)}, once the period has closed.`;
  }
  return {
    available,
    label,
    periodType,
    periodStart: period.startText,
    periodEnd: period.endText,
    opensOn: opensOn.toISOString().slice(0, 10),
    opensOnText: fmtLongDate(opensOn),
    daysUntil,
    inProgress,
    autoSendText: periodType === 'quarter' ? `23:55 on ${period.endText}` : `00:15 on ${fmtLongDate(opensOn)}`,
    message,
  };
}

/* ── Generic small helpers ───────────────────────────────────────── */

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthShortLabel(month) {
  const [y, m] = String(month).split('-');
  return `${MONTH_SHORT[Number(m) - 1] || m} ${y}`;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sampleStdDev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + ((v - avg) ** 2), 0) / (values.length - 1));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pctChange(current, previous) {
  if (!Number.isFinite(previous) || previous === 0 || !Number.isFinite(current)) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function safeDiv(a, b) {
  return b ? a / b : null;
}

function ghs(value) {
  const n = Number(value) || 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}GH₵${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPctText(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a';
  return `${Number(value).toFixed(digits)}%`;
}

function olsFit(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

/* ── Customer name normalisation ─────────────────────────────────── */
// The free-text customer field mixes real repeat buyers with generic
// placeholders, case variants, vehicle numbers and "A / B" combinations.
// Without this step the BCG matrix ranks the same buyer twice.

const PLACEHOLDER_RE = /^(walk[\s-]?ins?|client|clients|individual|individuals|customer|cash|unknown|anonymous|n\/a|none|-+|nil|retail)$/i;
const WALK_IN_KEY = '__walk_in__';

function normalizeCustomer(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.split('/')[0];
  s = s.replace(/\s+/g, ' ').trim();
  const lower = s.toLowerCase();
  if (!lower || PLACEHOLDER_RE.test(lower)) {
    return { key: WALK_IN_KEY, display: 'Walk-in / unnamed', isPlaceholder: true };
  }
  const display = lower.replace(/\b\w/g, (c) => c.toUpperCase());
  return { key: lower, display, isPlaceholder: false };
}

/* ── Raw data loading (AppData only) ─────────────────────────────── */

function invoiceQty(invoice) {
  if (Array.isArray(invoice.items) && invoice.items.length) {
    return invoice.items.reduce((sum, item) => sum + (Number(item && item.qty) || 0), 0);
  }
  return Number(invoice.bags || 0) || 0;
}

function invoiceMonth(invoice) {
  const raw = String(invoice && invoice.date || '').trim();
  return /^\d{4}-\d{2}/.test(raw) ? raw.slice(0, 7) : '';
}

async function loadSalesInvoices(AppData, endMonth) {
  const docs = await AppData.find({ key: /^ww_sales_\d{4}-\d{2}$/ }).lean();
  const seen = new Set();
  const out = [];
  for (const doc of docs) {
    const payload = (doc && doc.data && typeof doc.data === 'object') ? doc.data : {};
    const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
    for (const inv of invoices) {
      if (!inv || !inv.id || seen.has(inv.id)) continue;
      seen.add(inv.id);
      const month = invoiceMonth(inv);
      if (!month || month > endMonth) continue;
      const qty = invoiceQty(inv);
      const amount = Number(inv.amount) || 0;
      const status = String(inv.status || '').toLowerCase();
      const customer = normalizeCustomer(inv.customer);
      out.push({
        id: String(inv.id),
        date: String(inv.date).slice(0, 10),
        month,
        customer,
        qty,
        amount,
        status,
        isPaid: status === 'paid',
        countsAsDemand: !NON_DEMAND_STATUSES.has(status),
        promo: Number(inv.promo) || 0,
        rate: Number(inv.rate || (inv.items && inv.items[0] ? inv.items[0].unitPrice : 0)) || 0,
      });
    }
  }
  return out;
}

async function loadAccountingData(AppData) {
  const doc = await AppData.findOne({ key: ACCOUNTING_KEY }).lean();
  const data = (doc && doc.data && typeof doc.data === 'object') ? doc.data : {};
  return {
    ledger: Array.isArray(data.ledger) ? data.ledger : [],
    assets: Array.isArray(data.assets) ? data.assets : [],
  };
}

async function loadProductionSources(AppData) {
  const [batchDoc, dailyDoc, finishedDoc, inventoryDocs] = await Promise.all([
    AppData.findOne({ key: PRODUCTION_KEY }).lean(),
    AppData.findOne({ key: DAILY_PRODUCTION_KEY }).lean(),
    AppData.findOne({ key: FINISHED_PRODUCTS_KEY }).lean(),
    AppData.find({ key: /^ww_inventory_\d{4}-\d{2}$/ }).lean(),
  ]);
  const batches = Array.isArray(batchDoc && batchDoc.data) ? batchDoc.data : [];
  const dailyLog = (dailyDoc && dailyDoc.data && typeof dailyDoc.data === 'object' && !Array.isArray(dailyDoc.data)) ? dailyDoc.data : {};
  const finishedList = Array.isArray(finishedDoc && finishedDoc.data) ? finishedDoc.data : [];
  const inventoryFinished = [];
  for (const doc of inventoryDocs || []) {
    const rows = doc && doc.data && Array.isArray(doc.data.finishedProducts) ? doc.data.finishedProducts : [];
    inventoryFinished.push(...rows);
  }
  return { batches, dailyLog, finishedList, inventoryFinished };
}

/* ── Supply (production) by month, from every place output is recorded ── */

function supplyByMonth(sources) {
  const sumRows = (rows) => {
    const map = {};
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const qty = Number(row.qty || row.quantity || 0) || 0;
      const date = String(row.date || row.addedDate || row.createdAt || '').slice(0, 10);
      if (qty <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      map[date.slice(0, 7)] = (map[date.slice(0, 7)] || 0) + qty;
    }
    return map;
  };

  const daily = {};
  for (const [date, qty] of Object.entries(sources.dailyLog || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    daily[date.slice(0, 7)] = (daily[date.slice(0, 7)] || 0) + (Number(qty) || 0);
  }
  const completedBatches = (sources.batches || []).filter((b) => b && String(b.status).toLowerCase() === 'completed');

  const candidates = {
    'Daily production log': daily,
    'Inventory finished products': sumRows(sources.finishedList || []),
    'Inventory monthly records': sumRows(sources.inventoryFinished || []),
    'Completed production batches': sumRows(completedBatches),
  };

  // Several of these can describe the same output (the Production page
  // derives its batch list from them), so summing would double count.
  // Take the most complete source for each month instead.
  const result = {};
  const winners = {};
  const allMonths = new Set();
  Object.values(candidates).forEach((map) => Object.keys(map).forEach((m) => allMonths.add(m)));
  for (const month of allMonths) {
    let best = 0;
    let bestName = null;
    for (const [name, map] of Object.entries(candidates)) {
      if ((map[month] || 0) > best) { best = map[month]; bestName = name; }
    }
    result[month] = best;
    if (bestName) winners[month] = bestName;
  }
  return { byMonth: result, winners };
}

/* ── Ledger classification ───────────────────────────────────────── */

const VARIABLE_ACCOUNT_RE = /production|material|raw|film|sachet|packag|carton|nylon|fuel|diesel|transport|deliver|freight|commission/i;

function classifyExpenseAccount(account) {
  const a = String(account || '').trim();
  return {
    isProduction: a.toLowerCase() === 'production',
    isVariable: VARIABLE_ACCOUNT_RE.test(a),
  };
}

function ledgerExpenses(ledger, monthSet) {
  const byAccount = {};
  const byMonth = {};
  let total = 0;
  let variable = 0;
  let production = 0;
  for (const e of ledger) {
    if (!e || String(e.type).toLowerCase() !== 'expense') continue;
    const month = String(e.date || '').slice(0, 7);
    if (!monthSet.has(month)) continue;
    const amount = (Number(e.debit) || 0) - (Number(e.credit) || 0);
    const account = String(e.account || 'Other').trim() || 'Other';
    const cls = classifyExpenseAccount(account);
    byAccount[account] = (byAccount[account] || 0) + amount;
    byMonth[month] = (byMonth[month] || 0) + amount;
    total += amount;
    if (cls.isVariable) variable += amount;
    if (cls.isProduction) production += amount;
  }
  return { byAccount, byMonth, total, variable, production };
}

/* ── Seasonality (single calendar shared with the dashboard) ─────── */
// This calendar is deliberately identical to SEASON_CALENDAR in
// src/seasonal-outlook-widget.js so the dashboard and the PDF never
// contradict each other. It is GENERAL INDUSTRY KNOWLEDGE for drinking
// water in Ghana, not measured from this business. It is replaced by a
// measured seasonal index once 24+ months of history exist.
// If you edit the widget's calendar, edit this one too.

const R_PEAK = 'Harmattan and dry-season heat (Dec-Mar) typically drive the highest demand for drinking water nationwide.';
const R_LEAN = 'Jul-Sep is typically the wettest stretch of the year: more time indoors generally means lower demand for chilled/drinking water.';
const SEASON_CALENDAR = {
  '01': { key: 'peak', season: 'Peak Season', tendency: 'higher', expected: 'up', why: R_PEAK, events: 'Post-festive slowdown in institutional and event buying early in the month; schools resume mid-month.' },
  '02': { key: 'peak', season: 'Peak Season', tendency: 'higher', expected: 'up', why: R_PEAK, events: 'Temperatures climb toward the annual peak.' },
  '03': { key: 'peak', season: 'Peak Season', tendency: 'higher', expected: 'up', why: R_PEAK, events: 'Hottest month of the year; Independence Day (6 March) events lift bulk purchases.' },
  '04': { key: 'transition-down', season: 'Transition - Softening', tendency: 'softening', expected: 'down', why: 'Demand is usually still fairly strong in April, but rains begin picking up and start easing consumption.', events: 'Easter gatherings (movable date) can offset the softening.' },
  '05': { key: 'transition-down', season: 'Transition - Softening', tendency: 'softening', expected: 'down', why: 'Rainfall becomes more frequent through May, gradually easing outdoor water consumption.', events: 'Heavy rains can slow deliveries and reduce outdoor events.' },
  '06': { key: 'transition-down', season: 'Transition - Softening', tendency: 'softening', expected: 'down', why: 'By June, wetter weather has usually settled in, continuing to soften demand ahead of the lean months.', events: 'Peak rains and Accra flooding risk can disrupt distribution.' },
  '07': { key: 'lean', season: 'Lean Season', tendency: 'lower', expected: 'down', why: R_LEAN, events: 'Cool, overcast weather keeps thirst-driven demand subdued.' },
  '08': { key: 'lean', season: 'Lean Season', tendency: 'lower', expected: 'down', why: R_LEAN, events: 'School vacation reduces institutional demand; Homowo festivities can lift bulk orders.' },
  '09': { key: 'lean', season: 'Lean Season', tendency: 'lower', expected: 'down', why: R_LEAN, events: 'Schools back in session support institutional demand late in the month.' },
  '10': { key: 'transition-up', season: 'Transition - Rising', tendency: 'rising', expected: 'up', why: 'Weather starts turning hotter and drier again in October, and demand typically begins climbing back up.', events: 'Steady school and workplace demand.' },
  '11': { key: 'transition-up', season: 'Transition - Rising', tendency: 'rising', expected: 'up', why: 'Demand keeps building through November as the dry season approaches, plus early holiday-season activity.', events: 'Pre-Christmas build-up begins late in the month.' },
  '12': { key: 'peak', season: 'Peak Season', tendency: 'higher', expected: 'up', why: 'December combines dry-season heat with Christmas/New Year demand from events, gatherings, and retail: usually the strongest month of the year.', events: 'Christmas and New Year gatherings, events and travel.' },
};

// Illustrative adjustment used ONLY in the outlook scenario, and labelled as such.
const TENDENCY_MULTIPLIER = { higher: 0.08, rising: 0.04, softening: -0.04, lower: -0.08 };

function seasonOf(month) {
  return SEASON_CALENDAR[String(month).slice(5, 7)] || { key: 'n/a', season: 'n/a', tendency: 'softening', expected: 'down', why: '', events: '' };
}

/* ── Statistics blocks ───────────────────────────────────────────── */

function variabilityBand(avg, cv) {
  if (!avg) return 'No revenue recorded this period';
  if (cv < 15) return 'Low variability (stable revenue)';
  if (cv < 30) return 'Moderate variability';
  return 'High variability (volatile revenue)';
}

function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function buildWeekly(paidInvoices) {
  if (!paidInvoices.length) return [];
  const map = {};
  for (const inv of paidInvoices) {
    const w = weekStart(inv.date);
    map[w] = (map[w] || 0) + inv.amount;
  }
  const weeks = Object.keys(map).sort();
  const out = [];
  let cursor = weeks[0];
  const last = weeks[weeks.length - 1];
  let guard = 0;
  while (cursor <= last && guard < 120) {
    out.push({ weekStart: cursor, revenue: round2(map[cursor] || 0) });
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    cursor = d.toISOString().slice(0, 10);
    guard += 1;
  }
  return out;
}

function buildWeekdayPattern(paidInvoices) {
  const totals = Array(7).fill(0);
  const days = Array.from({ length: 7 }, () => new Set());
  for (const inv of paidInvoices) {
    const d = new Date(`${inv.date}T00:00:00Z`);
    const idx = (d.getUTCDay() + 6) % 7;
    totals[idx] += inv.amount;
    days[idx].add(inv.date);
  }
  const grand = totals.reduce((s, v) => s + v, 0);
  return WEEKDAYS.map((label, i) => ({
    label,
    revenue: round2(totals[i]),
    share: grand ? round2((totals[i] / grand) * 100) : 0,
    tradingDays: days[i].size,
    avgPerTradingDay: days[i].size ? round2(totals[i] / days[i].size) : 0,
  }));
}

function buildMonthlySeries(invoices, months, ledger, supply) {
  const monthSet = new Set(months);
  const expenses = ledgerExpenses(ledger, monthSet);
  return months.map((month) => {
    const inMonth = invoices.filter((i) => i.month === month);
    const paid = inMonth.filter((i) => i.isPaid);
    const demand = inMonth.filter((i) => i.countsAsDemand);
    const revenue = paid.reduce((s, i) => s + i.amount, 0);
    const bags = paid.reduce((s, i) => s + i.qty, 0);
    const byCust = {};
    paid.forEach((i) => {
      const k = i.customer.key;
      byCust[k] = byCust[k] || { name: i.customer.display, revenue: 0, placeholder: i.customer.isPlaceholder };
      byCust[k].revenue += i.amount;
    });
    const named = Object.values(byCust).filter((c) => !c.placeholder).sort((a, b) => b.revenue - a.revenue);
    const top = named[0] || null;
    return {
      month,
      label: monthShortLabel(month),
      revenue: round2(revenue),
      bags,
      billedBags: demand.reduce((s, i) => s + i.qty, 0),
      avgPrice: bags ? round2(revenue / bags) : null,
      tradingDays: new Set(paid.map((i) => i.date)).size,
      activeCustomers: named.length,
      topCustomer: top ? { name: top.name, revenue: round2(top.revenue), share: revenue ? round2((top.revenue / revenue) * 100) : 0 } : null,
      expenses: round2(expenses.byMonth[month] || 0),
      supply: supply.byMonth[month] || 0,
      hasActivity: inMonth.length > 0,
    };
  });
}

/* ── Core period computation ─────────────────────────────────────── */

function computePeriodCore(invoices, months) {
  const monthSet = new Set(months);
  const inPeriod = invoices.filter((i) => monthSet.has(i.month));
  const paid = inPeriod.filter((i) => i.isPaid);
  const demand = inPeriod.filter((i) => i.countsAsDemand);
  const revenue = paid.reduce((s, i) => s + i.amount, 0);
  const paidBags = paid.reduce((s, i) => s + i.qty, 0);
  const billed = demand.reduce((s, i) => s + i.amount, 0);
  const outstanding = demand.filter((i) => !i.isPaid).reduce((s, i) => s + i.amount, 0);
  const promoExpense = paid.reduce((s, i) => s + i.promo * i.rate, 0);
  const activeMonths = months.filter((m) => inPeriod.some((i) => i.month === m));
  return {
    inPeriod,
    paid,
    demand,
    revenue,
    paidBags,
    billed,
    outstanding,
    promoExpense,
    demandBags: demand.reduce((s, i) => s + i.qty, 0),
    activeMonths,
    avgPrice: paidBags ? revenue / paidBags : null,
    invoiceCount: inPeriod.length,
  };
}

function computeRevenueAndVariability(core, months, series) {
  const monthlyRevenue = {};
  months.forEach((m) => { monthlyRevenue[m] = 0; });
  series.forEach((s) => { if (Object.prototype.hasOwnProperty.call(monthlyRevenue, s.month)) monthlyRevenue[s.month] = s.revenue; });

  const statMonths = core.activeMonths.length ? core.activeMonths : months;
  const values = statMonths.map((m) => monthlyRevenue[m]);
  const avg = mean(values);
  const sd = sampleStdDev(values);
  const cv = avg > 0 && values.length >= 2 ? (sd / avg) * 100 : 0;

  const dailyMap = {};
  core.paid.forEach((i) => { dailyMap[i.date] = (dailyMap[i.date] || 0) + i.amount; });
  const dailyValues = Object.values(dailyMap);
  const dailyMean = mean(dailyValues);
  const dailySd = sampleStdDev(dailyValues);

  const weekly = buildWeekly(core.paid);
  const weeklyValues = weekly.map((w) => w.revenue);
  const weeklyMean = mean(weeklyValues);
  const weeklySd = sampleStdDev(weeklyValues);

  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const momChanges = [];
  for (let i = 1; i < statMonths.length; i += 1) {
    momChanges.push({ month: statMonths[i], change: pctChange(values[i], values[i - 1]) });
  }

  return {
    monthlyRevenue,
    totalRevenue: round2(core.revenue),
    promoExpense: round2(core.promoExpense),
    totalBagsOrdered: core.demandBags,
    mean: round2(avg),
    stdDev: round2(sd),
    coefficientOfVariation: round2(cv),
    variabilityBand: variabilityBand(avg, cv),
    statMonths,
    peakMonth: values.length ? statMonths[values.indexOf(max)] : null,
    troughMonth: values.length ? statMonths[values.indexOf(min)] : null,
    peakToTroughPct: min > 0 ? round2(((max - min) / min) * 100) : null,
    rangePctOfMean: avg > 0 ? round2(((max - min) / avg) * 100) : null,
    momChanges,
    daily: {
      tradingDays: dailyValues.length,
      mean: round2(dailyMean),
      stdDev: round2(dailySd),
      cv: dailyMean > 0 && dailyValues.length >= 2 ? round2((dailySd / dailyMean) * 100) : null,
      best: dailyValues.length ? round2(Math.max(...dailyValues)) : 0,
      worst: dailyValues.length ? round2(Math.min(...dailyValues)) : 0,
    },
    weekly,
    weeklyCv: weeklyMean > 0 && weeklyValues.length >= 2 ? round2((weeklySd / weeklyMean) * 100) : null,
    weekday: buildWeekdayPattern(core.paid),
  };
}

function computeProfitAndROI({ ledger, assets, batches, months, core, periodMonthsCount, allowBatchCost = true }) {
  const monthSet = new Set(months);
  const exp = ledgerExpenses(ledger, monthSet);

  const batchCost = (batches || [])
    .filter((b) => b && String(b.status).toLowerCase() === 'completed' && monthSet.has(String(b.date || '').slice(0, 7)))
    .reduce((s, b) => s + (Number(b.cost) || 0), 0);

  // If production spend is already in the ledger ("Production" account),
  // batch cost would be a double count, so only use it as a fallback.
  const usedBatchCost = allowBatchCost && exp.production === 0 ? batchCost : 0;
  const cogs = exp.production + usedBatchCost;
  const operatingExpenses = exp.total - exp.production;
  const revenue = core.revenue;
  const grossProfit = revenue - cogs;
  const operatingProfit = grossProfit - operatingExpenses;
  const netProfit = operatingProfit - core.promoExpense;

  const totalAssets = (assets || []).reduce((s, a) => s + (Number(a && a.value) || 0), 0);
  const roiPercent = totalAssets > 0 ? (netProfit / totalAssets) * 100 : null;
  const annualisationFactor = periodMonthsCount > 0 ? 12 / periodMonthsCount : 1;

  const variableCosts = exp.variable + usedBatchCost;
  const totalCosts = exp.total + usedBatchCost;
  const fixedCosts = Math.max(0, totalCosts - variableCosts);

  const accounts = Object.entries(exp.byAccount)
    .map(([account, amount]) => ({ account, amount: round2(amount), variable: classifyExpenseAccount(account).isVariable }))
    .filter((a) => a.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
  if (usedBatchCost > 0) accounts.push({ account: 'Production batches (costed)', amount: round2(usedBatchCost), variable: true });

  const netMargin = revenue ? (netProfit / revenue) * 100 : null;
  const assetTurnover = totalAssets > 0 ? revenue / totalAssets : null;

  return {
    cogs: round2(cogs),
    operatingExpenses: round2(operatingExpenses),
    grossProfit: round2(grossProfit),
    grossMargin: revenue ? round2((grossProfit / revenue) * 100) : null,
    operatingProfit: round2(operatingProfit),
    netProfit: round2(netProfit),
    netMargin: netMargin === null ? null : round2(netMargin),
    totalAssets: round2(totalAssets),
    roiPercent: roiPercent === null ? null : round2(roiPercent),
    roiAnnualisedPercent: roiPercent === null ? null : round2(roiPercent * annualisationFactor),
    assetTurnover: assetTurnover === null ? null : round2(assetTurnover),
    returnOnCostPercent: totalCosts > 0 ? round2((netProfit / totalCosts) * 100) : null,
    totalCosts: round2(totalCosts),
    variableCosts: round2(variableCosts),
    fixedCosts: round2(fixedCosts),
    accounts,
    usedBatchCostFallback: usedBatchCost > 0,
  };
}

function computeUnitEconomics(profit, core) {
  const bags = core.paidBags;
  const price = core.avgPrice;
  if (!bags || price === null) {
    return { bags, price: null, variableCostPerBag: null, contributionPerBag: null, contributionMarginPct: null, averageTotalCostPerBag: null, breakEvenBags: null, marginOfSafetyPct: null, operatingLeverage: null };
  }
  const vcpb = profit.variableCosts / bags;
  const contribution = price - vcpb;
  const atc = profit.totalCosts / bags;
  const breakEvenBags = contribution > 0 ? profit.fixedCosts / contribution : null;
  const mos = breakEvenBags !== null ? ((bags - breakEvenBags) / bags) * 100 : null;
  const contributionTotal = contribution * bags;
  const opProfit = contributionTotal - profit.fixedCosts;
  return {
    bags,
    price: round2(price),
    variableCostPerBag: round2(vcpb),
    contributionPerBag: round2(contribution),
    contributionMarginPct: price ? round2((contribution / price) * 100) : null,
    averageTotalCostPerBag: round2(atc),
    breakEvenBags: breakEvenBags === null ? null : Math.round(breakEvenBags),
    marginOfSafetyPct: mos === null ? null : round2(mos),
    operatingLeverage: opProfit > 0 ? round2(contributionTotal / opProfit) : null,
  };
}

function computeMarginalAnalysis(historySeries, unit) {
  const usable = historySeries.filter((s) => s.hasActivity && s.bags > 0);
  const window = usable.slice(-12);
  const xs = window.map((s) => s.bags);
  const revFit = olsFit(xs, window.map((s) => s.revenue));
  const costFit = olsFit(xs, window.map((s) => s.expenses));
  const reliable = !!(revFit && costFit && costFit.r2 >= 0.5 && window.length >= 4);

  let verdict;
  if (unit.contributionPerBag === null) {
    verdict = 'There were no paid sales in this period, so marginal economics cannot be measured.';
  } else if (unit.contributionPerBag <= 0) {
    verdict = `Each additional bag currently costs more to make and deliver (${ghs(unit.variableCostPerBag)} variable cost) than it earns (${ghs(unit.price)}). Marginal cost exceeds marginal revenue, so growing volume at today's prices would deepen losses. Review pricing or input costs before expanding.`;
  } else {
    verdict = `Marginal revenue (${ghs(unit.price)} per bag) exceeds marginal variable cost (${ghs(unit.variableCostPerBag)} per bag), leaving a contribution of ${ghs(unit.contributionPerBag)} on every extra bag sold. Because fixed costs do not rise with each bag, average total cost per bag (${ghs(unit.averageTotalCostPerBag)}) falls as volume grows. Expansion adds value until plant capacity or market demand becomes the binding constraint.`;
  }
  if (reliable && costFit.slope > revFit.slope) {
    verdict += ` Caution: the month-by-month cost curve is steeper than the revenue curve (empirical MC ${ghs(costFit.slope)} vs MR ${ghs(revFit.slope)}), a sign of diminishing returns at higher volumes.`;
  }

  return {
    months: window.map((s) => s.month),
    observations: window.length,
    empiricalMarginalRevenue: revFit ? round2(revFit.slope) : null,
    empiricalMarginalCost: costFit ? round2(costFit.slope) : null,
    revenueR2: revFit ? round2(revFit.r2) : null,
    costR2: costFit ? round2(costFit.r2) : null,
    empiricalReliable: reliable,
    points: window.map((s) => ({ month: s.label, bags: s.bags, revenue: s.revenue, cost: s.expenses })),
    verdict,
  };
}

/* ── BCG-adapted customer portfolio ──────────────────────────────── */

function computeCustomerPortfolio(currentCore, previousCore, currentOpMonths, previousOpMonths, topN = 8) {
  const sumBy = (paid) => {
    const map = new Map();
    for (const inv of paid) {
      const k = inv.customer.key;
      const entry = map.get(k) || { name: inv.customer.display, revenue: 0, bags: 0, placeholder: inv.customer.isPlaceholder };
      entry.revenue += inv.amount;
      entry.bags += inv.qty;
      map.set(k, entry);
    }
    return map;
  };
  const current = sumBy(currentCore.paid);
  const previous = sumBy(previousCore.paid);
  const totalCurrent = currentCore.revenue;
  const nCur = Math.max(1, currentOpMonths);
  const nPrev = Math.max(1, previousOpMonths);

  const named = [...current.entries()].filter(([, v]) => !v.placeholder).sort((a, b) => b[1].revenue - a[1].revenue);
  const walkIn = current.get(WALK_IN_KEY) || null;

  const businessGrowth = pctChange(totalCurrent / nCur, previousCore.revenue / nPrev);

  let rows = named.slice(0, topN).map(([key, v]) => {
    const prev = previous.get(key);
    const isNew = !prev || prev.revenue <= 0;
    const growth = isNew ? null : pctChange(v.revenue / nCur, prev.revenue / nPrev);
    return {
      customer: v.name,
      revenue: round2(v.revenue),
      bags: v.bags,
      share: totalCurrent ? round2((v.revenue / totalCurrent) * 100) : 0,
      growth: growth === null ? null : round2(growth),
      isNew,
    };
  });

  const shareThreshold = median(rows.map((r) => r.share));
  const growthThreshold = businessGrowth !== null ? businessGrowth : median(rows.filter((r) => r.growth !== null).map((r) => r.growth));

  rows = rows.map((r) => {
    const highShare = r.share >= shareThreshold;
    const highGrowth = r.isNew || (r.growth !== null && r.growth >= growthThreshold);
    let quadrant;
    if (highShare && highGrowth) quadrant = 'Star';
    else if (highShare && !highGrowth) quadrant = 'Cash Cow';
    else if (!highShare && highGrowth) quadrant = 'Question Mark';
    else quadrant = 'Dog';
    return { ...r, quadrant: r.isNew ? `${quadrant} (new)` : quadrant, quadrantBase: quadrant };
  });

  const lost = [...previous.entries()]
    .filter(([k, v]) => !v.placeholder && !current.has(k) && v.revenue > 0)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5)
    .map(([, v]) => ({ customer: v.name, priorRevenue: round2(v.revenue) }));

  const shares = named.map(([, v]) => (totalCurrent ? (v.revenue / totalCurrent) * 100 : 0));
  const walkShare = walkIn && totalCurrent ? (walkIn.revenue / totalCurrent) * 100 : 0;
  const hhi = [...shares, walkShare].reduce((s, x) => s + x * x, 0);
  const top1 = shares[0] || 0;
  const top3 = shares.slice(0, 3).reduce((s, x) => s + x, 0);
  let concentrationBand = 'Unconcentrated';
  if (hhi >= 2500) concentrationBand = 'Highly concentrated';
  else if (hhi >= 1500) concentrationBand = 'Moderately concentrated';

  return {
    rows,
    walkIn: walkIn ? { revenue: round2(walkIn.revenue), share: round2(walkShare), bags: walkIn.bags } : null,
    lostCustomers: lost,
    namedCustomerCount: named.length,
    businessGrowth: businessGrowth === null ? null : round2(businessGrowth),
    shareThreshold: round2(shareThreshold),
    growthThreshold: growthThreshold === null || growthThreshold === undefined ? null : round2(growthThreshold),
    top1Share: round2(top1),
    top3Share: round2(top3),
    hhi: Math.round(hhi),
    concentrationBand,
  };
}

/* ── Supply vs demand ────────────────────────────────────────────── */

function computeDemandSupply(supply, months, core) {
  const supplyBags = months.reduce((s, m) => s + (supply.byMonth[m] || 0), 0);
  const demandBags = core.demandBags;
  const recorded = supplyBags > 0;
  const sourceNames = [...new Set(months.map((m) => supply.winners[m]).filter(Boolean))];

  let condition;
  if (!recorded && demandBags === 0) {
    condition = 'No production or orders recorded this period.';
  } else if (!recorded) {
    condition = 'Production output was not recorded for this period, so supply cannot be compared with demand. Record finished products in Inventory (or batches in Production) to enable this test.';
  } else if (demandBags > supplyBags * 1.05) {
    condition = 'Demand exceeded period output: orders were met partly from opening stock, or there is stockout/backlog risk. Consider whether capacity needs to expand.';
  } else if (supplyBags > demandBags * 1.05) {
    condition = 'Output exceeded orders: finished-goods stock is building, tying up working capital. Watch for overproduction.';
  } else {
    condition = 'Output and orders were approximately balanced this period.';
  }

  return {
    supplyBags,
    demandBags,
    recorded,
    sourceNames,
    sellThroughRate: recorded ? round2((demandBags / supplyBags) * 100) : null,
    netStockMovement: recorded ? supplyBags - demandBags : null,
    condition,
    monthly: months.map((m) => ({ month: m, label: monthShortLabel(m), supply: supply.byMonth[m] || 0 })),
  };
}

/* ── Seasonality diagnosis ───────────────────────────────────────── */

function computeSeasonality(series, statMonths, revenueStats, isAnnual) {
  const inPeriod = series.filter((s) => statMonths.includes(s.month));
  const avgRev = mean(inPeriod.map((s) => s.revenue));
  const avgPrice = mean(inPeriod.filter((s) => s.avgPrice !== null).map((s) => s.avgPrice));
  const maxTradingDays = Math.max(0, ...inPeriod.map((s) => s.tradingDays));
  const avgActive = mean(inPeriod.map((x) => x.activeCustomers));
  const avgTopShare = mean(inPeriod.filter((x) => x.topCustomer).map((x) => x.topCustomer.share));

  const months = inPeriod.map((s) => {
    const season = seasonOf(s.month);
    const index = avgRev ? round2((s.revenue / avgRev) * 100) : null;
    let status = 'normal';
    if (index !== null && index < 85) status = 'low';
    else if (index !== null && index > 115) status = 'high';

    // Month-on-month move versus the calendar's expected direction, using the
    // same +/-5% neutral band and agree/counter wording as the dashboard's
    // Seasonal Outlook widget. Uses the previous month even if it falls
    // before the report period, as long as it had sales.
    const idx = series.findIndex((x) => x.month === s.month);
    const prev = idx > 0 ? series[idx - 1] : null;
    // If the two months had very different numbers of trading days (e.g. the
    // business started mid-month), compare revenue per trading day so a part
    // month is not mistaken for a collapse or a boom.
    let momPct = null;
    let momBasis = 'total';
    if (prev && prev.hasActivity && prev.revenue > 0) {
      const dayRatio = prev.tradingDays > 0 && s.tradingDays > 0 ? Math.max(prev.tradingDays, s.tradingDays) / Math.min(prev.tradingDays, s.tradingDays) : 1;
      if (dayRatio > 1.25) {
        momBasis = 'per trading day';
        momPct = round2(((s.revenue / s.tradingDays - prev.revenue / prev.tradingDays) / (prev.revenue / prev.tradingDays)) * 100);
      } else {
        momPct = round2(((s.revenue - prev.revenue) / prev.revenue) * 100);
      }
    }
    let agrees = null;
    if (momPct !== null && Math.abs(momPct) >= 5) agrees = (momPct >= 0) === (season.expected === 'up');

    const reasons = [];
    const seasonExplains = (status === 'low' && season.expected === 'down') || (status === 'high' && season.expected === 'up');
    if (seasonExplains) {
      reasons.push(`Seasonal: ${season.season.toLowerCase()}. ${season.why}${season.events ? ' ' + season.events : ''}`);
    } else if (status === 'low' && season.expected === 'up') {
      reasons.push(`Counter-seasonal: the calendar expects demand to be ${season.tendency} (${season.season.toLowerCase()}), so this dip is unlikely to be seasonal and points to something operational. ${season.events || ''}`.trim());
    } else if (status === 'high' && season.expected === 'down') {
      reasons.push(`Counter-seasonal: the calendar expects softer demand (${season.season.toLowerCase()}), so this strength probably came from specific orders rather than the season.`);
    }
    if (status === 'low') {
      if (maxTradingDays && s.tradingDays < maxTradingDays * 0.85) reasons.push(`Fewer trading days: sales were recorded on ${s.tradingDays} days versus ${maxTradingDays} in the busiest month.`);
      if (avgPrice && s.avgPrice !== null && s.avgPrice < avgPrice * 0.95) reasons.push(`Price effect: realised price of ${ghs(s.avgPrice)}/bag was below the period average of ${ghs(avgPrice)}.`);
      if (avgActive && s.activeCustomers < avgActive * 0.85) reasons.push(`Fewer active accounts: ${s.activeCustomers} named buyers versus an average of ${avgActive.toFixed(1)}.`);
      if (s.topCustomer && avgTopShare && s.topCustomer.share < 0.7 * avgTopShare) reasons.push('The largest account bought noticeably less than usual, which alone can move a concentrated business.');
      if (reasons.length < 2 && !seasonExplains) reasons.push('Check for a stock-out, equipment downtime or a lost order (see Demand vs Supply and the customer table).');
    } else if (status === 'high') {
      if (maxTradingDays && s.tradingDays >= maxTradingDays) reasons.push(`Most trading days in the period (${s.tradingDays}).`);
      if (s.topCustomer && s.topCustomer.share >= 30) reasons.push(`Bulk buying by ${s.topCustomer.name} (${s.topCustomer.share.toFixed(1)}% of the month's revenue) drove the peak.`);
      if (!reasons.length) reasons.push('Above-average month without an obvious calendar cause; likely a cluster of large orders.');
    }
    return {
      month: s.month, label: s.label, revenue: s.revenue, index, status,
      season: season.season, seasonKey: season.key, tendency: season.tendency, expected: season.expected,
      why: season.why, events: season.events, tradingDays: s.tradingDays, avgPrice: s.avgPrice,
      momPct, momBasis, agreesWithSeason: agrees, reasons,
    };
  });

  const downCount = months.filter((m) => m.expected === 'down').length;
  const upCount = months.filter((m) => m.expected === 'up').length;
  const mostlyDown = months.length > 0 && downCount >= Math.ceil(months.length / 2);
  const mostlyUp = months.length > 0 && upCount >= Math.ceil(months.length / 2);
  const checked = months.filter((m) => m.agreesWithSeason !== null);
  const agreeCount = checked.filter((m) => m.agreesWithSeason).length;
  const agreementText = checked.length
    ? ` Month-on-month, actual revenue moved in the direction the calendar expects in ${agreeCount} of ${checked.length} month(s) with a measurable move (changes under 5% are treated as neutral, as on the dashboard).`
    : '';

  const measurable = series.filter((s) => s.hasActivity).length;
  return {
    months,
    periodSeasonSummary: (mostlyDown
      ? 'The period fell mostly in a seasonally softening or lean part of the year for drinking water in Ghana (rains, cooler weather), so softer figures are partly structural rather than a sign of poor execution.'
      : mostlyUp
        ? 'The period fell mostly in a seasonally strong or rising part of the year (dry-season heat, festive demand), so headline figures may flatter underlying performance.'
        : 'The period straddled seasonal phases with no strong net seasonal tilt.') + agreementText,
    calendar: Object.keys(SEASON_CALENDAR).sort().map((mm) => ({ month: mm, name: MONTH_SHORT[Number(mm) - 1], ...SEASON_CALENDAR[mm] })),
    measuredMonthsOfHistory: measurable,
    empiricalIndexAvailable: measurable >= 24,
    caveat: measurable >= 24
      ? 'The seasonal calendar is general industry knowledge for Ghana, the same one shown on the dashboard Seasonal Outlook. Compare it with the measured monthly indices in the trend table.'
      : `Only ${measurable} month(s) of sales history exist, which is too short to measure a true seasonal index (24+ months are needed to separate season from trend). The seasonal explanations therefore use the same general industry calendar as the dashboard Seasonal Outlook: a reasoned expectation, not a measurement. Treat them as hypotheses that the next year's data will confirm or reject.`,
    isAnnual,
  };
}

/* ── NPV ─────────────────────────────────────────────────────────── */
// Indicative NPV of expected future operating profit (not a capital
// project NPV: there is no initial outlay netted off). Three growth
// scenarios and a discount-rate sensitivity are shown so the reader can
// see how much the answer depends on the assumptions.

function npvOf({ baseProfit, growth, annualRate, horizon, periodsPerYear }) {
  const periodicRate = ((1 + annualRate) ** (1 / periodsPerYear)) - 1;
  let npv = 0;
  const flows = [];
  for (let t = 1; t <= horizon; t += 1) {
    const cf = baseProfit * ((1 + growth) ** t);
    const disc = cf / ((1 + periodicRate) ** t);
    npv += disc;
    flows.push({ period: t, projectedCashFlow: round2(cf), discountedValue: round2(disc) });
  }
  return { npv: round2(npv), flows, periodicRate };
}

function computeForwardNPV({ currentNetProfit, previousNetProfit, annualDiscountRate, horizon, periodsPerYear, clamp }) {
  let trailing = 0;
  if (previousNetProfit && previousNetProfit !== 0) {
    trailing = (currentNetProfit - previousNetProfit) / Math.abs(previousNetProfit);
  }
  const trendGrowth = Math.max(clamp.min, Math.min(clamp.max, trailing));
  const downsideGrowth = periodsPerYear === 4 ? -0.15 : -0.20;

  const trend = npvOf({ baseProfit: currentNetProfit, growth: trendGrowth, annualRate: annualDiscountRate, horizon, periodsPerYear });
  const flat = npvOf({ baseProfit: currentNetProfit, growth: 0, annualRate: annualDiscountRate, horizon, periodsPerYear });
  const downside = npvOf({ baseProfit: currentNetProfit, growth: downsideGrowth, annualRate: annualDiscountRate, horizon, periodsPerYear });

  const sensitivity = [-0.05, 0, 0.05].map((delta) => {
    const rate = Math.max(0.01, annualDiscountRate + delta);
    return { rate: round2(rate * 100), npvFlat: npvOf({ baseProfit: currentNetProfit, growth: 0, annualRate: rate, horizon, periodsPerYear }).npv };
  });

  return {
    npv: trend.npv,
    quarterlyDiscountRate: round2(trend.periodicRate * 100),
    periodicDiscountRate: round2(trend.periodicRate * 100),
    assumedGrowthRatePerQuarter: round2(trendGrowth * 100),
    assumedGrowthRatePerYear: round2(trendGrowth * 100),
    assumedGrowthPerPeriod: round2(trendGrowth * 100),
    horizon,
    horizonQuarters: horizon,
    horizonYears: horizon,
    periodsPerYear,
    trailingGrowthRaw: round2(trailing * 100),
    projectedCashFlows: trend.flows.map((f) => ({ quarter: f.period, year: f.period, ...f })),
    scenarios: [
      { name: 'Downside', growthPerPeriod: round2(downsideGrowth * 100), npv: downside.npv },
      { name: 'Flat (no growth)', growthPerPeriod: 0, npv: flat.npv },
      { name: 'Trend', growthPerPeriod: round2(trendGrowth * 100), npv: trend.npv },
    ],
    sensitivity,
    annualDiscountRateUsed: round2(annualDiscountRate * 100),
  };
}

/* ── Outlook (forward range for the next period) ─────────────────── */

function computeOutlook({ historySeries, periodType, year, quarter, statSd }) {
  const active = historySeries.filter((s) => s.hasActivity);
  const k = periodType === 'quarter' ? 3 : 12;
  const lastMonth = historySeries.length ? historySeries[historySeries.length - 1].month : null;
  if (!lastMonth || active.length < 2) return null;

  const nextMonths = Array.from({ length: k }, (_, i) => addMonths(lastMonth, i + 1));
  const recent = active.slice(-3);
  const monthlyRun = mean(recent.map((s) => s.revenue));
  const runRate = monthlyRun * k;

  const window = active.slice(-12);
  const fit = window.length >= 4 ? olsFit(window.map((_, i) => i), window.map((s) => s.revenue)) : null;
  let trend = null;
  if (fit) {
    let total = 0;
    for (let i = 0; i < k; i += 1) total += Math.max(0, fit.intercept + fit.slope * (window.length + i));
    trend = total;
  }

  const recentTendency = mean(recent.map((s) => TENDENCY_MULTIPLIER[seasonOf(s.month).tendency] || 0));
  const nextTendency = mean(nextMonths.map((m) => TENDENCY_MULTIPLIER[seasonOf(m).tendency] || 0));
  const factor = (1 + nextTendency) / (1 + recentTendency);
  const seasonAdjusted = runRate * factor;

  const sd = statSd || sampleStdDev(recent.map((s) => s.revenue));
  const band = sd * Math.sqrt(k);

  const label = periodType === 'quarter'
    ? (quarter === 4 ? quarterLabel(year + 1, 1) : quarterLabel(year, quarter + 1))
    : yearLabel(year + 1);

  return {
    label,
    months: nextMonths,
    runRate: round2(runRate),
    trend: trend === null ? null : round2(trend),
    trendR2: fit ? round2(fit.r2) : null,
    seasonalFactor: round2(factor),
    seasonAdjusted: round2(seasonAdjusted),
    low: round2(Math.max(0, seasonAdjusted - band)),
    high: round2(seasonAdjusted + band),
    seasonalDetail: nextMonths.map((m) => ({ month: m, label: monthShortLabel(m), season: seasonOf(m).season, tendency: seasonOf(m).tendency })),
    basisMonths: recent.map((s) => s.label),
    assumptions: [
      `"Recent pace" means the average of the last ${recent.length} months with sales (${recent.map((s) => s.label).join(', ')}), carried forward for ${k} months.`,
      'The weather/season adjustment adds about 8% for the busiest months, 4% for months where demand is rising, and takes off 4% or 8% for months where demand is softening or lowest. It uses the same season calendar as the dashboard. It is a judgement, not a measured figure.',
      `The "likely range" is based on how much monthly sales have moved up and down in the past. About two times out of three, the real result should land inside it.`,
      'The estimate does not include price changes, new big customers, competitors, or machine breakdowns.',
    ],
  };
}

/* ── Side-by-side comparison (month by month) ───────────────────────
   Used for the yearly report (this year vs last year) and for the
   quarterly report (vs the previous quarter, and vs the same quarter
   last year). Months are matched by position, so Jan 2027 sits next to
   Jan 2026, Q3 2026 month 1 next to Q2 2026 month 1, and so on.
   Where the earlier period has fewer months of sales (for example the
   business only started trading part-way through), a "like-for-like"
   total is also worked out from only the months that have sales on
   both sides, so the comparison stays fair.                          */

const monthName3 = (m) => MONTH_SHORT[Number(String(m).slice(5, 7)) - 1] || String(m);

function moreOrLess(cur, prior) {
  const d = (Number(cur) || 0) - (Number(prior) || 0);
  if (Math.abs(d) < 0.005) return 'the same';
  const p = pctChange(cur, prior);
  return `${ghs(Math.abs(d))} ${d > 0 ? 'more' : 'less'}${p === null ? '' : ` (${Math.abs(p).toFixed(1)}% ${d > 0 ? 'up' : 'down'})`}`;
}

function buildComparison({ kind, title, curLabel, priorLabel, curMonths, priorMonths, curSeries, priorSeries, curCore, priorCore, curProfit, priorProfit, isAnnual }) {
  const hasPrior = priorCore.revenue > 0;
  const months = curMonths.map((m, i) => {
    const cur = curSeries.find((s) => s.month === m) || { revenue: 0, bags: 0 };
    const pm = priorMonths[i];
    const prior = priorSeries.find((s) => s.month === pm) || { revenue: 0, bags: 0 };
    const curHas = cur.revenue > 0;
    const priorHas = prior.revenue > 0;
    const changePct = curHas && priorHas ? pctChange(cur.revenue, prior.revenue) : null;
    let status = 'none';
    if (curHas && priorHas) status = changePct >= 5 ? 'up' : changePct <= -5 ? 'down' : 'flat';
    else if (curHas) status = 'new';
    else if (priorHas) status = 'missing';
    return {
      month: m,
      priorMonth: pm,
      label: monthName3(m),
      curRevenue: round2(cur.revenue),
      priorRevenue: round2(prior.revenue),
      curBags: cur.bags || 0,
      priorBags: prior.bags || 0,
      change: round2(cur.revenue - prior.revenue),
      changePct: changePct === null ? null : round2(changePct),
      status,
    };
  });

  const both = months.filter((x) => ['up', 'down', 'flat'].includes(x.status));
  const likeCur = both.reduce((s, x) => s + x.curRevenue, 0);
  const likePrior = both.reduce((s, x) => s + x.priorRevenue, 0);
  const likePct = pctChange(likeCur, likePrior);
  const counts = { up: 0, down: 0, flat: 0 };
  both.forEach((x) => { counts[x.status] += 1; });

  const curActive = months.filter((x) => x.curRevenue > 0);
  const priorActive = months.filter((x) => x.priorRevenue > 0);
  const pick = (list, key, dir) => (list.length ? list.reduce((a, b) => (dir === 'max' ? (b[key] > a[key] ? b : a) : (b[key] < a[key] ? b : a))) : null);
  const bestCur = pick(curActive, 'curRevenue', 'max');
  const worstCur = pick(curActive, 'curRevenue', 'min');
  const bestPrior = pick(priorActive, 'priorRevenue', 'max');
  const worstPrior = pick(priorActive, 'priorRevenue', 'min');
  const gain = pick(both.filter((x) => x.change > 0), 'change', 'max');
  const drop = pick(both.filter((x) => x.change < 0), 'change', 'min');

  const pctOf = (c, p) => { const g = pctChange(c, p); return g === null ? null : round2(g); };
  const totals = {
    revenue: { cur: round2(curCore.revenue), prior: round2(priorCore.revenue), change: round2(curCore.revenue - priorCore.revenue), pct: pctOf(curCore.revenue, priorCore.revenue) },
    bags: { cur: curCore.paidBags, prior: priorCore.paidBags, change: curCore.paidBags - priorCore.paidBags, pct: pctOf(curCore.paidBags, priorCore.paidBags) },
    avgPrice: { cur: curCore.avgPrice === null ? null : round2(curCore.avgPrice), prior: priorCore.avgPrice === null ? null : round2(priorCore.avgPrice), pct: (curCore.avgPrice && priorCore.avgPrice) ? pctOf(curCore.avgPrice, priorCore.avgPrice) : null },
    costs: { cur: curProfit.totalCosts, prior: priorProfit.totalCosts, change: round2(curProfit.totalCosts - priorProfit.totalCosts), pct: pctOf(curProfit.totalCosts, priorProfit.totalCosts) },
    netProfit: { cur: curProfit.netProfit, prior: priorProfit.netProfit, change: round2(curProfit.netProfit - priorProfit.netProfit) },
    activeMonths: { cur: curCore.activeMonths.length, prior: priorCore.activeMonths.length },
  };

  const quarters = isAnnual ? [0, 1, 2, 3].map((q) => {
    const slice = months.slice(q * 3, q * 3 + 3);
    const cur = slice.reduce((s, x) => s + x.curRevenue, 0);
    const prior = slice.reduce((s, x) => s + x.priorRevenue, 0);
    const curN = slice.filter((x) => x.curRevenue > 0).length;
    const priorN = slice.filter((x) => x.priorRevenue > 0).length;
    // Only show a % when both sides have the same number of selling months,
    // otherwise a part-quarter would look like a huge (false) jump.
    const fair = cur > 0 && prior > 0 && curN === priorN;
    return { label: `Q${q + 1}`, cur: round2(cur), prior: round2(prior), pct: fair ? pctOf(cur, prior) : null, curMonths: curN, priorMonths: priorN, partial: curN !== priorN && (cur > 0 || prior > 0) };
  }) : [];

  const story = [];
  if (!hasPrior) {
    story.push(`There are no paid sales recorded for ${priorLabel}, so there is nothing to compare ${curLabel} with yet. This page fills in by itself once ${priorLabel} figures exist.`);
  } else {
    story.push(`Sales were ${ghs(curCore.revenue)} in ${curLabel}, against ${ghs(priorCore.revenue)} in ${priorLabel}. That is ${moreOrLess(curCore.revenue, priorCore.revenue)}.`);
    if (priorCore.activeMonths.length < curCore.activeMonths.length && both.length) {
      story.push(`${priorLabel} only had sales in ${priorCore.activeMonths.length} month(s), while ${curLabel} had ${curCore.activeMonths.length}, so the two totals are not a fair match. Looking only at the ${both.length} month(s) that have sales in both, ${curLabel} made ${ghs(likeCur)} against ${ghs(likePrior)}: ${moreOrLess(likeCur, likePrior)}.`);
    } else if (priorCore.activeMonths.length > curCore.activeMonths.length && both.length) {
      story.push(`${curLabel} only has sales in ${curCore.activeMonths.length} month(s), while ${priorLabel} had ${priorCore.activeMonths.length}, so the totals are not a fair match. Looking only at the ${both.length} month(s) with sales on both sides, ${curLabel} made ${ghs(likeCur)} against ${ghs(likePrior)}: ${moreOrLess(likeCur, likePrior)}.`);
    }
    if (both.length) {
      story.push(`Of the ${both.length} month(s) we can compare, sales went up in ${counts.up}, went down in ${counts.down} and stayed about the same (within 5%) in ${counts.flat}.`);
    }
    if (gain) story.push(`The biggest step up was ${gain.label}: ${ghs(gain.curRevenue)} against ${ghs(gain.priorRevenue)}, which is ${moreOrLess(gain.curRevenue, gain.priorRevenue)}.`);
    if (drop) story.push(`The biggest step down was ${drop.label}: ${ghs(drop.curRevenue)} against ${ghs(drop.priorRevenue)}, which is ${moreOrLess(drop.curRevenue, drop.priorRevenue)}.`);
    if (bestCur && bestPrior) {
      story.push(`Best month in ${curLabel}: ${bestCur.label} (${ghs(bestCur.curRevenue)}). Best month in ${priorLabel}: ${bestPrior.label} (${ghs(bestPrior.priorRevenue)}).`);
    }
    if (totals.avgPrice.cur !== null && totals.avgPrice.prior !== null) {
      story.push(`The average price per bag was ${ghs(totals.avgPrice.cur)} against ${ghs(totals.avgPrice.prior)} before.`);
    }
    story.push(`Profit after costs was ${ghs(curProfit.netProfit)} in ${curLabel} against ${ghs(priorProfit.netProfit)} in ${priorLabel}.`);
  }

  return {
    kind, title, curLabel, priorLabel, hasPrior,
    months, totals, quarters, story,
    likeForLike: { months: both.length, cur: round2(likeCur), prior: round2(likePrior), change: round2(likeCur - likePrior), pct: likePct === null ? null : round2(likePct) },
    counts,
    best: { cur: bestCur ? { label: bestCur.label, revenue: bestCur.curRevenue } : null, prior: bestPrior ? { label: bestPrior.label, revenue: bestPrior.priorRevenue } : null },
    worst: { cur: worstCur ? { label: worstCur.label, revenue: worstCur.curRevenue } : null, prior: worstPrior ? { label: worstPrior.label, revenue: worstPrior.priorRevenue } : null },
    biggestGain: gain ? { label: gain.label, change: gain.change } : null,
    biggestDrop: drop ? { label: drop.label, change: drop.change } : null,
  };
}

/* ── Plain-language layer ───────────────────────────────────────────
   Everything a non-specialist needs: a health check with yes/no style
   answers, one-paragraph explanations for each section, and a short
   list of questions worth asking at the next meeting.               */

function buildPlain(a) {
  const isQ = a.periodType === 'quarter';
  const p = isQ ? 'quarter' : 'year';
  const rev = a.revenue;
  const pr = a.profitRoi;
  const ue = a.unitEconomics;
  const col = a.collections;
  const pf = a.portfolio;
  const cmp = a.comparison;
  const sets = a.compareSets || [];
  const yearSet = sets.find((s) => s.kind === 'year-ago' || s.kind === 'year') || null;

  // Best available growth figure and what it is measured against.
  let growth = null;
  let growthAgainst = null;
  if (yearSet && yearSet.hasPrior) {
    growth = yearSet.likeForLike.months ? yearSet.likeForLike.pct : yearSet.totals.revenue.pct;
    growthAgainst = yearSet.priorLabel;
  }
  if (growth === null && cmp && cmp.revenueGrowthPerMonthPct !== null) {
    growth = cmp.revenueGrowthPerMonthPct;
    growthAgainst = a.previousLabel;
  }

  const items = [];
  const add = (question, tone, answer, detail) => items.push({ question, tone, answer, detail });

  // 1. Profit
  if (pr.netProfit >= 0) {
    const kept = pr.netMargin === null ? null : pr.netMargin;
    add('Did the business make money?', kept !== null && kept < 5 ? 'warn' : 'good', kept !== null && kept < 5 ? 'Only just' : 'Yes',
      `Profit after all costs was ${ghs(pr.netProfit)}${kept === null ? '' : `, which means about GH₵${kept.toFixed(0)} kept from every GH₵100 sold`}.`);
  } else {
    add('Did the business make money?', 'bad', 'No', `We spent ${ghs(Math.abs(pr.netProfit))} more than we earned this ${p}.`);
  }

  // 2. Growth
  if (growth === null) {
    add('Are sales going up?', 'neutral', 'Too early to say', 'There is no earlier period with sales to compare against yet.');
  } else if (growth >= 5) {
    add('Are sales going up?', 'good', 'Yes', `Sales are about ${growth.toFixed(0)}% higher than ${growthAgainst}.`);
  } else if (growth > -5) {
    add('Are sales going up?', 'warn', 'About the same', `Sales are close to ${growthAgainst} (${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%).`);
  } else {
    add('Are sales going up?', 'bad', 'No, they fell', `Sales are about ${Math.abs(growth).toFixed(0)}% lower than ${growthAgainst}.`);
  }

  // 3. Collections
  if (col.efficiencyPct === null) {
    add('Are customers paying us?', 'neutral', 'No invoices yet', 'There were no invoices to collect on.');
  } else if (col.efficiencyPct >= 90) {
    add('Are customers paying us?', 'good', 'Yes', `${col.efficiencyPct.toFixed(0)}% of what we billed has been paid.`);
  } else if (col.efficiencyPct >= 75) {
    add('Are customers paying us?', 'warn', 'Mostly', `${col.efficiencyPct.toFixed(0)}% has been paid. ${ghs(col.outstanding)} is still owed to us.`);
  } else {
    add('Are customers paying us?', 'bad', 'Not enough', `Only ${col.efficiencyPct.toFixed(0)}% has been paid. ${ghs(col.outstanding)} is still owed to us.`);
  }

  // 4. Steadiness
  if (rev.coefficientOfVariation) {
    const cv = rev.coefficientOfVariation;
    if (cv < 15) add('Are sales steady from month to month?', 'good', 'Yes', 'Monthly sales stay close to the usual level.');
    else if (cv < 30) add('Are sales steady from month to month?', 'warn', 'Some ups and downs', 'Sales move up and down a fair bit between months.');
    else add('Are sales steady from month to month?', 'bad', 'No, they swing a lot', 'Sales change a lot between months, so it is hard to plan cash.');
  }

  // 5. Dependence on a few buyers
  if (pf && pf.rows && pf.rows.length) {
    if (pf.top1Share < 25) add('Do we depend too much on one buyer?', 'good', 'No', `Our biggest buyer is ${pf.top1Share.toFixed(0)}% of sales.`);
    else if (pf.top1Share < 40) add('Do we depend too much on one buyer?', 'warn', 'A little', `Our biggest buyer is ${pf.top1Share.toFixed(0)}% of sales. If they left, we would feel it.`);
    else add('Do we depend too much on one buyer?', 'bad', 'Yes', `Our biggest buyer is ${pf.top1Share.toFixed(0)}% of sales. Losing them would hurt badly.`);
  }

  // 6. Earn on each bag
  if (ue.contributionPerBag !== null) {
    if (ue.contributionPerBag > 0) add('Do we earn something on every bag?', 'good', 'Yes', `A bag sells for ${ghs(ue.price)} and costs about ${ghs(ue.variableCostPerBag)} to make and deliver, leaving ${ghs(ue.contributionPerBag)}.`);
    else add('Do we earn something on every bag?', 'bad', 'No', `A bag sells for ${ghs(ue.price)} but costs about ${ghs(ue.variableCostPerBag)} to make and deliver.`);
  }

  // 7. Cushion
  if (ue.marginOfSafetyPct !== null) {
    if (ue.marginOfSafetyPct >= 30) add('How big is our safety cushion?', 'good', 'Comfortable', `Sales could fall about ${ue.marginOfSafetyPct.toFixed(0)}% before we stop making a profit.`);
    else if (ue.marginOfSafetyPct >= 15) add('How big is our safety cushion?', 'warn', 'Fairly thin', `Sales could fall about ${ue.marginOfSafetyPct.toFixed(0)}% before we stop making a profit.`);
    else add('How big is our safety cushion?', 'bad', 'Very thin', `Sales could fall only about ${Math.max(0, ue.marginOfSafetyPct).toFixed(0)}% before we stop making a profit.`);
  }

  // 8. Production records
  add('Do we know how many bags we made?', a.demandSupply.recorded ? 'good' : 'warn', a.demandSupply.recorded ? 'Yes' : 'Not recorded', a.demandSupply.recorded ? 'Production records exist for this period.' : 'Production was not written down, so we cannot compare what we made with what we sold.');

  const bads = items.filter((i) => i.tone === 'bad').length;
  const warns = items.filter((i) => i.tone === 'warn').length;
  let verdict;
  if (pr.netProfit < 0 || bads >= 2) verdict = { tone: 'bad', label: 'Needs attention' };
  else if (bads === 0 && warns <= 2) verdict = { tone: 'good', label: 'Healthy' };
  else verdict = { tone: 'warn', label: 'Mixed' };
  const sentence = {
    good: `Overall the ${p} looks healthy: the business made money and most of the checks below are in good shape.`,
    warn: `Overall the ${p} was mixed: there are good signs, but a few things below need watching.`,
    bad: `Overall the ${p} needs attention: at least one important check below is in poor shape.`,
  }[verdict.tone];

  const questions = [];
  items.filter((i) => i.tone === 'bad' || i.tone === 'warn').forEach((i) => {
    const map = {
      'Did the business make money?': 'Which costs grew the most, and can any of them be cut or shared?',
      'Are sales going up?': 'What changed with our biggest buyers, and what would win back or grow sales?',
      'Are customers paying us?': 'Which customers owe us, how old are those invoices, and who will follow them up this week?',
      'Are sales steady from month to month?': 'Can we agree regular orders with a few buyers so slow months hurt less?',
      'Do we depend too much on one buyer?': 'Who are two or three new buyers we can win this coming period?',
      'Do we earn something on every bag?': 'Is it time to raise the price or lower the cost of film, fuel and delivery?',
      'How big is our safety cushion?': 'How much cash should we keep aside for a slow month?',
      'Do we know how many bags we made?': 'Who will write down daily production from now on?',
    };
    if (map[i.question]) questions.push(map[i.question]);
  });

  const sections = {};
  const best = a.periodSeries.filter((s) => s.revenue > 0).sort((x, y) => y.revenue - x.revenue);
  sections.sales = `Sales from paid invoices came to ${ghs(rev.totalRevenue)}${best.length > 1 ? `. The best month was ${best[0].label} (${ghs(best[0].revenue)}) and the weakest was ${best[best.length - 1].label} (${ghs(best[best.length - 1].revenue)})` : ''}. ${rev.coefficientOfVariation >= 30 ? 'Sales swing a lot from month to month.' : rev.coefficientOfVariation >= 15 ? 'Sales move up and down a fair bit, which is normal for this business.' : 'Sales are fairly steady.'}`;
  sections.seasons = 'Some months are naturally busier than others, mostly because of the weather: hot, dry months sell more water and rainy months sell less. Before judging a month as good or bad, check whether the season explains it. Only a change that the season cannot explain is a real change in how the business is doing.';
  sections.profit = pr.netProfit >= 0
    ? `After paying for production, running costs and free promotional bags, ${ghs(pr.netProfit)} was left as profit${pr.netMargin === null ? '' : ` (about GH₵${pr.netMargin.toFixed(0)} in every GH₵100 sold)`}.`
    : `After paying for production, running costs and free promotional bags, the business was ${ghs(Math.abs(pr.netProfit))} short.`;
  sections.perBag = ue.contributionPerBag === null
    ? 'There were no paid sales, so the cost of one extra bag cannot be worked out.'
    : `Each bag sells for ${ghs(ue.price)} and costs about ${ghs(ue.variableCostPerBag)} in materials, fuel and delivery. That leaves ${ghs(ue.contributionPerBag)} on every bag to pay for salaries, rent and profit. ${ue.contributionPerBag > 0 ? 'So selling more bags helps, as long as we can make and deliver them.' : 'Selling more bags at this price makes things worse, not better.'}`;
  sections.customers = 'We grouped customers by two questions: how much of our sales do they make up, and are they buying more or less than before? Stars are big and growing, so look after them. Cash cows are big but not growing, so protect them. Question marks are small but growing, so help them grow. Dogs are small and not growing, so serve them cheaply.';
  sections.supply = a.demandSupply.recorded ? 'This compares the bags we made with the bags customers ordered. If we make more than we sell, stock builds up; if we sell more than we make, we may be running out or missing orders.' : 'Production was not written down for this period, so we cannot compare what we made with what customers ordered. Recording daily production fixes this.';
  sections.future = `This estimates what the next ${a.npv.horizon} ${isQ ? 'quarters' : 'years'} of profit are worth in today's money. Money received later is worth a little less than money in hand today, so future profit is reduced by a discount rate. It is a rough guide, not the price the business could be sold for.`;

  return { verdict: { ...verdict, sentence }, scorecard: items, sections, questions: questions.slice(0, 5), growth, growthAgainst };
}

/* ── Narrative (rule-based, deterministic, uses only computed values) ── */

function buildNarrative(a) {
  const isQ = a.periodType === 'quarter';
  const p = isQ ? 'quarter' : 'year';
  const findings = [];
  const risks = [];
  const actions = [];

  const rev = a.revenue;
  const pr = a.profitRoi;
  const ue = a.unitEconomics;
  const cmp = a.comparison;

  let headline = `${a.label}: customers paid us ${ghs(rev.totalRevenue)} and after all costs ${pr.netProfit >= 0 ? `we were left with a profit of ${ghs(pr.netProfit)}` : `we made a loss of ${ghs(Math.abs(pr.netProfit))}`}`;
  if (pr.netMargin !== null && pr.netProfit >= 0) headline += ` (about GH₵${pr.netMargin.toFixed(0)} kept from every GH₵100 sold)`;
  headline += '.';
  if (cmp && cmp.revenueGrowthPerMonthPct !== null) {
    headline += ` On average each month, sales ${cmp.revenueGrowthPerMonthPct >= 0 ? 'rose' : 'fell'} ${Math.abs(cmp.revenueGrowthPerMonthPct).toFixed(1)}% compared with ${a.previousLabel}${cmp.previousPartial ? ' (that period was shorter, so we compare month by month)' : ''}.`;
  }

  if (rev.coefficientOfVariation) {
    findings.push(`Steadiness: monthly sales swung by about ${fmtPctText(rev.coefficientOfVariation, 0)} around the monthly average, which we rate "${rev.variabilityBand}". The best month beat the weakest by ${fmtPctText(rev.rangePctOfMean, 0)} of an average month.${rev.daily.cv !== null ? ` Day to day the swing is bigger (${fmtPctText(rev.daily.cv, 0)} over ${rev.daily.tradingDays} trading days) because sales come in as large orders.` : ''}`);
  }
  if (cmp && cmp.priceEffect !== null) {
    const dominant = Math.abs(cmp.volumeEffect) >= Math.abs(cmp.priceEffect) ? 'the number of bags sold' : 'the price per bag';
    findings.push(`Price or bags? Compared with ${a.previousLabel}, selling ${cmp.volumeEffect >= 0 ? 'more' : 'fewer'} bags moved sales by ${ghs(cmp.volumeEffect)}, and the change in price moved them by ${ghs(cmp.priceEffect)}. The change came mainly from ${dominant}.`);
  }
  if (ue.price !== null) {
    findings.push(`Each bag: it sold for ${ghs(ue.price)} and cost about ${ghs(ue.variableCostPerBag)} in materials, fuel and delivery, leaving ${ghs(ue.contributionPerBag)} a bag towards salaries, rent and profit.${ue.breakEvenBags !== null ? ` We need to sell about ${ue.breakEvenBags.toLocaleString()} bags a ${p} to cover all our costs. We sold ${ue.bags.toLocaleString()}, which is ${fmtPctText(ue.marginOfSafetyPct, 0)} above that.` : ''}`);
  }
  if (pr.roiPercent !== null) {
    findings.push(`Return on what we own: for every GH₵100 of company assets, we earned about GH₵${pr.roiPercent.toFixed(1)} of profit this ${p}${isQ ? ` (roughly GH₵${pr.roiAnnualisedPercent.toFixed(0)} over a full year at this pace)` : ''}.`);
  }
  if (a.collections.billed > 0) {
    findings.push(`Getting paid: ${fmtPctText(a.collections.efficiencyPct, 0)} of what we billed has been paid. ${ghs(a.collections.outstanding)} is still owed to us.`);
  }

  if (a.portfolio.top1Share >= 25) risks.push(`Too much on one buyer: our biggest customer is ${fmtPctText(a.portfolio.top1Share, 0)} of sales and our top three make up ${fmtPctText(a.portfolio.top3Share, 0)}. If one of them stopped buying, sales would drop sharply.`);
  if (a.collections.efficiencyPct !== null && a.collections.efficiencyPct < 85) risks.push(`Money owed to us: only ${fmtPctText(a.collections.efficiencyPct, 0)} of billing was paid, so ${ghs(a.collections.outstanding)} of our cash is sitting with customers.`);
  if (rev.coefficientOfVariation >= 30) risks.push('Sales swing a lot between months. One weak month can wipe out a lot of profit, so keep some cash aside, at least enough for one month of fixed costs.');
  if (ue.marginOfSafetyPct !== null && ue.marginOfSafetyPct < 20) risks.push(`Thin safety cushion: sales could fall only about ${fmtPctText(Math.max(0, ue.marginOfSafetyPct), 0)} before we stop making a profit.`);
  if (!a.demandSupply.recorded) risks.push('Production was not written down, so we cannot compare what we made with what we sold, or work out the true cost of a bag.');
  if (a.portfolio.lostCustomers.length) risks.push(`Buyers who went quiet: ${a.portfolio.lostCustomers.map((c) => c.customer).slice(0, 3).join(', ')} bought in ${a.previousLabel} but not in ${a.label}.`);

  if (a.portfolio.top1Share >= 25) actions.push('Spread the risk: aim for no single buyer being more than 20% of sales, and look for two or three mid-sized wholesale customers.');
  if (a.collections.efficiencyPct !== null && a.collections.efficiencyPct < 90) actions.push('Get paid faster: agree payment terms in writing, chase invoices older than 14 days, and ask repeat credit buyers for a deposit.');
  if (ue.contributionPerBag !== null && ue.contributionPerBag > 0) actions.push(`Protect the margin on each bag: price is the easiest lever (every GH₵0.10 added per bag brings in about ${ghs(0.1 * ue.bags)} at the current volume). Also try to negotiate the cost of film and fuel, the biggest running costs.`);
  actions.push(`Write down daily production against invoices, so we can track stock, and the true cost of a bag, from ${a.label} onwards.`);
  if (a.seasonality.months.some((m) => m.expected === 'down')) actions.push('Plan for the slow months: do machine servicing and build stock when demand is low, and go after schools, offices and event buyers when weather-driven sales dip.');

  const seasonalText = `${a.seasonality.periodSeasonSummary} ${a.seasonality.caveat}`;

  const cnt = (q) => a.portfolio.rows.filter((r) => r.quadrantBase === q).length;
  const bcgText = a.portfolio.rows.length
    ? `We sorted customers into four groups: ${cnt('Star')} star(s) (big and growing), ${cnt('Cash Cow')} cash cow(s) (big but steady), ${cnt('Question Mark')} question mark(s) (small but growing) and ${cnt('Dog')} dog(s) (small and not growing). "Big" means a large share of our sales. "Growing" means the customer spends more per month than in ${a.previousLabel}${a.portfolio.businessGrowth !== null ? `, compared with ${fmtPctText(a.portfolio.businessGrowth, 0)} growth for the whole business` : ''}. New buyers count as growing.`
    : 'No named customer sales were available to sort into groups.';

  const npvText = `If profit carries on as recently, the next ${a.npv.horizon} ${isQ ? 'quarters' : 'years'} of profit are worth about ${ghs(a.npv.npv)} in today's money. If profit stays flat it is about ${ghs(a.npv.scenarios[1].npv)}, and if profit falls it is about ${ghs(a.npv.scenarios[0].npv)}. We reduce future profit by ${fmtPctText(a.discountRateInfo.rate * 100, 0)} a year (${a.discountRateInfo.benchmark}) because money received later is worth less than money in hand today. A positive number means the business is expected to earn more than a safe investment would. It is not the price the business could be sold for.`;

  let outlookText = 'There is not enough history yet to guess the next period.';
  if (a.outlook) {
    outlookText = `For ${a.outlook.label}, our best estimate of paid sales is ${ghs(a.outlook.seasonAdjusted)}, and it would probably land between ${ghs(a.outlook.low)} and ${ghs(a.outlook.high)}. For comparison, simply carrying on at the recent pace gives ${ghs(a.outlook.runRate)}${a.outlook.trend !== null ? `, and following the recent trend line gives ${ghs(a.outlook.trend)}` : ''}. These are estimates from a short history, not promises.`;
  }

  return { headline, findings, risks, actions, seasonalText, bcgText, npvText, outlookText };
}

/* ── Data quality flags ──────────────────────────────────────────── */

function buildDataQuality(a, invoices, periodMonths, historySeries) {
  const flags = [];
  const monthSet = new Set(periodMonths);
  const pending = invoices.filter((i) => monthSet.has(i.month) && i.status === 'pending_approval');
  if (pending.length) flags.push(`${pending.length} invoice(s) are awaiting approval and are excluded from revenue and demand.`);
  if (!a.demandSupply.recorded) flags.push('Production output is not recorded for this period (no daily log, finished-product or completed-batch entries), so supply-side figures are shown as "not recorded" rather than zero.');
  if (a.profitRoi.totalAssets === 0) flags.push('No company assets are recorded in Accounting, so ROI on assets cannot be computed.');
  if (a.comparison && a.comparison.previousPartial) flags.push(`${a.previousLabel} contains fewer active months than ${a.label}, so growth is measured per active month rather than on totals.`);
  const active = historySeries.filter((s) => s.hasActivity).length;
  if (active < 12) flags.push(`Only ${active} month(s) of sales history exist; trend, seasonality and forecast statistics are indicative only.`);
  const walk = a.portfolio.walkIn;
  if (walk && walk.share >= 10) flags.push(`${fmtPctText(walk.share)} of revenue is recorded against generic names (walk-in/client/individual), which limits customer analysis.`);
  if (a.profitRoi.usedBatchCostFallback) flags.push('Costs include completed production batches because no "Production" ledger entries were found for the period.');
  if (a.bags && !a.bags.producedRecorded) flags.push('Bags made are not recorded for this period, so the Bags section shows sales and promo only and cannot show the stock gap.');
  if (a.bags && a.bags.producedRecorded) flags.push('In the Bags section, sold and promo bags come from PAID invoices only. Bags on unpaid invoices are not counted, so the stock gap can look larger than the real warehouse stock.');
  flags.push('Revenue is recognised on the invoice date for paid invoices only. Salary entries appear in the ledger on the date they were saved, so monthly cost timing is approximate.');
  return flags;
}

/* ── Bags: made, sold and given away (promo) ─────────────────────────
   Three numbers per month, all in BAGS:
     made  = production (same sources and "most complete source" rule as the
             supply figures above, so it matches the Inventory page)
     sold  = bags on PAID invoices (same basis as "Bags sold" elsewhere)
     promo = free promotional bags on those same paid invoices (the Sales &
             Invoicing "Promo" column). Counted SEPARATELY from sold, never
             inside it, exactly as they are entered on the invoice.
   "Gap" = made - sold - promo: positive means stock is building up in the
   warehouse, negative means stock was drawn down.
   Months with no production recorded are left blank (null), not zero, so
   the made-curve never falsely drops to nothing.                         */

function bagTotalsFor(invoices, supply, months) {
  const set = new Set(months);
  let sold = 0;
  let promo = 0;
  for (const inv of invoices) {
    if (!inv.isPaid || !set.has(inv.month)) continue;
    sold += inv.qty;
    promo += inv.promo;
  }
  const made = months.reduce((s, m) => s + (supply.byMonth[m] || 0), 0);
  return { made, sold, promo };
}

function movingAverage3(values) {
  return values.map((_, i) => {
    if (i < 2) return null;
    const win = values.slice(i - 2, i + 1).filter((v) => v !== null && v !== undefined);
    return win.length >= 2 ? round2(mean(win)) : null;
  });
}

function trendLine(values) {
  const pts = [];
  values.forEach((v, i) => { if (v !== null && v !== undefined) pts.push([i, v]); });
  if (pts.length < 4) return { values: values.map(() => null), slope: null, r2: null, meanValue: null };
  const fit = olsFit(pts.map((p) => p[0]), pts.map((p) => p[1]));
  if (!fit) return { values: values.map(() => null), slope: null, r2: null, meanValue: null };
  const first = pts[0][0];
  const last = pts[pts.length - 1][0];
  return {
    values: values.map((_, i) => (i >= first && i <= last ? round2(Math.max(0, fit.intercept + fit.slope * i)) : null)),
    slope: fit.slope,
    r2: fit.r2,
    meanValue: mean(pts.map((p) => p[1])),
  };
}

function describeTrend(name, t, verb = 'have') {
  if (!t || t.slope === null || !t.meanValue) return { direction: 'unknown', perMonth: null, perMonthPct: null, r2: null, text: `Not enough months yet to see a clear ${name} trend (needs at least 4).` };
  const perMonthPct = (t.slope / t.meanValue) * 100;
  const direction = perMonthPct > 2 ? 'rising' : perMonthPct < -2 ? 'falling' : 'steady';
  const amount = Math.round(Math.abs(t.slope)).toLocaleString('en-GB');
  const text = direction === 'steady'
    ? `${name[0].toUpperCase()}${name.slice(1)} ${verb} been about steady, changing by only ${Math.abs(perMonthPct).toFixed(1)}% a month on average.`
    : `${name[0].toUpperCase()}${name.slice(1)} ${verb} been ${direction}, by about ${amount} bags a month (${Math.abs(perMonthPct).toFixed(1)}% of an average month).`;
  return { direction, perMonth: round2(t.slope), perMonthPct: round2(perMonthPct), r2: t.r2 === null ? null : round2(t.r2), text };
}

function bagChange(cur, prior) {
  const p = pctChange(cur, prior);
  return { cur, prior, change: cur - prior, pct: p === null ? null : round2(p) };
}

function computeBagsAnalysis({ invoices, supply, months, endMonth, label, previousLabel, previousMonths, yearAgoLabel, yearAgoMonths }) {
  const totals = bagTotalsFor(invoices, supply, months);
  const dispatched = totals.sold + totals.promo;
  const producedRecorded = totals.made > 0;

  // Window for the curves: the 12 months up to the end of the period, starting
  // at the first month that has any bag activity at all.
  const promoByMonth = {};
  const soldByMonth = {};
  for (const inv of invoices) {
    if (!inv.isPaid) continue;
    soldByMonth[inv.month] = (soldByMonth[inv.month] || 0) + inv.qty;
    promoByMonth[inv.month] = (promoByMonth[inv.month] || 0) + inv.promo;
  }
  const activityMonths = new Set([...Object.keys(soldByMonth), ...Object.keys(promoByMonth), ...Object.keys(supply.byMonth).filter((m) => (supply.byMonth[m] || 0) > 0)]);
  const firstActivity = [...activityMonths].filter((m) => m <= endMonth).sort()[0];
  const windowStartLimit = addMonths(endMonth, -11);
  let windowStart = firstActivity && firstActivity > windowStartLimit ? firstActivity : windowStartLimit;
  if (months[0] < windowStart) windowStart = months[0];
  const windowMonths = [];
  for (let m = windowStart; m <= endMonth && windowMonths.length < 24; m = addMonths(m, 1)) windowMonths.push(m);

  const madeVals = windowMonths.map((m) => ((supply.byMonth[m] || 0) > 0 ? supply.byMonth[m] : null));
  const soldVals = windowMonths.map((m) => soldByMonth[m] || 0);
  const promoVals = windowMonths.map((m) => promoByMonth[m] || 0);
  const maMade = movingAverage3(madeVals);
  const maSold = movingAverage3(soldVals);
  const maPromo = movingAverage3(promoVals);
  const trMade = trendLine(madeVals);
  const trSold = trendLine(soldVals);
  const trPromo = trendLine(promoVals);
  const periodSet = new Set(months);

  const win = windowMonths.map((m, i) => {
    const made = madeVals[i];
    const sold = soldVals[i];
    const promo = promoVals[i];
    return {
      month: m,
      label: monthShortLabel(m),
      shortLabel: MONTH_SHORT[Number(m.slice(5, 7)) - 1] || m,
      inPeriod: periodSet.has(m),
      made,
      sold,
      promo,
      gap: made === null ? null : made - sold - promo,
      sellThroughPct: made === null ? null : round2((sold / made) * 100),
      promoPer100Sold: sold > 0 ? round2((promo / sold) * 100) : null,
      maMade: maMade[i],
      maSold: maSold[i],
      maPromo: maPromo[i],
      trendMade: trMade.values[i],
      trendSold: trSold.values[i],
      trendPromo: trPromo.values[i],
    };
  });

  const periodRows = win.filter((r) => r.inPeriod);
  const gap = producedRecorded ? totals.made - dispatched : null;
  const period = {
    made: totals.made,
    sold: totals.sold,
    promo: totals.promo,
    dispatched,
    gap,
    sellThroughPct: producedRecorded ? round2((totals.sold / totals.made) * 100) : null,
    dispatchedPct: producedRecorded ? round2((dispatched / totals.made) * 100) : null,
    promoPer100Sold: totals.sold > 0 ? round2((totals.promo / totals.sold) * 100) : null,
    promoSharePct: dispatched > 0 ? round2((totals.promo / dispatched) * 100) : null,
  };

  const compareWith = (cmpLabel, cmpMonths) => {
    if (!cmpMonths || !cmpMonths.length) return null;
    const t = bagTotalsFor(invoices, supply, cmpMonths);
    if (t.made === 0 && t.sold === 0 && t.promo === 0) return null;
    return {
      label: cmpLabel,
      made: bagChange(totals.made, t.made),
      sold: bagChange(totals.sold, t.sold),
      promo: bagChange(totals.promo, t.promo),
      promoPer100Sold: { cur: period.promoPer100Sold, prior: t.sold > 0 ? round2((t.promo / t.sold) * 100) : null },
    };
  };
  const vsPrevious = compareWith(previousLabel, previousMonths);
  const vsYearAgo = yearAgoMonths ? compareWith(yearAgoLabel, yearAgoMonths) : null;

  const pick = (rows, key, pickMax) => {
    const usable = rows.filter((r) => r[key] !== null && r[key] !== undefined && (r[key] > 0 || !pickMax));
    if (!usable.length) return null;
    const best = usable.reduce((b, r) => ((pickMax ? r[key] > b[key] : r[key] < b[key]) ? r : b), usable[0]);
    return { month: best.month, label: best.label, value: best[key] };
  };
  const highlights = {
    bestSold: pick(periodRows, 'sold', true),
    weakestSold: periodRows.length > 1 ? pick(periodRows, 'sold', false) : null,
    bestMade: pick(periodRows, 'made', true),
    highestPromo: pick(periodRows, 'promo', true),
  };

  const trends = {
    made: describeTrend('production', trMade, 'has'),
    sold: describeTrend('bags sold', trSold),
    promo: describeTrend('promo bags', trPromo),
  };

  const n = (v) => Math.round(v).toLocaleString('en-GB');
  const reading = [];
  if (totals.sold === 0 && totals.promo === 0 && !producedRecorded) {
    reading.push('No bags made, sold or given away were recorded for this period.');
  } else {
    if (producedRecorded) {
      reading.push(`In ${label} we made ${n(totals.made)} bags, sold ${n(totals.sold)} paid bags (${fmtPctText(period.sellThroughPct, 0)} of what we made) and gave away ${n(totals.promo)} free promo bags.`);
      reading.push(gap >= 0
        ? `That leaves ${n(gap)} more bags made than went out, so stock is building up in the warehouse (or sits on unpaid or undelivered orders).`
        : `${n(Math.abs(gap))} more bags went out than were made this period, so the shortfall came out of opening stock. Check that stock has not run too low.`);
    } else {
      reading.push(`In ${label} we sold ${n(totals.sold)} paid bags and gave away ${n(totals.promo)} free promo bags. Production was not recorded, so we cannot say how many bags were made or what happened to stock. Recording finished products in Inventory fixes this.`);
    }
    if (period.promoPer100Sold !== null) {
      reading.push(`For every 100 bags sold we gave away about ${period.promoPer100Sold.toFixed(1)} free bags. Promo bags were ${fmtPctText(period.promoSharePct, 1)} of everything that left the factory.`);
    }
    if (trends.sold.direction !== 'unknown') reading.push(trends.sold.text);
    if (producedRecorded && trends.made.direction !== 'unknown') reading.push(trends.made.text);
    if (highlights.bestSold && highlights.weakestSold && highlights.bestSold.month !== highlights.weakestSold.month) {
      reading.push(`Best month for sales was ${highlights.bestSold.label} (${n(highlights.bestSold.value)} bags) and the weakest was ${highlights.weakestSold.label} (${n(highlights.weakestSold.value)} bags).`);
    }
    if (vsPrevious && vsPrevious.sold.pct !== null) {
      reading.push(`Compared with ${vsPrevious.label}, bags sold are ${vsPrevious.sold.pct >= 0 ? 'up' : 'down'} ${Math.abs(vsPrevious.sold.pct).toFixed(1)}%${vsPrevious.promo.pct === null ? '' : ` and promo bags are ${vsPrevious.promo.pct >= 0 ? 'up' : 'down'} ${Math.abs(vsPrevious.promo.pct).toFixed(1)}%`}.`);
    }
  }

  return {
    producedRecorded,
    sourceNames: [...new Set(months.map((m) => supply.winners[m]).filter(Boolean))],
    window: win,
    periodRows,
    period,
    vsPrevious,
    vsYearAgo,
    highlights,
    trends,
    reading,
    basisNote: 'Sold = bags on paid invoices. Promo = free bags on those same invoices, counted separately from sold. Made = production records. Gap = made minus sold minus promo.',
  };
}

/* ── Orchestration ───────────────────────────────────────────────── */

async function buildPeriodAnalysis({ AppData }, spec) {
  const { periodType, year, quarter, label, months, previousLabel, previousMonths, discountRateInfo } = spec;
  const endMonth = months[months.length - 1];

  const [invoices, accounting, productionSources] = await Promise.all([
    loadSalesInvoices(AppData, endMonth),
    loadAccountingData(AppData),
    loadProductionSources(AppData),
  ]);
  const { ledger, assets } = accounting;
  const supply = supplyByMonth(productionSources);

  const core = computePeriodCore(invoices, months);
  const prevCore = computePeriodCore(invoices, previousMonths);

  const firstActive = invoices.length ? invoices.map((i) => i.month).sort()[0] : months[0];
  const historyStart = firstActive < months[0] ? firstActive : months[0];
  const historyMonths = [];
  for (let m = historyStart; m <= endMonth && historyMonths.length < 240; m = addMonths(m, 1)) historyMonths.push(m);
  const historySeries = buildMonthlySeries(invoices, historyMonths, ledger, supply);
  const periodSeries = historySeries.filter((s) => months.includes(s.month));

  const revenue = computeRevenueAndVariability(core, months, periodSeries);
  const profitRoi = computeProfitAndROI({ ledger, assets, batches: productionSources.batches, months, core, periodMonthsCount: months.length });
  const prevProfit = computeProfitAndROI({ ledger, assets, batches: productionSources.batches, months: previousMonths, core: prevCore, periodMonthsCount: previousMonths.length });
  const unitEconomics = computeUnitEconomics(profitRoi, core);
  const marginal = computeMarginalAnalysis(historySeries, unitEconomics);

  const opCur = core.activeMonths.length || 1;
  const opPrev = prevCore.activeMonths.length;
  const portfolio = computeCustomerPortfolio(core, prevCore, opCur, opPrev);

  // Price-volume decomposition on an average-month basis.
  let comparison = null;
  if (opPrev > 0 && prevCore.paidBags > 0 && core.paidBags > 0) {
    const bagsCur = core.paidBags / opCur;
    const bagsPrev = prevCore.paidBags / opPrev;
    const priceCur = core.avgPrice;
    const pricePrev = prevCore.avgPrice;
    comparison = {
      previousPartial: opPrev < opCur,
      previousActiveMonths: opPrev,
      currentActiveMonths: opCur,
      revenueGrowthPerMonthPct: (() => { const g = pctChange(core.revenue / opCur, prevCore.revenue / opPrev); return g === null ? null : round2(g); })(),
      bagsGrowthPerMonthPct: (() => { const g = pctChange(bagsCur, bagsPrev); return g === null ? null : round2(g); })(),
      priceChangePct: (() => { const g = pctChange(priceCur, pricePrev); return g === null ? null : round2(g); })(),
      volumeEffect: round2((bagsCur - bagsPrev) * pricePrev * opCur),
      priceEffect: round2((priceCur - pricePrev) * bagsCur * opCur),
      previousRevenue: round2(prevCore.revenue),
      previousNetProfit: round2(prevProfit.netProfit),
      previousAvgPrice: round2(pricePrev),
    };
  } else if (opPrev > 0) {
    comparison = { previousPartial: opPrev < opCur, previousActiveMonths: opPrev, currentActiveMonths: opCur, revenueGrowthPerMonthPct: null, volumeEffect: null, priceEffect: null, previousRevenue: round2(prevCore.revenue), previousNetProfit: round2(prevProfit.netProfit) };
  }

  const demandSupply = computeDemandSupply(supply, months, core);
  const seasonality = computeSeasonality(historySeries, revenue.statMonths, revenue, periodType === 'year');

  const npv = computeForwardNPV({
    currentNetProfit: profitRoi.netProfit,
    previousNetProfit: prevProfit.netProfit,
    annualDiscountRate: discountRateInfo.rate,
    horizon: periodType === 'quarter' ? 4 : 3,
    periodsPerYear: periodType === 'quarter' ? 4 : 1,
    clamp: periodType === 'quarter' ? { min: -0.3, max: 0.25 } : { min: -0.3, max: 0.3 },
  });

  const outlook = computeOutlook({ historySeries, periodType, year, quarter, statSd: null });

  const bags = computeBagsAnalysis({
    invoices,
    supply,
    months,
    endMonth,
    label,
    previousLabel,
    previousMonths,
    yearAgoLabel: periodType === 'quarter' ? quarterLabel(year - 1, quarter) : null,
    yearAgoMonths: periodType === 'quarter' ? months.map((m) => addMonths(m, -12)) : null,
  });

  const collections = {
    billed: round2(core.billed),
    paid: round2(core.revenue),
    outstanding: round2(core.outstanding),
    efficiencyPct: core.billed > 0 ? round2((core.revenue / core.billed) * 100) : null,
    invoiceCount: core.invoiceCount,
    paidInvoiceCount: core.paid.length,
  };

  // ── Month-by-month comparisons ──
  // Sales for the earlier months are rebuilt directly from invoices, so the
  // comparison works even if the earlier period is before the first month
  // that appears in historySeries.
  const cmpSets = [];
  const buildPriorSeries = (priorMonths) => buildMonthlySeries(invoices, priorMonths, ledger, supply);
  if (periodType === 'year') {
    cmpSets.push(buildComparison({
      kind: 'year', title: `${label} compared with ${previousLabel}`,
      curLabel: label, priorLabel: previousLabel, curMonths: months, priorMonths: previousMonths,
      curSeries: periodSeries, priorSeries: buildPriorSeries(previousMonths),
      curCore: core, priorCore: prevCore, curProfit: profitRoi, priorProfit: prevProfit, isAnnual: true,
    }));
  } else {
    cmpSets.push(buildComparison({
      kind: 'previous-period', title: `${label} compared with ${previousLabel} (the quarter before)`,
      curLabel: label, priorLabel: previousLabel, curMonths: months, priorMonths: previousMonths,
      curSeries: periodSeries, priorSeries: buildPriorSeries(previousMonths),
      curCore: core, priorCore: prevCore, curProfit: profitRoi, priorProfit: prevProfit, isAnnual: false,
    }));
    const yoyMonths = months.map((m) => addMonths(m, -12));
    const yoyCore = computePeriodCore(invoices, yoyMonths);
    const yoyProfit = computeProfitAndROI({ ledger, assets, batches: productionSources.batches, months: yoyMonths, core: yoyCore, periodMonthsCount: yoyMonths.length });
    cmpSets.push(buildComparison({
      kind: 'year-ago', title: `${label} compared with the same quarter last year`,
      curLabel: label, priorLabel: quarterLabel(year - 1, quarter), curMonths: months, priorMonths: yoyMonths,
      curSeries: periodSeries, priorSeries: buildPriorSeries(yoyMonths),
      curCore: core, priorCore: yoyCore, curProfit: profitRoi, priorProfit: yoyProfit, isAnnual: false,
    }));
  }

  const analysis = {
    periodType,
    year,
    quarter: quarter || null,
    label,
    months,
    period: describePeriod(months),
    operatingMonths: core.activeMonths,
    partialYear: periodType === 'year' && core.activeMonths.length > 0 && core.activeMonths.length < 12,
    previousLabel,
    previousQuarterLabel: previousLabel,
    previousYearLabel: previousLabel,
    revenue,
    profitRoi,
    unitEconomics,
    marginal,
    comparison,
    compareSets: cmpSets,
    portfolio,
    bcgMatrix: portfolio.rows,
    demandSupply,
    bags,
    seasonality,
    collections,
    npv,
    outlook,
    discountRateInfo,
    series: historySeries,
    periodSeries,
    generatedAt: new Date().toISOString(),
  };

  analysis.narrative = buildNarrative(analysis);
  analysis.plain = buildPlain(analysis);
  analysis.dataQuality = buildDataQuality(analysis, invoices, months, historySeries);
  return analysis;
}

async function buildQuarterlyAnalysis({ AppData }, { year, quarter, discountRateInfo }) {
  const prev = previousQuarter(year, quarter);
  return buildPeriodAnalysis({ AppData }, {
    periodType: 'quarter',
    year,
    quarter,
    label: quarterLabel(year, quarter),
    months: quarterMonths(year, quarter),
    previousLabel: quarterLabel(prev.year, prev.quarter),
    previousMonths: quarterMonths(prev.year, prev.quarter),
    discountRateInfo,
  });
}

async function buildAnnualAnalysis({ AppData }, { year, discountRateInfo }) {
  return buildPeriodAnalysis({ AppData }, {
    periodType: 'year',
    year,
    quarter: null,
    label: yearLabel(year),
    months: yearMonths(year),
    previousLabel: yearLabel(year - 1),
    previousMonths: yearMonths(year - 1),
    discountRateInfo,
  });
}

module.exports = {
  quarterMonths,
  previousQuarter,
  justCompletedQuarter,
  quarterEndingToday,
  quarterLabel,
  buildQuarterlyAnalysis,
  yearMonths,
  yearLabel,
  justCompletedYear,
  buildAnnualAnalysis,
  // exported for testing
  normalizeCustomer,
  describePeriod,
  checkPeriodAvailability,
  ghs,
  computeBagsAnalysis,
};