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
} = require('./server/db');

const app = express();
const rootDir = __dirname;
const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE = 'ww_session';
const SESSION_AGE_MS = 1000 * 60 * 60 * 12;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    if (!req.user || !allowedRoles.includes(req.user.role)) {
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
  const docs = await Model.find({}, field).lean();
  if (!docs.length) return `${prefix}-${year}-${padCode(1)}`;

  let maxSuffix = 0;
  for (const doc of docs) {
    const code = doc[field];
    const parts = String(code).split('-');
    const num = Number(parts[parts.length - 1]);
    if (Number.isFinite(num) && num > maxSuffix) maxSuffix = num;
  }
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
      const rows = await User.find().sort({ createdAt: -1 }).lean();
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
      const rows = await Invoice.find().populate('customer_id').populate('sales_order_id').sort({ createdAt: -1 }).lean();
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
    res.json({
      user: { id: user._id, name: user.name, email: user.email, role: user.role, status: user.status },
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
    if (!user) { res.json({ message: 'If the account exists, reset instructions have been sent.' }); return; }
    res.json({ message: 'Reset instructions generated. Use the reset password form below.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    requireFields(req.body, ['email', 'newPassword']);
    const email = String(req.body.email).trim().toLowerCase();
    const newPassword = String(req.body.newPassword);
    if (newPassword.length < 6) throw createError(400, 'New password must be at least 6 characters');

    const result = await User.updateOne({ email }, { password_hash: bcrypt.hashSync(newPassword, 10) });
    if (!result.modifiedCount) throw createError(404, 'No user found with this email');

    const user = await User.findOne({ email });
    if (user) await Session.deleteMany({ user_id: user._id });

    res.json({ message: 'Password reset successful. Please sign in with your new password.' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) { res.status(401).json({ message: 'Not signed in' }); return; }
  res.json({ user: req.user });
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

app.get('/api/:resource', ensureAuthenticated, async (req, res, next) => {
  try {
    const resource = req.params.resource;
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
    res.status(201).json({ id: doc._id, code: doc.code });
  } catch (error) { next(error); }
});

app.delete('/api/factory-equipment/:id', ensureAuthenticated, async (req, res, next) => {
  try {
    await FactoryEquipment.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   APP DATA (generic key-value persistence)
   ═══════════════════════════════════════════════ */

const ALLOWED_DATA_KEYS = [
  'ww_raw_materials', 'ww_finished_products', 'ww_production_batches',
  'ww_daily_production', 'ww_purchase_data_v2', 'ww_accounting_data_v2',
  'ww_waybills', 'ww_cost_centre_budgets', 'ww_bom_data',
  'ww_sales_months', 'ww_equipment', 'ww_seed_flags',
];

function isAllowedDataKey(key) {
  if (ALLOWED_DATA_KEYS.includes(key)) return true;
  if (/^ww_sales_\d{4}-\d{2}$/.test(key)) return true;
  return false;
}

app.get('/api/app-data/:key', ensureAuthenticated, async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!isAllowedDataKey(key)) return res.status(400).json({ message: 'Invalid key' });
    const doc = await AppData.findOne({ key }).lean();
    res.json({ key, data: doc ? doc.data : null });
  } catch (error) { next(error); }
});

app.put('/api/app-data/:key', ensureAuthenticated, async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!isAllowedDataKey(key)) return res.status(400).json({ message: 'Invalid key' });
    await AppData.updateOne({ key }, { key, data: req.body.data }, { upsert: true });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/app-data-bulk', ensureAuthenticated, async (req, res, next) => {
  try {
    const keys = (req.query.keys || '').split(',').filter(k => isAllowedDataKey(k));
    if (!keys.length) return res.json({ items: [] });
    const docs = await AppData.find({ key: { $in: keys } }).lean();
    const map = {};
    docs.forEach(d => { map[d.key] = d.data; });
    res.json({ items: map });
  } catch (error) { next(error); }
});

/* ═══════════════════════════════════════════════
   DELETE ROUTE
   ═══════════════════════════════════════════════ */

app.delete('/api/:resource/:id', ensureAuthenticated, async (req, res, next) => {
  try {
    const resource = req.params.resource;
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

    await Model.deleteOne({ _id: req.params.id });
    if (resource === 'sales' || resource === 'invoices') await refreshCustomerStats();
    if (resource === 'inventory') await refreshInventoryStatuses();
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

app.get('/api/store/admin/orders', attachUser, ensureAuthenticated, async (req, res, next) => {
  try {
    const orders = await StoreOrder.find().populate('customer_id').sort({ createdAt: -1 }).lean();
    res.json(orders.map(o => ({
      ...o, id: o._id,
      customerName: o.customer_id?.name, customerEmail: o.customer_id?.email, customerPhone: o.customer_id?.phone,
    })));
  } catch (error) { next(error); }
});

app.put('/api/store/admin/orders/:id/status', attachUser, ensureAuthenticated, async (req, res, next) => {
  try {
    requireFields(req.body, ['status']);
    const validStatuses = ['Pending', 'Confirmed', 'Processing', 'Dispatched', 'Delivered', 'Cancelled'];
    if (!validStatuses.includes(req.body.status)) throw createError(400, 'Invalid status');
    await StoreOrder.updateOne({ _id: req.params.id }, { status: req.body.status });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/store/admin/stats', attachUser, ensureAuthenticated, async (_req, res) => {
  const [customerCount, orderCount, pendingOrders, revenueAgg] = await Promise.all([
    StoreCustomer.countDocuments(),
    StoreOrder.countDocuments(),
    StoreOrder.countDocuments({ status: 'Pending' }),
    StoreOrder.aggregate([{ $group: { _id: null, t: { $sum: '$total' } } }]),
  ]);
  res.json({ customerCount, orderCount, pendingOrders, totalRevenue: revenueAgg[0]?.t || 0 });
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
  connectDB().then(() => {
    app.listen(PORT, () => {
      console.log(`White Water Ghana app running on http://localhost:${PORT}`);
    });
  }).catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
}

module.exports = app;
