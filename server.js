require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const express = require('express');
const {
  db,
  initDatabase,
  nowIso,
  computeInventoryStatus,
  refreshCustomerStats,
  refreshInventoryStatuses,
} = require('./server/db');

initDatabase();

const app = express();
const rootDir = __dirname;
const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE = 'ww_session';
const SESSION_AGE_MS = 1000 * 60 * 60 * 12;

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

function getSession(token) {
  if (!token) {
    return null;
  }

  const session = db.prepare(`
    SELECT
      sessions.token,
      sessions.expires_at AS expiresAt,
      users.id,
      users.name,
      users.email,
      users.role,
      users.status,
      users.last_login AS lastLogin
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
  `).get(token);

  if (!session) {
    return null;
  }

  if (Date.parse(session.expiresAt) < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return session;
}

function attachUser(req, _res, next) {
  req.user = getSession(req.cookies[SESSION_COOKIE]);
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
    if (!allowedRoles) {
      next();
      return;
    }

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

function nextCode(tableName, columnName, prefix) {
  const year = new Date().getFullYear();
  const rows = db.prepare(`SELECT ${columnName} AS code FROM ${tableName}`).all();

  if (!rows.length) {
    return `${prefix}-${year}-${padCode(1)}`;
  }

  let maxSuffix = 0;
  for (const row of rows) {
    const parts = String(row.code).split('-');
    const num = Number(parts[parts.length - 1]);
    if (Number.isFinite(num) && num > maxSuffix) maxSuffix = num;
  }
  return `${prefix}-${year}-${padCode(maxSuffix + 1)}`;
}

function parseJsonPayload(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeApprovalRow(row) {
  return {
    ...row,
    oldValues: parseJsonPayload(row.oldValues),
    newValues: parseJsonPayload(row.newValues),
  };
}

function getInventoryByName(name) {
  return db.prepare('SELECT * FROM inventory_items WHERE name = ?').get(name);
}

function adjustInventoryQuantity(name, quantityChange) {
  const item = getInventoryByName(name);
  if (!item) {
    return;
  }

  const quantity = Math.max(0, Number(item.quantity) + Number(quantityChange));
  const timestamp = nowIso();
  db.prepare(`
    UPDATE inventory_items
    SET quantity = ?, status = ?, last_updated = ?, updated_at = ?
    WHERE id = ?
  `).run(quantity, computeInventoryStatus(quantity, item.reorder_level), timestamp, timestamp, item.id);
}

function createAccountingEntry(type, category, amount, description, entryDate) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO accounting_entries (type, category, amount, entry_date, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(type, category, amount, entryDate, description, timestamp, timestamp);
}

function getCollection(resource) {
  switch (resource) {
    case 'users':
      return db.prepare(`
        SELECT id, name, email, role, status, last_login AS lastLogin, created_at AS createdAt
        FROM users
        ORDER BY created_at DESC
      `).all();
    case 'customers':
      return db.prepare(`
        SELECT id, name, type, phone, email, address, total_orders AS totalOrders, outstanding, status, created_at AS createdAt
        FROM customers
        ORDER BY name ASC
      `).all();
    case 'vendors':
      return db.prepare(`
        SELECT id, name, category, phone, email, address, status, created_at AS createdAt
        FROM vendors
        ORDER BY name ASC
      `).all();
    case 'inventory':
      return db.prepare(`
        SELECT id, name, category, quantity, unit, reorder_level AS reorderLevel, unit_cost AS unitCost, status, last_updated AS lastUpdated, created_at AS createdAt
        FROM inventory_items
        ORDER BY category ASC, name ASC
      `).all();
    case 'machines':
      return db.prepare(`
        SELECT id, name, status, output_per_hour AS outputPerHour, last_maintenance AS lastMaintenance, operator, created_at AS createdAt
        FROM machines
        ORDER BY name ASC
      `).all();
    case 'production':
      return db.prepare(`
        SELECT id, batch_code AS batchCode, product, quantity, start_time AS startTime, machine, operator, status, cost, wastage, created_at AS createdAt
        FROM production_batches
        ORDER BY created_at DESC
      `).all();
    case 'sales':
      return db.prepare(`
        SELECT sales_orders.id, sales_orders.order_code AS orderCode, customers.name AS customerName, sales_orders.customer_id AS customerId,
          sales_orders.product, sales_orders.quantity, sales_orders.amount, sales_orders.order_date AS orderDate, sales_orders.source,
          sales_orders.status, invoices.invoice_code AS invoiceCode, sales_orders.created_at AS createdAt
        FROM sales_orders
        JOIN customers ON customers.id = sales_orders.customer_id
        LEFT JOIN invoices ON invoices.id = sales_orders.invoice_id
        ORDER BY sales_orders.created_at DESC
      `).all();
    case 'invoices':
      return db.prepare(`
        SELECT invoices.id, invoices.invoice_code AS invoiceCode, customers.name AS customerName, invoices.customer_id AS customerId,
          sales_orders.order_code AS orderCode, invoices.sales_order_id AS salesOrderId, invoices.amount, invoices.issue_date AS issueDate,
          invoices.due_date AS dueDate, invoices.status, invoices.created_at AS createdAt
        FROM invoices
        JOIN customers ON customers.id = invoices.customer_id
        LEFT JOIN sales_orders ON sales_orders.id = invoices.sales_order_id
        ORDER BY invoices.created_at DESC
      `).all();
    case 'purchaseOrders':
      return db.prepare(`
        SELECT purchase_orders.id, purchase_orders.po_code AS poCode, vendors.name AS vendorName, purchase_orders.vendor_id AS vendorId,
          purchase_orders.item, purchase_orders.quantity, purchase_orders.amount, purchase_orders.required_by AS requiredBy,
          purchase_orders.status, purchase_orders.notes, purchase_orders.created_at AS createdAt
        FROM purchase_orders
        JOIN vendors ON vendors.id = purchase_orders.vendor_id
        ORDER BY purchase_orders.created_at DESC
      `).all();
    case 'accounting':
      return db.prepare(`
        SELECT id, type, category, amount, entry_date AS entryDate, description, created_at AS createdAt
        FROM accounting_entries
        ORDER BY entry_date DESC, id DESC
      `).all();
    case 'approvals':
      return db.prepare(`
        SELECT id, request_type AS requestType, module_name AS moduleName, record_id AS recordId, submitted_by AS submittedBy,
          reason, status, old_values AS oldValues, new_values AS newValues, decided_by AS decidedBy,
          submitted_at AS submittedAt, decided_at AS decidedAt
        FROM approvals
        ORDER BY submitted_at DESC
      `).all().map(serializeApprovalRow);
    default:
      throw createError(404, 'Unknown collection');
  }
}

function createApprovalRequest({ requestType, moduleName, recordId, submittedBy, reason, oldValues, newValues }) {
  const timestamp = nowIso();
  const result = db.prepare(`
    INSERT INTO approvals (request_type, module_name, record_id, submitted_by, reason, status, old_values, new_values, decided_by, submitted_at, decided_at)
    VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, NULL, ?, NULL)
  `).run(
    requestType,
    moduleName,
    recordId,
    submittedBy,
    reason,
    JSON.stringify(oldValues ?? null),
    JSON.stringify(newValues ?? null),
    timestamp,
  );

  return result.lastInsertRowid;
}

function applyApprovalMutation(approvalId) {
  const approval = db.prepare(`
    SELECT id, request_type AS requestType, module_name AS moduleName, record_id AS recordId, old_values AS oldValues, new_values AS newValues, status
    FROM approvals WHERE id = ?
  `).get(approvalId);

  if (!approval || approval.status !== 'Pending') {
    throw createError(400, 'Approval is not pending');
  }

  const newValues = parseJsonPayload(approval.newValues) || {};
  const tables = {
    inventory: 'inventory_items',
    sales: 'sales_orders',
    vendors: 'vendors',
    customers: 'customers',
    machines: 'machines',
    production: 'production_batches',
    invoices: 'invoices',
    purchaseOrders: 'purchase_orders',
  };

  const tableName = tables[approval.moduleName];
  if (!tableName) {
    return;
  }

  if (approval.requestType === 'Delete') {
    db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(approval.recordId);
    if (approval.moduleName === 'sales') {
      refreshCustomerStats();
    }
    return;
  }

  const setClauses = [];
  const values = [];
  for (const [key, value] of Object.entries(newValues)) {
    const dbKey = key
      .replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
      .replace(/^po_code$/, 'po_code');
    setClauses.push(`${dbKey} = ?`);
    values.push(value);
  }
  setClauses.push('updated_at = ?');
  values.push(nowIso(), approval.recordId);
  db.prepare(`UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  if (approval.moduleName === 'inventory') {
    refreshInventoryStatuses();
  }

  if (approval.moduleName === 'sales' || approval.moduleName === 'invoices') {
    refreshCustomerStats();
  }
}

function requireApprovalForRole(user) {
  return ['supervisor', 'staff'].includes(user.role);
}

function getOptions() {
  return {
    customers: db.prepare('SELECT id, name FROM customers ORDER BY name').all(),
    vendors: db.prepare('SELECT id, name FROM vendors ORDER BY name').all(),
    machines: db.prepare('SELECT id, name FROM machines ORDER BY name').all(),
    products: db.prepare("SELECT id, name FROM inventory_items WHERE category = 'Finished Goods' ORDER BY name").all(),
    openSalesOrders: db.prepare(`
      SELECT id, order_code AS code FROM sales_orders WHERE invoice_id IS NULL ORDER BY created_at DESC
    `).all(),
    users: db.prepare('SELECT id, name, role FROM users ORDER BY name').all(),
  };
}

function getDashboardData() {
  const revenue = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM invoices`).get().total;
  const outstanding = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM invoices WHERE status != 'Paid'").get().total;
  const produced = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS total FROM production_batches').get().total;
  const stockAlerts = db.prepare("SELECT COUNT(*) AS count FROM inventory_items WHERE status IN ('LOW', 'CRITICAL', 'OUT OF STOCK')").get().count;
  const customers = db.prepare("SELECT COUNT(*) AS count FROM customers WHERE status != 'Suspended'").get().count;
  const recentOrders = getCollection('sales').slice(0, 5);
  const machineStatus = db.prepare('SELECT status, COUNT(*) AS count FROM machines GROUP BY status').all();
  const lowStock = getCollection('inventory').filter((item) => item.status !== 'ADEQUATE').slice(0, 5);
  const pendingApprovals = db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE status = 'Pending'").get().count;

  return {
    cards: [
      { label: 'Revenue', value: revenue, tone: 'success', kind: 'currency' },
      { label: 'Units Produced', value: produced, tone: 'brand', kind: 'number' },
      { label: 'Active Customers', value: customers, tone: 'neutral', kind: 'number' },
      { label: 'Stock Alerts', value: stockAlerts, tone: 'warning', kind: 'number' },
      { label: 'Outstanding Invoices', value: outstanding, tone: 'danger', kind: 'currency' },
      { label: 'Pending Approvals', value: pendingApprovals, tone: 'accent', kind: 'number' },
    ],
    recentOrders,
    machineStatus,
    lowStock,
  };
}

function getReportData() {
  const revenueByChannel = db.prepare(`
    SELECT source AS channel, COUNT(*) AS orders, SUM(amount) AS revenue
    FROM sales_orders
    GROUP BY source
    ORDER BY revenue DESC
  `).all();
  const topCustomers = db.prepare(`
    SELECT customers.name, COUNT(sales_orders.id) AS orders, COALESCE(SUM(sales_orders.amount), 0) AS revenue
    FROM customers
    LEFT JOIN sales_orders ON sales_orders.customer_id = customers.id
    GROUP BY customers.id
    ORDER BY revenue DESC
    LIMIT 5
  `).all();
  const expenseSummary = db.prepare(`
    SELECT category, SUM(amount) AS amount
    FROM accounting_entries
    WHERE type = 'Expense'
    GROUP BY category
    ORDER BY amount DESC
  `).all();
  const inventoryStatus = db.prepare(`
    SELECT category,
      COUNT(*) AS totalItems,
      SUM(CASE WHEN status = 'ADEQUATE' THEN 1 ELSE 0 END) AS adequate,
      SUM(CASE WHEN status = 'LOW' THEN 1 ELSE 0 END) AS low,
      SUM(CASE WHEN status = 'CRITICAL' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN status = 'OUT OF STOCK' THEN 1 ELSE 0 END) AS outOfStock
    FROM inventory_items
    GROUP BY category
    ORDER BY category
  `).all();
  const monthlyFinance = db.prepare(`
    SELECT substr(entry_date, 1, 7) AS month,
      SUM(CASE WHEN type = 'Income' THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN type = 'Expense' THEN amount ELSE 0 END) AS expense
    FROM accounting_entries
    GROUP BY substr(entry_date, 1, 7)
    ORDER BY month DESC
    LIMIT 6
  `).all().reverse();

  return {
    revenueByChannel,
    topCustomers,
    expenseSummary,
    inventoryStatus,
    monthlyFinance,
  };
}

app.use(attachUser);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: nowIso() });
});

app.post('/api/auth/login', (req, res, next) => {
  try {
    requireFields(req.body, ['email', 'password']);
    const email = String(req.body.email).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
    if (!user) {
      throw createError(401, 'Invalid email or password');
    }

    const matches = bcrypt.compareSync(String(req.body.password), user.password_hash);
    if (!matches) {
      throw createError(401, 'Invalid email or password');
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_AGE_MS).toISOString();
    const timestamp = nowIso();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(token, user.id, expiresAt, timestamp);
    db.prepare('UPDATE users SET last_login = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, user.id);

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_AGE_MS,
    });

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', ensureAuthenticated, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.post('/api/auth/forgot-password', (req, res, next) => {
  try {
    requireFields(req.body, ['email']);
    const email = String(req.body.email).trim().toLowerCase();
    const user = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);

    if (!user) {
      res.json({ message: 'If the account exists, reset instructions have been sent.' });
      return;
    }

    res.json({ message: 'Reset instructions generated. Use the reset password form below.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', (req, res, next) => {
  try {
    requireFields(req.body, ['email', 'newPassword']);
    const email = String(req.body.email).trim().toLowerCase();
    const newPassword = String(req.body.newPassword);

    if (newPassword.length < 6) {
      throw createError(400, 'New password must be at least 6 characters');
    }

    const timestamp = nowIso();
    const result = db.prepare(`
      UPDATE users
      SET password_hash = ?, updated_at = ?
      WHERE lower(email) = ?
    `).run(bcrypt.hashSync(newPassword, 10), timestamp, email);

    if (!result.changes) {
      throw createError(404, 'No user found with this email');
    }

    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email) = ?)').run(email);
    res.json({ message: 'Password reset successful. Please sign in with your new password.' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) {
    res.status(401).json({ message: 'Not signed in' });
    return;
  }

  res.json({ user: req.user });
});

app.get('/api/options', ensureAuthenticated, (req, res) => {
  res.json(getOptions());
});

app.get('/api/dashboard', ensureAuthenticated, ensureRole('dashboard'), (_req, res) => {
  refreshCustomerStats();
  refreshInventoryStatuses();
  res.json(getDashboardData());
});

app.get('/api/reports', ensureAuthenticated, ensureRole('reports'), (_req, res) => {
  res.json(getReportData());
});

app.get('/api/:resource', ensureAuthenticated, (req, res, next) => {
  try {
    const resource = req.params.resource;
    ensureRole(resource)(req, res, (error) => {
      if (error) {
        throw error;
      }
    });
    res.json(getCollection(resource));
  } catch (error) {
    next(error);
  }
});

app.post('/api/users', ensureAuthenticated, ensureRole('users'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'email', 'role', 'password']);
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, status, last_login, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      String(req.body.name).trim(),
      String(req.body.email).trim().toLowerCase(),
      bcrypt.hashSync(String(req.body.password), 10),
      String(req.body.role).trim().toLowerCase(),
      req.body.status ? String(req.body.status) : 'Active',
      timestamp,
      timestamp,
    );

    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      next(createError(409, 'A user with this email already exists'));
      return;
    }
    next(error);
  }
});

app.post('/api/customers', ensureAuthenticated, ensureRole('customers'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'type']);
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT INTO customers (name, type, phone, email, address, total_orders, outstanding, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `).run(
      req.body.name,
      req.body.type,
      req.body.phone || '',
      req.body.email || '',
      req.body.address || '',
      req.body.status || 'Active',
      timestamp,
      timestamp,
    );
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

app.post('/api/vendors', ensureAuthenticated, ensureRole('vendors'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'category']);
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT INTO vendors (name, category, phone, email, address, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.name,
      req.body.category,
      req.body.phone || '',
      req.body.email || '',
      req.body.address || '',
      req.body.status || 'Active',
      timestamp,
      timestamp,
    );
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

app.post('/api/inventory', ensureAuthenticated, ensureRole('inventory'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'category', 'quantity', 'unit', 'reorderLevel', 'unitCost']);
    const quantity = Number(req.body.quantity);
    const reorderLevel = Number(req.body.reorderLevel);
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT INTO inventory_items (name, category, quantity, unit, reorder_level, unit_cost, status, last_updated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.name,
      req.body.category,
      quantity,
      req.body.unit,
      reorderLevel,
      Number(req.body.unitCost),
      computeInventoryStatus(quantity, reorderLevel),
      timestamp,
      timestamp,
      timestamp,
    );
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

app.post('/api/machines', ensureAuthenticated, ensureRole('machines'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'status']);
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT INTO machines (name, status, output_per_hour, last_maintenance, operator, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.name,
      req.body.status,
      req.body.outputPerHour || null,
      req.body.lastMaintenance || null,
      req.body.operator || '',
      timestamp,
      timestamp,
    );
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    next(error);
  }
});

app.post('/api/production', ensureAuthenticated, ensureRole('production'), (req, res, next) => {
  try {
    requireFields(req.body, ['product', 'quantity', 'startTime', 'machine', 'status']);
    const timestamp = nowIso();
    const batchCode = nextCode('production_batches', 'batch_code', 'B');
    const quantity = Number(req.body.quantity);
    const result = db.prepare(`
      INSERT INTO production_batches (batch_code, product, quantity, start_time, machine, operator, status, cost, wastage, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchCode,
      req.body.product,
      quantity,
      req.body.startTime,
      req.body.machine,
      req.body.operator || '',
      req.body.status,
      Number(req.body.cost || 0),
      Number(req.body.wastage || 0),
      timestamp,
      timestamp,
    );

    if (req.body.status === 'Completed') {
      adjustInventoryQuantity(req.body.product, quantity);
    }

    res.status(201).json({ id: result.lastInsertRowid, batchCode });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sales', ensureAuthenticated, ensureRole('sales'), (req, res, next) => {
  try {
    requireFields(req.body, ['customerId', 'product', 'quantity', 'amount', 'orderDate', 'source', 'status']);
    const timestamp = nowIso();
    const orderCode = nextCode('sales_orders', 'order_code', 'SO');
    const quantity = Number(req.body.quantity);
    const amount = Number(req.body.amount);
    const saleResult = db.prepare(`
      INSERT INTO sales_orders (order_code, customer_id, product, quantity, amount, order_date, source, status, invoice_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      orderCode,
      Number(req.body.customerId),
      req.body.product,
      quantity,
      amount,
      req.body.orderDate,
      req.body.source,
      req.body.status,
      timestamp,
      timestamp,
    );

    let invoiceCode = null;
    if (req.body.status !== 'Cancelled') {
      invoiceCode = nextCode('invoices', 'invoice_code', 'INV');
      const invoiceResult = db.prepare(`
        INSERT INTO invoices (invoice_code, customer_id, sales_order_id, amount, issue_date, due_date, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        invoiceCode,
        Number(req.body.customerId),
        saleResult.lastInsertRowid,
        amount,
        req.body.orderDate,
        req.body.dueDate || req.body.orderDate,
        req.body.invoiceStatus || 'Pending',
        timestamp,
        timestamp,
      );

      db.prepare('UPDATE sales_orders SET invoice_id = ?, updated_at = ? WHERE id = ?').run(invoiceResult.lastInsertRowid, timestamp, saleResult.lastInsertRowid);
      adjustInventoryQuantity(req.body.product, -quantity);
    }

    refreshCustomerStats();
    createAccountingEntry('Income', 'Sales Revenue', amount, `Sales order ${orderCode}`, req.body.orderDate);
    res.status(201).json({ id: saleResult.lastInsertRowid, orderCode, invoiceCode });
  } catch (error) {
    next(error);
  }
});

app.post('/api/invoices', ensureAuthenticated, ensureRole('invoices'), (req, res, next) => {
  try {
    requireFields(req.body, ['customerId', 'amount', 'issueDate', 'dueDate', 'status']);
    const timestamp = nowIso();
    const invoiceCode = nextCode('invoices', 'invoice_code', 'INV');
    const result = db.prepare(`
      INSERT INTO invoices (invoice_code, customer_id, sales_order_id, amount, issue_date, due_date, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invoiceCode,
      Number(req.body.customerId),
      req.body.salesOrderId || null,
      Number(req.body.amount),
      req.body.issueDate,
      req.body.dueDate,
      req.body.status,
      timestamp,
      timestamp,
    );
    refreshCustomerStats();
    res.status(201).json({ id: result.lastInsertRowid, invoiceCode });
  } catch (error) {
    next(error);
  }
});

app.post('/api/purchaseOrders', ensureAuthenticated, ensureRole('purchaseOrders'), (req, res, next) => {
  try {
    requireFields(req.body, ['vendorId', 'item', 'quantity', 'amount', 'status']);
    const timestamp = nowIso();
    const poCode = nextCode('purchase_orders', 'po_code', 'PO');
    const result = db.prepare(`
      INSERT INTO purchase_orders (po_code, vendor_id, item, quantity, amount, required_by, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      poCode,
      Number(req.body.vendorId),
      req.body.item,
      Number(req.body.quantity),
      Number(req.body.amount),
      req.body.requiredBy || null,
      req.body.status,
      req.body.notes || '',
      timestamp,
      timestamp,
    );
    if (req.body.status === 'Received') {
      adjustInventoryQuantity(req.body.item, Number(req.body.quantity));
    }
    createAccountingEntry('Expense', 'Supplier Payment', Number(req.body.amount), `Purchase order ${poCode}`, req.body.requiredBy || new Date().toISOString().slice(0, 10));
    res.status(201).json({ id: result.lastInsertRowid, poCode });
  } catch (error) {
    next(error);
  }
});

app.post('/api/accounting', ensureAuthenticated, ensureRole('accounting'), (req, res, next) => {
  try {
    requireFields(req.body, ['type', 'category', 'amount', 'entryDate', 'description']);
    createAccountingEntry(req.body.type, req.body.category, Number(req.body.amount), req.body.description, req.body.entryDate);
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put('/api/invoices/:id/status', ensureAuthenticated, ensureRole('invoices'), (req, res, next) => {
  try {
    requireFields(req.body, ['status']);
    const timestamp = nowIso();
    db.prepare('UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?').run(req.body.status, timestamp, Number(req.params.id));
    refreshCustomerStats();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put('/api/machines/:id/status', ensureAuthenticated, ensureRole('machines'), (req, res, next) => {
  try {
    requireFields(req.body, ['status']);
    const timestamp = nowIso();
    db.prepare('UPDATE machines SET status = ?, updated_at = ? WHERE id = ?').run(req.body.status, timestamp, Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:resource/:id', ensureAuthenticated, (req, res, next) => {
  try {
    const resource = req.params.resource;
    ensureRole(resource)(req, res, (error) => {
      if (error) {
        throw error;
      }
    });

    const resourceMap = {
      users: { table: 'users', label: 'users' },
      customers: { table: 'customers', label: 'customers' },
      vendors: { table: 'vendors', label: 'vendors' },
      inventory: { table: 'inventory_items', label: 'inventory' },
      machines: { table: 'machines', label: 'machines' },
      production: { table: 'production_batches', label: 'production' },
      sales: { table: 'sales_orders', label: 'sales' },
      invoices: { table: 'invoices', label: 'invoices' },
      accounting: { table: 'accounting_entries', label: 'accounting' },
      purchaseOrders: { table: 'purchase_orders', label: 'purchaseOrders' },
    };

    const target = resourceMap[resource];
    if (!target) {
      throw createError(404, 'Unknown collection');
    }

    const record = db.prepare(`SELECT * FROM ${target.table} WHERE id = ?`).get(Number(req.params.id));
    if (!record) {
      throw createError(404, 'Record not found');
    }

    if (resource === 'users' && Number(req.params.id) === req.user.id) {
      throw createError(400, 'You cannot delete your own account');
    }

    if (requireApprovalForRole(req.user) && resource !== 'accounting' && resource !== 'users') {
      const approvalId = createApprovalRequest({
        requestType: 'Delete',
        moduleName: target.label,
        recordId: Number(req.params.id),
        submittedBy: `${req.user.name} (${req.user.role})`,
        reason: req.body.reason || 'Delete request submitted from application',
        oldValues: record,
        newValues: { deleted: true },
      });
      res.status(202).json({ ok: true, approvalId, pending: true });
      return;
    }

    db.prepare(`DELETE FROM ${target.table} WHERE id = ?`).run(Number(req.params.id));
    if (resource === 'sales' || resource === 'invoices') {
      refreshCustomerStats();
    }
    if (resource === 'inventory') {
      refreshInventoryStatuses();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/approvals/:id/decision', ensureAuthenticated, ensureRole('approvals'), (req, res, next) => {
  try {
    requireFields(req.body, ['decision']);
    const approvalId = Number(req.params.id);
    const decision = String(req.body.decision);
    const timestamp = nowIso();

    if (decision === 'approve') {
      applyApprovalMutation(approvalId);
      db.prepare(`
        UPDATE approvals
        SET status = 'Approved', decided_by = ?, decided_at = ?
        WHERE id = ?
      `).run(req.user.name, timestamp, approvalId);
    } else if (decision === 'reject') {
      db.prepare(`
        UPDATE approvals
        SET status = 'Rejected', decided_by = ?, decided_at = ?
        WHERE id = ?
      `).run(req.user.name, timestamp, approvalId);
    } else {
      db.prepare(`
        UPDATE approvals
        SET status = 'Clarification Requested', decided_by = ?, decided_at = ?
        WHERE id = ?
      `).run(req.user.name, timestamp, approvalId);
    }

    refreshCustomerStats();
    refreshInventoryStatuses();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/* =============================================
   CUSTOMER STORE API
   ============================================= */

// ── Store: List available products ──
app.get('/api/store/products', (_req, res) => {
  const products = db.prepare('SELECT id, name, description, price, unit, min_order, image FROM store_products WHERE available = 1 ORDER BY sort_order, name').all();
  res.json(products);
});

// ── Store: Customer Register ──
app.post('/api/store/register', async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'email', 'phone', 'password']);
    const { name, email, phone, password, address, city, region } = req.body;

    if (password.length < 6) {
      throw createError(400, 'Password must be at least 6 characters');
    }

    const existing = db.prepare('SELECT id FROM store_customers WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) {
      throw createError(409, 'An account with this email already exists');
    }

    const hash = bcrypt.hashSync(password, 10);
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT INTO store_customers (name, email, phone, password_hash, address, city, region, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)
    `).run(name.trim(), email.toLowerCase().trim(), phone.trim(), hash, address || null, city || null, region || null, timestamp, timestamp);

    const token = crypto.randomUUID();
    db.prepare('INSERT INTO store_sessions (token, customer_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
      token, result.lastInsertRowid, new Date(Date.now() + SESSION_AGE_MS).toISOString(), timestamp
    );

    res.cookie('ww_store_session', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_AGE_MS });
    res.status(201).json({
      ok: true,
      customer: { id: result.lastInsertRowid, name: name.trim(), email: email.toLowerCase().trim(), phone: phone.trim() },
    });
  } catch (error) {
    next(error);
  }
});

// ── Store: Customer Login ──
app.post('/api/store/login', (req, res, next) => {
  try {
    requireFields(req.body, ['email', 'password']);
    const { email, password } = req.body;

    const customer = db.prepare('SELECT * FROM store_customers WHERE email = ?').get(email.toLowerCase().trim());
    if (!customer || !bcrypt.compareSync(password, customer.password_hash)) {
      throw createError(401, 'Invalid email or password');
    }

    if (customer.status !== 'Active') {
      throw createError(403, 'Your account has been suspended');
    }

    const token = crypto.randomUUID();
    const timestamp = nowIso();
    db.prepare('INSERT INTO store_sessions (token, customer_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
      token, customer.id, new Date(Date.now() + SESSION_AGE_MS).toISOString(), timestamp
    );

    res.cookie('ww_store_session', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_AGE_MS });
    res.json({
      ok: true,
      customer: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone },
    });
  } catch (error) {
    next(error);
  }
});

// ── Store: Customer Logout ──
app.post('/api/store/logout', (req, res) => {
  const token = req.cookies.ww_store_session;
  if (token) {
    db.prepare('DELETE FROM store_sessions WHERE token = ?').run(token);
  }
  res.clearCookie('ww_store_session');
  res.json({ ok: true });
});

// ── Store: Get current customer session ──
function getStoreCustomer(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT store_customers.id, store_customers.name, store_customers.email, store_customers.phone,
           store_customers.address, store_customers.city, store_customers.region,
           store_sessions.expires_at AS expiresAt
    FROM store_sessions
    JOIN store_customers ON store_customers.id = store_sessions.customer_id
    WHERE store_sessions.token = ?
  `).get(token);
  if (!row) return null;
  if (Date.parse(row.expiresAt) < Date.now()) {
    db.prepare('DELETE FROM store_sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

app.get('/api/store/me', (req, res) => {
  const customer = getStoreCustomer(req.cookies.ww_store_session);
  if (!customer) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  res.json({ ok: true, customer });
});

// ── Store: Place Order ──
app.post('/api/store/orders', (req, res, next) => {
  try {
    const customer = getStoreCustomer(req.cookies.ww_store_session);
    if (!customer) {
      throw createError(401, 'Please log in to place an order');
    }

    requireFields(req.body, ['items', 'deliveryAddress', 'phone']);
    const { items, deliveryAddress, deliveryCity, deliveryRegion, phone, notes } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      throw createError(400, 'Order must have at least one item');
    }

    // Validate items against real products and calculate totals
    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      const product = db.prepare('SELECT * FROM store_products WHERE id = ? AND available = 1').get(item.productId);
      if (!product) {
        throw createError(400, `Product not found or unavailable`);
      }
      const qty = Math.max(product.min_order, Math.floor(Number(item.qty) || 0));
      const lineTotal = qty * product.price;
      subtotal += lineTotal;
      validatedItems.push({ productId: product.id, name: product.name, qty, unitPrice: product.price, lineTotal });
    }

    const deliveryFee = 0;
    const total = subtotal + deliveryFee;
    const timestamp = nowIso();

    // Generate order code
    const lastOrder = db.prepare("SELECT order_code FROM store_orders ORDER BY id DESC LIMIT 1").get();
    let orderNum = 1;
    if (lastOrder?.order_code) {
      const parts = lastOrder.order_code.split('-');
      orderNum = (Number(parts[parts.length - 1]) || 0) + 1;
    }
    const orderCode = `WW-${new Date().getFullYear()}-${String(orderNum).padStart(4, '0')}`;

    const result = db.prepare(`
      INSERT INTO store_orders (order_code, customer_id, items, subtotal, delivery_fee, total, delivery_address, delivery_city, delivery_region, phone, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
    `).run(orderCode, customer.id, JSON.stringify(validatedItems), subtotal, deliveryFee, total, deliveryAddress, deliveryCity || null, deliveryRegion || null, phone, notes || null, timestamp, timestamp);

    // Also create a matching sales_order + invoice in the management system
    // Find or create an internal customer record
    let internalCustomer = db.prepare('SELECT id FROM customers WHERE email = ?').get(customer.email);
    if (!internalCustomer) {
      const custResult = db.prepare(`
        INSERT INTO customers (name, type, phone, email, address, total_orders, outstanding, status, created_at, updated_at)
        VALUES (?, 'Online', ?, ?, ?, 0, 0, 'Active', ?, ?)
      `).run(customer.name, customer.phone, customer.email, deliveryAddress, timestamp, timestamp);
      internalCustomer = { id: custResult.lastInsertRowid };
    }

    const soCode = nextCode('sales_orders', 'order_code', 'SO');
    const invCode = soCode.replace('SO', 'INV');
    const issueDate = timestamp.slice(0, 10);
    const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const soResult = db.prepare(`
      INSERT INTO sales_orders (order_code, customer_id, product, quantity, amount, order_date, source, status, invoice_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Online Store', 'Pending', NULL, ?, ?)
    `).run(soCode, internalCustomer.id, validatedItems.map(i => i.name).join(', '), validatedItems.reduce((s, i) => s + i.qty, 0), total, issueDate, timestamp, timestamp);

    const invResult = db.prepare(`
      INSERT INTO invoices (invoice_code, customer_id, sales_order_id, amount, issue_date, due_date, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
    `).run(invCode, internalCustomer.id, soResult.lastInsertRowid, total, issueDate, dueDate, timestamp, timestamp);

    db.prepare('UPDATE sales_orders SET invoice_id = ?, updated_at = ? WHERE id = ?').run(invResult.lastInsertRowid, timestamp, soResult.lastInsertRowid);
    refreshCustomerStats();

    res.status(201).json({
      ok: true,
      order: { id: result.lastInsertRowid, orderCode, total, status: 'Pending' },
    });
  } catch (error) {
    next(error);
  }
});

// ── Store: Customer Order History ──
app.get('/api/store/orders', (req, res, next) => {
  try {
    const customer = getStoreCustomer(req.cookies.ww_store_session);
    if (!customer) {
      throw createError(401, 'Please log in to view orders');
    }

    const orders = db.prepare(`
      SELECT id, order_code AS orderCode, items, subtotal, delivery_fee AS deliveryFee, total,
             delivery_address AS deliveryAddress, phone, notes, status, created_at AS createdAt
      FROM store_orders WHERE customer_id = ? ORDER BY id DESC
    `).all(customer.id);

    for (const order of orders) {
      order.items = JSON.parse(order.items);
    }

    res.json(orders);
  } catch (error) {
    next(error);
  }
});

// ── Management: Get all online store orders ──
app.get('/api/store/admin/orders', attachUser, ensureAuthenticated, (req, res, next) => {
  try {
    const orders = db.prepare(`
      SELECT store_orders.*, store_customers.name AS customerName, store_customers.email AS customerEmail, store_customers.phone AS customerPhone
      FROM store_orders
      JOIN store_customers ON store_customers.id = store_orders.customer_id
      ORDER BY store_orders.id DESC
    `).all();

    for (const order of orders) {
      order.items = JSON.parse(order.items);
    }

    res.json(orders);
  } catch (error) {
    next(error);
  }
});

// ── Management: Update store order status ──
app.put('/api/store/admin/orders/:id/status', attachUser, ensureAuthenticated, (req, res, next) => {
  try {
    requireFields(req.body, ['status']);
    const validStatuses = ['Pending', 'Confirmed', 'Processing', 'Dispatched', 'Delivered', 'Cancelled'];
    if (!validStatuses.includes(req.body.status)) {
      throw createError(400, 'Invalid status');
    }
    const timestamp = nowIso();
    db.prepare('UPDATE store_orders SET status = ?, updated_at = ? WHERE id = ?').run(req.body.status, timestamp, Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ── Management: Get store customer count & order stats ──
app.get('/api/store/admin/stats', attachUser, ensureAuthenticated, (_req, res) => {
  const customerCount = db.prepare('SELECT COUNT(*) AS c FROM store_customers').get().c;
  const orderCount = db.prepare('SELECT COUNT(*) AS c FROM store_orders').get().c;
  const pendingOrders = db.prepare("SELECT COUNT(*) AS c FROM store_orders WHERE status = 'Pending'").get().c;
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(total), 0) AS t FROM store_orders').get().t;
  res.json({ customerCount, orderCount, pendingOrders, totalRevenue });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next(createError(404, 'Route not found'));
    return;
  }

  res.status(404).send('Page not found');
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    message: error.message || 'Unexpected server error',
  });
});

app.listen(PORT, () => {
  console.log(`White Water Ghana app running on http://localhost:${PORT}`);
});