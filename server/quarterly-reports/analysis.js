/* ═══════════════════════════════════════════════════════════════════
   QUARTERLY ANALYSIS ENGINE
   ───────────────────────────────────────────────────────────────────
   Reads straight from the AppData key-value buckets (the app's
   established source of truth — see README §4 / server.js comments),
   never from the older Mongoose collections, so this always matches
   what the Reports page shows.

   Every calculation below states its own assumptions inline. This is
   deliberate: a discount rate, a growth extrapolation, or a BCG
   quadrant threshold is only trustworthy to a business reader if they
   can see exactly how it was derived. Nothing here should be read as
   audited financial statements — it is a fast, internally-consistent
   management report.
   ═══════════════════════════════════════════════════════════════════ */

const SALES_MONTH_RE = /^ww_sales_(\d{4})-(\d{2})$/;
const ACCOUNTING_KEY = 'ww_accounting_data_v2';
const PRODUCTION_KEY = 'ww_production_batches';

/* ── Quarter/date helpers ─────────────────────────────────────────── */

function quarterMonths(year, quarter) {
  const startMonth = (quarter - 1) * 3 + 1; // 1,4,7,10
  return [0, 1, 2].map((offset) => `${year}-${String(startMonth + offset).padStart(2, '0')}`);
}

function previousQuarter(year, quarter) {
  if (quarter === 1) return { year: year - 1, quarter: 4 };
  return { year, quarter: quarter - 1 };
}

// Determines the most recently *completed* quarter relative to `now`,
// which is what the automatic quarterly send should always report on.
function justCompletedQuarter(now = new Date()) {
  const month = now.getMonth() + 1; // 1-12
  const year = now.getFullYear();
  if (month <= 3) return { year: year - 1, quarter: 4 };
  if (month <= 6) return { year, quarter: 1 };
  if (month <= 9) return { year, quarter: 2 };
  return { year, quarter: 3 };
}

function quarterLabel(year, quarter) {
  return `Q${quarter} ${year}`;
}

// Used by the automatic cron only, which now fires on the LAST day of the
// quarter itself (not the day after) — see index.js. On that day, `now`'s
// own month already tells you exactly which quarter just closed, so this
// is a straight ceil(month/3) rather than justCompletedQuarter()'s
// "which quarter most recently finished as of today" logic (which would
// incorrectly look one quarter further back if used on the closing day).
function quarterEndingToday(now = new Date()) {
  const month = now.getMonth() + 1;
  return { year: now.getFullYear(), quarter: Math.ceil(month / 3) };
}

/* ── Year helpers ─────────────────────────────────────────────────── */

function yearMonths(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

function yearLabel(year) {
  return String(year);
}

// The automatic annual cron fires 00:15 on Jan 1st, so `now`'s year is
// already the new year — the year that just completed is the one before it.
function justCompletedYear(now = new Date()) {
  return { year: now.getFullYear() - 1 };
}

/* ── Raw data loading (AppData only) ─────────────────────────────── */

async function loadMonthPayload(AppData, month) {
  const doc = await AppData.findOne({ key: `ww_sales_${month}` }).lean();
  const payload = (doc && doc.data && typeof doc.data === 'object') ? doc.data : {};
  return {
    invoices: Array.isArray(payload.invoices) ? payload.invoices : [],
    salesOrders: Array.isArray(payload.salesOrders) ? payload.salesOrders : [],
  };
}

async function loadQuarterInvoices(AppData, year, quarter) {
  const months = quarterMonths(year, quarter);
  const results = await Promise.all(months.map((m) => loadMonthPayload(AppData, m)));
  const invoices = results.flatMap((r) => r.invoices).filter((inv) => inv && inv.id);
  return { months, invoices };
}

async function loadYearInvoices(AppData, year) {
  const months = yearMonths(year);
  const results = await Promise.all(months.map((m) => loadMonthPayload(AppData, m)));
  const invoices = results.flatMap((r) => r.invoices).filter((inv) => inv && inv.id);
  return { months, invoices };
}

// Some months of a calendar year may have no invoices AND no production —
// e.g. the factory started operations partway through its first year.
// Feeding those idle months into the revenue-variability trend or the
// marginal (first-month vs last-month) comparison would badly distort both
// (a real month compared against an artificial zero-month). This detects
// which months actually saw activity so the annual report can compute its
// trend/marginal sections over real operating months only, while yearly
// totals (which sum invoices directly, not month-by-month) stay unaffected.
function detectOperatingMonths(invoices, batches, months) {
  const active = new Set();
  invoices.forEach((inv) => {
    const m = invoiceMonth(inv);
    if (m) active.add(m);
  });
  batches.forEach((b) => {
    const m = String(b && b.date || '').slice(0, 7);
    if (m) active.add(m);
  });
  return months.filter((m) => active.has(m));
}

async function loadAccountingData(AppData) {
  const doc = await AppData.findOne({ key: ACCOUNTING_KEY }).lean();
  const data = (doc && doc.data && typeof doc.data === 'object') ? doc.data : {};
  return {
    ledger: Array.isArray(data.ledger) ? data.ledger : [],
    assets: Array.isArray(data.assets) ? data.assets : [],
  };
}

async function loadProductionBatches(AppData) {
  const doc = await AppData.findOne({ key: PRODUCTION_KEY }).lean();
  return Array.isArray(doc && doc.data) ? doc.data : [];
}

/* ── Small numeric helpers ───────────────────────────────────────── */

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

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sampleStdDev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, v) => sum + ((v - avg) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/* ── Section 1: Revenue & variability ────────────────────────────── */

function computeRevenueAndVariability(invoices, months) {
  const monthlyRevenue = {};
  months.forEach((m) => { monthlyRevenue[m] = 0; });

  let totalRevenue = 0;
  let promoExpense = 0;
  let totalBagsOrdered = 0;

  for (const inv of invoices) {
    const month = invoiceMonth(inv);
    const qty = invoiceQty(inv);
    totalBagsOrdered += qty;
    if (inv.status !== 'paid') continue;
    const amount = Number(inv.amount || 0) || 0;
    totalRevenue += amount;
    if (Object.prototype.hasOwnProperty.call(monthlyRevenue, month)) {
      monthlyRevenue[month] += amount;
    }
    const rate = Number(inv.rate || (inv.items && inv.items[0] ? inv.items[0].unitPrice : 0)) || 0;
    promoExpense += (Number(inv.promo || 0) || 0) * rate;
  }

  const series = months.map((m) => monthlyRevenue[m]);
  const avg = mean(series);
  const stdDev = sampleStdDev(series);
  const coefficientOfVariation = avg > 0 ? (stdDev / avg) * 100 : 0;

  let variabilityBand;
  if (avg === 0) variabilityBand = 'No revenue recorded this quarter';
  else if (coefficientOfVariation < 15) variabilityBand = 'Low variability (stable revenue)';
  else if (coefficientOfVariation < 30) variabilityBand = 'Moderate variability';
  else variabilityBand = 'High variability (volatile revenue)';

  return {
    monthlyRevenue,
    totalRevenue: round2(totalRevenue),
    promoExpense: round2(promoExpense),
    totalBagsOrdered,
    mean: round2(avg),
    stdDev: round2(stdDev),
    coefficientOfVariation: round2(coefficientOfVariation),
    variabilityBand,
  };
}

/* ── Section 2: Costs, profit, ROI ───────────────────────────────── */

function computeProfitAndROI(ledger, assets, batches, months, totalRevenue, promoExpense) {
  const monthSet = new Set(months);

  const operatingExpenses = ledger
    .filter((e) => String(e && e.type).toLowerCase() === 'expense' && monthSet.has(String(e.date || '').slice(0, 7)))
    .reduce((sum, e) => sum + ((Number(e.debit) || 0) - (Number(e.credit) || 0)), 0);

  const cogs = batches
    .filter((b) => b && String(b.status).toLowerCase() === 'completed' && monthSet.has(String(b.date || '').slice(0, 7)))
    .reduce((sum, b) => sum + (Number(b.cost) || 0), 0);

  const netProfit = totalRevenue - cogs - operatingExpenses - promoExpense;

  const totalAssets = assets.reduce((sum, a) => sum + (Number(a && a.value) || 0), 0);
  const roiPercent = totalAssets > 0 ? (netProfit / totalAssets) * 100 : null;

  return {
    cogs: round2(cogs),
    operatingExpenses: round2(operatingExpenses),
    netProfit: round2(netProfit),
    totalAssets: round2(totalAssets),
    roiPercent: roiPercent === null ? null : round2(roiPercent),
  };
}

/* ── Section 3: Marginal benefit vs marginal cost ────────────────── */

function computeMarginalAnalysis(batches, invoices, months) {
  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];

  const qtyByMonth = (month) => batches
    .filter((b) => b && String(b.status).toLowerCase() === 'completed' && String(b.date || '').slice(0, 7) === month)
    .reduce((sum, b) => sum + (Number(b.qty) || 0), 0);

  const costByMonth = (month) => batches
    .filter((b) => b && String(b.status).toLowerCase() === 'completed' && String(b.date || '').slice(0, 7) === month)
    .reduce((sum, b) => sum + (Number(b.cost) || 0), 0);

  const revenueByMonth = (month) => invoices
    .filter((inv) => inv.status === 'paid' && invoiceMonth(inv) === month)
    .reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);

  const qtyFirst = qtyByMonth(firstMonth);
  const qtyLast = qtyByMonth(lastMonth);
  const costFirst = costByMonth(firstMonth);
  const costLast = costByMonth(lastMonth);
  const revenueFirst = revenueByMonth(firstMonth);
  const revenueLast = revenueByMonth(lastMonth);

  const deltaQty = qtyLast - qtyFirst;

  if (deltaQty === 0) {
    return {
      firstMonth, lastMonth, qtyFirst, qtyLast,
      marginalCostPerBag: null,
      marginalRevenuePerBag: null,
      verdict: 'Output was flat between the first and last month of the quarter, so no marginal cost/benefit could be derived from this comparison.',
    };
  }

  const marginalCostPerBag = round2((costLast - costFirst) / deltaQty);
  const marginalRevenuePerBag = round2((revenueLast - revenueFirst) / deltaQty);

  let verdict;
  if (deltaQty < 0) {
    verdict = `Output contracted by ${Math.abs(deltaQty).toLocaleString()} bags from ${firstMonth} to ${lastMonth}. Marginal figures below describe the cost/revenue given up per bag of that contraction, not an expansion scenario.`;
  } else if (marginalRevenuePerBag > marginalCostPerBag) {
    verdict = `Marginal revenue (GH₵${marginalRevenuePerBag}/bag) exceeded marginal cost (GH₵${marginalCostPerBag}/bag) as output rose — the plant was still operating below its efficient scale, so further output growth this quarter continued adding value.`;
  } else {
    verdict = `Marginal cost (GH₵${marginalCostPerBag}/bag) met or exceeded marginal revenue (GH₵${marginalRevenuePerBag}/bag) as output rose — a sign of diminishing returns, i.e. the plant was operating at or beyond its efficient scale for this quarter.`;
  }

  return { firstMonth, lastMonth, qtyFirst, qtyLast, marginalCostPerBag, marginalRevenuePerBag, verdict };
}

/* ── Section 4: BCG-adapted customer portfolio matrix ────────────── */
// A textbook BCG matrix plots business units by market growth vs share
// of an *external* market, benchmarked against competitors. This
// business has one product line and no visibility into competitors'
// sales, so a literal BCG matrix cannot be built. What follows is an
// internally-adapted version — a legitimate and common substitute when
// external market data is unavailable — using each customer account as
// the "unit", plotted by revenue growth (quarter-over-quarter) against
// share of this quarter's own revenue. This is stated explicitly in
// the report so it is never mistaken for a market-share-based matrix.

function computeCustomerPortfolioMatrix(currentInvoices, previousInvoices, topN = 8) {
  const sumByCustomer = (invoices) => {
    const map = new Map();
    for (const inv of invoices) {
      if (inv.status !== 'paid') continue;
      const name = String(inv.customer || 'Unknown').trim() || 'Unknown';
      map.set(name, (map.get(name) || 0) + (Number(inv.amount) || 0));
    }
    return map;
  };

  const current = sumByCustomer(currentInvoices);
  const previous = sumByCustomer(previousInvoices);
  const totalCurrent = [...current.values()].reduce((s, v) => s + v, 0);

  const rows = [...current.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([customer, revenue]) => {
      const priorRevenue = previous.get(customer) || 0;
      const share = totalCurrent > 0 ? (revenue / totalCurrent) * 100 : 0;
      const isNew = priorRevenue === 0 && revenue > 0;
      const growth = isNew ? null : (priorRevenue > 0 ? ((revenue - priorRevenue) / priorRevenue) * 100 : 0);
      return { customer, revenue: round2(revenue), share: round2(share), growth: growth === null ? null : round2(growth), isNew };
    });

  const knownGrowthRows = rows.filter((r) => r.growth !== null);
  const medianOf = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const medianShare = medianOf(rows.map((r) => r.share));
  const medianGrowth = medianOf(knownGrowthRows.map((r) => r.growth));

  const classify = (row) => {
    if (row.isNew) return 'Question Mark (new account)';
    const highShare = row.share >= medianShare;
    const highGrowth = row.growth >= medianGrowth;
    if (highShare && highGrowth) return 'Star';
    if (highShare && !highGrowth) return 'Cash Cow';
    if (!highShare && highGrowth) return 'Question Mark';
    return 'Dog';
  };

  return rows.map((row) => ({ ...row, quadrant: classify(row) }));
}

/* ── Section 5: Demand vs. supply ─────────────────────────────────── */

function computeDemandSupply(batches, months, totalBagsOrdered) {
  const monthSet = new Set(months);
  const supply = batches
    .filter((b) => b && String(b.status).toLowerCase() === 'completed' && monthSet.has(String(b.date || '').slice(0, 7)))
    .reduce((sum, b) => sum + (Number(b.qty) || 0), 0);

  const demand = totalBagsOrdered;
  const fulfillmentRate = supply > 0 ? round2((demand / supply) * 100) : null;

  let condition;
  if (supply === 0 && demand === 0) {
    condition = 'No production or orders recorded this quarter.';
  } else if (demand > supply * 1.05) {
    condition = 'Demand exceeded supply — a sign of potential stockouts, unmet orders, or backlog risk. Consider whether production capacity needs to expand.';
  } else if (supply > demand * 1.05) {
    condition = 'Supply exceeded demand — a sign of potential overproduction, rising finished-goods inventory, and tied-up working capital.';
  } else {
    condition = 'Supply and demand were approximately balanced this quarter.';
  }

  return { supplyBags: supply, demandBags: demand, fulfillmentRate, condition };
}

/* ── Section 6: NPV of forward operating cash flow ───────────────── */
// This is an indicative, short-horizon NPV of expected future operating
// cash flow — NOT a capital-project NPV (which would net an initial
// investment outlay against future inflows). It projects this
// quarter's net profit forward, growing at the trailing quarter-over-
// quarter growth rate (clamped to avoid absurd compounding off one
// noisy quarter), and discounts each future quarter back at the
// resolved discount rate. All assumptions are surfaced in the output
// so this is never mistaken for a formal investment appraisal.

function computeForwardNPV({ currentNetProfit, previousNetProfit, annualDiscountRate, horizonQuarters = 4 }) {
  const quarterlyRate = ((1 + annualDiscountRate) ** (1 / 4)) - 1;

  let growthRate = 0;
  if (previousNetProfit && previousNetProfit !== 0) {
    growthRate = (currentNetProfit - previousNetProfit) / Math.abs(previousNetProfit);
  }
  const clampedGrowthRate = Math.max(-0.5, Math.min(1.0, growthRate));

  let npv = 0;
  const projectedCashFlows = [];
  for (let t = 1; t <= horizonQuarters; t += 1) {
    const projectedCF = currentNetProfit * ((1 + clampedGrowthRate) ** t);
    const discounted = projectedCF / ((1 + quarterlyRate) ** t);
    npv += discounted;
    projectedCashFlows.push({ quarter: t, projectedCashFlow: round2(projectedCF), discountedValue: round2(discounted) });
  }

  return {
    npv: round2(npv),
    quarterlyDiscountRate: round2(quarterlyRate * 100),
    assumedGrowthRatePerQuarter: round2(clampedGrowthRate * 100),
    horizonQuarters,
    projectedCashFlows,
  };
}

// Annual counterpart of computeForwardNPV. Two deliberate differences from
// the quarterly version, both because a year-over-year growth swing is a
// much bigger extrapolation to project forward than a quarter-over-quarter
// one: (1) a shorter 3-year horizon instead of 4 periods, so compounding
// error doesn't run too far ahead of a single data point, and (2) a
// tighter growth clamp of -30%/+50% per year instead of -50%/+100% per
// quarter, to avoid one unusually good or bad year dominating the whole
// projection. The discount rate is applied directly per year — no
// quarterly conversion needed here.
function computeForwardAnnualNPV({ currentNetProfit, previousNetProfit, annualDiscountRate, horizonYears = 3 }) {
  let growthRate = 0;
  if (previousNetProfit && previousNetProfit !== 0) {
    growthRate = (currentNetProfit - previousNetProfit) / Math.abs(previousNetProfit);
  }
  const clampedGrowthRate = Math.max(-0.3, Math.min(0.5, growthRate));

  let npv = 0;
  const projectedCashFlows = [];
  for (let t = 1; t <= horizonYears; t += 1) {
    const projectedCF = currentNetProfit * ((1 + clampedGrowthRate) ** t);
    const discounted = projectedCF / ((1 + annualDiscountRate) ** t);
    npv += discounted;
    projectedCashFlows.push({ year: t, projectedCashFlow: round2(projectedCF), discountedValue: round2(discounted) });
  }

  return {
    npv: round2(npv),
    annualDiscountRateUsed: round2(annualDiscountRate * 100),
    assumedGrowthRatePerYear: round2(clampedGrowthRate * 100),
    horizonYears,
    projectedCashFlows,
  };
}

/* ── Orchestration ────────────────────────────────────────────────── */

async function buildQuarterlyAnalysis({ AppData, ProductionBatch: _unused }, { year, quarter, discountRateInfo }) {
  const { months, invoices } = await loadQuarterInvoices(AppData, year, quarter);
  const prev = previousQuarter(year, quarter);
  const { invoices: previousInvoices } = await loadQuarterInvoices(AppData, prev.year, prev.quarter);

  const { ledger, assets } = await loadAccountingData(AppData);
  const batches = await loadProductionBatches(AppData);

  const revenue = computeRevenueAndVariability(invoices, months);
  const profitRoi = computeProfitAndROI(ledger, assets, batches, months, revenue.totalRevenue, revenue.promoExpense);
  const marginal = computeMarginalAnalysis(batches, invoices, months);
  const bcgMatrix = computeCustomerPortfolioMatrix(invoices, previousInvoices);
  const demandSupply = computeDemandSupply(batches, months, revenue.totalBagsOrdered);

  // Previous quarter's net profit, needed for the NPV growth assumption.
  const prevRevenue = computeRevenueAndVariability(previousInvoices, quarterMonths(prev.year, prev.quarter));
  const prevProfitRoi = computeProfitAndROI(ledger, assets, batches, quarterMonths(prev.year, prev.quarter), prevRevenue.totalRevenue, prevRevenue.promoExpense);

  const npv = computeForwardNPV({
    currentNetProfit: profitRoi.netProfit,
    previousNetProfit: prevProfitRoi.netProfit,
    annualDiscountRate: discountRateInfo.rate,
  });

  return {
    year,
    quarter,
    label: quarterLabel(year, quarter),
    months,
    previousQuarterLabel: quarterLabel(prev.year, prev.quarter),
    revenue,
    profitRoi,
    marginal,
    bcgMatrix,
    demandSupply,
    npv,
    discountRateInfo,
    generatedAt: new Date().toISOString(),
  };
}

async function buildAnnualAnalysis({ AppData, ProductionBatch: _unused }, { year, discountRateInfo }) {
  const months = yearMonths(year);
  const { invoices } = await loadYearInvoices(AppData, year);
  const { ledger, assets } = await loadAccountingData(AppData);
  const batches = await loadProductionBatches(AppData);

  // Restrict the trend/marginal sections to months that actually saw
  // activity (see detectOperatingMonths above) — falls back to the full
  // 12 months for a normal, fully-operational year.
  const operatingMonths = detectOperatingMonths(invoices, batches, months);
  const trendMonths = operatingMonths.length ? operatingMonths : months;
  const partialYear = operatingMonths.length > 0 && operatingMonths.length < 12;

  const revenue = computeRevenueAndVariability(invoices, trendMonths);
  const profitRoi = computeProfitAndROI(ledger, assets, batches, months, revenue.totalRevenue, revenue.promoExpense);
  const marginal = computeMarginalAnalysis(batches, invoices, trendMonths);

  const prevYear = year - 1;
  const { invoices: prevInvoices } = await loadYearInvoices(AppData, prevYear);
  const bcgMatrix = computeCustomerPortfolioMatrix(invoices, prevInvoices);
  const demandSupply = computeDemandSupply(batches, months, revenue.totalBagsOrdered);

  // Previous year's net profit for the NPV growth assumption. For a
  // business's first operating year, prevInvoices will simply be empty —
  // computeProfitAndROI naturally returns 0, and computeForwardAnnualNPV
  // already treats a 0/falsy previousNetProfit as "no trend available,
  // assume flat continuation" (growthRate stays 0), so no special-casing
  // is needed here for the first-year scenario.
  const prevRevenue = computeRevenueAndVariability(prevInvoices, yearMonths(prevYear));
  const prevProfitRoi = computeProfitAndROI(ledger, assets, batches, yearMonths(prevYear), prevRevenue.totalRevenue, prevRevenue.promoExpense);

  const npv = computeForwardAnnualNPV({
    currentNetProfit: profitRoi.netProfit,
    previousNetProfit: prevProfitRoi.netProfit,
    annualDiscountRate: discountRateInfo.rate,
  });

  return {
    year,
    label: yearLabel(year),
    months,
    operatingMonths,
    partialYear,
    previousYearLabel: yearLabel(prevYear),
    revenue,
    profitRoi,
    marginal,
    bcgMatrix,
    demandSupply,
    npv,
    discountRateInfo,
    generatedAt: new Date().toISOString(),
  };
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
};