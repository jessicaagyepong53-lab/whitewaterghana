/* ═══════════════════════════════════════════════════════════════════
   AI ASSISTANT — server-side router  (v3)
   ───────────────────────────────────────────────────────────────────
   Same mount signature as v2 — this file is a drop-in replacement,
   server.js does not need to change again:

     const { mountAssistantRoutes } = require('./server/assistant');
     mountAssistantRoutes(app, {
       AppData, Invoice, Customer, InventoryItem, FactoryEquipment,
       User, StaffAction, SPECIAL_ACCESS_OVERRIDES, nowIso, createError,
     });

   WHAT'S NEW IN v3
   ─────────────────
   1. Token budget tracking. Anthropic bills per token, and this call
      pattern (tool loop → multiple API calls per person's message) can
      add up. Usage is tallied per billing period (daily by default,
      configurable) and persisted to AppData — so it survives a Render
      restart, unlike the in-memory conversation cache — with an atomic
      MongoDB pipeline update so concurrent requests can't undercount
      each other. At 90% of budget the reply carries a warning; at 100%
      new requests are rejected outright (before ever calling Anthropic,
      so a maxed-out budget can't be exceeded further) with the exact
      time the budget resets.

   2. Sturdier error handling. Every external call (Anthropic, the two
      web-lookup APIs) now has an explicit timeout via AbortController
      rather than hanging indefinitely; usage tracking is wrapped so a
      transient Mongo hiccup degrades gracefully (the chat still works,
      just without a usage figure that turn) instead of failing the
      whole request; and error responses carry a `code` field so the
      frontend can react differently to "budget exceeded" vs "rate
      limited" vs "not configured" vs "upstream hiccup".

   ENV VARS
   ────────
   ANTHROPIC_API_KEY        required
   ASSISTANT_MODEL          optional, defaults to 'claude-sonnet-5'
   ASSISTANT_TOKEN_BUDGET   optional, defaults to 500000 (tokens per period)
   ASSISTANT_TOKEN_BUDGET_PERIOD   optional, 'daily' (default) or 'monthly'
   ═══════════════════════════════════════════════════════════════════ */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.ASSISTANT_MODEL || 'claude-sonnet-5';
const MAX_TOOL_ITERATIONS = 6;
const MAX_HISTORY_MESSAGES = 16;
const HISTORY_IDLE_TTL_MS = 30 * 60 * 1000;
const RATE_LIMIT_MAX = 25;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const WEB_LOOKUP_TIMEOUT_MS = 8000;
const ANTHROPIC_CALL_TIMEOUT_MS = 30000;

const TOKEN_BUDGET = Math.max(1000, Number(process.env.ASSISTANT_TOKEN_BUDGET) || 500000);
const TOKEN_BUDGET_PERIOD = String(process.env.ASSISTANT_TOKEN_BUDGET_PERIOD || 'daily').trim().toLowerCase() === 'monthly' ? 'monthly' : 'daily';
const TOKEN_WARNING_RATIO = 0.9;
const USAGE_APPDATA_KEY = 'ww_assistant_token_usage';

function mountAssistantRoutes(app, deps) {
  const {
    AppData,
    Invoice,
    Customer,
    InventoryItem,
    FactoryEquipment,
    User,
    StaffAction,
    SPECIAL_ACCESS_OVERRIDES = {},
    nowIso,
    createError,
  } = deps;

  if (!AppData || !Invoice || !Customer || !InventoryItem || !FactoryEquipment) {
    throw new Error('mountAssistantRoutes: missing required dependencies (AppData, Invoice, Customer, InventoryItem, FactoryEquipment)');
  }

  const conversations = new Map(); // userId -> { messages, updatedAt }
  const rateLimits = new Map(); // userId -> timestamps[]

  function makeError(status, message, code) {
    const err = createError ? createError(status, message) : new Error(message);
    if (code) err.code = code;
    return err;
  }

  /* ── Access control ─────────────────────────────────────────────── */

  function effectiveRoles(user) {
    const overrideRoles = SPECIAL_ACCESS_OVERRIDES[String(user.email || '').toLowerCase()] || [];
    return Array.from(new Set([String(user.role || '').trim().toLowerCase(), ...overrideRoles]));
  }

  function isCeoOrManager(user) {
    const roles = effectiveRoles(user);
    return roles.includes('ceo') || roles.includes('manager');
  }

  function ensureAssistantAccess(req, res, next) {
    if (!req.user) { next(makeError(401, 'Authentication required', 'NOT_AUTHENTICATED')); return; }
    if (!isCeoOrManager(req.user)) {
      res.status(403).json({ message: 'The assistant is only available to CEO and Manager accounts.', code: 'FORBIDDEN_ROLE' });
      return;
    }
    next();
  }

  /* ── Shared helpers ──────────────────────────────────────────────── */

  function pruneIdleConversations() {
    const now = Date.now();
    for (const [userId, convo] of conversations.entries()) {
      if (now - convo.updatedAt > HISTORY_IDLE_TTL_MS) conversations.delete(userId);
    }
  }

  function checkRateLimit(userId) {
    const now = Date.now();
    const hits = (rateLimits.get(userId) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (hits.length >= RATE_LIMIT_MAX) return false;
    hits.push(now);
    rateLimits.set(userId, hits);
    return true;
  }

  function currentMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function shiftMonth(monthKey, delta) {
    const [y, m] = String(monthKey).split('-').map(Number);
    const d = new Date(y, (m - 1) + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthsBetween(startMonth, endMonth) {
    const out = [];
    let cursor = startMonth;
    let guard = 0;
    while (cursor <= endMonth && guard < 60) {
      out.push(cursor);
      cursor = shiftMonth(cursor, 1);
      guard += 1;
    }
    return out;
  }

  async function readSalesMonth(monthKey) {
    const doc = await AppData.findOne({ key: `ww_sales_${monthKey}` }).lean();
    const payload = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
    return {
      invoices: Array.isArray(payload.invoices) ? payload.invoices : [],
      salesOrders: Array.isArray(payload.salesOrders) ? payload.salesOrders : [],
    };
  }

  async function readAppDataKey(key, fallback) {
    const doc = await AppData.findOne({ key }).lean();
    return doc && doc.data !== undefined && doc.data !== null ? doc.data : fallback;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || WEB_LOOKUP_TIMEOUT_MS) : null;
    try {
      return await fetch(url, { ...options, signal: controller ? controller.signal : undefined });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ── Token budget tracking ───────────────────────────────────────── */
  // Persisted to AppData (survives restarts, unlike the in-memory maps
  // above) and updated with an atomic Mongo pipeline update so two
  // concurrent requests can't clobber each other's increment — the same
  // kind of race the login-lockout counter elsewhere in this app avoids
  // with $inc, just expressed as a pipeline since the period-rollover
  // logic (reset counts to zero when the day/month changes) needs a
  // conditional that a plain $inc can't express atomically.

  function periodKeyNow() {
    const now = new Date();
    if (TOKEN_BUDGET_PERIOD === 'monthly') {
      return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    return now.toISOString().slice(0, 10);
  }

  function nextResetAtIso() {
    const now = new Date();
    if (TOKEN_BUDGET_PERIOD === 'monthly') {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString();
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)).toISOString();
  }

  function warningLevelFor(percentUsed) {
    if (percentUsed >= 100) return 'exceeded';
    if (percentUsed >= TOKEN_WARNING_RATIO * 100) return 'warning';
    return 'none';
  }

  function usageSnapshot(usageData) {
    const totalTokens = Number(usageData && usageData.totalTokens) || 0;
    const percentUsed = TOKEN_BUDGET > 0 ? Math.min(999, +((totalTokens / TOKEN_BUDGET) * 100).toFixed(1)) : 0;
    return {
      period: TOKEN_BUDGET_PERIOD,
      budget: TOKEN_BUDGET,
      totalTokens,
      percentUsed,
      resetAt: nextResetAtIso(),
      warningLevel: warningLevelFor(percentUsed),
    };
  }

  // Read-only, safe to call even if it fails (caller decides fallback).
  async function readUsage() {
    const period = periodKeyNow();
    const doc = await AppData.findOne({ key: USAGE_APPDATA_KEY }).lean();
    const data = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
    if (data.period !== period) return { period, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return {
      period,
      inputTokens: Number(data.inputTokens) || 0,
      outputTokens: Number(data.outputTokens) || 0,
      totalTokens: Number(data.totalTokens) || 0,
    };
  }

  // Atomically adds tokens to the current period's counter, resetting
  // to zero first if the period has rolled over since the last write.
  async function addUsage(inputTokens, outputTokens) {
    const period = periodKeyNow();
    const addedTotal = (Number(inputTokens) || 0) + (Number(outputTokens) || 0);
    const updated = await AppData.findOneAndUpdate(
      { key: USAGE_APPDATA_KEY },
      [
        {
          $set: {
            key: USAGE_APPDATA_KEY,
            data: {
              $cond: [
                { $eq: [{ $ifNull: ['$data.period', null] }, period] },
                {
                  period,
                  inputTokens: { $add: [{ $ifNull: ['$data.inputTokens', 0] }, Number(inputTokens) || 0] },
                  outputTokens: { $add: [{ $ifNull: ['$data.outputTokens', 0] }, Number(outputTokens) || 0] },
                  totalTokens: { $add: [{ $ifNull: ['$data.totalTokens', 0] }, addedTotal] },
                },
                {
                  period,
                  inputTokens: Number(inputTokens) || 0,
                  outputTokens: Number(outputTokens) || 0,
                  totalTokens: addedTotal,
                },
              ],
            },
          },
        },
      ],
      { upsert: true, new: true }
    ).lean();
    return updated && updated.data ? updated.data : { period, inputTokens, outputTokens, totalTokens: addedTotal };
  }

  /* ── Tool definitions ───────────────────────────────────────────── */

  const TOOLS = [
    {
      name: 'get_business_snapshot',
      description: 'Top-line snapshot: all-time revenue, outstanding invoice value, units produced, low-stock item count, pending approvals count.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const [revenueAgg, outstandingAgg, lowStock] = await Promise.all([
          Invoice.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
          Invoice.aggregate([{ $match: { status: { $ne: 'Paid' } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
          InventoryItem.countDocuments({ status: { $in: ['LOW', 'CRITICAL', 'OUT OF STOCK'] } }),
        ]);
        return {
          totalInvoicedAllTime: revenueAgg[0]?.total || 0,
          outstandingInvoiceValue: outstandingAgg[0]?.total || 0,
          itemsLowOrCriticalStock: lowStock,
          currency: 'GH\u20B5',
          note: 'For actual sales revenue by month, prefer get_sales_summary or get_revenue_vs_expense_by_month.',
        };
      },
    },
    {
      name: 'get_low_stock_items',
      description: 'List raw materials or finished goods at LOW, CRITICAL, or OUT OF STOCK status.',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Max rows (default 20, max 50).' } },
        additionalProperties: false,
      },
      async run({ limit }) {
        const cap = Math.min(50, Math.max(1, Number(limit) || 20));
        const rows = await InventoryItem.find({ status: { $in: ['LOW', 'CRITICAL', 'OUT OF STOCK'] } })
          .sort({ status: 1, name: 1 }).limit(cap).lean();
        return rows.map((r) => ({ name: r.name, category: r.category, quantity: r.quantity, unit: r.unit, reorderLevel: r.reorder_level, status: r.status }));
      },
    },
    {
      name: 'get_sales_summary',
      description: 'Aggregate invoice totals for one month (YYYY-MM) or across all recorded months if omitted: invoice count, total revenue, paid revenue, unpaid count.',
      input_schema: {
        type: 'object',
        properties: { month: { type: 'string', description: 'Optional YYYY-MM. Omit for all-time.' } },
        additionalProperties: false,
      },
      async run({ month }) {
        let query = { key: /^ww_sales_\d{4}-\d{2}$/ };
        if (month && /^\d{4}-\d{2}$/.test(String(month))) query = { key: `ww_sales_${month}` };
        const docs = await AppData.find(query).lean();
        let totalInvoices = 0, totalRevenue = 0, paidRevenue = 0, unpaidCount = 0;
        for (const doc of docs) {
          const payload = doc.data && typeof doc.data === 'object' ? doc.data : {};
          const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
          totalInvoices += invoices.length;
          for (const inv of invoices) {
            const amount = Number(inv && inv.amount) || 0;
            totalRevenue += amount;
            if (inv && (inv.status === 'paid' || inv.payment === 'paid')) paidRevenue += amount;
            else unpaidCount += 1;
          }
        }
        return { scope: month || 'all-time', totalInvoices, totalRevenue, paidRevenue, unpaidCount, currency: 'GH\u20B5' };
      },
    },
    {
      name: 'get_pending_or_overdue_invoices',
      description: 'List invoices that are pending, overdue, or awaiting approval, with customer and amount.',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Max rows (default 25, max 60).' } },
        additionalProperties: false,
      },
      async run({ limit }) {
        const cap = Math.min(60, Math.max(1, Number(limit) || 25));
        const rows = await Invoice.find({ status: { $in: ['Pending', 'Overdue', 'pending_approval'] } })
          .populate('customer_id').sort({ due_date: 1 }).limit(cap).lean();
        return rows.map((r) => ({ invoiceCode: r.invoice_code, customer: r.customer_id?.name || 'Unknown', amount: r.amount, status: r.status, dueDate: r.due_date }));
      },
    },
    {
      name: 'get_sales_comparison',
      description: 'Compare a month\u2019s sales performance against the prior month: invoice count, revenue, average order value, bags sold, promo bags, unique customers, pending/overdue counts. Use this to reason about WHY a month\u2019s sales were up or down.',
      input_schema: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM. Defaults to the current month.' } },
        additionalProperties: false,
      },
      async run({ month }) {
        const targetMonth = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : currentMonthKey();
        const prevMonth = shiftMonth(targetMonth, -1);

        const summarize = async (monthKey) => {
          const { invoices } = await readSalesMonth(monthKey);
          const paid = invoices.filter((i) => i && i.status === 'paid');
          const bags = invoices.reduce((s, i) => s + (Number(i?.items?.[0]?.qty) || 0), 0);
          const promo = invoices.reduce((s, i) => s + (Number(i?.promo) || 0), 0);
          const customers = new Set(invoices.map((i) => String(i?.customer || '').trim().toLowerCase()).filter(Boolean));
          const revenue = paid.reduce((s, i) => s + (Number(i.amount) || 0), 0);
          return {
            month: monthKey,
            invoiceCount: invoices.length,
            paidInvoiceCount: paid.length,
            pendingCount: invoices.filter((i) => i && (i.status === 'pending' || i.status === 'pending_approval')).length,
            overdueCount: invoices.filter((i) => i && i.status === 'overdue').length,
            totalRevenuePaid: revenue,
            averageOrderValue: paid.length ? +(revenue / paid.length).toFixed(2) : 0,
            totalBagsSold: bags,
            promoBags: promo,
            uniqueCustomers: customers.size,
          };
        };

        const [currentStats, previousStats] = await Promise.all([summarize(targetMonth), summarize(prevMonth)]);
        const pctChange = (a, b) => (b === 0 ? (a === 0 ? 0 : null) : +(((a - b) / b) * 100).toFixed(1));
        return {
          current: currentStats,
          previous: previousStats,
          revenueChangePercent: pctChange(currentStats.totalRevenuePaid, previousStats.totalRevenuePaid),
          invoiceCountChangePercent: pctChange(currentStats.invoiceCount, previousStats.invoiceCount),
          currency: 'GH\u20B5',
          guidance: 'When explaining a change, cite the specific deltas above rather than a generic explanation. If the data doesn\u2019t clearly point to a cause, say so plainly instead of speculating.',
        };
      },
    },
    {
      name: 'get_revenue_vs_expense_by_month',
      description: 'Revenue (paid invoices) vs. expenses (general ledger expense entries) for a range of months. Use this when the person wants a chart/graph of revenue against expenditure.',
      input_schema: {
        type: 'object',
        properties: {
          startMonth: { type: 'string', description: 'YYYY-MM. Defaults to 5 months before endMonth.' },
          endMonth: { type: 'string', description: 'YYYY-MM. Defaults to the current month.' },
        },
        additionalProperties: false,
      },
      async run({ startMonth, endMonth }) {
        const end = /^\d{4}-\d{2}$/.test(String(endMonth || '')) ? endMonth : currentMonthKey();
        const start = /^\d{4}-\d{2}$/.test(String(startMonth || '')) ? startMonth : shiftMonth(end, -5);
        const months = monthsBetween(start, end);

        const accountingData = await readAppDataKey('ww_accounting_data_v2', { ledger: [] });
        const ledger = Array.isArray(accountingData.ledger) ? accountingData.ledger : [];

        const revenueByMonth = {};
        const expenseByMonth = {};
        for (const m of months) { revenueByMonth[m] = 0; expenseByMonth[m] = 0; }

        for (const m of months) {
          const { invoices } = await readSalesMonth(m);
          revenueByMonth[m] = invoices.filter((i) => i && i.status === 'paid').reduce((s, i) => s + (Number(i.amount) || 0), 0);
        }

        for (const entry of ledger) {
          const date = String(entry && entry.date || '').trim();
          const monthKey = date.slice(0, 7);
          if (!Object.prototype.hasOwnProperty.call(expenseByMonth, monthKey)) continue;
          if (String(entry.type || '').toLowerCase() !== 'expense') continue;
          expenseByMonth[monthKey] += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
        }

        return {
          months,
          revenue: months.map((m) => Math.round(revenueByMonth[m] * 100) / 100),
          expense: months.map((m) => Math.round(expenseByMonth[m] * 100) / 100),
          currency: 'GH\u20B5',
          source: 'revenue = paid invoices per Sales & Invoicing month buckets; expense = General Ledger entries of type "expense" (Accounting page).',
        };
      },
    },
    {
      name: 'get_expense_breakdown',
      description: 'Expense totals grouped by ledger account/category for one month (or all-time if omitted). Good for "what are we spending the most on" questions.',
      input_schema: {
        type: 'object',
        properties: { month: { type: 'string', description: 'Optional YYYY-MM. Omit for all recorded months.' } },
        additionalProperties: false,
      },
      async run({ month }) {
        const accountingData = await readAppDataKey('ww_accounting_data_v2', { ledger: [] });
        const ledger = Array.isArray(accountingData.ledger) ? accountingData.ledger : [];
        const scoped = ledger.filter((e) => {
          if (String(e && e.type || '').toLowerCase() !== 'expense') return false;
          if (!month) return true;
          return String(e.date || '').slice(0, 7) === month;
        });
        const byAccount = new Map();
        for (const e of scoped) {
          const acct = String(e.account || 'Other').trim() || 'Other';
          const amount = (Number(e.debit) || 0) - (Number(e.credit) || 0);
          byAccount.set(acct, (byAccount.get(acct) || 0) + amount);
        }
        const rows = [...byAccount.entries()].map(([account, amount]) => ({ account, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
        const total = rows.reduce((s, r) => s + r.amount, 0);
        return { scope: month || 'all-time', total: Math.round(total * 100) / 100, byAccount: rows, currency: 'GH\u20B5' };
      },
    },
    {
      name: 'get_purchase_summary',
      description: 'Purchase order status counts, spend by vendor, and open orders. Optional month filter (YYYY-MM, by order date).',
      input_schema: {
        type: 'object',
        properties: { month: { type: 'string', description: 'Optional YYYY-MM.' } },
        additionalProperties: false,
      },
      async run({ month }) {
        const purchaseData = await readAppDataKey('ww_purchase_data_v2', { purchaseOrders: [], suppliers: [] });
        const orders = (Array.isArray(purchaseData.purchaseOrders) ? purchaseData.purchaseOrders : [])
          .filter((po) => !month || String(po?.date || '').slice(0, 7) === month);
        const total = (po) => Array.isArray(po.items) && po.items.length
          ? po.items.reduce((s, i) => s + ((Number(i.qty) || 0) * (Number(i.unitCost) || 0)), 0)
          : (Number(po.amount) || 0);
        const byVendor = new Map();
        const byStatus = {};
        let grandTotal = 0;
        for (const po of orders) {
          const amt = total(po);
          grandTotal += amt;
          byVendor.set(po.supplier || 'Unknown', (byVendor.get(po.supplier || 'Unknown') || 0) + amt);
          const status = String(po.status || 'unknown');
          byStatus[status] = (byStatus[status] || 0) + 1;
        }
        return {
          scope: month || 'all-time',
          orderCount: orders.length,
          totalSpend: Math.round(grandTotal * 100) / 100,
          byStatus,
          topVendorsBySpend: [...byVendor.entries()].map(([supplier, amount]) => ({ supplier, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount).slice(0, 8),
          currency: 'GH\u20B5',
        };
      },
    },
    {
      name: 'get_production_summary',
      description: 'Production batch totals: units produced, batch count, cost, grouped by product. Optional month filter (YYYY-MM).',
      input_schema: {
        type: 'object',
        properties: { month: { type: 'string', description: 'Optional YYYY-MM.' } },
        additionalProperties: false,
      },
      async run({ month }) {
        const batches = await readAppDataKey('ww_production_batches', []);
        const scoped = (Array.isArray(batches) ? batches : []).filter((b) => !month || String(b?.date || '').slice(0, 7) === month);
        const byProduct = new Map();
        let totalUnits = 0, totalCost = 0;
        for (const b of scoped) {
          const qty = Number(b.qty) || 0;
          const cost = Number(b.cost) || 0;
          totalUnits += qty;
          totalCost += cost;
          const key = b.product || 'Unknown';
          const prev = byProduct.get(key) || { product: key, units: 0, cost: 0, batches: 0 };
          prev.units += qty;
          prev.cost += cost;
          prev.batches += 1;
          byProduct.set(key, prev);
        }
        return {
          scope: month || 'all-time',
          batchCount: scoped.length,
          totalUnits,
          totalCost: Math.round(totalCost * 100) / 100,
          byProduct: [...byProduct.values()].map((p) => ({ ...p, cost: Math.round(p.cost * 100) / 100 })),
          currency: 'GH\u20B5',
        };
      },
    },
    {
      name: 'get_equipment_status',
      description: 'Factory equipment status: operational count vs. machines needing repair or faulty, with details on which ones.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const rows = await FactoryEquipment.find().sort({ code: 1 }).lean();
        const problems = rows.filter((r) => ['needs_repair', 'faulty', 'faulty_needs_repair'].includes(r.status));
        return {
          totalMachines: rows.length,
          operational: rows.filter((r) => r.status === 'operational').length,
          needingAttention: problems.map((r) => ({ code: r.code, equipment: r.equipment, status: r.status, nextMaintenance: r.nextMaintenance })),
        };
      },
    },
    {
      name: 'search_customer',
      description: 'Find a customer by partial name match; returns type, status, order count, outstanding balance.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Full or partial customer name.' } },
        required: ['name'],
        additionalProperties: false,
      },
      async run({ name }) {
        const query = String(name || '').trim();
        if (!query) return { matches: [] };
        const rows = await Customer.find({ name: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).limit(10).lean();
        return { matches: rows.map((r) => ({ name: r.name, type: r.type, status: r.status, totalOrders: r.total_orders, outstanding: r.outstanding })) };
      },
    },
    {
      name: 'get_tax_records_summary',
      description: 'Tax records: total due, overdue count, and upcoming due dates.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const records = await readAppDataKey('ww_tax_records', []);
        const rows = Array.isArray(records) ? records : [];
        const open = rows.filter((r) => r && r.status !== 'Paid');
        const overdue = rows.filter((r) => r && r.status === 'Overdue');
        return {
          totalDue: Math.round(open.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100,
          overdueCount: overdue.length,
          upcoming: open.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(0, 8).map((r) => ({ type: r.type, period: r.period, amount: r.amount, dueDate: r.dueDate, status: r.status })),
          currency: 'GH\u20B5',
        };
      },
    },
    {
      name: 'get_staff_actions_summary',
      description: 'Recent add/edit/delete actions performed by Staff or Supervisor accounts, for oversight questions like "what has the team been doing".',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Max rows (default 15, max 40).' } },
        additionalProperties: false,
      },
      async run({ limit }) {
        if (!StaffAction) return { available: false, note: 'StaffAction model was not provided to the assistant router.' };
        const cap = Math.min(40, Math.max(1, Number(limit) || 15));
        const rows = await StaffAction.find().sort({ timestamp: -1 }).limit(cap).lean();
        return rows.map((r) => ({ action: r.action, module: r.module, userName: r.userName, userRole: r.userRole, timestamp: r.timestamp }));
      },
    },
    {
      name: 'get_users_overview',
      description: 'System users: name, role, status, last login. No credentials of any kind are ever returned.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        if (!User) return { available: false, note: 'User model was not provided to the assistant router.' };
        const rows = await User.find({}, 'name email role status last_login').lean();
        return rows.map((r) => ({ name: r.name, email: r.email, role: r.role, status: r.status, lastLogin: r.last_login }));
      },
    },
    {
      name: 'look_up_definition',
      description: 'Look up the definition of a word or business/accounting term using public web references, for use ONLY when the term isn\u2019t something you can answer from general knowledge and isn\u2019t part of this system\u2019s own data.',
      input_schema: {
        type: 'object',
        properties: { term: { type: 'string', description: 'The word or phrase to define.' } },
        required: ['term'],
        additionalProperties: false,
      },
      async run({ term }) {
        const query = String(term || '').trim();
        if (!query) return { found: false };
        const results = {};

        try {
          const dictRes = await fetchWithTimeout(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(query)}`, {}, WEB_LOOKUP_TIMEOUT_MS);
          if (dictRes.ok) {
            const dictJson = await dictRes.json();
            const first = Array.isArray(dictJson) ? dictJson[0] : null;
            const firstMeaning = first && Array.isArray(first.meanings) ? first.meanings[0] : null;
            const firstDef = firstMeaning && Array.isArray(firstMeaning.definitions) ? firstMeaning.definitions[0] : null;
            if (firstDef && firstDef.definition) {
              results.dictionary = { partOfSpeech: firstMeaning.partOfSpeech, definition: firstDef.definition, example: firstDef.example || null };
            }
          }
        } catch (_e) { /* fall through to Wikipedia; a failed lookup here is not fatal to the whole reply */ }

        try {
          const wikiRes = await fetchWithTimeout(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {}, WEB_LOOKUP_TIMEOUT_MS);
          if (wikiRes.ok) {
            const wikiJson = await wikiRes.json();
            if (wikiJson && wikiJson.extract) {
              results.encyclopedia = { title: wikiJson.title, summary: wikiJson.extract, sourceUrl: wikiJson.content_urls?.desktop?.page || null };
            }
          }
        } catch (_e) { /* no encyclopedia result either \u2014 the tool still returns found:false cleanly */ }

        return { found: Object.keys(results).length > 0, term: query, ...results };
      },
    },
  ];

  function buildSystemPrompt(user, pageContext) {
    return [
      'You are the internal AI Assistant for White Water Wells Ltd\u2019s factory management system, available only to CEO and Manager accounts because it has visibility across every module.',
      `The person you\u2019re talking to is ${user.name || user.email} (${String(user.role || '').toUpperCase()}).`,
      pageContext ? `They are currently viewing the "${pageContext}" page.` : '',
      `Today\u2019s date is ${new Date().toISOString().slice(0, 10)}. Resolve relative or partial dates (e.g. "April", "last month") against this.`,
      '',
      'RULES:',
      '- State only figures you retrieved via a tool call this turn. Never estimate or invent a number.',
      '- When asked "why" something happened (e.g. why sales were down), call get_sales_comparison or another relevant tool, then explain using the specific deltas it returns. If the data doesn\u2019t clearly explain it, say that plainly instead of guessing at a cause.',
      '- If a question is about a general term, concept, or definition that is NOT part of this business\u2019s own data, call look_up_definition rather than answering from memory alone, and say the definition came from the web (cite the source briefly).',
      '- You cannot create, edit, or delete any record in this system. If asked to make a change, say so and point to the relevant page.',
      '',
      'CHARTS: when the person asks for a chart, graph, or visual comparison, first call the tool that has the numbers, then write a short prose summary, and end the reply with exactly one fenced block in this exact format:',
      '```chart',
      '{"type":"bar","title":"Revenue vs Expenditure","labels":["2026-03","2026-04"],"datasets":[{"label":"Revenue","data":[12000,15500]},{"label":"Expenditure","data":[9000,9800]}]}',
      '```',
      'Valid "type" values: bar, line, pie, doughnut. Only emit this block when you actually have tool-sourced numbers to put in it.',
    ].filter(Boolean).join('\n');
  }

  async function callAnthropic({ system, messages, tools }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw makeError(503, 'Assistant is not configured \u2014 an admin needs to add ANTHROPIC_API_KEY.', 'NOT_CONFIGURED');

    let res;
    try {
      res = await fetchWithTimeout(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: 1400,
          system,
          messages,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        }),
      }, ANTHROPIC_CALL_TIMEOUT_MS);
    } catch (networkErr) {
      if (networkErr && networkErr.name === 'AbortError') {
        throw makeError(504, 'The assistant took too long to respond. Please try again.', 'UPSTREAM_TIMEOUT');
      }
      throw makeError(502, 'Could not reach the assistant service. Please try again shortly.', 'UPSTREAM_NETWORK_ERROR');
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch (_e) { /* ignore parse failure */ }
      if (res.status === 401) throw makeError(503, 'Assistant API key was rejected \u2014 an admin needs to check ANTHROPIC_API_KEY.', 'NOT_CONFIGURED');
      if (res.status === 429) throw makeError(429, 'The assistant provider is rate-limiting requests right now. Please wait a moment and try again.', 'UPSTREAM_RATE_LIMITED');
      throw makeError(502, `Assistant upstream error (${res.status})${detail ? ': ' + detail : ''}.`, 'UPSTREAM_ERROR');
    }
    return res.json();
  }

  app.post('/api/assistant/chat', ensureAssistantAccess, async (req, res, next) => {
    try {
      pruneIdleConversations();
      const userId = String(req.user.id || req.user._id || req.user.email);

      if (!checkRateLimit(userId)) {
        res.status(429).json({ message: 'Too many assistant messages in a short time. Please wait a moment and try again.', code: 'RATE_LIMITED' });
        return;
      }

      const userMessage = String(req.body && req.body.message || '').trim();
      const pageContext = String(req.body && req.body.page || '').trim();
      if (!userMessage) { res.status(400).json({ message: 'message is required', code: 'BAD_REQUEST' }); return; }
      if (userMessage.length > 2000) { res.status(400).json({ message: 'Message is too long (2000 character limit).', code: 'MESSAGE_TOO_LONG' }); return; }

      // Budget check BEFORE calling Anthropic at all — a maxed-out budget
      // can't be exceeded further, and we don't spend a call just to find
      // out we're blocked.
      let usageBefore;
      try {
        usageBefore = usageSnapshot(await readUsage());
      } catch (_usageErr) {
        usageBefore = null; // fail open: a usage-read hiccup shouldn't block the assistant
      }
      if (usageBefore && usageBefore.warningLevel === 'exceeded') {
        res.status(429).json({
          message: `The assistant\u2019s ${TOKEN_BUDGET_PERIOD} token budget is fully used. It resets at ${usageBefore.resetAt}.`,
          code: 'TOKEN_BUDGET_EXCEEDED',
          usage: usageBefore,
        });
        return;
      }

      const convo = conversations.get(userId) || { messages: [], updatedAt: Date.now() };
      convo.messages.push({ role: 'user', content: userMessage });
      convo.messages = convo.messages.slice(-MAX_HISTORY_MESSAGES);

      const system = buildSystemPrompt(req.user, pageContext);
      let workingMessages = convo.messages.map((m) => ({ role: m.role, content: m.content }));
      let finalText = '';
      let turnInputTokens = 0;
      let turnOutputTokens = 0;

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const data = await callAnthropic({ system, messages: workingMessages, tools: TOOLS });
        turnInputTokens += Number(data?.usage?.input_tokens) || 0;
        turnOutputTokens += Number(data?.usage?.output_tokens) || 0;

        const toolUseBlocks = (data.content || []).filter((b) => b.type === 'tool_use');
        const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

        if (!toolUseBlocks.length) { finalText = textBlocks; break; }

        workingMessages.push({ role: 'assistant', content: data.content });
        const toolResultContent = [];
        for (const block of toolUseBlocks) {
          const tool = TOOLS.find((t) => t.name === block.name);
          let resultPayload;
          try {
            resultPayload = tool ? await tool.run(block.input || {}) : { error: 'Unknown tool.' };
          } catch (_toolErr) {
            resultPayload = { error: 'This lookup failed. Please try rephrasing or try again shortly.' };
          }
          toolResultContent.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(resultPayload) });
        }
        workingMessages.push({ role: 'user', content: toolResultContent });

        if (iteration === MAX_TOOL_ITERATIONS - 1) {
          finalText = textBlocks || 'I gathered the data but ran out of steps to summarize it \u2014 please ask again.';
        }
      }

      convo.messages.push({ role: 'assistant', content: finalText || 'I\u2019m not sure how to answer that from the data I have access to.' });
      convo.messages = convo.messages.slice(-MAX_HISTORY_MESSAGES);
      convo.updatedAt = Date.now();
      conversations.set(userId, convo);

      let usageAfter = usageBefore;
      try {
        usageAfter = usageSnapshot(await addUsage(turnInputTokens, turnOutputTokens));
      } catch (_usageErr) {
        // Usage tracking failed to persist this turn \u2014 the chat reply itself
        // already succeeded, so we still return it; the usage figure just
        // won't reflect this turn until the next successful write.
      }

      res.json({
        reply: finalText,
        timestamp: nowIso ? nowIso() : new Date().toISOString(),
        usage: usageAfter,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/assistant/usage', ensureAssistantAccess, async (_req, res, next) => {
    try {
      res.json({ usage: usageSnapshot(await readUsage()) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/assistant/reset', ensureAssistantAccess, (req, res) => {
    conversations.delete(String(req.user.id || req.user._id || req.user.email));
    res.json({ ok: true });
  });
}

module.exports = { mountAssistantRoutes };