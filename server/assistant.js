/* ═══════════════════════════════════════════════════════════════════
   AI ASSISTANT — backend routes & tool runtime  (v5)
   ───────────────────────────────────────────────────────────────────
   Mounted once from server.js:

     const { mountAssistantRoutes } = require('./server/assistant');
     mountAssistantRoutes(app, {
       AppData, Invoice, Customer, InventoryItem, FactoryEquipment,
       User, StaffAction, SPECIAL_ACCESS_OVERRIDES, nowIso, createError,
     });

   Must be mounted AFTER `app.use(attachUser)` so `req.user` is populated.

   WHAT'S NEW IN v5
   ─────────────────
   1. Fully persistent conversation history, stored in AppData (not
      in-memory) under `ww_assistant_conversations_<sanitizedUserId>`.
      Conversations survive server restarts/redeploys and are never
      auto-deleted — only an explicit user action removes one.
   2. Projects — lightweight folders for grouping conversations, stored
      under `ww_assistant_projects_<sanitizedUserId>`. Deleting a
      project reassigns its conversations to "General" rather than
      deleting them.
   3. Image generation via OpenAI's image endpoint (gpt-image-1, with
      graceful fallback to dall-e-3 if the account isn't enabled for
      it), gated by a separate per-user daily cap tracked with an
      atomic AppData counter (`ww_assistant_image_usage_v1_<user>`),
      independent of the token budget below. Runs two ways:
        a) Inline in chat: the model emits a fenced ```image block
           (a JSON prompt spec) which this file detects, strips out of
           the prose, and turns into a real generated image server-side
           before the reply goes back to the client.
        b) Direct: POST /api/assistant/image, used by a dedicated
           "Generate image" action in the sidebar.
   4. Topic-scope guard: the system prompt instructs the model to
      decline anything unrelated to the water factory business with an
      exact, friendly one-liner, so off-topic questions never consume
      tool calls or leak unrelated behaviour.
   5. Persisted token-budget tracking (carried over from v3/v4) so a
      runaway conversation can't blow through the day's OpenAI spend
      unnoticed — soft warning at 90%, hard block at 100% with the
      exact reset time.
   6. Typed error codes on every failure path, so the frontend can show
      an accurate message instead of one generic "something went
      wrong": FORBIDDEN_ROLE, NOT_CONFIGURED, TOKEN_BUDGET_EXCEEDED,
      IMAGE_BUDGET_EXCEEDED, UPSTREAM_RATE_LIMITED, UPSTREAM_TIMEOUT,
      UPSTREAM_ERROR, CONVERSATION_NOT_FOUND, PROJECT_NOT_FOUND,
      VALIDATION_ERROR.

   DATA IT READS
   ─────────────
   AppData is the source of truth for sales, accounting, purchasing,
   and production data (see README §4) — this module reads AppData
   keys directly (ww_sales_YYYY-MM, ww_accounting_data_v2,
   ww_purchase_data_v2, ww_raw_materials, ww_finished_products,
   ww_production_batches, ww_tax_records) rather than the legacy
   Mongoose collections for that data. Customers, factory equipment,
   users, and staff-action history still come from their Mongoose
   models, which remain authoritative for those.
   ═══════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

/* ─────────────────────────────────────────────────────────────────
   CONFIG
   ───────────────────────────────────────────────────────────────── */

const ASSISTANT_ALLOWED_ROLES = ['ceo', 'manager'];

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const OPENAI_CHAT_MODEL = process.env.ASSISTANT_CHAT_MODEL || 'gpt-4o-mini';
const OPENAI_IMAGE_MODEL = process.env.ASSISTANT_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_IMAGE_MODEL_FALLBACK = 'dall-e-3';
const OPENAI_TIMEOUT_MS = Number(process.env.ASSISTANT_TIMEOUT_MS || 30000);
const MAX_TOOL_ITERATIONS = 6;

const TOKEN_BUDGET_DAILY_LIMIT = Number(process.env.ASSISTANT_DAILY_TOKEN_LIMIT || 250000);
const TOKEN_BUDGET_WARNING_PCT = 90;
const TOKEN_BUDGET_KEY = 'ww_assistant_token_budget_v1';

const IMAGE_DAILY_CAP = Number(process.env.ASSISTANT_IMAGE_DAILY_CAP || 8);

const CONVERSATION_TITLE_MAX_LEN = 60;
const CONVERSATIONS_LIST_LIMIT = 200;

/* ─────────────────────────────────────────────────────────────────
   SMALL HELPERS
   ───────────────────────────────────────────────────────────────── */

function sanitizeKeyPart(value) {
  return String(value || 'anon').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80) || 'anon';
}

function conversationsKeyFor(userId) {
  return `ww_assistant_conversations_v1_${sanitizeKeyPart(userId)}`;
}

function projectsKeyFor(userId) {
  return `ww_assistant_projects_v1_${sanitizeKeyPart(userId)}`;
}

function imageUsageKeyFor(userId) {
  return `ww_assistant_image_usage_v1_${sanitizeKeyPart(userId)}`;
}

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function truncateTitle(text) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return 'New conversation';
  return clean.length > CONVERSATION_TITLE_MAX_LEN
    ? `${clean.slice(0, CONVERSATION_TITLE_MAX_LEN - 1)}\u2026`
    : clean;
}

function isAssistantRole(user, specialAccessOverrides) {
  if (!user) return false;
  const role = String(user.role || '').trim().toLowerCase();
  const overrides = (specialAccessOverrides && specialAccessOverrides[String(user.email || '').toLowerCase()]) || [];
  const effectiveRoles = Array.from(new Set([role, ...overrides]));
  return ASSISTANT_ALLOWED_ROLES.some((r) => effectiveRoles.includes(r));
}

function toIsoMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

/* ─────────────────────────────────────────────────────────────────
   GENERIC APPDATA READ/WRITE (small wrapper around the existing
   `{ key, data }` collection so this file reads cleanly)
   ───────────────────────────────────────────────────────────────── */

async function readAppData(AppData, key, fallback) {
  const doc = await AppData.findOne({ key }).lean();
  if (!doc || doc.data === null || doc.data === undefined) return fallback;
  return doc.data;
}

async function writeAppData(AppData, key, data) {
  await AppData.updateOne({ key }, { key, data }, { upsert: true });
}

/* ─────────────────────────────────────────────────────────────────
   CONVERSATION + PROJECT STORE
   ───────────────────────────────────────────────────────────────── */

async function loadConversations(AppData, userId) {
  const data = await readAppData(AppData, conversationsKeyFor(userId), { conversations: [] });
  return Array.isArray(data.conversations) ? data.conversations : [];
}

async function saveConversations(AppData, userId, conversations) {
  await writeAppData(AppData, conversationsKeyFor(userId), { conversations });
}

async function loadProjects(AppData, userId) {
  const data = await readAppData(AppData, projectsKeyFor(userId), { projects: [] });
  return Array.isArray(data.projects) ? data.projects : [];
}

async function saveProjects(AppData, userId, projects) {
  await writeAppData(AppData, projectsKeyFor(userId), { projects });
}

function conversationSummary(conv) {
  return {
    id: conv.id,
    title: conv.title || 'New conversation',
    projectId: conv.projectId || null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
  };
}

/* ─────────────────────────────────────────────────────────────────
   TOKEN BUDGET (persisted, resets daily at UTC midnight)
   ───────────────────────────────────────────────────────────────── */

async function readTokenBudget(AppData) {
  const doc = await AppData.findOne({ key: TOKEN_BUDGET_KEY }).lean();
  const dayKey = todayDateKey();
  const data = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
  if (data.dayKey !== dayKey) {
    return { dayKey, tokensUsed: 0 };
  }
  return { dayKey, tokensUsed: Number(data.tokensUsed || 0) };
}

async function addTokenUsage(AppData, tokensDelta) {
  const dayKey = todayDateKey();
  const existing = await AppData.findOne({ key: TOKEN_BUDGET_KEY }).lean();
  const existingData = existing && existing.data && typeof existing.data === 'object' ? existing.data : {};
  const carried = existingData.dayKey === dayKey ? Number(existingData.tokensUsed || 0) : 0;
  const nextUsed = carried + Math.max(0, Number(tokensDelta) || 0);
  await AppData.updateOne(
    { key: TOKEN_BUDGET_KEY },
    { key: TOKEN_BUDGET_KEY, data: { dayKey, tokensUsed: nextUsed } },
    { upsert: true },
  );
  return { dayKey, tokensUsed: nextUsed };
}

function buildUsagePayload(budget, imageUsage) {
  const percentUsed = TOKEN_BUDGET_DAILY_LIMIT > 0
    ? Math.min(999, Math.round((budget.tokensUsed / TOKEN_BUDGET_DAILY_LIMIT) * 100))
    : 0;
  let warningLevel = 'none';
  if (percentUsed >= 100) warningLevel = 'exceeded';
  else if (percentUsed >= TOKEN_BUDGET_WARNING_PCT) warningLevel = 'warning';

  const resetAt = new Date();
  resetAt.setUTCHours(24, 0, 0, 0);

  return {
    tokensUsed: budget.tokensUsed,
    tokensLimit: TOKEN_BUDGET_DAILY_LIMIT,
    percentUsed,
    warningLevel,
    period: 'day',
    resetAt: resetAt.toISOString(),
    images: imageUsage
      ? { used: imageUsage.count, cap: IMAGE_DAILY_CAP, resetAt: resetAt.toISOString() }
      : { used: 0, cap: IMAGE_DAILY_CAP, resetAt: resetAt.toISOString() },
  };
}

/* ─────────────────────────────────────────────────────────────────
   IMAGE DAILY CAP (atomic-ish counter, same pattern as login lockouts
   elsewhere in server.js: read-modify-write keyed by today's date)
   ───────────────────────────────────────────────────────────────── */

async function readImageUsage(AppData, userId) {
  const key = imageUsageKeyFor(userId);
  const doc = await AppData.findOne({ key }).lean();
  const dayKey = todayDateKey();
  const data = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
  if (data.dayKey !== dayKey) return { dayKey, count: 0 };
  return { dayKey, count: Number(data.count || 0) };
}

async function incrementImageUsage(AppData, userId) {
  const key = imageUsageKeyFor(userId);
  const dayKey = todayDateKey();
  const updated = await AppData.findOneAndUpdate(
    { key },
    [
      {
        $set: {
          key,
          data: {
            dayKey,
            count: {
              $cond: [
                { $eq: ['$data.dayKey', dayKey] },
                { $add: [{ $ifNull: ['$data.count', 0] }, 1] },
                1,
              ],
            },
          },
        },
      },
    ],
    { upsert: true, new: true },
  ).lean().catch(() => null);

  if (updated && updated.data) {
    return { dayKey: updated.data.dayKey, count: Number(updated.data.count || 0) };
  }

  // Fallback for drivers/environments where the pipeline-update form above
  // isn't supported: plain read-modify-write (fine at this low concurrency —
  // one user clicking "generate image" doesn't race itself meaningfully).
  const current = await readImageUsage(AppData, userId);
  const nextCount = current.count + 1;
  await AppData.updateOne(
    { key },
    { key, data: { dayKey, count: nextCount } },
    { upsert: true },
  );
  return { dayKey, count: nextCount };
}

/* ─────────────────────────────────────────────────────────────────
   FENCED-BLOCK CONTRACTS (```chart and ```image)
   ───────────────────────────────────────────────────────────────── */

const IMAGE_BLOCK_RE = /```image\s*([\s\S]*?)```/i;

function extractImageBlock(text) {
  const match = IMAGE_BLOCK_RE.exec(String(text || ''));
  if (!match) return { prose: text, imageSpec: null };
  let spec = null;
  try {
    spec = JSON.parse(match[1].trim());
  } catch (_e) {
    spec = { prompt: match[1].trim() };
  }
  const prose = String(text || '').replace(IMAGE_BLOCK_RE, '').trim();
  return { prose, imageSpec: spec };
}

/* ─────────────────────────────────────────────────────────────────
   EXPENSE CATEGORY NORMALIZATION
   Mirrors normalizeExpenseCategory() in src/script.js (Accounting page
   → Expense Distribution chart) so the assistant's category totals
   always agree with what's shown on screen. Keep these two in sync if
   either one changes.
   ───────────────────────────────────────────────────────────────── */

function toTitleCaseText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((word) => (word ? `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}` : word))
    .join(' ');
}

function normalizeExpenseCategory(rawCategory) {
  const raw = String(rawCategory || '').trim();
  if (!raw) return 'Other';
  const lower = raw.toLowerCase();
  if (lower.includes('salary') || lower.includes('wage') || lower.includes('payroll')) return 'Salaries';
  if (lower.includes('raw material') || lower.includes('material') || lower.includes('packaging')) return 'Raw Materials';
  if (lower.includes('electric') || lower.includes('power') || lower.includes('ecg')) return 'Electricity';
  if (lower.includes('water')) return 'Water Supply';
  if (lower.includes('maint') || lower.includes('repair') || lower.includes('servic')) return 'Maintenance';
  if (lower.includes('supply') || lower.includes('office')) return 'Supplies';
  if (lower === 'production') return 'Raw Materials';
  return toTitleCaseText(raw);
}

// Shared by get_accounting_summary (top 5 inline) and get_expense_breakdown
// (full list) so the two tools can never drift out of sync with each other.
function computeExpenseBreakdown(ledger, month) {
  const rows = (Array.isArray(ledger) ? ledger : [])
    .filter((e) => e && String(e.type || '').toLowerCase() === 'expense')
    .filter((e) => !month || String(e.date || '').startsWith(month));

  const totals = new Map();
  for (const entry of rows) {
    const category = normalizeExpenseCategory(entry.account || entry.desc || 'Other');
    const amount = (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
    if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) continue;
    totals.set(category, (totals.get(category) || 0) + amount);
  }

  const totalExpense = Array.from(totals.values()).reduce((sum, v) => sum + v, 0);
  const categories = Array.from(totals.entries())
    .map(([category, amount]) => ({
      category,
      amountGhs: Math.round(amount * 100) / 100,
      percent: totalExpense > 0 ? Math.round((amount / totalExpense) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amountGhs - a.amountGhs);

  return { totalExpenseGhs: Math.round(totalExpense * 100) / 100, categories };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─────────────────────────────────────────────────────────────────
   TOOL IMPLEMENTATIONS
   Each tool reads from AppData (source of truth for business data) or
   the Mongoose models passed in as deps, and returns a small plain
   object the model can reason over. Kept intentionally compact —
   the model does the narrative work, these just fetch facts.
   ───────────────────────────────────────────────────────────────── */

function buildToolRuntime(deps) {
  const { AppData, Invoice, Customer, InventoryItem, FactoryEquipment, User, StaffAction } = deps;

  async function getSalesMonthDocs(monthFilter) {
    const query = monthFilter
      ? { key: `ww_sales_${monthFilter}` }
      : { key: /^ww_sales_\d{4}-\d{2}$/ };
    return AppData.find(query).lean();
  }

  function paidInvoicesOf(payload) {
    const invoices = Array.isArray(payload && payload.invoices) ? payload.invoices : [];
    return invoices.filter((inv) => inv && String(inv.status || '').toLowerCase() === 'paid');
  }

  async function run_get_sales_summary({ month, year } = {}) {
    let docs;
    if (month) docs = await getSalesMonthDocs(month);
    else if (year) docs = (await getSalesMonthDocs()).filter((d) => d.key.startsWith(`ww_sales_${year}-`));
    else docs = await getSalesMonthDocs();

    let totalRevenue = 0;
    let paidCount = 0;
    let pendingCount = 0;
    let totalInvoices = 0;
    const months = [];

    for (const doc of docs) {
      const payload = doc.data && typeof doc.data === 'object' ? doc.data : {};
      const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
      const paid = paidInvoicesOf(payload);
      const monthRevenue = paid.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);
      totalRevenue += monthRevenue;
      paidCount += paid.length;
      pendingCount += invoices.length - paid.length;
      totalInvoices += invoices.length;
      months.push({
        month: doc.key.replace('ww_sales_', ''),
        invoices: invoices.length,
        paidInvoices: paid.length,
        revenue: Math.round(monthRevenue * 100) / 100,
      });
    }

    months.sort((a, b) => a.month.localeCompare(b.month));
    return {
      scope: month ? `month:${month}` : year ? `year:${year}` : 'all-time',
      totalInvoices,
      paidCount,
      pendingCount,
      totalRevenueGhs: Math.round(totalRevenue * 100) / 100,
      months,
    };
  }

  async function run_get_daily_sales_range({ month }) {
    if (!month) throw new Error('month (YYYY-MM) is required');
    const docs = await getSalesMonthDocs(month);
    const payload = docs[0] && docs[0].data && typeof docs[0].data === 'object' ? docs[0].data : {};
    const paid = paidInvoicesOf(payload);

    const byDay = new Map();
    for (const inv of paid) {
      const day = String(inv.date || '').slice(0, 10);
      if (!day) continue;
      byDay.set(day, (byDay.get(day) || 0) + (Number(inv.amount) || 0));
    }

    const days = Array.from(byDay.entries())
      .map(([date, amount]) => ({ date, amountGhs: Math.round(amount * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!days.length) {
      return { month, daysWithSales: 0, note: 'No paid invoices recorded for this month yet.' };
    }

    const sorted = [...days].sort((a, b) => a.amountGhs - b.amountGhs);
    const total = days.reduce((sum, d) => sum + d.amountGhs, 0);

    return {
      month,
      daysWithSales: days.length,
      lowestDay: sorted[0],
      highestDay: sorted[sorted.length - 1],
      averagePerActiveDayGhs: Math.round((total / days.length) * 100) / 100,
      totalGhs: Math.round(total * 100) / 100,
    };
  }

  async function run_get_weekly_sales_breakdown({ month }) {
    if (!month) throw new Error('month (YYYY-MM) is required');
    const docs = await getSalesMonthDocs(month);
    const payload = docs[0] && docs[0].data && typeof docs[0].data === 'object' ? docs[0].data : {};
    const paid = paidInvoicesOf(payload);

    function weekStart(dateStr) {
      const d = new Date(`${dateStr}T00:00:00`);
      const day = d.getDay();
      const mondayOffset = (day + 6) % 7;
      d.setDate(d.getDate() - mondayOffset);
      return d.toISOString().slice(0, 10);
    }

    const byWeek = new Map();
    for (const inv of paid) {
      const day = String(inv.date || '').slice(0, 10);
      if (!day) continue;
      const wk = weekStart(day);
      const bucket = byWeek.get(wk) || { revenueGhs: 0, invoices: 0 };
      bucket.revenueGhs += Number(inv.amount) || 0;
      bucket.invoices += 1;
      byWeek.set(wk, bucket);
    }

    const weeks = Array.from(byWeek.entries())
      .map(([weekStartDate, bucket]) => ({
        weekStart: weekStartDate,
        invoices: bucket.invoices,
        revenueGhs: Math.round(bucket.revenueGhs * 100) / 100,
      }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

    return { month, weeks };
  }

  async function run_get_monthly_performance_overview({ month }) {
    if (!month) throw new Error('month (YYYY-MM) is required');

    const [sales, weekly, accounting, production, equipment] = await Promise.all([
      run_get_sales_summary({ month }),
      run_get_weekly_sales_breakdown({ month }),
      run_get_accounting_summary({ month }),
      readAppData(AppData, 'ww_production_batches', []),
      run_get_equipment_status(),
    ]);

    const productionRows = (Array.isArray(production) ? production : [])
      .filter((b) => String(b && b.date || '').startsWith(month));
    const unitsProduced = productionRows.reduce((sum, b) => sum + (Number(b.qty) || 0), 0);

    return {
      month,
      sales,
      weeklyBreakdown: weekly.weeks,
      accounting,
      production: {
        batches: productionRows.length,
        unitsProduced,
      },
      equipment: {
        total: equipment.total,
        operational: equipment.operational,
        needsAttention: equipment.needsAttention,
      },
    };
  }

  async function run_get_inventory_status({ category } = {}) {
    const [rawMaterials, finishedProducts] = await Promise.all([
      readAppData(AppData, 'ww_raw_materials', []),
      readAppData(AppData, 'ww_finished_products', []),
    ]);

    const rawList = (Array.isArray(rawMaterials) ? rawMaterials : [])
      .filter((m) => !category || String(m.category || '').toLowerCase().includes(String(category).toLowerCase()))
      .map((m) => ({
        material: m.material,
        quantity: Number(m.quantity) || 0,
        minLevel: Number(m.minLevel) || 0,
        status: (Number(m.quantity) || 0) < (Number(m.minLevel) || 0) * 0.5
          ? 'critical'
          : (Number(m.quantity) || 0) < (Number(m.minLevel) || 0) ? 'low' : 'adequate',
      }));

    const finishedTotal = (Array.isArray(finishedProducts) ? finishedProducts : [])
      .reduce((sum, p) => sum + (Number(p.qty) || 0), 0);

    return {
      rawMaterials: rawList,
      criticalCount: rawList.filter((m) => m.status === 'critical').length,
      lowCount: rawList.filter((m) => m.status === 'low').length,
      finishedGoodsUnits: finishedTotal,
    };
  }

  async function run_get_equipment_status() {
    const rows = await FactoryEquipment.find().lean();
    const operational = rows.filter((r) => r.status === 'operational').length;
    const needsAttention = rows.filter((r) => ['needs_repair', 'faulty', 'faulty_needs_repair'].includes(r.status));
    return {
      total: rows.length,
      operational,
      needsAttention: needsAttention.map((r) => ({ code: r.code, equipment: r.equipment, status: r.status })),
    };
  }

  async function run_get_accounting_summary({ month } = {}) {
    const acct = await readAppData(AppData, 'ww_accounting_data_v2', { ledger: [], cashbook: [], salaries: [], assets: [] });
    const ledger = (Array.isArray(acct.ledger) ? acct.ledger : [])
      .filter((e) => !month || String(e.date || '').startsWith(month));
    const cashbook = (Array.isArray(acct.cashbook) ? acct.cashbook : [])
      .filter((e) => !month || String(e.date || '').startsWith(month));
    const salaries = (Array.isArray(acct.salaries) ? acct.salaries : [])
      .filter((e) => !month || String(e.date || e.month || '').startsWith(month));

    const income = ledger.filter((e) => e.type === 'revenue' || e.type === 'income')
      .reduce((sum, e) => sum + ((Number(e.credit) || 0) - (Number(e.debit) || 0)), 0);
    const expense = ledger.filter((e) => e.type === 'expense')
      .reduce((sum, e) => sum + ((Number(e.debit) || 0) - (Number(e.credit) || 0)), 0);
    const cashbookTotal = cashbook.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const salariesTotal = salaries.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const { categories: topExpenseCategories } = computeExpenseBreakdown(acct.ledger, month);

    return {
      scope: month || 'all-time',
      incomeGhs: Math.round(income * 100) / 100,
      expenseGhs: Math.round(expense * 100) / 100,
      netGhs: Math.round((income - expense) * 100) / 100,
      cashbookTotalGhs: Math.round(cashbookTotal * 100) / 100,
      salariesTotalGhs: Math.round(salariesTotal * 100) / 100,
      topExpenseCategories: topExpenseCategories.slice(0, 5),
    };
  }

  async function run_get_expense_breakdown({ month } = {}) {
    const acct = await readAppData(AppData, 'ww_accounting_data_v2', { ledger: [] });
    const { totalExpenseGhs, categories } = computeExpenseBreakdown(acct.ledger, month);

    if (!categories.length) {
      return {
        scope: month || 'all-time',
        totalExpenseGhs: 0,
        categories: [],
        note: `No expense ledger entries recorded ${month ? `for ${month}` : 'yet'}.`,
      };
    }

    return { scope: month || 'all-time', totalExpenseGhs, categories };
  }

  async function run_get_employee_salary({ name, month } = {}) {
    if (!name) throw new Error('name is required');
    const acct = await readAppData(AppData, 'ww_accounting_data_v2', { salaries: [] });
    const salaries = Array.isArray(acct.salaries) ? acct.salaries : [];
    const needle = String(name).trim().toLowerCase();

    const matches = salaries
      .filter((s) => String(s && s.employee || '').toLowerCase().includes(needle))
      .filter((s) => !month || String(s.month || s.date || '').startsWith(month));

    if (!matches.length) {
      return {
        found: false,
        query: name,
        month: month || null,
        note: `No salary records found for "${name}"${month ? ` in ${month}` : ''}.`,
      };
    }

    const totalPaidGhs = matches.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const monthsCovered = Array.from(new Set(
      matches.map((s) => String(s.month || String(s.date || '').slice(0, 7) || '')).filter(Boolean),
    )).sort();

    return {
      found: true,
      query: name,
      matchedEmployees: Array.from(new Set(matches.map((s) => s.employee))),
      recordCount: matches.length,
      totalPaidGhs: Math.round(totalPaidGhs * 100) / 100,
      monthsCovered,
      records: matches.slice(0, 20).map((s) => ({
        employee: s.employee,
        date: s.date || null,
        month: s.month || String(s.date || '').slice(0, 7),
        amountGhs: Math.round((Number(s.amount) || 0) * 100) / 100,
        note: s.note || '',
      })),
    };
  }

  async function run_get_staff_directory({ query } = {}) {
    const needle = String(query || '').trim();
    const filter = needle
      ? { $or: [
          { name: new RegExp(escapeRegExp(needle), 'i') },
          { email: new RegExp(escapeRegExp(needle), 'i') },
        ] }
      : {};

    const rows = await User.find(filter).sort({ name: 1 }).limit(30).lean();

    if (!rows.length) {
      return {
        found: false,
        query: query || null,
        note: needle ? `No staff member found matching "${query}".` : 'No users found in the system.',
      };
    }

    return {
      found: true,
      count: rows.length,
      staff: rows.map((u) => ({
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        lastLogin: u.last_login || null,
      })),
    };
  }

  async function run_get_purchase_orders({ status } = {}) {
    const data = await readAppData(AppData, 'ww_purchase_data_v2', { purchaseOrders: [] });
    const orders = (Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [])
      .filter((po) => !status || String(po.status || '').toLowerCase() === String(status).toLowerCase());
    const totalSpendGhs = orders.reduce((sum, po) => {
      const amt = Array.isArray(po.items) && po.items.length
        ? po.items.reduce((t, i) => t + ((Number(i.qty) || 0) * (Number(i.unitCost) || 0)), 0)
        : (Number(po.amount) || 0);
      return sum + amt;
    }, 0);
    return {
      count: orders.length,
      totalSpendGhs: Math.round(totalSpendGhs * 100) / 100,
      orders: orders.slice(0, 20).map((po) => ({
        id: po.id, supplier: po.supplier, status: po.status, date: po.date, expectedDate: po.expectedDate,
      })),
    };
  }

  async function run_get_customers_overview() {
    const rows = await Customer.find().sort({ outstanding: -1 }).limit(10).lean();
    return rows.map((c) => ({
      name: c.name,
      type: c.type,
      totalOrders: c.total_orders,
      outstandingGhs: c.outstanding,
      status: c.status,
    }));
  }

  async function run_get_staff_actions({ limit } = {}) {
    const cap = Math.min(50, Math.max(1, Number(limit) || 15));
    const rows = await StaffAction.find().sort({ timestamp: -1 }).limit(cap).lean();
    return rows.map((r) => ({
      when: r.timestamp,
      user: r.userName,
      role: r.userRole,
      action: r.action,
      module: r.module,
    }));
  }

  async function run_get_tax_records() {
    const records = await readAppData(AppData, 'ww_tax_records', []);
    const rows = Array.isArray(records) ? records : [];
    const totalDue = rows.filter((r) => r.status !== 'Paid').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const overdue = rows.filter((r) => r.status === 'Overdue');
    return {
      totalDueGhs: Math.round(totalDue * 100) / 100,
      overdueCount: overdue.length,
      records: rows.slice(0, 20).map((r) => ({
        type: r.type, period: r.period, amountGhs: r.amount, dueDate: r.dueDate, status: r.status,
      })),
    };
  }

  async function run_define_word({ term }) {
    if (!term) throw new Error('term is required');
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`, {
        signal: controller ? controller.signal : undefined,
      });
      if (timeoutId) clearTimeout(timeoutId);
      if (!res.ok) return { term, found: false };
      const json = await res.json();
      const entry = Array.isArray(json) ? json[0] : null;
      const meaning = entry && Array.isArray(entry.meanings) ? entry.meanings[0] : null;
      const definition = meaning && Array.isArray(meaning.definitions) ? meaning.definitions[0] : null;
      if (!definition) return { term, found: false };
      return {
        term,
        found: true,
        partOfSpeech: meaning.partOfSpeech || '',
        definition: definition.definition || '',
        example: definition.example || '',
      };
    } catch (_e) {
      return { term, found: false, note: 'Lookup service unavailable right now.' };
    }
  }

  return {
    get_sales_summary: run_get_sales_summary,
    get_daily_sales_range: run_get_daily_sales_range,
    get_weekly_sales_breakdown: run_get_weekly_sales_breakdown,
    get_monthly_performance_overview: run_get_monthly_performance_overview,
    get_inventory_status: run_get_inventory_status,
    get_equipment_status: run_get_equipment_status,
    get_accounting_summary: run_get_accounting_summary,
    get_expense_breakdown: run_get_expense_breakdown,
    get_purchase_orders: run_get_purchase_orders,
    get_customers_overview: run_get_customers_overview,
    get_staff_actions: run_get_staff_actions,
    get_staff_directory: run_get_staff_directory,
    get_employee_salary: run_get_employee_salary,
    get_tax_records: run_get_tax_records,
    define_word: run_define_word,
  };
}

/* ─────────────────────────────────────────────────────────────────
   TOOL SCHEMAS (OpenAI function-calling format)
   ───────────────────────────────────────────────────────────────── */

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'get_sales_summary',
      description: 'Overall sales totals and revenue. Use for general "how are sales" / "total revenue" questions. Optionally scope to one month (YYYY-MM) or one year (YYYY).',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'YYYY-MM, optional' },
          year: { type: 'string', description: 'YYYY, optional' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_daily_sales_range',
      description: 'The lowest and highest single-day sales within a given month, plus the daily average. Use for "what was our best/worst day" or "daily sales range this month" questions.',
      parameters: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM, required' } },
        required: ['month'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weekly_sales_breakdown',
      description: 'Sales grouped into calendar weeks for a given month. Use for "weekly breakdown" / "how did each week do" questions.',
      parameters: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM, required' } },
        required: ['month'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_monthly_performance_overview',
      description: 'A full monthly performance report combining sales, accounting, production, and equipment health for one month. Use for "give me a report for this month" / "how did we do overall in [month]" questions.',
      parameters: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM, required' } },
        required: ['month'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_inventory_status',
      description: 'Raw material stock levels (with low/critical flags) and total finished-goods units. Optional category filter.',
      parameters: {
        type: 'object',
        properties: { category: { type: 'string', description: 'Optional category filter, e.g. "packaging"' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_equipment_status',
      description: 'Factory equipment operational status and which machines need attention.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_accounting_summary',
      description: 'Income, expenses, net position, cashbook total, salaries total, and the top 5 expense categories. Optionally scope to one month (YYYY-MM). For the FULL expense category list (not just top 5), use get_expense_breakdown instead.',
      parameters: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM, optional' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_expense_breakdown',
      description: 'The complete expense breakdown by category (Salaries, Raw Materials, Electricity, Water Supply, Maintenance, Supplies, Other) with amounts and percent share of total expenses. Use for "where is our money going" / "biggest expense category" / "full expense breakdown" questions. Optionally scope to one month (YYYY-MM).',
      parameters: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM, optional' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_employee_salary',
      description: 'Salary payment history for one employee by name (partial match), with total paid and the months covered. Use for "how much was [employee] paid" / "[employee] salary history" / "salary history for [employee]" questions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Employee name or partial name, required' },
          month: { type: 'string', description: 'YYYY-MM, optional — narrows to one month' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_staff_directory',
      description: 'Looks up system users (staff/supervisor/manager/CEO accounts) by name or email, returning role, status, and last login. Use for "who is [person]" / "is [person] still active" / "find [person] account" / "list staff" questions. Omit query to list all users.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Name or email substring, optional — omit to list everyone' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_purchase_orders',
      description: 'Purchase orders and total spend, optionally filtered by status (pending/confirmed/shipped/delivered).',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', description: 'Optional status filter' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_customers_overview',
      description: 'Top customers by outstanding balance, with order counts and status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_staff_actions',
      description: 'Recent staff/supervisor create/edit/delete actions across the system.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max rows, default 15' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tax_records',
      description: 'Tax obligations: total due, overdue count, and the records themselves.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'define_word',
      description: 'Looks up a plain-English dictionary definition for a general word the person asked about. Only use this for genuine word/term definitions, never for business questions.',
      parameters: {
        type: 'object',
        properties: { term: { type: 'string' } },
        required: ['term'],
      },
    },
  },
];

/* ─────────────────────────────────────────────────────────────────
   SYSTEM PROMPT
   ───────────────────────────────────────────────────────────────── */

function buildSystemPrompt(pageLabel) {
  return `You are the internal AI assistant for White Water Wells Ltd, a water sachet factory management system, speaking with the CEO or a Manager inside the app${pageLabel ? ` (they are currently viewing the ${pageLabel} page)` : ''}.

TOPIC SCOPE — this is a hard rule:
Only help with things related to this water factory business: sales, invoices, inventory, production, accounting, purchasing, vendors, equipment, staff, customers, tax records, and reports drawn from this system, plus using the tools you're given and defining plain-English words when asked. If the person asks about anything else — general trivia, coding help, other companies, personal advice, or anything unrelated to running this business — reply with EXACTLY this sentence and nothing else: "Sorry, we can't help you with that." Do not soften it, do not explain further, do not apologize twice.

TOOL ROUTING — match these common phrasings to the right tool:
- "how are sales" / "total revenue" / "sales this month/year" → get_sales_summary
- "best day" / "worst day" / "daily sales range" / "highest and lowest sales day" → get_daily_sales_range
- "weekly breakdown" / "how did each week do" → get_weekly_sales_breakdown
- "monthly report" / "how did we do this month overall" / "performance overview" → get_monthly_performance_overview
- "stock levels" / "low stock" / "what materials are we low on" → get_inventory_status
- "machine status" / "equipment status" / "what's broken" → get_equipment_status
- "expenses" / "income" / "cashbook" / "salaries paid" (overall picture) → get_accounting_summary
- "where is our money going" / "biggest expense category" / "full expense breakdown" → get_expense_breakdown
- "how much was [employee] paid" / "[employee]'s salary history" → get_employee_salary
- "purchase orders" / "what have we ordered" → get_purchase_orders
- "top customers" / "who owes us money" → get_customers_overview
- "staff activity" / "who edited/deleted what" → get_staff_actions
- "who is [person]" / "is [person] still active" / "find [person]'s account" / "list staff" → get_staff_directory
- "taxes owed" / "tax due" → get_tax_records
Always call a tool rather than guessing a number. If the person's question requires data you don't have a tool for, say so plainly rather than inventing figures.

CHARTS: when a chart would genuinely help (a trend, a comparison, a breakdown), include exactly one fenced block in this exact format, on its own, in addition to a short written summary:
\`\`\`chart
{"title": "Short title", "type": "bar", "labels": ["A","B"], "datasets": [{"label": "Series name", "data": [1,2]}]}
\`\`\`
"type" may be "bar", "line", "pie", or "doughnut" — pick whichever best fits the data (trends → line, comparisons → bar, composition/share of a whole → pie or doughnut). Use GHS currency framing in the written summary, not inside the chart JSON.

IMAGES: only if the person explicitly asks you to create/draw/generate an image, respond with a short one-line intro and then exactly one fenced block in this exact format and nothing else after it:
\`\`\`image
{"prompt": "A detailed, safe-for-work description of the image to generate"}
\`\`\`
Never emit an image block unless directly asked to generate/draw/create an image.

Keep answers concise, concrete, and business-appropriate. Use GH₵ for currency. When you don't have enough information, ask one clear follow-up question instead of guessing.`;
}

/* ─────────────────────────────────────────────────────────────────
   OPENAI CALLS
   ───────────────────────────────────────────────────────────────── */

function assistantConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

async function callOpenAIChat(messages) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        messages,
        tools: TOOL_SCHEMAS,
        tool_choice: 'auto',
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      const err = new Error('Upstream rate limited');
      err.code = 'UPSTREAM_RATE_LIMITED';
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`OpenAI error ${res.status}: ${text.slice(0, 300)}`);
      err.code = 'UPSTREAM_ERROR';
      throw err;
    }

    const json = await res.json();
    const choice = json.choices && json.choices[0];
    return {
      message: choice ? choice.message : { role: 'assistant', content: '' },
      usage: json.usage || {},
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const err = new Error('OpenAI request timed out');
      err.code = 'UPSTREAM_TIMEOUT';
      throw err;
    }
    if (!error.code) error.code = 'UPSTREAM_ERROR';
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOpenAIImage(prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  const attempt = async (model) => {
    const res = await fetch(`${OPENAI_API_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024' }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`OpenAI image error ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  try {
    let json;
    try {
      json = await attempt(OPENAI_IMAGE_MODEL);
    } catch (firstError) {
      // Fall back to dall-e-3 if the primary model isn't available on this account.
      if (OPENAI_IMAGE_MODEL !== OPENAI_IMAGE_MODEL_FALLBACK) {
        json = await attempt(OPENAI_IMAGE_MODEL_FALLBACK);
      } else {
        throw firstError;
      }
    }
    const item = json.data && json.data[0];
    const url = item && (item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : null));
    if (!url) {
      const err = new Error('No image returned by upstream');
      err.code = 'UPSTREAM_ERROR';
      throw err;
    }
    return { url };
  } catch (error) {
    if (error.name === 'AbortError') {
      const err = new Error('Image generation timed out');
      err.code = 'UPSTREAM_TIMEOUT';
      throw err;
    }
    if (!error.code) error.code = 'UPSTREAM_ERROR';
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ─────────────────────────────────────────────────────────────────
   CHAT ORCHESTRATION (tool-call loop)
   ───────────────────────────────────────────────────────────────── */

async function runAssistantTurn({ history, userMessage, pageLabel, tools }) {
  const systemPrompt = buildSystemPrompt(pageLabel);
  const workingMessages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let totalTokens = 0;
  let finalText = '';

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    const { message, usage } = await callOpenAIChat(workingMessages);
    totalTokens += Number(usage.total_tokens || 0);

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!toolCalls.length) {
      finalText = message.content || '';
      break;
    }

    workingMessages.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const fnName = call.function && call.function.name;
      const impl = tools[fnName];
      let resultPayload;
      if (!impl) {
        resultPayload = { error: `Unknown tool: ${fnName}` };
      } else {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (_e) { args = {}; }
        try {
          resultPayload = await impl(args);
        } catch (toolError) {
          resultPayload = { error: toolError.message || 'Tool execution failed' };
        }
      }
      workingMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(resultPayload),
      });
    }
  }

  if (!finalText) {
    finalText = "I wasn't able to put together a complete answer that time — could you rephrase, or ask about one thing at a time?";
  }

  return { text: finalText, totalTokens };
}

/* ─────────────────────────────────────────────────────────────────
   ROUTE MOUNTING
   ───────────────────────────────────────────────────────────────── */

function mountAssistantRoutes(app, deps) {
  const { AppData, SPECIAL_ACCESS_OVERRIDES, createError } = deps;
  const tools = buildToolRuntime(deps);

  function ensureAssistantAccess(req, _res, next) {
    if (!req.user) { next(createError(401, 'Authentication required')); return; }
    if (!isAssistantRole(req.user, SPECIAL_ACCESS_OVERRIDES)) {
      const err = createError(403, 'The AI assistant is available to CEO and Manager accounts only.');
      err.code = 'FORBIDDEN_ROLE';
      next(err);
      return;
    }
    next();
  }

  function userIdOf(req) {
    return String(req.user.id || req.user._id || req.user.email || 'anon');
  }

  app.use('/api/assistant', ensureAssistantAccess);

  /* ── Usage ── */
  app.get('/api/assistant/usage', async (req, res, next) => {
    try {
      const [budget, imageUsage] = await Promise.all([
        readTokenBudget(AppData),
        readImageUsage(AppData, userIdOf(req)),
      ]);
      res.json({ usage: buildUsagePayload(budget, imageUsage) });
    } catch (error) { next(error); }
  });

  /* ── Projects ── */
  app.get('/api/assistant/projects', async (req, res, next) => {
    try {
      const projects = await loadProjects(AppData, userIdOf(req));
      res.json({ projects });
    } catch (error) { next(error); }
  });

  app.post('/api/assistant/projects', async (req, res, next) => {
    try {
      const name = String(req.body && req.body.name || '').trim();
      if (!name) { const err = createError(400, 'Project name is required'); err.code = 'VALIDATION_ERROR'; throw err; }
      const userId = userIdOf(req);
      const projects = await loadProjects(AppData, userId);
      const project = { id: newId('proj'), name, createdAt: new Date().toISOString() };
      projects.unshift(project);
      await saveProjects(AppData, userId, projects);
      res.status(201).json({ project });
    } catch (error) { next(error); }
  });

  app.delete('/api/assistant/projects/:id', async (req, res, next) => {
    try {
      const userId = userIdOf(req);
      const [projects, conversations] = await Promise.all([
        loadProjects(AppData, userId),
        loadConversations(AppData, userId),
      ]);
      const exists = projects.some((p) => p.id === req.params.id);
      if (!exists) { const err = createError(404, 'Project not found'); err.code = 'PROJECT_NOT_FOUND'; throw err; }

      const nextProjects = projects.filter((p) => p.id !== req.params.id);
      // Deleting a project reassigns its conversations to General rather than deleting them.
      const nextConversations = conversations.map((c) => (
        c.projectId === req.params.id ? { ...c, projectId: null } : c
      ));

      await Promise.all([
        saveProjects(AppData, userId, nextProjects),
        saveConversations(AppData, userId, nextConversations),
      ]);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  /* ── Conversations (sidebar: New Chat / History / Projects) ── */
  app.get('/api/assistant/conversations', async (req, res, next) => {
    try {
      const userId = userIdOf(req);
      const [conversations, projects] = await Promise.all([
        loadConversations(AppData, userId),
        loadProjects(AppData, userId),
      ]);
      const sorted = [...conversations].sort((a, b) => toIsoMs(b.updatedAt) - toIsoMs(a.updatedAt));
      res.json({
        conversations: sorted.slice(0, CONVERSATIONS_LIST_LIMIT).map(conversationSummary),
        projects,
      });
    } catch (error) { next(error); }
  });

  app.get('/api/assistant/conversations/:id', async (req, res, next) => {
    try {
      const userId = userIdOf(req);
      const conversations = await loadConversations(AppData, userId);
      const conv = conversations.find((c) => c.id === req.params.id);
      if (!conv) { const err = createError(404, 'Conversation not found'); err.code = 'CONVERSATION_NOT_FOUND'; throw err; }
      res.json({ conversation: conv });
    } catch (error) { next(error); }
  });

  app.post('/api/assistant/conversations', async (req, res, next) => {
    try {
      const userId = userIdOf(req);
      const projectId = req.body && req.body.projectId ? String(req.body.projectId) : null;
      const conversations = await loadConversations(AppData, userId);
      const now = new Date().toISOString();
      const conv = {
        id: newId('conv'), title: 'New conversation', projectId, messages: [], createdAt: now, updatedAt: now,
      };
      conversations.unshift(conv);
      await saveConversations(AppData, userId, conversations);
      res.status(201).json({ conversation: conv });
    } catch (error) { next(error); }
  });

  app.patch('/api/assistant/conversations/:id', async (req, res, next) => {
    try {
      const userId = userIdOf(req);
      const conversations = await loadConversations(AppData, userId);
      const idx = conversations.findIndex((c) => c.id === req.params.id);
      if (idx < 0) { const err = createError(404, 'Conversation not found'); err.code = 'CONVERSATION_NOT_FOUND'; throw err; }

      const updates = {};
      if (typeof req.body.title === 'string') updates.title = truncateTitle(req.body.title);
      if ('projectId' in (req.body || {})) updates.projectId = req.body.projectId ? String(req.body.projectId) : null;
      conversations[idx] = { ...conversations[idx], ...updates, updatedAt: new Date().toISOString() };

      await saveConversations(AppData, userId, conversations);
      res.json({ conversation: conversations[idx] });
    } catch (error) { next(error); }
  });

  app.delete('/api/assistant/conversations/:id', async (req, res, next) => {
    try {
      const userId = userIdOf(req);
      const conversations = await loadConversations(AppData, userId);
      const exists = conversations.some((c) => c.id === req.params.id);
      if (!exists) { const err = createError(404, 'Conversation not found'); err.code = 'CONVERSATION_NOT_FOUND'; throw err; }
      const next_ = conversations.filter((c) => c.id !== req.params.id);
      await saveConversations(AppData, userId, next_);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  /* Back-compat: v3/v4 frontends called /reset to clear the ephemeral thread.
     In v5 that maps to "start a new conversation". */
  app.post('/api/assistant/reset', async (req, res, next) => {
    try {
      const userId = userIdOf(req);
      const conversations = await loadConversations(AppData, userId);
      const now = new Date().toISOString();
      const conv = { id: newId('conv'), title: 'New conversation', projectId: null, messages: [], createdAt: now, updatedAt: now };
      conversations.unshift(conv);
      await saveConversations(AppData, userId, conversations);
      res.json({ ok: true, conversationId: conv.id });
    } catch (error) { next(error); }
  });

  /* ── Chat ── */
  app.post('/api/assistant/chat', async (req, res, next) => {
    try {
      if (!assistantConfigured()) {
        const err = createError(503, 'The AI assistant is not configured yet. Ask an administrator to set OPENAI_API_KEY.');
        err.code = 'NOT_CONFIGURED';
        throw err;
      }

      const userMessage = String(req.body && req.body.message || '').trim();
      if (!userMessage) { const err = createError(400, 'message is required'); err.code = 'VALIDATION_ERROR'; throw err; }

      const userId = userIdOf(req);
      const pageLabel = String(req.body && req.body.page || '').trim();

      const budgetBefore = await readTokenBudget(AppData);
      if (TOKEN_BUDGET_DAILY_LIMIT > 0 && budgetBefore.tokensUsed >= TOKEN_BUDGET_DAILY_LIMIT) {
        const imageUsage = await readImageUsage(AppData, userId);
        const err = createError(429, "Today's AI assistant usage budget has been reached. It resets at midnight UTC.");
        err.code = 'TOKEN_BUDGET_EXCEEDED';
        err.usage = buildUsagePayload(budgetBefore, imageUsage);
        throw err;
      }

      const conversations = await loadConversations(AppData, userId);
      let conv;
      if (req.body && req.body.conversationId) {
        conv = conversations.find((c) => c.id === req.body.conversationId);
        if (!conv) { const err = createError(404, 'Conversation not found'); err.code = 'CONVERSATION_NOT_FOUND'; throw err; }
      } else {
        const now = new Date().toISOString();
        conv = { id: newId('conv'), title: 'New conversation', projectId: null, messages: [], createdAt: now, updatedAt: now };
        conversations.unshift(conv);
      }

      const history = conv.messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
      const { text, totalTokens } = await runAssistantTurn({ history, userMessage, pageLabel, tools });

      const { prose, imageSpec } = extractImageBlock(text);
      let imageResult = null;
      let imageNote = '';

      if (imageSpec && imageSpec.prompt) {
        const imageUsageBefore = await readImageUsage(AppData, userId);
        if (imageUsageBefore.count >= IMAGE_DAILY_CAP) {
          imageNote = `\n\n(I'd generate that image, but today's limit of ${IMAGE_DAILY_CAP} images has been reached — it resets at midnight UTC.)`;
        } else {
          try {
            imageResult = await callOpenAIImage(imageSpec.prompt);
            await incrementImageUsage(AppData, userId);
          } catch (imageError) {
            imageNote = "\n\n(I tried to generate that image, but the image service didn't respond in time. Please try again.)";
          }
        }
      }

      const nowIso = new Date().toISOString();
      const userMsgRecord = { id: newId('msg'), role: 'user', content: userMessage, createdAt: nowIso };
      const assistantMsgRecord = {
        id: newId('msg'),
        role: 'assistant',
        content: `${prose}${imageNote}`.trim(),
        image: imageResult ? { url: imageResult.url, prompt: imageSpec.prompt } : null,
        createdAt: new Date().toISOString(),
      };

      conv.messages.push(userMsgRecord, assistantMsgRecord);
      conv.updatedAt = new Date().toISOString();
      if (conv.messages.length === 2) conv.title = truncateTitle(userMessage);

      const updatedConversations = req.body.conversationId
        ? conversations.map((c) => (c.id === conv.id ? conv : c))
        : conversations; // conv was already unshifted above for the new-conversation path

      await saveConversations(AppData, userId, updatedConversations);

      const budgetAfter = await addTokenUsage(AppData, totalTokens);
      const imageUsageAfter = await readImageUsage(AppData, userId);

      res.json({
        reply: assistantMsgRecord.content,
        image: assistantMsgRecord.image,
        conversationId: conv.id,
        title: conv.title,
        usage: buildUsagePayload(budgetAfter, imageUsageAfter),
      });
    } catch (error) { next(error); }
  });

  /* ── Direct image generation (sidebar "Generate image" action) ── */
  app.post('/api/assistant/image', async (req, res, next) => {
    try {
      if (!assistantConfigured()) {
        const err = createError(503, 'The AI assistant is not configured yet. Ask an administrator to set OPENAI_API_KEY.');
        err.code = 'NOT_CONFIGURED';
        throw err;
      }
      const prompt = String(req.body && req.body.prompt || '').trim();
      if (!prompt) { const err = createError(400, 'prompt is required'); err.code = 'VALIDATION_ERROR'; throw err; }

      const userId = userIdOf(req);
      const usageBefore = await readImageUsage(AppData, userId);
      if (usageBefore.count >= IMAGE_DAILY_CAP) {
        const err = createError(429, `Today's image generation limit of ${IMAGE_DAILY_CAP} has been reached. It resets at midnight UTC.`);
        err.code = 'IMAGE_BUDGET_EXCEEDED';
        throw err;
      }

      const result = await callOpenAIImage(prompt);
      const usageAfter = await incrementImageUsage(AppData, userId);

      // Optionally attach the result to a conversation as a pair of messages.
      if (req.body && req.body.conversationId) {
        const conversations = await loadConversations(AppData, userId);
        const idx = conversations.findIndex((c) => c.id === req.body.conversationId);
        if (idx >= 0) {
          const nowIso = new Date().toISOString();
          conversations[idx].messages.push(
            { id: newId('msg'), role: 'user', content: `Generate an image: ${prompt}`, createdAt: nowIso },
            { id: newId('msg'), role: 'assistant', content: '', image: { url: result.url, prompt }, createdAt: new Date().toISOString() },
          );
          conversations[idx].updatedAt = new Date().toISOString();
          await saveConversations(AppData, userId, conversations);
        }
      }

      res.json({
        image: { url: result.url, prompt },
        usage: { used: usageAfter.count, cap: IMAGE_DAILY_CAP },
      });
    } catch (error) { next(error); }
  });

  /* Error handler local to the assistant routes so `code` reaches the client
     even though the global error handler in server.js only reads `message`. */
  app.use('/api/assistant', (error, _req, res, _next) => {
    const status = error.status || 500;
    res.status(status).json({
      message: error.message || 'Unexpected assistant error',
      code: error.code || 'UPSTREAM_ERROR',
      usage: error.usage || undefined,
    });
  });
}

module.exports = { mountAssistantRoutes };
// Test-only internals export — not used by server.js, only by smoke tests.
module.exports.__test__ = { buildToolRuntime, computeExpenseBreakdown, normalizeExpenseCategory };