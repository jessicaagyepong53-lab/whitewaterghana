require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const express = require('express');
const {
  connectDB,
  nowIso,
  computeInventoryStatus,
  refreshCustomerStats,
  refreshInventoryStatuses,
  User,
  Session,
  Customer,
  Vendor,
  InventoryItem,
  Machine,
  ProductionBatch,
  SalesOrder,
  Invoice,
  PurchaseOrder,
  AccountingEntry,
  Approval,
  StoreCustomer,
  StoreOrder,
  StoreProduct,
  StoreSession,
  FactoryEquipment,
  AppData,
  TrashBin,
} = require('./server/db');

const app = express();
const rootDir = __dirname;
const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE = 'ww_session';
const SESSION_AGE_MS = 1000 * 60 * 60 * 12;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const DEV_EMAIL = 'naanabrenda52@gmail.com';
const HIDDEN_EMAILS = [DEV_EMAIL, 'supervisor24@whitewaterghana.com'];
const SPECIAL_ACCESS_OVERRIDES = {
  [DEV_EMAIL]: ['ceo', 'supervisor'],
};

function cookieOpts(maxAge) {
  const opts = { httpOnly: true, sameSite: 'lax', maxAge };
  if (IS_PROD) { opts.secure = true; }
  return opts;
}

const RESOURCE_RULES = {
  users: ['ceo', 'manager'],
  customers: ['ceo', 'manager', 'supervisor', 'staff'],
  vendors: ['ceo', 'manager', 'supervisor'],
  inventory: ['ceo', 'manager', 'supervisor'],
  machines: ['ceo', 'manager', 'supervisor'],
  production: ['ceo', 'manager'],
  sales: ['ceo', 'manager', 'supervisor'],
  invoices: ['ceo', 'manager', 'supervisor'],
  accounting: ['ceo', 'manager'],
  approvals: ['ceo', 'manager'],
  reports: ['ceo', 'manager'],
  dashboard: ['ceo', 'manager', 'supervisor', 'staff'],
  purchaseOrders: ['ceo', 'manager', 'supervisor'],
};

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
if (IS_PROD) app.set('trust proxy', 1);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/src', express.static(path.join(rootDir, 'src')));
app.use('/pages', express.static(path.join(rootDir, 'pages')));
app.use('/images', express.static(path.join(rootDir, 'images')));
app.use(express.static(rootDir, { index: false }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(rootDir, 'login.html'));
});

app.get('/store', (_req, res) => {
  res.sendFile(path.join(rootDir, 'store.html'));
});

/* ═══════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════ */

function createError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw createError(400, `${field} is required`);
    }
  }
}

async function getSession(token) {
  if (!token) return null;

  const session = await Session.findOne({ token }).populate('user_id');
  if (!session || !session.user_id) return null;

  if (Date.parse(session.expires_at) < Date.now()) {
    await Session.deleteOne({ token });
    return null;
  }

  const u = session.user_id;
  return {
    token: session.token,
    expiresAt: session.expires_at,
    id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    lastLogin: u.last_login,
  };
}

async function attachUser(req, _res, next) {
  req.user = await getSession(req.cookies[SESSION_COOKIE]);
  next();
}

function ensureAuthenticated(req, _res, next) {
  if (!req.user) {
    next(createError(401, 'Authentication required'));
    return;
  }
  next();
}

function ensureRole(resourceKey) {
  return (req, _res, next) => {
    const allowedRoles = RESOURCE_RULES[resourceKey];
    if (!allowedRoles) { next(); return; }
    if (!req.user) {
      next(createError(403, 'You do not have access to this module'));
      return;
    }

    const overrideRoles = SPECIAL_ACCESS_OVERRIDES[String(req.user.email || '').toLowerCase()] || [];
    const effectiveRoles = Array.from(new Set([req.user.role, ...overrideRoles]));
    const allowed = allowedRoles.some((role) => effectiveRoles.includes(role));
    if (!allowed) {
      next(createError(403, 'You do not have access to this module'));
      return;
    }
    next();
  };
}

function padCode(number) {
  return String(number).padStart(3, '0');
}

async function nextCode(Model, field, prefix) {
  const year = new Date().getFullYear();
  // Sort by the code field descending and take only the last one — avoids
  // a full collection scan and is safe under concurrent requests since
  // MongoDB returns the highest existing code rather than a stale in-memory max.
  const [latest] = await Model.find({}, field).sort({ [field]: -1 }).limit(1).lean();
  if (!latest) return `${prefix}-${year}-${padCode(1)}`;

  const parts = String(latest[field] || '').split('-');
  const num = Number(parts[parts.length - 1]);
  const maxSuffix = Number.isFinite(num) ? num : 0;
  return `${prefix}-${year}-${padCode(maxSuffix + 1)}`;
}

async function getInventoryByName(name) {
  return InventoryItem.findOne({ name }).lean();
}

async function adjustInventoryQuantity(name, quantityChange) {
  const item = await getInventoryByName(name);
  if (!item) return;
  const quantity = Math.max(0, Number(item.quantity) + Number(quantityChange));
  const timestamp = nowIso();
  await InventoryItem.updateOne({ _id: item._id }, {
    quantity,
    status: computeInventoryStatus(quantity, item.reorder_level),
    last_updated: timestamp,
  });
}

async function createAccountingEntry(type, category, amount, description, entryDate) {
  await AccountingEntry.create({ type, category, amount, entry_date: entryDate, description });
}

/* ═══════════════════════════════════════════════
   getCollection  — returns plain objects
   ═══════════════════════════════════════════════ */

async function getCollection(resource) {
  switch (resource) {
    case 'users': {
      const rows = await User.find({ email: { $nin: HIDDEN_EMAILS } }).sort({ createdAt: -1 }).lean();
      return rows.map(r => ({
        id: r._id, name: r.name, email: r.email, role: r.role, status: r.status,
        lastLogin: r.last_login, createdAt: r.createdAt,
      }));
    }
    case 'customers': {
      const rows = await Customer.find().sort({ name: 1 }).lean();
      return rows.map(r => ({
        id: r._id, name: r.name, type: r.type, phone: r.phone, email: r.email, address: r.address,
        totalOrders: r.total_orders, outstanding: r.outstanding, status: r.status, createdAt: r.createdAt,
      }));
    }
    case 'vendors': {
      const rows = await Vendor.find().sort({ name: 1 }).lean();
      return rows.map(r => ({
        id: r._id, name: r.name, category: r.category, phone: r.phone, email: r.email, address: r.address,
        status: r.status, createdAt: r.createdAt,
      }));
    }
    case 'inventory': {
      const rows = await InventoryItem.find().sort({ category: 1, name: 1 }).lean();
      return rows.map(r => ({
        id: r._id, name: r.name, category: r.category, quantity: r.quantity, unit: r.unit,
        reorderLevel: r.reorder_level, unitCost: r.unit_cost, status: r.status,
        lastUpdated: r.last_updated, createdAt: r.createdAt,
      }));
    }
    case 'machines': {
      const rows = await Machine.find().sort({ name: 1 }).lean();
      return rows.map(r => ({
        id: r._id, name: r.name, status: r.status, outputPerHour: r.output_per_hour,
        lastMaintenance: r.last_maintenance, operator: r.operator, createdAt: r.createdAt,
      }));
    }
    case 'production': {
      const rows = await ProductionBatch.find().sort({ createdAt: -1 }).lean();
      return rows.map(r => ({
        id: r._id, batchCode: r.batch_code, product: r.product, quantity: r.quantity,
        startTime: r.start_time, machine: r.machine, operator: r.operator, status: r.status,
        cost: r.cost, wastage: r.wastage, createdAt: r.createdAt,
      }));
    }
    case 'sales': {
      const rows = await SalesOrder.find().populate('customer_id').populate('invoice_id').sort({ createdAt: -1 }).lean();
      return rows.map(r => ({
        id: r._id, orderCode: r.order_code, customerName: r.customer_id?.name ?? '', customerId: r.customer_id?._id,
        product: r.product, quantity: r.quantity, amount: r.amount, orderDate: r.order_date,
        source: r.source, status: r.status, invoiceCode: r.invoice_id?.invoice_code ?? null, createdAt: r.createdAt,
      }));
    }
    case 'invoices': {
      const rows = await Invoice.find().populate('customer_id').populate('sales_order_id').sort({ invoice_code: 1 }).lean();
      return rows.map(r => ({
        id: r._id, invoiceCode: r.invoice_code, customerName: r.customer_id?.name ?? '', customerId: r.customer_id?._id,
        orderCode: r.sales_order_id?.order_code ?? null, salesOrderId: r.sales_order_id?._id ?? null,
        amount: r.amount, issueDate: r.issue_date, dueDate: r.due_date, status: r.status, createdAt: r.createdAt,
      }));
    }
    case 'purchaseOrders': {
      const rows = await PurchaseOrder.find().populate('vendor_id').sort({ createdAt: -1 }).lean();
      return rows.map(r => ({
        id: r._id, poCode: r.po_code, vendorName: r.vendor_id?.name ?? '', vendorId: r.vendor_id?._id,
        item: r.item, quantity: r.quantity, amount: r.amount, requiredBy: r.required_by,
        status: r.status, notes: r.notes, createdAt: r.createdAt,
      }));
    }
    case 'accounting': {
      const rows = await AccountingEntry.find().sort({ entry_date: -1 }).lean();
      return rows.map(r => ({
        id: r._id, type: r.type, category: r.category, amount: r.amount,
        entryDate: r.entry_date, description: r.description, createdAt: r.createdAt,
      }));
    }
    case 'approvals': {
      const rows = await Approval.find().sort({ submitted_at: -1 }).lean();
      return rows.map(r => ({
        id: r._id, requestType: r.request_type, moduleName: r.module_name, recordId: r.record_id,
        submittedBy: r.submitted_by, reason: r.reason, status: r.status,
        oldValues: r.old_values, newValues: r.new_values,
        decidedBy: r.decided_by, submittedAt: r.submitted_at, decidedAt: r.decided_at,
      }));
    }
    default:
      throw createError(404, 'Unknown collection');
  }
}

/* ═══════════════════════════════════════════════
   APPROVAL HELPERS
   ═══════════════════════════════════════════════ */

async function createApprovalRequest({ requestType, moduleName, recordId, submittedBy, reason, oldValues, newValues }) {
  const doc = await Approval.create({
    request_type: requestType,
    module_name: moduleName,
    record_id: recordId,
    submitted_by: submittedBy,
    reason,
    status: 'Pending',
    old_values: oldValues ?? null,
    new_values: newValues ?? null,
    submitted_at: nowIso(),
  });
  return doc._id;
}

async function applyApprovalMutation(approvalId) {
  const approval = await Approval.findById(approvalId).lean();
  if (!approval || approval.status !== 'Pending') throw createError(400, 'Approval is not pending');

  const newValues = approval.new_values || {};
  const models = {
    inventory: InventoryItem,
    sales: SalesOrder,
    vendors: Vendor,
    customers: Customer,
    machines: Machine,
    production: ProductionBatch,
    invoices: Invoice,
    purchaseOrders: PurchaseOrder,
  };

  const Model = models[approval.module_name];
  if (!Model) return;

  if (approval.request_type === 'Delete') {
    const record = await Model.findById(approval.record_id).lean();
    if (record) {
      await moveToTrash(approval.module_name, record, approval.submitted_by);
    }
    await Model.deleteOne({ _id: approval.record_id });
    if (approval.module_name === 'sales') await refreshCustomerStats();
    return;
  }

  // Edit — convert camelCase keys to snake_case for Mongoose fields
  const update = {};
  for (const [key, value] of Object.entries(newValues)) {
    const dbKey = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    update[dbKey] = value;
  }
  await Model.updateOne({ _id: approval.record_id }, update);

  if (approval.module_name === 'inventory') await refreshInventoryStatuses();
  if (approval.module_name === 'sales' || approval.module_name === 'invoices') await refreshCustomerStats();
}

function requireApprovalForRole(user) {
  return ['supervisor', 'staff'].includes(user.role);
}

/* ═══════════════════════════════════════════════
   OPTIONS / DASHBOARD / REPORTS
   ═══════════════════════════════════════════════ */

async function getOptions() {
  const [customers, vendors, machines, products, openSalesOrders, users] = await Promise.all([
    Customer.find({}, 'name').sort({ name: 1 }).lean(),
    Vendor.find({}, 'name').sort({ name: 1 }).lean(),
    Machine.find({}, 'name').sort({ name: 1 }).lean(),
    InventoryItem.find({ category: 'Finished Goods' }, 'name').sort({ name: 1 }).lean(),
    SalesOrder.find({ invoice_id: null }, 'order_code').sort({ createdAt: -1 }).lean(),
    User.find({}, 'name role').sort({ name: 1 }).lean(),
  ]);
  return {
    customers: customers.map(c => ({ id: c._id, name: c.name })),
    vendors: vendors.map(v => ({ id: v._id, name: v.name })),
    machines: machines.map(m => ({ id: m._id, name: m.name })),
    products: products.map(p => ({ id: p._id, name: p.name })),
    openSalesOrders: openSalesOrders.map(s => ({ id: s._id, code: s.order_code })),
    users: users.map(u => ({ id: u._id, name: u.name, role: u.role })),
  };
}

async function getDashboardData() {
  const [revenueAgg, outstandingAgg, producedAgg, stockAlerts, customerCount, machineStatus, pendingApprovalCount] = await Promise.all([
    Invoice.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
    Invoice.aggregate([{ $match: { status: { $ne: 'Paid' } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ProductionBatch.aggregate([{ $group: { _id: null, total: { $sum: '$quantity' } } }]),
    InventoryItem.countDocuments({ status: { $in: ['LOW', 'CRITICAL', 'OUT OF STOCK'] } }),
    Customer.countDocuments({ status: { $ne: 'Suspended' } }),
    Machine.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Approval.countDocuments({ status: 'Pending' }),
  ]);

  const revenue = revenueAgg[0]?.total || 0;
  const outstanding = outstandingAgg[0]?.total || 0;
  const produced = producedAgg[0]?.total || 0;
  const recentOrders = (await getCollection('sales')).slice(0, 5);
  const lowStock = (await getCollection('inventory')).filter(i => i.status !== 'ADEQUATE').slice(0, 5);

  return {
    cards: [
      { label: 'Revenue', value: revenue, tone: 'success', kind: 'currency' },
      { label: 'Units Produced', value: produced, tone: 'brand', kind: 'number' },
      { label: 'Active Customers', value: customerCount, tone: 'neutral', kind: 'number' },
      { label: 'Stock Alerts', value: stockAlerts, tone: 'warning', kind: 'number' },
      { label: 'Outstanding Invoices', value: outstanding, tone: 'danger', kind: 'currency' },
      { label: 'Pending Approvals', value: pendingApprovalCount, tone: 'accent', kind: 'number' },
    ],
    recentOrders,
    machineStatus: machineStatus.map(m => ({ status: m._id, count: m.count })),
    lowStock,
  };
}

async function getReportData() {
  const [revenueByChannel, topCustomers, expenseSummary, inventoryStatus, monthlyFinance] = await Promise.all([
    SalesOrder.aggregate([
      { $group: { _id: '$source', orders: { $sum: 1 }, revenue: { $sum: '$amount' } } },
      { $sort: { revenue: -1 } },
      { $project: { _id: 0, channel: '$_id', orders: 1, revenue: 1 } },
    ]),
    Customer.aggregate([
      {
        $lookup: {
          from: 'salesorders', localField: '_id', foreignField: 'customer_id', as: 'sales',
        },
      },
      {
        $project: {
          name: 1,
          orders: { $size: '$sales' },
          revenue: { $ifNull: [{ $sum: '$sales.amount' }, 0] },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    AccountingEntry.aggregate([
      { $match: { type: 'Expense' } },
      { $group: { _id: '$category', amount: { $sum: '$amount' } } },
      { $sort: { amount: -1 } },
      { $project: { _id: 0, category: '$_id', amount: 1 } },
    ]),
    InventoryItem.aggregate([
      {
        $group: {
          _id: '$category',
          totalItems: { $sum: 1 },
          adequate: { $sum: { $cond: [{ $eq: ['$status', 'ADEQUATE'] }, 1, 0] } },
          low: { $sum: { $cond: [{ $eq: ['$status', 'LOW'] }, 1, 0] } },
          critical: { $sum: { $cond: [{ $eq: ['$status', 'CRITICAL'] }, 1, 0] } },
          outOfStock: { $sum: { $cond: [{ $eq: ['$status', 'OUT OF STOCK'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, category: '$_id', totalItems: 1, adequate: 1, low: 1, critical: 1, outOfStock: 1 } },
    ]),
    AccountingEntry.aggregate([
      {
        $group: {
          _id: { $substr: ['$entry_date', 0, 7] },
          income: { $sum: { $cond: [{ $eq: ['$type', 'Income'] }, '$amount', 0] } },
          expense: { $sum: { $cond: [{ $eq: ['$type', 'Expense'] }, '$amount', 0] } },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 6 },
      { $project: { _id: 0, month: '$_id', income: 1, expense: 1 } },
    ]),
  ]);

  return {
    revenueByChannel,
    topCustomers,
    expenseSummary,
    inventoryStatus,
    monthlyFinance: monthlyFinance.reverse(),
  };
}

/* ═══════════════════════════════════════════════
   AUTH ROUTES
   ═══════════════════════════════════════════════ */

const AUTHORIZED_EMAILS = {
  'ceo9@whitewaterghana.com': { role: 'ceo', defaultName: 'CEO' },
  'manager25@whitewaterghana.com': { role: 'manager', defaultName: 'Manager' },
  'supervisor1@whitewaterghana.com': { role: 'supervisor', defaultName: 'Supervisor' },
  'supervisor24@whitewaterghana.com': { role: 'supervisor', defaultName: 'Supervisor' },
  [DEV_EMAIL]: { role: 'ceo', defaultName: 'Dev' },
};

app.use(attachUser);

// Prevent caching on all API responses
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: nowIso() });
});

// ── SSE: real-time cross-device sync ──
const sseClients = new Set();

function broadcastSseEvent(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_e) { sseClients.delete(res); }
  }
}

// GET handlers for auth routes — silences browser/extension prefetch probes
app.get('/api/auth/register', (_req, res) => { res.json({ message: 'Use POST.' }); });
app.get('/api/auth/login', (_req, res) => { res.json({ message: 'Use POST.' }); });
app.get('/api/auth/reset-password', (_req, res) => { res.json({ message: 'Use POST.' }); });

app.post('/api/auth/register', async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'email', 'password', 'role']);
    const email = String(req.body.email).trim().toLowerCase();
    const name = String(req.body.name).trim();
    const password = String(req.body.password);
    const selectedRole = String(req.body.role).trim().toLowerCase();

    if (password.length < 6) throw createError(400, 'Password must be at least 6 characters');

    const validRoles = ['ceo', 'manager', 'supervisor', 'staff'];
    if (!validRoles.includes(selectedRole)) throw createError(400, 'Please select a valid role');

    const authorized = AUTHORIZED_EMAILS[email];
    if (!authorized) throw createError(403, 'This email is not authorized. Contact your administrator.');

    if (authorized.role !== selectedRole) {
      const expected = authorized.role.toUpperCase();
      const chosen = selectedRole.toUpperCase();
      throw createError(403, `This email is registered as ${expected}, not ${chosen}. Please select the correct role.`);
    }

    const existing = await User.findOne({ email });
    if (existing) throw createError(409, 'An account with this email already exists. Please sign in.');

    const user = await User.create({
      name, email,
      password_hash: bcrypt.hashSync(password, 10),
      role: authorized.role,
      status: 'Active',
    });

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_AGE_MS).toISOString();
    await Session.create({ token, user_id: user._id, expires_at: expiresAt });

    res.cookie(SESSION_COOKIE, token, cookieOpts(SESSION_AGE_MS));
    res.status(201).json({
      user: { id: user._id, name, email, role: authorized.role, status: 'Active' },
    });
  } catch (error) {
    if (error.code === 11000) { next(createError(409, 'An account with this email already exists. Please sign in.')); return; }
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    requireFields(req.body, ['email', 'password']);
    const email = String(req.body.email).trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) throw createError(401, 'Invalid email or password');

    if (!bcrypt.compareSync(String(req.body.password), user.password_hash)) {
      throw createError(401, 'Invalid email or password');
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_AGE_MS).toISOString();
    const timestamp = nowIso();
    await Session.create({ token, user_id: user._id, expires_at: expiresAt });
    await User.updateOne({ _id: user._id }, { last_login: timestamp });

    res.cookie(SESSION_COOKIE, token, cookieOpts(SESSION_AGE_MS));
    const overrideRoles = SPECIAL_ACCESS_OVERRIDES[String(user.email || '').toLowerCase()] || [];
    const effectiveRoles = Array.from(new Set([user.role, ...overrideRoles]));
    const effectiveRole = effectiveRoles.includes('ceo') ? 'ceo' : user.role;

    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        effectiveRole,
        effectiveRoles,
        status: user.status,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', ensureAuthenticated, async (req, res) => {
  await Session.deleteOne({ token: req.cookies[SESSION_COOKIE] });
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/auth/forgot-password', (_req, res) => { res.json({ message: 'Use POST to submit a forgot-password request.' }); });
app.post('/api/auth/forgot-password', async (req, res, next) => {
  try {
    requireFields(req.body, ['email']);
    const email = String(req.body.email).trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) { res.json({ message: 'If this account exists, please contact a Manager or CEO to reset your password.' }); return; }
    res.json({ message: 'Please contact a Manager or CEO to reset your password from the User Management page.' });
  } catch (error) {
    next(error);
  }
});

// Change password (requires current password)
app.get('/api/auth/reset-password', (_req, res) => { res.json({ message: 'Use POST.' }); });
app.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    requireFields(req.body, ['email', 'currentPassword', 'newPassword']);
    const email = String(req.body.email).trim().toLowerCase();
    const currentPassword = String(req.body.currentPassword);
    const newPassword = String(req.body.newPassword);
    if (newPassword.length < 6) throw createError(400, 'New password must be at least 6 characters');

    const user = await User.findOne({ email });
    if (!user) throw createError(404, 'No user found with this email');

    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      throw createError(401, 'Current password is incorrect');
    }

    await User.updateOne({ _id: user._id }, { password_hash: bcrypt.hashSync(newPassword, 10) });
    await Session.deleteMany({ user_id: user._id });

    res.json({ message: 'Password changed successfully. Please sign in with your new password.' });
  } catch (error) {
    next(error);
  }
});

// Admin password reset (managers/CEOs can reset any user's password)
app.post('/api/auth/admin-reset-password', ensureAuthenticated, ensureRole('users'), async (req, res, next) => {
  try {
    requireFields(req.body, ['userId', 'newPassword']);
    const newPassword = String(req.body.newPassword);
    if (newPassword.length < 6) throw createError(400, 'New password must be at least 6 characters');

    const user = await User.findById(req.body.userId);
    if (!user) throw createError(404, 'User not found');

    await User.updateOne({ _id: user._id }, { password_hash: bcrypt.hashSync(newPassword, 10) });
    await Session.deleteMany({ user_id: user._id });

    res.json({ message: `Password reset for ${user.name}. They can now sign in with the new password.` });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) { res.status(401).json({ message: 'Not signed in' }); return; }
  const overrideRoles = SPECIAL_ACCESS_OVERRIDES[String(req.user.email || '').toLowerCase()] || [];
  const effectiveRoles = Array.from(new Set([req.user.role, ...overrideRoles]));
  const effectiveRole = effectiveRoles.includes('ceo') ? 'ceo' : req.user.role;
  res.json({ user: { ...req.user, effectiveRole, effectiveRoles } });
});

/* ═══════════════════════════════════════════════
   DATA ROUTES
   ═══════════════════════════════════════════════ */

app.get('/api/options', ensureAuthenticated, async (req, res, next) => {
  try { res.json(await getOptions()); } catch (e) { next(e); }
});

app.get('/api/dashboard', ensureAuthenticated, ensureRole('dashboard'), async (_req, res, next) => {
  try {
    await refreshCustomerStats();
    await refreshInventoryStatuses();
    res.json(await getDashboardData());
  } catch (e) { next(e); }
});

app.get('/api/reports', ensureAuthenticated, ensureRole('reports'), async (_req, res, next) => {
  try { res.json(await getReportData()); } catch (e) { next(e); }
});

// Aggregate invoice/sales totals from AppData (the source of truth for this system)
app.get('/api/reports/sales-summary', ensureAuthenticated, ensureRole('reports'), async (req, res, next) => {
  try {
    const { month, year } = req.query;
    // Find all sales month keys
    let query = { key: /^ww_sales_\d{4}-\d{2}$/ };
    if (month) {
      // month param like "2026-05"
      query = { key: 'ww_sales_' + month };
    } else if (year) {
      query = { key: new RegExp('^ww_sales_' + year + '-\\d{2}$') };
    }

    const docs = await AppData.find(query).lean();
    let totalInvoices = 0;
    let totalRevenue = 0;
    let paidRevenue = 0;
    let totalOrders = 0;
    let paidCount = 0;
    let unpaidCount = 0;
    const monthBreakdown = [];

    for (const doc of docs) {
      const payload = (doc.data && typeof doc.data === 'object') ? doc.data : {};
      const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
      const orders = Array.isArray(payload.salesOrders) ? payload.salesOrders : [];
      const monthRevenue = invoices.reduce((sum, inv) => sum + (Number(inv && inv.amount) || 0), 0);
      const isPaid = (inv) => inv && (inv.status === 'paid' || inv.payment === 'paid');
      const monthPaid = invoices.filter(isPaid).length;
      const monthPaidRevenue = invoices.filter(isPaid).reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);

      totalInvoices += invoices.length;
      totalOrders += orders.length;
      totalRevenue += monthRevenue;
      paidRevenue += monthPaidRevenue;
      paidCount += monthPaid;
      unpaidCount += (invoices.length - monthPaid);

      monthBreakdown.push({
        month: doc.key.replace('ww_sales_', ''),
        invoices: invoices.length,
        orders: orders.length,
        revenue: monthRevenue,
        paidRevenue: monthPaidRevenue,
        paid: monthPaid,
        unpaid: invoices.length - monthPaid,
      });
    }

    monthBreakdown.sort((a, b) => a.month.localeCompare(b.month));

    res.json({
      totalInvoices,
      totalOrders,
      totalRevenue,
      paidRevenue,
      paidCount,
      unpaidCount,
      months: monthBreakdown,
    });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   APP DATA (generic key-value persistence)
   ═══════════════════════════════════════════════ */

const ALLOWED_DATA_KEYS = [
  'ww_raw_materials', 'ww_finished_products', 'ww_production_batches',
  'ww_daily_production', 'ww_purchase_data_v2', 'ww_accounting_data_v2',
  'ww_cost_centre_budgets', 'ww_bom_data',
  'ww_sales_months', 'ww_equipment', 'ww_seed_flags', 'ww_last_data_update', 'ww_recent_restores',
];

function isAllowedDataKey(key) {
  if (ALLOWED_DATA_KEYS.includes(key)) return true;
  if (/^ww_sales_\d{4}-\d{2}$/.test(key)) return true;
  return false;
}

function toIsoMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function pickNewerRecord(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  // Only updatedAt/modifiedAt — createdAt never changes so using it with >=
  // always lets the incoming record win, resurrecting deleted invoices.
  const existingMs = Math.max(toIsoMs(existing.updatedAt), toIsoMs(existing.modifiedAt));
  const incomingMs = Math.max(toIsoMs(incoming.updatedAt), toIsoMs(incoming.modifiedAt));
  return incomingMs > existingMs ? incoming : existing;
}

function invoiceContentFingerprint(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const firstItem = Array.isArray(inv.items) && inv.items[0] ? inv.items[0] : null;
  const itemName = String((firstItem && firstItem.name) || inv.product || '').trim().toLowerCase();
  const qty = Number((firstItem && firstItem.qty) || 0);
  const unitPrice = Number((firstItem && firstItem.unitPrice) || inv.rate || 0);
  return [
    String(inv.customer || '').trim().toLowerCase(),
    String(inv.date || '').trim(),
    String(inv.phone || '').trim(),
    String(inv.address || '').trim(),
    String(inv.paidDate || '').trim(),
    Number(inv.amount || 0),
    itemName,
    qty,
    unitPrice,
    String(inv.paymentMode || '').trim().toLowerCase(),
    String(inv.carType || '').trim().toLowerCase(),
    String(inv.carNumber || '').trim().toLowerCase(),
    Number(inv.promo || 0),
    String(inv.promoNote || '').trim(),
    String(inv.entryTime || '').trim(),
    String(inv.createdAt || '').trim(),
  ].join('|');
}

function normalizeSalesMonthPayload(key, payload) {
  if (!/^ww_sales_\d{4}-\d{2}$/.test(String(key || ''))) return payload;
  if (!payload || typeof payload !== 'object') return payload;

  const invoices = Array.isArray(payload.invoices) ? payload.invoices.filter((inv) => inv && inv.id) : [];
  const byId = new Map();
  for (const inv of invoices) {
    const id = String(inv.id || '').trim();
    if (!id) continue;
    byId.set(id, pickNewerRecord(byId.get(id), inv));
  }
  const dedupInvoices = [...byId.values()].sort((a, b) => {
    const ta = new Date(a.createdAt || a.date || 0).getTime();
    const tb = new Date(b.createdAt || b.date || 0).getTime();
    return ta - tb;
  });
  const activeInvoiceIds = new Set(dedupInvoices.map((inv) => String(inv.id || '')).filter(Boolean));

  const orders = Array.isArray(payload.salesOrders) ? payload.salesOrders.filter((ord) => ord && ord.id) : [];
  const orderById = new Map();
  for (const ord of orders) {
    const sourceInvoiceId = String(ord.sourceInvoiceId || '').trim();
    const id = String(ord.id || '').trim();
    if (!id || !sourceInvoiceId || !activeInvoiceIds.has(sourceInvoiceId)) continue;
    orderById.set(id, pickNewerRecord(orderById.get(id), ord));
  }
  const dedupOrders = [...orderById.values()].sort((a, b) => {
    const ta = new Date(a.createdAt || a.date || 0).getTime();
    const tb = new Date(b.createdAt || b.date || 0).getTime();
    return ta - tb;
  });

  const nextDeletedInvoiceIds = (Array.isArray(payload.deletedInvoiceIds) ? payload.deletedInvoiceIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && !activeInvoiceIds.has(id));

  const activeOrderIds = new Set(dedupOrders.map((ord) => String(ord.id || '')).filter(Boolean));
  const nextDeletedOrderIds = (Array.isArray(payload.deletedOrderIds) ? payload.deletedOrderIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && !activeOrderIds.has(id));

  const finalInvoices = dedupInvoices;
  const finalInvoiceIds = new Set(finalInvoices.map((inv) => String(inv?.id || '')).filter(Boolean));
  const finalOrders = dedupOrders.filter((ord) => {
    const sourceInvoiceId = String(ord?.sourceInvoiceId || '').trim();
    return sourceInvoiceId && finalInvoiceIds.has(sourceInvoiceId);
  });

  return {
    ...payload,
    invoices: finalInvoices,
    salesOrders: finalOrders,
    deletedInvoiceIds: Array.from(new Set(nextDeletedInvoiceIds)),
    deletedOrderIds: Array.from(new Set(nextDeletedOrderIds)),
  };
}

app.get('/api/app-data-bulk', ensureAuthenticated, async (req, res, next) => {
  try {
    const keys = (req.query.keys || '').split(',').filter(k => isAllowedDataKey(k));
    if (!keys.length) return res.json({ items: [] });
    const docs = await AppData.find({ key: { $in: keys } }).lean();
    const map = {};
    const savePromises = [];
    for (const d of docs) {
      if (/^ww_sales_\d{4}-\d{2}$/.test(d.key)) {
        const normalized = normalizeSalesMonthPayload(d.key, d.data);
        map[d.key] = normalized;
        // BUG FIX: also check deletedInvoiceIds — count-only check missed cases where
        // a deletion was recorded but the array length stayed the same, causing resurrection.
        const origCount = Array.isArray(d.data && d.data.invoices) ? d.data.invoices.length : -1;
        const normCount = Array.isArray(normalized && normalized.invoices) ? normalized.invoices.length : -1;
        const origDeleted = JSON.stringify((d.data && d.data.deletedInvoiceIds) || []);
        const normDeleted = JSON.stringify((normalized && normalized.deletedInvoiceIds) || []);
        if (origCount !== normCount || origDeleted !== normDeleted) {
          savePromises.push(AppData.updateOne({ key: d.key }, { key: d.key, data: normalized }, { upsert: true }));
        }
      } else {
        map[d.key] = d.data;
      }
    }
    if (savePromises.length) await Promise.all(savePromises);
    res.json({ items: map });
  } catch (error) { next(error); }
});

app.get('/api/app-data/:key', ensureAuthenticated, async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!isAllowedDataKey(key)) return res.status(400).json({ message: 'Invalid key' });
    const doc = await AppData.findOne({ key }).lean();
    if (!doc) return res.json({ key, data: null });
    if (/^ww_sales_\d{4}-\d{2}$/.test(key)) {
      const normalized = normalizeSalesMonthPayload(key, doc.data);
      // BUG FIX: also check deletedInvoiceIds, not just count
      const origCount = Array.isArray(doc.data && doc.data.invoices) ? doc.data.invoices.length : -1;
      const normCount = Array.isArray(normalized && normalized.invoices) ? normalized.invoices.length : -1;
      const origDel = JSON.stringify((doc.data && doc.data.deletedInvoiceIds) || []);
      const normDel = JSON.stringify((normalized && normalized.deletedInvoiceIds) || []);
      if (origCount !== normCount || origDel !== normDel) {
        await AppData.updateOne({ key }, { key, data: normalized }, { upsert: true });
      }
      return res.json({ key, data: normalized });
    }
    res.json({ key, data: doc.data });
  } catch (error) { next(error); }
});

app.put('/api/app-data/:key', ensureAuthenticated, async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!isAllowedDataKey(key)) return res.status(400).json({ message: 'Invalid key' });

    if (/^ww_sales_\d{4}-\d{2}$/.test(String(key))) {
      // Apply deletion guard BEFORE normalizing. Normalizing first runs pickNewerRecord
      // on raw incoming data and can revive deleted invoices before the guard runs.
      const incoming = req.body.data && typeof req.body.data === 'object' ? req.body.data : {};
      const existingDoc = await AppData.findOne({ key }).lean();
      const serverData = existingDoc && existingDoc.data && typeof existingDoc.data === 'object' ? existingDoc.data : {};

      // Merge deletedInvoiceIds from both sources — deletions are permanent.
      const deletedInvoiceIds = new Set([
        ...(Array.isArray(serverData.deletedInvoiceIds) ? serverData.deletedInvoiceIds : []),
        ...(Array.isArray(incoming.deletedInvoiceIds) ? incoming.deletedInvoiceIds : []),
      ].map((id) => String(id || '').trim()).filter(Boolean));

      const deletedOrderIds = new Set([
        ...(Array.isArray(serverData.deletedOrderIds) ? serverData.deletedOrderIds : []),
        ...(Array.isArray(incoming.deletedOrderIds) ? incoming.deletedOrderIds : []),
      ].map((id) => String(id || '').trim()).filter(Boolean));

      // Build server invoice map for record-by-record merge.
      const serverInvoiceMap = new Map();
      for (const inv of (Array.isArray(serverData.invoices) ? serverData.invoices : [])) {
        if (inv && inv.id && !deletedInvoiceIds.has(String(inv.id).trim()))
          serverInvoiceMap.set(String(inv.id).trim(), inv);
      }

      // Strip deleted from incoming, merge with server copies.
      const seenIds = new Set();
      const mergedInvoices = [];
      for (const inv of (Array.isArray(incoming.invoices) ? incoming.invoices : [])) {
        if (!inv || !inv.id) continue;
        const id = String(inv.id).trim();
        if (deletedInvoiceIds.has(id) || seenIds.has(id)) continue;
        seenIds.add(id);
        mergedInvoices.push(pickNewerRecord(serverInvoiceMap.get(id), inv));
      }
      for (const [id, inv] of serverInvoiceMap.entries()) {
        if (!seenIds.has(id)) {
          seenIds.add(id); // BUG FIX: mark as seen so re-POSTs can't double-add
          mergedInvoices.push(inv);
        }
      }
      // BUG FIX: sort merged invoices by createdAt so ordering is always consistent
      mergedInvoices.sort((a, b) => {
        const ta = new Date(a.createdAt || a.date || 0).getTime();
        const tb = new Date(b.createdAt || b.date || 0).getTime();
        return ta - tb;
      });

      const activeInvoiceIds = new Set(mergedInvoices.map((inv) => String(inv.id).trim()));

      // Same for orders.
      const serverOrderMap = new Map();
      for (const ord of (Array.isArray(serverData.salesOrders) ? serverData.salesOrders : [])) {
        if (!ord || !ord.id) continue;
        const src = String(ord.sourceInvoiceId || '').trim();
        if (!deletedOrderIds.has(String(ord.id).trim()) && activeInvoiceIds.has(src))
          serverOrderMap.set(String(ord.id).trim(), ord);
      }

      const seenOrdIds = new Set();
      const mergedOrders = [];
      for (const ord of (Array.isArray(incoming.salesOrders) ? incoming.salesOrders : [])) {
        if (!ord || !ord.id) continue;
        const id = String(ord.id).trim();
        const src = String(ord.sourceInvoiceId || '').trim();
        if (deletedOrderIds.has(id) || deletedInvoiceIds.has(src) || !activeInvoiceIds.has(src) || seenOrdIds.has(id)) continue;
        seenOrdIds.add(id);
        mergedOrders.push(pickNewerRecord(serverOrderMap.get(id), ord));
      }
      for (const [id, ord] of serverOrderMap.entries()) {
        if (!seenOrdIds.has(id)) {
          seenOrdIds.add(id); // BUG FIX: mark as seen to prevent future double-adds
          mergedOrders.push(ord);
        }
      }
      // BUG FIX: sort merged orders by createdAt for consistent ordering
      mergedOrders.sort((a, b) => {
        const ta = new Date(a.createdAt || a.date || 0).getTime();
        const tb = new Date(b.createdAt || b.date || 0).getTime();
        return ta - tb;
      });

      const normalized = normalizeSalesMonthPayload(key, {
        ...incoming,
        invoices: mergedInvoices,
        salesOrders: mergedOrders,
        deletedInvoiceIds: Array.from(deletedInvoiceIds),
        deletedOrderIds: Array.from(deletedOrderIds),
      });

      await AppData.updateOne({ key }, { key, data: normalized }, { upsert: true });
      if (typeof broadcastSseEvent === 'function') broadcastSseEvent('data_updated', { key });
      return res.json({ ok: true });
    }

    // Non-sales keys: simple normalize and save.
    const normalized = normalizeSalesMonthPayload(key, req.body.data);
    await AppData.updateOne({ key }, { key, data: normalized }, { upsert: true });
    if (typeof broadcastSseEvent === 'function') broadcastSseEvent('data_updated', { key });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/live-updates', ensureAuthenticated, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_e) { clearInterval(heartbeat); sseClients.delete(res); }
  }, 25000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

/* Generic resource GET (must be AFTER specific /api/* routes) */
app.get('/api/:resource', ensureAuthenticated, async (req, res, next) => {
  try {
    const resource = req.params.resource;
    if (resource === 'trash') { next(); return; }
    ensureRole(resource)(req, res, (error) => { if (error) throw error; });
    res.json(await getCollection(resource));
  } catch (error) {
    next(error);
  }
});

/* ═══════════════════════════════════════════════
   CREATE ROUTES
   ═══════════════════════════════════════════════ */

app.post('/api/users', ensureAuthenticated, ensureRole('users'), async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'email', 'role', 'password']);
    const user = await User.create({
      name: String(req.body.name).trim(),
      email: String(req.body.email).trim().toLowerCase(),
      password_hash: bcrypt.hashSync(String(req.body.password), 10),
      role: String(req.body.role).trim().toLowerCase(),
      status: req.body.status || 'Active',
    });
    res.status(201).json({ id: user._id });
  } catch (error) {
    if (error.code === 11000) { next(createError(409, 'A user with this email already exists')); return; }
    next(error);
  }
});

app.post('/api/customers', ensureAuthenticated, ensureRole('customers'), async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'type']);
    const doc = await Customer.create({
      name: req.body.name, type: req.body.type,
      phone: req.body.phone || '', email: req.body.email || '',
      address: req.body.address || '', status: req.body.status || 'Active',
    });
    res.status(201).json({ id: doc._id });
  } catch (error) { next(error); }
});

app.post('/api/vendors', ensureAuthenticated, ensureRole('vendors'), async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'category']);
    const doc = await Vendor.create({
      name: req.body.name, category: req.body.category,
      phone: req.body.phone || '', email: req.body.email || '',
      address: req.body.address || '', status: req.body.status || 'Active',
    });
    res.status(201).json({ id: doc._id });
  } catch (error) { next(error); }
});

app.post('/api/inventory', ensureAuthenticated, ensureRole('inventory'), async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'category', 'quantity', 'unit', 'reorderLevel', 'unitCost']);
    const quantity = Number(req.body.quantity);
    const reorderLevel = Number(req.body.reorderLevel);
    const timestamp = nowIso();
    const doc = await InventoryItem.create({
      name: req.body.name, category: req.body.category, quantity, unit: req.body.unit,
      reorder_level: reorderLevel, unit_cost: Number(req.body.unitCost),
      status: computeInventoryStatus(quantity, reorderLevel), last_updated: timestamp,
    });
    res.status(201).json({ id: doc._id });
  } catch (error) { next(error); }
});

app.post('/api/machines', ensureAuthenticated, ensureRole('machines'), async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'status']);
    const doc = await Machine.create({
      name: req.body.name, status: req.body.status,
      output_per_hour: req.body.outputPerHour || null,
      last_maintenance: req.body.lastMaintenance || null,
      operator: req.body.operator || '',
    });
    res.status(201).json({ id: doc._id });
  } catch (error) { next(error); }
});

app.post('/api/production', ensureAuthenticated, ensureRole('production'), async (req, res, next) => {
  try {
    requireFields(req.body, ['product', 'quantity', 'startTime', 'machine', 'status']);
    const batchCode = await nextCode(ProductionBatch, 'batch_code', 'B');
    const quantity = Number(req.body.quantity);
    const doc = await ProductionBatch.create({
      batch_code: batchCode, product: req.body.product, quantity,
      start_time: req.body.startTime, machine: req.body.machine,
      operator: req.body.operator || '', status: req.body.status,
      cost: Number(req.body.cost || 0), wastage: Number(req.body.wastage || 0),
    });
    if (req.body.status === 'Completed') await adjustInventoryQuantity(req.body.product, quantity);
    res.status(201).json({ id: doc._id, batchCode });
  } catch (error) { next(error); }
});

app.post('/api/sales', ensureAuthenticated, ensureRole('sales'), async (req, res, next) => {
  try {
    requireFields(req.body, ['customerId', 'product', 'quantity', 'amount', 'orderDate', 'source', 'status']);
    const orderCode = await nextCode(SalesOrder, 'order_code', 'SO');
    const quantity = Number(req.body.quantity);
    const amount = Number(req.body.amount);

    const so = await SalesOrder.create({
      order_code: orderCode, customer_id: req.body.customerId,
      product: req.body.product, quantity, amount,
      order_date: req.body.orderDate, source: req.body.source, status: req.body.status,
    });

    let invoiceCode = null;
    if (req.body.status !== 'Cancelled') {
      invoiceCode = await nextCode(Invoice, 'invoice_code', 'INV');
      const inv = await Invoice.create({
        invoice_code: invoiceCode, customer_id: req.body.customerId,
        sales_order_id: so._id, amount,
        issue_date: req.body.orderDate,
        due_date: req.body.dueDate || req.body.orderDate,
        status: req.body.invoiceStatus || 'Pending',
      });
      await SalesOrder.updateOne({ _id: so._id }, { invoice_id: inv._id });
      await adjustInventoryQuantity(req.body.product, -quantity);
    }

    await refreshCustomerStats();
    await createAccountingEntry('Income', 'Sales Revenue', amount, `Sales order ${orderCode}`, req.body.orderDate);
    res.status(201).json({ id: so._id, orderCode, invoiceCode });
  } catch (error) { next(error); }
});

app.post('/api/invoices', ensureAuthenticated, ensureRole('invoices'), async (req, res, next) => {
  try {
    requireFields(req.body, ['customerId', 'amount', 'issueDate', 'dueDate', 'status']);
    const invoiceCode = await nextCode(Invoice, 'invoice_code', 'INV');
    const doc = await Invoice.create({
      invoice_code: invoiceCode, customer_id: req.body.customerId,
      sales_order_id: req.body.salesOrderId || null,
      amount: Number(req.body.amount),
      issue_date: req.body.issueDate, due_date: req.body.dueDate, status: req.body.status,
    });
    await refreshCustomerStats();
    res.status(201).json({ id: doc._id, invoiceCode });
  } catch (error) { next(error); }
});

app.post('/api/purchaseOrders', ensureAuthenticated, ensureRole('purchaseOrders'), async (req, res, next) => {
  try {
    requireFields(req.body, ['vendorId', 'item', 'quantity', 'amount', 'status']);
    const poCode = await nextCode(PurchaseOrder, 'po_code', 'PO');
    const doc = await PurchaseOrder.create({
      po_code: poCode, vendor_id: req.body.vendorId,
      item: req.body.item, quantity: Number(req.body.quantity),
      amount: Number(req.body.amount), required_by: req.body.requiredBy || null,
      status: req.body.status, notes: req.body.notes || '',
    });
    if (req.body.status === 'Received') await adjustInventoryQuantity(req.body.item, Number(req.body.quantity));
    await createAccountingEntry('Expense', 'Supplier Payment', Number(req.body.amount), `Purchase order ${poCode}`, req.body.requiredBy || new Date().toISOString().slice(0, 10));
    res.status(201).json({ id: doc._id, poCode });
  } catch (error) { next(error); }
});

app.post('/api/accounting', ensureAuthenticated, ensureRole('accounting'), async (req, res, next) => {
  try {
    requireFields(req.body, ['type', 'category', 'amount', 'entryDate', 'description']);
    await createAccountingEntry(req.body.type, req.body.category, Number(req.body.amount), req.body.description, req.body.entryDate);
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   UPDATE ROUTES
   ═══════════════════════════════════════════════ */

app.put('/api/users/:id', ensureAuthenticated, ensureRole('users'), async (req, res, next) => {
  try {
    const update = {};
    if (req.body.name) update.name = String(req.body.name).trim();
    if (req.body.email) update.email = String(req.body.email).trim().toLowerCase();
    if (req.body.role) update.role = String(req.body.role).trim().toLowerCase();
    if (req.body.status) update.status = req.body.status;
    if (req.body.password) update.password_hash = bcrypt.hashSync(String(req.body.password), 10);
    await User.updateOne({ _id: req.params.id }, update);
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 11000) { next(createError(409, 'A user with this email already exists')); return; }
    next(error);
  }
});

app.put('/api/invoices/:id/status', ensureAuthenticated, ensureRole('invoices'), async (req, res, next) => {
  try {
    requireFields(req.body, ['status']);
    await Invoice.updateOne({ _id: req.params.id }, { status: req.body.status });
    await refreshCustomerStats();
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.put('/api/machines/:id/status', ensureAuthenticated, ensureRole('machines'), async (req, res, next) => {
  try {
    requireFields(req.body, ['status']);
    await Machine.updateOne({ _id: req.params.id }, { status: req.body.status });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   FACTORY EQUIPMENT (inventory equipment tab)
   ═══════════════════════════════════════════════ */

app.get('/api/factory-equipment', ensureAuthenticated, async (req, res, next) => {
  try {
    const rows = await FactoryEquipment.find().sort({ code: 1 }).lean();
    res.json(rows.map(r => ({
      id: r._id, code: r.code, equipment: r.equipment, details: r.details,
      status: r.status, lastMaintenance: r.lastMaintenance, nextMaintenance: r.nextMaintenance,
    })));
  } catch (error) { next(error); }
});

app.put('/api/factory-equipment/:id', ensureAuthenticated, async (req, res, next) => {
  try {
    const update = {};
    if (req.body.status) update.status = req.body.status;
    if (req.body.equipment) update.equipment = req.body.equipment;
    if (req.body.details !== undefined) update.details = req.body.details;
    if (req.body.lastMaintenance !== undefined) update.lastMaintenance = req.body.lastMaintenance;
    if (req.body.nextMaintenance !== undefined) update.nextMaintenance = req.body.nextMaintenance;
    await FactoryEquipment.updateOne({ _id: req.params.id }, update);
    if (typeof broadcastSseEvent === 'function') broadcastSseEvent('data_updated', { key: 'ww_equipment' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/factory-equipment', ensureAuthenticated, async (req, res, next) => {
  try {
    requireFields(req.body, ['code', 'equipment', 'status']);
    const doc = await FactoryEquipment.create({
      code: req.body.code, equipment: req.body.equipment,
      details: req.body.details || '', status: req.body.status,
      lastMaintenance: req.body.lastMaintenance || null,
      nextMaintenance: req.body.nextMaintenance || null,
    });
    if (typeof broadcastSseEvent === 'function') broadcastSseEvent('data_updated', { key: 'ww_equipment' });
    res.status(201).json({ id: doc._id, code: doc.code });
  } catch (error) { next(error); }
});

app.delete('/api/factory-equipment/:id', ensureAuthenticated, async (req, res, next) => {
  try {
    const record = await FactoryEquipment.findById(req.params.id).lean();
    if (!record) throw createError(404, 'Equipment not found');
    await moveToTrash('factory-equipment', record, `${req.user.name} (${req.user.role})`);
    await FactoryEquipment.deleteOne({ _id: req.params.id });
    if (typeof broadcastSseEvent === 'function') broadcastSseEvent('data_updated', { key: 'ww_equipment' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   DELETE ROUTE  (soft-delete → trash bin)
   ═══════════════════════════════════════════════ */

const TRASH_TTL_DAYS = 30;

// BUG FIX: recentRestoreByUser was an in-memory Map. On serverless/Vercel each
// request may hit a different instance so popRecentRestore always returned undefined,
// making undo silently do nothing. Replaced with AppData persistence so undo works
// correctly across any server instance. Entries auto-expire after 5 minutes.
const RESTORE_TTL_MS = 5 * 60 * 1000;
const RECENT_RESTORE_KEY = 'ww_recent_restores';

function restoreActorKey(user) {
  if (!user) return 'anon';
  return String(user.id || user._id || user.email || user.name || 'anon');
}

async function rememberRecentRestore(user, action) {
  const actorKey = restoreActorKey(user);
  const doc = await AppData.findOne({ key: RECENT_RESTORE_KEY }).lean();
  const map = (doc && doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data)) ? { ...doc.data } : {};
  // Evict expired entries while we're here
  const now = Date.now();
  for (const k of Object.keys(map)) {
    if (!map[k].recordedAt || now - map[k].recordedAt > RESTORE_TTL_MS) delete map[k];
  }
  map[actorKey] = { ...action, recordedAt: now };
  await AppData.updateOne({ key: RECENT_RESTORE_KEY }, { key: RECENT_RESTORE_KEY, data: map }, { upsert: true });
}

async function popRecentRestore(user) {
  const actorKey = restoreActorKey(user);
  const doc = await AppData.findOne({ key: RECENT_RESTORE_KEY }).lean();
  if (!doc || !doc.data || typeof doc.data !== 'object') return undefined;
  const map = { ...doc.data };
  const action = map[actorKey];
  if (!action) return undefined;
  // Check expiry
  if (!action.recordedAt || Date.now() - action.recordedAt > RESTORE_TTL_MS) {
    delete map[actorKey];
    await AppData.updateOne({ key: RECENT_RESTORE_KEY }, { key: RECENT_RESTORE_KEY, data: map }, { upsert: true });
    return undefined;
  }
  delete map[actorKey];
  await AppData.updateOne({ key: RECENT_RESTORE_KEY }, { key: RECENT_RESTORE_KEY, data: map }, { upsert: true });
  return action;
}

async function moveToTrash(module, record, deletedBy, restoreMeta = null) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + TRASH_TTL_DAYS);
  return TrashBin.create({
    module,
    record_data: record,
    restore_meta: restoreMeta,
    deleted_by: deletedBy,
    deleted_at: new Date(),
    expires_at: expiresAt,
  });
}

async function restoreTrashAppDataItem(trashItem) {
  const meta = trashItem && trashItem.restore_meta ? trashItem.restore_meta : null;
  if (!meta || !meta.kind) throw createError(400, 'Unsupported restore metadata kind');

  if (meta.kind === 'appDataArray') {
    const key = String(meta.key || '').trim();
    if (!isAllowedDataKey(key)) throw createError(400, 'Cannot restore to invalid app-data key');

    if (meta.arrayPath) {
      // Safe read-modify-write: avoids $push/$pull race and ensures normalize
      // sees the restored record alongside its linked invoice/order.
      const existingDoc = await AppData.findOne({ key }).lean();
      const payload = (existingDoc && existingDoc.data && typeof existingDoc.data === 'object' && !Array.isArray(existingDoc.data))
        ? { ...existingDoc.data }
        : { invoices: [], salesOrders: [], deletedInvoiceIds: [], deletedOrderIds: [] };

      const restoredRecord = trashItem.record_data;
      const restoredId = String((restoredRecord && restoredRecord.id) || '').trim();

      // 1. Remove the ID from the deleted-IDs tombstone list FIRST
      if (meta.arrayPath === 'invoices' && restoredId) {
        payload.deletedInvoiceIds = (Array.isArray(payload.deletedInvoiceIds) ? payload.deletedInvoiceIds : [])
          .filter((id) => String(id || '').trim() !== restoredId);
      }
      if (meta.arrayPath === 'salesOrders' && restoredId) {
        payload.deletedOrderIds = (Array.isArray(payload.deletedOrderIds) ? payload.deletedOrderIds : [])
          .filter((id) => String(id || '').trim() !== restoredId);
      }

      // 2. Add the record back into its array (replace if already present by id, else append)
      const arr = Array.isArray(payload[meta.arrayPath]) ? payload[meta.arrayPath] : [];
      const existingIdx = restoredId ? arr.findIndex((r) => String(r && r.id || '').trim() === restoredId) : -1;
      if (existingIdx >= 0) {
        arr[existingIdx] = restoredRecord;
      } else {
        arr.push(restoredRecord);
      }
      payload[meta.arrayPath] = arr;

      // 3. Write back without running normalizeSalesMonthPayload yet — the caller
      //    (restore endpoint) may push linked orders immediately after, so we do a
      //    raw write here and let the next read normalize naturally.
      await AppData.updateOne({ key }, { $set: { key, data: payload } }, { upsert: true });
    } else {
      const doc = await AppData.findOne({ key }).lean();
      const current = Array.isArray(doc && doc.data) ? doc.data : [];
      current.push(trashItem.record_data);
      await AppData.updateOne(
        { key },
        { $set: { key, data: current } },
        { upsert: true }
      );
    }

    await TrashBin.deleteOne({ _id: trashItem._id });
    return {
      kind: 'appDataRestore',
      module: trashItem.module,
      recordData: trashItem.record_data,
      restoreMeta: trashItem.restore_meta || null,
    };
  }

  if (meta.kind === 'bomComponent') {
    const key = String(meta.key || '').trim();
    const product = String(meta.product || '').trim();
    if (!isAllowedDataKey(key) || !product) throw createError(400, 'Cannot restore BOM component');

    const doc = await AppData.findOne({ key }).lean();
    const data = (doc && doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data)) ? doc.data : {};
    const productData = (data[product] && typeof data[product] === 'object') ? data[product] : { components: [], labor: 0, overhead: 0 };
    const components = Array.isArray(productData.components) ? productData.components : [];
    components.push(trashItem.record_data);
    productData.components = components;
    data[product] = productData;

    await AppData.updateOne({ key }, { $set: { key, data } }, { upsert: true });
    await TrashBin.deleteOne({ _id: trashItem._id });
    return {
      kind: 'appDataRestore',
      module: trashItem.module,
      recordData: trashItem.record_data,
      restoreMeta: trashItem.restore_meta || null,
    };
  }

  throw createError(400, 'Unsupported restore metadata kind');
}

async function undoSingleRestoreAction(action, user) {
  if (action.kind === 'appDataRestore') {
    const meta = action.restoreMeta || {};
    const key = String(meta.key || '').trim();
    if (!isAllowedDataKey(key)) throw createError(400, 'Undo failed: invalid restore key');

    if (meta.kind === 'appDataArray') {
      // BUG FIX: $pull with the full object does deep equality matching — if any field
      // changed after restore (e.g. updatedAt), $pull silently fails and the record
      // stays alive. Instead, read-modify-write by filtering on the stable id field.
      if (meta.arrayPath) {
        const restoredId = String((action.recordData && action.recordData.id) || '').trim();
        if (!restoredId) throw createError(400, 'Undo failed: restored record has no id');
        const existingDoc = await AppData.findOne({ key }).lean();
        const payload = (existingDoc && existingDoc.data && typeof existingDoc.data === 'object' && !Array.isArray(existingDoc.data))
          ? { ...existingDoc.data }
          : { invoices: [], salesOrders: [], deletedInvoiceIds: [], deletedOrderIds: [] };
        const arr = Array.isArray(payload[meta.arrayPath]) ? payload[meta.arrayPath] : [];
        payload[meta.arrayPath] = arr.filter((r) => String(r && r.id || '').trim() !== restoredId);
        // Re-add to tombstone list so the record stays deleted across future merges
        if (meta.arrayPath === 'invoices') {
          const tombstone = new Set((Array.isArray(payload.deletedInvoiceIds) ? payload.deletedInvoiceIds : []).map(String));
          tombstone.add(restoredId);
          payload.deletedInvoiceIds = Array.from(tombstone);
        }
        if (meta.arrayPath === 'salesOrders') {
          const tombstone = new Set((Array.isArray(payload.deletedOrderIds) ? payload.deletedOrderIds : []).map(String));
          tombstone.add(restoredId);
          payload.deletedOrderIds = Array.from(tombstone);
        }
        await AppData.updateOne({ key }, { $set: { key, data: payload } }, { upsert: true });
      } else {
        // Non-array-path variant: filter by id if available, else fall back to equality
        const restoredId = String((action.recordData && action.recordData.id) || '').trim();
        const existingDoc = await AppData.findOne({ key }).lean();
        const current = Array.isArray(existingDoc && existingDoc.data) ? existingDoc.data : [];
        const updated = restoredId
          ? current.filter((r) => String(r && r.id || '').trim() !== restoredId)
          : current.filter((r) => JSON.stringify(r) !== JSON.stringify(action.recordData));
        await AppData.updateOne({ key }, { $set: { key, data: updated } }, { upsert: true });
      }
    } else if (meta.kind === 'bomComponent') {
      const product = String(meta.product || '').trim();
      if (!product) throw createError(400, 'Undo failed: invalid BOM product');
      // BUG FIX: same $pull equality issue — use read-modify-write with id filter
      const restoredId = String((action.recordData && action.recordData.id) || '').trim();
      const existingDoc = await AppData.findOne({ key }).lean();
      const data = (existingDoc && existingDoc.data && typeof existingDoc.data === 'object' && !Array.isArray(existingDoc.data))
        ? { ...existingDoc.data }
        : {};
      const productData = (data[product] && typeof data[product] === 'object') ? data[product] : { components: [], labor: 0, overhead: 0 };
      const components = Array.isArray(productData.components) ? productData.components : [];
      productData.components = restoredId
        ? components.filter((c) => String(c && c.id || '').trim() !== restoredId)
        : components.filter((c) => JSON.stringify(c) !== JSON.stringify(action.recordData));
      data[product] = productData;
      await AppData.updateOne({ key }, { $set: { key, data } }, { upsert: true });
    } else {
      throw createError(400, 'Undo failed: unsupported restore metadata');
    }

    await moveToTrash(action.module, action.recordData, `${user.name} (${user.role})`, action.restoreMeta || null);
    if (action.module === 'sales' || action.module === 'invoices') await refreshCustomerStats();
    if (action.module === 'inventory') await refreshInventoryStatuses();
    return;
  }

  if (action.kind === 'modelRestore') {
    const restoreMap = {
      users: User, customers: Customer, vendors: Vendor,
      inventory: InventoryItem, machines: Machine, production: ProductionBatch,
      sales: SalesOrder, invoices: Invoice, accounting: AccountingEntry,
      purchaseOrders: PurchaseOrder, 'factory-equipment': FactoryEquipment,
    };
    const Model = restoreMap[action.module];
    if (!Model) throw createError(400, 'Undo failed: unsupported module');

    await Model.deleteOne({ _id: action.restoredId });
    await moveToTrash(action.module, action.recordData, `${user.name} (${user.role})`, action.restoreMeta || null);
    if (action.module === 'sales' || action.module === 'invoices') await refreshCustomerStats();
    if (action.module === 'inventory') await refreshInventoryStatuses();
    return;
  }

  throw createError(400, 'Undo failed: unsupported action type');
}

app.post('/api/trash/app-data-delete', ensureAuthenticated, async (req, res, next) => {
  try {
    requireFields(req.body, ['module', 'recordData', 'restoreMeta']);
    const module = String(req.body.module || '').trim();
    const recordData = req.body.recordData;
    const restoreMeta = req.body.restoreMeta;
    if (!module) throw createError(400, 'Invalid module');
    if (!restoreMeta || typeof restoreMeta !== 'object') throw createError(400, 'Invalid restore metadata');
    if (!restoreMeta.kind) throw createError(400, 'Restore metadata must include kind');

    // BUG FIX: Moving to trash alone is not enough — if the client later PUTs the full
    // month payload (which still contains this record), the merge loop will see the ID
    // is not in deletedInvoiceIds/deletedOrderIds and resurrect it. We must write the
    // tombstone into AppData BEFORE acknowledging the delete.
    if (restoreMeta.kind === 'appDataArray' && restoreMeta.arrayPath && restoreMeta.key) {
      const key = String(restoreMeta.key || '').trim();
      const restoredId = String((recordData && recordData.id) || '').trim();
      if (isAllowedDataKey(key) && restoredId) {
        const existingDoc = await AppData.findOne({ key }).lean();
        const payload = (existingDoc && existingDoc.data && typeof existingDoc.data === 'object' && !Array.isArray(existingDoc.data))
          ? { ...existingDoc.data }
          : { invoices: [], salesOrders: [], deletedInvoiceIds: [], deletedOrderIds: [] };

        if (restoreMeta.arrayPath === 'invoices') {
          const arr = Array.isArray(payload.invoices) ? payload.invoices : [];
          payload.invoices = arr.filter((r) => String(r && r.id || '').trim() !== restoredId);
          const tombstone = new Set((Array.isArray(payload.deletedInvoiceIds) ? payload.deletedInvoiceIds : []).map(String));
          tombstone.add(restoredId);
          payload.deletedInvoiceIds = Array.from(tombstone);
        } else if (restoreMeta.arrayPath === 'salesOrders') {
          const arr = Array.isArray(payload.salesOrders) ? payload.salesOrders : [];
          payload.salesOrders = arr.filter((r) => String(r && r.id || '').trim() !== restoredId);
          const tombstone = new Set((Array.isArray(payload.deletedOrderIds) ? payload.deletedOrderIds : []).map(String));
          tombstone.add(restoredId);
          payload.deletedOrderIds = Array.from(tombstone);
        }
        await AppData.updateOne({ key }, { $set: { key, data: payload } }, { upsert: true });
      }
    }

    await moveToTrash(module, recordData, `${req.user.name} (${req.user.role})`, restoreMeta);
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:resource/:id', ensureAuthenticated, async (req, res, next) => {
  try {
    const resource = req.params.resource;
    if (resource === 'trash') { next(); return; }
    ensureRole(resource)(req, res, (error) => { if (error) throw error; });

    const modelMap = {
      users: User, customers: Customer, vendors: Vendor,
      inventory: InventoryItem, machines: Machine, production: ProductionBatch,
      sales: SalesOrder, invoices: Invoice, accounting: AccountingEntry,
      purchaseOrders: PurchaseOrder,
    };

    const labelMap = {
      users: 'users', customers: 'customers', vendors: 'vendors',
      inventory: 'inventory', machines: 'machines', production: 'production',
      sales: 'sales', invoices: 'invoices', accounting: 'accounting',
      purchaseOrders: 'purchaseOrders',
    };

    const Model = modelMap[resource];
    if (!Model) throw createError(404, 'Unknown collection');

    const record = await Model.findById(req.params.id).lean();
    if (!record) throw createError(404, 'Record not found');

    if (resource === 'users' && String(req.params.id) === String(req.user.id)) {
      throw createError(400, 'You cannot delete your own account');
    }
    if (resource === 'users' && HIDDEN_EMAILS.includes(record.email)) {
      throw createError(403, 'This account cannot be deleted');
    }

    if (requireApprovalForRole(req.user) && resource !== 'accounting' && resource !== 'users') {
      const approvalId = await createApprovalRequest({
        requestType: 'Delete',
        moduleName: labelMap[resource],
        recordId: record._id,
        submittedBy: `${req.user.name} (${req.user.role})`,
        reason: req.body.reason || 'Delete request submitted from application',
        oldValues: record,
        newValues: { deleted: true },
      });
      res.status(202).json({ ok: true, approvalId, pending: true });
      return;
    }

    await moveToTrash(labelMap[resource], record, `${req.user.name} (${req.user.role})`);
    await Model.deleteOne({ _id: req.params.id });
    if (resource === 'sales' || resource === 'invoices') await refreshCustomerStats();
    if (resource === 'inventory') await refreshInventoryStatuses();
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   TRASH BIN  (managers only)
   ═══════════════════════════════════════════════ */

app.get('/api/trash', ensureAuthenticated, ensureRole('users'), async (_req, res, next) => {
  try {
    const items = await TrashBin.find().sort({ deleted_at: -1 }).lean();
    res.json(items.map(t => ({
      id: t._id,
      module: t.module,
      recordData: t.record_data,
      restoreMeta: t.restore_meta,
      deletedBy: t.deleted_by,
      deletedAt: t.deleted_at,
      expiresAt: t.expires_at,
    })));
  } catch (error) { next(error); }
});

app.post('/api/trash/:id/restore', ensureAuthenticated, ensureRole('users'), async (req, res, next) => {
  try {
    const trashItem = await TrashBin.findById(req.params.id);
    if (!trashItem) throw createError(404, 'Trash item not found');

    if (trashItem.restore_meta && trashItem.restore_meta.kind) {
      const meta = trashItem.restore_meta;
      const restoredActions = [];
      restoredActions.push(await restoreTrashAppDataItem(trashItem));

      // Invoices and sales are a linked pair in app-data payloads.
      // Restoring an invoice should also restore its linked sales order(s).
      if (trashItem.module === 'invoices' && meta.kind === 'appDataArray') {
        const key = String(meta.key || '').trim();
        const invoiceId = String((trashItem.record_data && trashItem.record_data.id) || '').trim();
        const derivedOrderId = invoiceId.startsWith('INV-') ? `SO${invoiceId.slice(3)}` : '';
        if (invoiceId && isAllowedDataKey(key)) {
          const salesTrashItems = await TrashBin.find({
            module: 'sales',
            'restore_meta.kind': 'appDataArray',
            'restore_meta.key': key,
            'restore_meta.arrayPath': 'salesOrders',
          }).sort({ deleted_at: -1 });

          const pickedBySalesId = new Set();
          for (const salesTrash of salesTrashItems) {
            const rd = salesTrash.record_data || {};
            const sourceInvoiceId = String(rd.sourceInvoiceId || '').trim();
            const salesId = String(rd.id || '').trim();
            const matchesInvoice = sourceInvoiceId === invoiceId || (derivedOrderId && salesId === derivedOrderId);
            if (!matchesInvoice) continue;
            const dedupeKey = salesId || String(salesTrash._id);
            if (pickedBySalesId.has(dedupeKey)) continue;
            pickedBySalesId.add(dedupeKey);
            restoredActions.push(await restoreTrashAppDataItem(salesTrash));
          }
        }
      }

      await rememberRecentRestore(
        req.user,
        restoredActions.length > 1 ? { kind: 'restoreBatch', actions: restoredActions } : restoredActions[0]
      );
      if (restoredActions.some((a) => a.module === 'sales' || a.module === 'invoices')) await refreshCustomerStats();
      if (restoredActions.some((a) => a.module === 'inventory')) await refreshInventoryStatuses();
      res.json({
        ok: true,
        restored: restoredActions.length,
        restoredLinkedSales: restoredActions.filter((a) => a.module === 'sales').length,
      });
      return;
    }

    const restoreMap = {
      users: User, customers: Customer, vendors: Vendor,
      inventory: InventoryItem, machines: Machine, production: ProductionBatch,
      sales: SalesOrder, invoices: Invoice, accounting: AccountingEntry,
      purchaseOrders: PurchaseOrder, 'factory-equipment': FactoryEquipment,
    };

    const Model = restoreMap[trashItem.module];
    if (!Model) throw createError(400, 'Cannot restore items from module: ' + trashItem.module);

    const data = { ...trashItem.record_data };
    const originalId = data._id;
    delete data._id;
    delete data.__v;
    delete data.id;

    const existing = originalId ? await Model.findById(originalId).lean() : null;
    if (existing) throw createError(409, 'A record with this ID already exists. It may have been re-created.');

    const restoredDoc = originalId
      ? await Model.create({ _id: originalId, ...data })
      : await Model.create(data);

    await rememberRecentRestore(req.user, {
      kind: 'modelRestore',
      module: trashItem.module,
      restoredId: String(restoredDoc._id),
      recordData: trashItem.record_data,
      restoreMeta: null,
    });

    await TrashBin.deleteOne({ _id: trashItem._id });

    if (trashItem.module === 'sales' || trashItem.module === 'invoices') await refreshCustomerStats();
    if (trashItem.module === 'inventory') await refreshInventoryStatuses();

    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/trash/restore/undo-last', ensureAuthenticated, ensureRole('users'), async (req, res, next) => {
  try {
    const action = await popRecentRestore(req.user);
    if (!action) throw createError(404, 'No recent restore to undo');

    if (action.kind === 'restoreBatch') {
      const actions = Array.isArray(action.actions) ? action.actions : [];
      for (let i = actions.length - 1; i >= 0; i -= 1) {
        await undoSingleRestoreAction(actions[i], req.user);
      }
      res.json({ ok: true, message: 'Last restore has been undone.' });
      return;
    }

    if (action.kind === 'appDataRestore') {
      await undoSingleRestoreAction(action, req.user);
      res.json({ ok: true, message: 'Last restore has been undone.' });
      return;
    }

    if (action.kind === 'modelRestore') {
      await undoSingleRestoreAction(action, req.user);
      res.json({ ok: true, message: 'Last restore has been undone.' });
      return;
    }

    throw createError(400, 'Undo failed: unsupported action type');
  } catch (error) {
    next(error);
  }
});

app.delete('/api/trash/:id', ensureAuthenticated, ensureRole('users'), async (req, res, next) => {
  try {
    const result = await TrashBin.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) throw createError(404, 'Trash item not found');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   APPROVAL DECISION
   ═══════════════════════════════════════════════ */

app.post('/api/approvals/:id/decision', ensureAuthenticated, ensureRole('approvals'), async (req, res, next) => {
  try {
    requireFields(req.body, ['decision']);
    const approvalId = req.params.id;
    const decision = String(req.body.decision);
    const timestamp = nowIso();

    if (decision === 'approve') {
      await applyApprovalMutation(approvalId);
      await Approval.updateOne({ _id: approvalId }, { status: 'Approved', decided_by: req.user.name, decided_at: timestamp });
    } else if (decision === 'reject') {
      await Approval.updateOne({ _id: approvalId }, { status: 'Rejected', decided_by: req.user.name, decided_at: timestamp });
    } else {
      await Approval.updateOne({ _id: approvalId }, { status: 'Clarification Requested', decided_by: req.user.name, decided_at: timestamp });
    }

    await refreshCustomerStats();
    await refreshInventoryStatuses();
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   CUSTOMER STORE API
   ═══════════════════════════════════════════════ */

app.get('/api/store/products', async (_req, res) => {
  const products = await StoreProduct.find({ available: true }).sort({ sort_order: 1, name: 1 }).lean();
  res.json(products.map(p => ({ id: p._id, name: p.name, description: p.description, price: p.price, unit: p.unit, min_order: p.min_order, image: p.image })));
});

app.post('/api/store/register', async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'email', 'phone', 'password']);
    const { name, email, phone, password, address, city, region } = req.body;
    if (password.length < 6) throw createError(400, 'Password must be at least 6 characters');

    const existing = await StoreCustomer.findOne({ email: email.toLowerCase().trim() });
    if (existing) throw createError(409, 'An account with this email already exists');

    const customer = await StoreCustomer.create({
      name: name.trim(), email: email.toLowerCase().trim(), phone: phone.trim(),
      password_hash: bcrypt.hashSync(password, 10),
      address: address || null, city: city || null, region: region || null,
    });

    const token = crypto.randomUUID();
    await StoreSession.create({ token, customer_id: customer._id, expires_at: new Date(Date.now() + SESSION_AGE_MS).toISOString() });

    res.cookie('ww_store_session', token, cookieOpts(SESSION_AGE_MS));
    res.status(201).json({ ok: true, customer: { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone } });
  } catch (error) {
    if (error.code === 11000) { next(createError(409, 'An account with this email already exists')); return; }
    next(error);
  }
});

app.post('/api/store/login', async (req, res, next) => {
  try {
    requireFields(req.body, ['email', 'password']);
    const { email, password } = req.body;
    const customer = await StoreCustomer.findOne({ email: email.toLowerCase().trim() });
    if (!customer || !bcrypt.compareSync(password, customer.password_hash)) throw createError(401, 'Invalid email or password');
    if (customer.status !== 'Active') throw createError(403, 'Your account has been suspended');

    const token = crypto.randomUUID();
    await StoreSession.create({ token, customer_id: customer._id, expires_at: new Date(Date.now() + SESSION_AGE_MS).toISOString() });

    res.cookie('ww_store_session', token, cookieOpts(SESSION_AGE_MS));
    res.json({ ok: true, customer: { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone } });
  } catch (error) { next(error); }
});

app.post('/api/store/logout', async (req, res) => {
  const token = req.cookies.ww_store_session;
  if (token) await StoreSession.deleteOne({ token });
  res.clearCookie('ww_store_session');
  res.json({ ok: true });
});

async function getStoreCustomer(token) {
  if (!token) return null;
  const session = await StoreSession.findOne({ token }).populate('customer_id');
  if (!session || !session.customer_id) return null;
  if (Date.parse(session.expires_at) < Date.now()) {
    await StoreSession.deleteOne({ token });
    return null;
  }
  const c = session.customer_id;
  return { id: c._id, name: c.name, email: c.email, phone: c.phone, address: c.address, city: c.city, region: c.region };
}

app.get('/api/store/me', async (req, res) => {
  const customer = await getStoreCustomer(req.cookies.ww_store_session);
  if (!customer) return res.status(401).json({ message: 'Not authenticated' });
  res.json({ ok: true, customer });
});

app.post('/api/store/orders', async (req, res, next) => {
  try {
    const customer = await getStoreCustomer(req.cookies.ww_store_session);
    if (!customer) throw createError(401, 'Please log in to place an order');

    requireFields(req.body, ['items', 'deliveryAddress', 'phone']);
    const { items, deliveryAddress, deliveryCity, deliveryRegion, phone, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) throw createError(400, 'Order must have at least one item');

    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      const product = await StoreProduct.findOne({ _id: item.productId, available: true }).lean();
      if (!product) throw createError(400, 'Product not found or unavailable');
      const qty = Math.max(product.min_order, Math.floor(Number(item.qty) || 0));
      const lineTotal = qty * product.price;
      subtotal += lineTotal;
      validatedItems.push({ productId: product._id, name: product.name, qty, unitPrice: product.price, lineTotal });
    }

    const deliveryFee = 0;
    const total = subtotal + deliveryFee;

    // Generate order code
    const lastOrder = await StoreOrder.findOne().sort({ createdAt: -1 }).lean();
    let orderNum = 1;
    if (lastOrder?.order_code) {
      const parts = lastOrder.order_code.split('-');
      orderNum = (Number(parts[parts.length - 1]) || 0) + 1;
    }
    const orderCode = `WW-${new Date().getFullYear()}-${String(orderNum).padStart(4, '0')}`;

    const storeOrder = await StoreOrder.create({
      order_code: orderCode, customer_id: customer.id,
      items: validatedItems, subtotal, delivery_fee: deliveryFee,
      total, delivery_address: deliveryAddress,
      delivery_city: deliveryCity || null, delivery_region: deliveryRegion || null,
      phone, notes: notes || null,
    });

    // Create a matching internal sales_order + invoice
    let internalCustomer = await Customer.findOne({ email: customer.email }).lean();
    if (!internalCustomer) {
      internalCustomer = await Customer.create({
        name: customer.name, type: 'Online',
        phone: customer.phone, email: customer.email,
        address: deliveryAddress, status: 'Active',
      });
    }

    const soCode = await nextCode(SalesOrder, 'order_code', 'SO');
    const invCode = soCode.replace('SO', 'INV');
    const issueDate = nowIso().slice(0, 10);
    const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const so = await SalesOrder.create({
      order_code: soCode, customer_id: internalCustomer._id,
      product: validatedItems.map(i => i.name).join(', '),
      quantity: validatedItems.reduce((s, i) => s + i.qty, 0),
      amount: total, order_date: issueDate, source: 'Online Store', status: 'Pending',
    });

    const inv = await Invoice.create({
      invoice_code: invCode, customer_id: internalCustomer._id,
      sales_order_id: so._id, amount: total,
      issue_date: issueDate, due_date: dueDate, status: 'Pending',
    });

    await SalesOrder.updateOne({ _id: so._id }, { invoice_id: inv._id });
    await refreshCustomerStats();

    res.status(201).json({ ok: true, order: { id: storeOrder._id, orderCode, total, status: 'Pending' } });
  } catch (error) { next(error); }
});

app.get('/api/store/orders', async (req, res, next) => {
  try {
    const customer = await getStoreCustomer(req.cookies.ww_store_session);
    if (!customer) throw createError(401, 'Please log in to view orders');

    const orders = await StoreOrder.find({ customer_id: customer.id }).sort({ createdAt: -1 }).lean();
    res.json(orders.map(o => ({
      id: o._id, orderCode: o.order_code, items: o.items,
      subtotal: o.subtotal, deliveryFee: o.delivery_fee, total: o.total,
      deliveryAddress: o.delivery_address, phone: o.phone,
      notes: o.notes, status: o.status, createdAt: o.createdAt,
    })));
  } catch (error) { next(error); }
});

const handleStoreAdminOrders = async (req, res, next) => {
  try {
    const orders = await StoreOrder.find().populate('customer_id').sort({ createdAt: -1 }).lean();
    res.json(orders.map(o => ({
      ...o, id: o._id,
      customerName: o.customer_id?.name, customerEmail: o.customer_id?.email, customerPhone: o.customer_id?.phone,
    })));
  } catch (error) { next(error); }
};

app.get('/api/store/admin/orders', attachUser, ensureAuthenticated, handleStoreAdminOrders);
app.post('/api/store/admin/orders', attachUser, ensureAuthenticated, handleStoreAdminOrders);

const handleStoreAdminOrderStatus = async (req, res, next) => {
  try {
    requireFields(req.body, ['status']);
    const validStatuses = ['Pending', 'Confirmed', 'Processing', 'Dispatched', 'Delivered', 'Cancelled'];
    if (!validStatuses.includes(req.body.status)) throw createError(400, 'Invalid status');
    await StoreOrder.updateOne({ _id: req.params.id }, { status: req.body.status });
    res.json({ ok: true });
  } catch (error) { next(error); }
};

app.put('/api/store/admin/orders/:id/status', attachUser, ensureAuthenticated, handleStoreAdminOrderStatus);
app.patch('/api/store/admin/orders/:id/status', attachUser, ensureAuthenticated, handleStoreAdminOrderStatus);
app.post('/api/store/admin/orders/:id/status', attachUser, ensureAuthenticated, handleStoreAdminOrderStatus);

const handleStoreAdminStats = async (_req, res) => {
  const [customerCount, orderCount, pendingOrders, revenueAgg] = await Promise.all([
    StoreCustomer.countDocuments(),
    StoreOrder.countDocuments(),
    StoreOrder.countDocuments({ status: 'Pending' }),
    StoreOrder.aggregate([{ $group: { _id: null, t: { $sum: '$total' } } }]),
  ]);
  res.json({ customerCount, orderCount, pendingOrders, totalRevenue: revenueAgg[0]?.t || 0 });
};

app.get('/api/store/admin/stats', attachUser, ensureAuthenticated, handleStoreAdminStats);
app.post('/api/store/admin/stats', attachUser, ensureAuthenticated, handleStoreAdminStats);

// ── HARD DELETE: wipe all sales, invoices, store orders, and re-sync ──
app.delete('/api/admin/purge-sales-and-invoices', attachUser, ensureAuthenticated, ensureRole('production'), async (req, res, next) => {
  try {
    // Only allow CEO
    if (req.user.role !== 'ceo') {
      return next(createError(403, 'Only a CEO can perform this action'));
    }

    // 1. Delete all sales orders and invoices
    await SalesOrder.deleteMany({});
    await Invoice.deleteMany({});

    // 2. Delete all store orders (they auto-create sales+invoices)
    await StoreOrder.deleteMany({});

    // 3. Remove synced sales app-data so the browser cannot rehydrate stale figures
    await AppData.deleteMany({ key: /^ww_sales_/ });

    // 4. Clean matching trash entries for these modules
    await TrashBin.deleteMany({ module: { $in: ['sales', 'invoices'] } });

    // 5. Reset customer stats (total_orders, outstanding) to zero
    await Customer.updateMany({}, { total_orders: 0, outstanding: 0 });

    // 6. Re-run the stats refresh on clean data
    await refreshCustomerStats();

    res.json({ ok: true, message: 'All sales, invoices, and store orders purged. Customer stats reset.' });
  } catch (error) {
    next(error);
  }
});

/* ═══════════════════════════════════════════════
   ERROR HANDLING + START
   ═══════════════════════════════════════════════ */

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) { next(createError(404, 'Route not found')); return; }
  res.status(404).send('Page not found');
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({ message: error.message || 'Unexpected server error' });
});

if (!process.env.VERCEL) {
  const start = async () => {
    let connected = false;
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await connectDB();
        connected = true;
        break;
      } catch (err) {
        console.error(`[DB] Connection attempt ${attempt}/${maxAttempts} failed:`, err.message);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    }

    if (!connected) {
      console.error('[DB] Could not establish MongoDB connection after retries.');
      process.exit(1);
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  };

  start();
}

module.exports = app;