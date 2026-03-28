const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'whitewater.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function nowIso() {
  return new Date().toISOString();
}

function computeInventoryStatus(quantity, reorderLevel) {
  if (quantity <= 0) {
    return 'OUT OF STOCK';
  }

  if (quantity <= reorderLevel * 0.5) {
    return 'CRITICAL';
  }

  if (quantity <= reorderLevel) {
    return 'LOW';
  }

  return 'ADEQUATE';
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      last_login TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      total_orders INTEGER NOT NULL DEFAULT 0,
      outstanding REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL,
      reorder_level REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      last_updated TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      output_per_hour REAL,
      last_maintenance TEXT,
      operator TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS production_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_code TEXT NOT NULL UNIQUE,
      product TEXT NOT NULL,
      quantity REAL NOT NULL,
      start_time TEXT NOT NULL,
      machine TEXT NOT NULL,
      operator TEXT,
      status TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      wastage REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      product TEXT NOT NULL,
      quantity REAL NOT NULL,
      amount REAL NOT NULL,
      order_date TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      invoice_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_code TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      sales_order_id INTEGER,
      amount REAL NOT NULL,
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_code TEXT NOT NULL UNIQUE,
      vendor_id INTEGER NOT NULL,
      item TEXT NOT NULL,
      quantity REAL NOT NULL,
      amount REAL NOT NULL,
      required_by TEXT,
      status TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS accounting_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      entry_date TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_type TEXT NOT NULL,
      module_name TEXT NOT NULL,
      record_id INTEGER,
      submitted_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      old_values TEXT,
      new_values TEXT,
      decided_by TEXT,
      submitted_at TEXT NOT NULL,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS store_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      address TEXT,
      city TEXT,
      region TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS store_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      items TEXT NOT NULL,
      subtotal REAL NOT NULL,
      delivery_fee REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      delivery_address TEXT NOT NULL,
      delivery_city TEXT,
      delivery_region TEXT,
      phone TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES store_customers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS store_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'bag',
      min_order INTEGER NOT NULL DEFAULT 1,
      image TEXT,
      available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS store_sessions (
      token TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES store_customers(id) ON DELETE CASCADE
    );
  `);
}

function refreshCustomerStats() {
  const customers = db.prepare('SELECT id FROM customers').all();
  const orderCountStatement = db.prepare('SELECT COUNT(*) AS count FROM sales_orders WHERE customer_id = ?');
  const outstandingStatement = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM invoices WHERE customer_id = ? AND status != 'Paid'");
  const updateStatement = db.prepare('UPDATE customers SET total_orders = ?, outstanding = ?, updated_at = ? WHERE id = ?');

  const transaction = db.transaction(() => {
    for (const customer of customers) {
      const orderCount = orderCountStatement.get(customer.id).count;
      const outstanding = outstandingStatement.get(customer.id).total;
      updateStatement.run(orderCount, outstanding, nowIso(), customer.id);
    }
  });

  transaction();
}

function refreshInventoryStatuses() {
  const items = db.prepare('SELECT id, quantity, reorder_level FROM inventory_items').all();
  const updateStatement = db.prepare('UPDATE inventory_items SET status = ?, last_updated = ?, updated_at = ? WHERE id = ?');

  const transaction = db.transaction(() => {
    const timestamp = nowIso();
    for (const item of items) {
      updateStatement.run(
        computeInventoryStatus(item.quantity, item.reorder_level),
        timestamp,
        timestamp,
        item.id,
      );
    }
  });

  transaction();
}

function seedDatabase() {
  const existingUsers = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (existingUsers > 0) {
    refreshCustomerStats();
    refreshInventoryStatuses();
    return;
  }

  const timestamp = nowIso();
  const adminPasswordHash = bcrypt.hashSync('admin1234', 10);

  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, status, last_login, created_at, updated_at)
    VALUES (@name, @email, @password_hash, @role, @status, @last_login, @created_at, @updated_at)
  `);
  const insertCustomer = db.prepare(`
    INSERT INTO customers (name, type, phone, email, address, total_orders, outstanding, status, created_at, updated_at)
    VALUES (@name, @type, @phone, @email, @address, @total_orders, @outstanding, @status, @created_at, @updated_at)
  `);
  const insertVendor = db.prepare(`
    INSERT INTO vendors (name, category, phone, email, address, status, created_at, updated_at)
    VALUES (@name, @category, @phone, @email, @address, @status, @created_at, @updated_at)
  `);
  const insertInventory = db.prepare(`
    INSERT INTO inventory_items (name, category, quantity, unit, reorder_level, unit_cost, status, last_updated, created_at, updated_at)
    VALUES (@name, @category, @quantity, @unit, @reorder_level, @unit_cost, @status, @last_updated, @created_at, @updated_at)
  `);
  const insertMachine = db.prepare(`
    INSERT INTO machines (name, status, output_per_hour, last_maintenance, operator, created_at, updated_at)
    VALUES (@name, @status, @output_per_hour, @last_maintenance, @operator, @created_at, @updated_at)
  `);
  const insertProduction = db.prepare(`
    INSERT INTO production_batches (batch_code, product, quantity, start_time, machine, operator, status, cost, wastage, created_at, updated_at)
    VALUES (@batch_code, @product, @quantity, @start_time, @machine, @operator, @status, @cost, @wastage, @created_at, @updated_at)
  `);
  const insertSale = db.prepare(`
    INSERT INTO sales_orders (order_code, customer_id, product, quantity, amount, order_date, source, status, invoice_id, created_at, updated_at)
    VALUES (@order_code, @customer_id, @product, @quantity, @amount, @order_date, @source, @status, @invoice_id, @created_at, @updated_at)
  `);
  const insertInvoice = db.prepare(`
    INSERT INTO invoices (invoice_code, customer_id, sales_order_id, amount, issue_date, due_date, status, created_at, updated_at)
    VALUES (@invoice_code, @customer_id, @sales_order_id, @amount, @issue_date, @due_date, @status, @created_at, @updated_at)
  `);
  const updateSaleInvoice = db.prepare('UPDATE sales_orders SET invoice_id = ?, updated_at = ? WHERE id = ?');
  const insertPurchaseOrder = db.prepare(`
    INSERT INTO purchase_orders (po_code, vendor_id, item, quantity, amount, required_by, status, notes, created_at, updated_at)
    VALUES (@po_code, @vendor_id, @item, @quantity, @amount, @required_by, @status, @notes, @created_at, @updated_at)
  `);
  const insertAccounting = db.prepare(`
    INSERT INTO accounting_entries (type, category, amount, entry_date, description, created_at, updated_at)
    VALUES (@type, @category, @amount, @entry_date, @description, @created_at, @updated_at)
  `);
  const insertApproval = db.prepare(`
    INSERT INTO approvals (request_type, module_name, record_id, submitted_by, reason, status, old_values, new_values, decided_by, submitted_at, decided_at)
    VALUES (@request_type, @module_name, @record_id, @submitted_by, @reason, @status, @old_values, @new_values, @decided_by, @submitted_at, @decided_at)
  `);

  const transaction = db.transaction(() => {
    insertUser.run({
      name: 'Samuel Owusu',
      email: 'admin@whitewaterghana.com',
      password_hash: adminPasswordHash,
      role: 'ceo',
      status: 'Active',
      last_login: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    const customers = [
      { name: 'Accra Fresh Drinks', type: 'Wholesale', phone: '024-000-1101', email: 'sales@accrafresh.com', address: 'North Industrial Area, Accra', total_orders: 0, outstanding: 0, status: 'Active' },
      { name: 'Kwame Distributors', type: 'Wholesale', phone: '020-000-2202', email: 'orders@kwamedistributors.com', address: 'Spintex Road, Accra', total_orders: 0, outstanding: 0, status: 'Active' },
      { name: 'GH Water Depot', type: 'Retail Chain', phone: '026-000-3303', email: 'contact@ghwaterdepot.com', address: 'Community 1, Tema', total_orders: 0, outstanding: 0, status: 'Owing' },
      { name: 'Tema Cold Room', type: 'Retail', phone: '050-000-4404', email: 'hello@temacoldroom.com', address: 'Tema Harbour Road', total_orders: 0, outstanding: 0, status: 'Active' },
      { name: 'KNUST Campus Store', type: 'Institutional', phone: '032-000-5505', email: 'procurement@knustcampus.edu', address: 'KNUST Campus, Kumasi', total_orders: 0, outstanding: 0, status: 'Active' }
    ];

    for (const customer of customers) {
      insertCustomer.run({
        ...customer,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const vendors = [
      { name: 'PackRight Ltd', category: 'Packaging', phone: '024-111-1111', email: 'supply@packright.com', address: 'Tema Free Zones', status: 'Active' },
      { name: 'AquaFilter GH', category: 'Filtration', phone: '020-222-2222', email: 'service@aquafiltergh.com', address: 'Kumasi Industrial Park', status: 'Active' },
      { name: 'GH Cartons Co.', category: 'Packaging', phone: '026-333-3333', email: 'orders@ghcartons.com', address: 'Accra Central', status: 'Active' },
      { name: 'PolyFilm GH', category: 'Raw Material', phone: '050-444-4444', email: 'support@polyfilmgh.com', address: 'Kasoa Industrial Area', status: 'On Hold' }
    ];

    for (const vendor of vendors) {
      insertVendor.run({
        ...vendor,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const inventoryItems = [
      { name: 'Sachet Film Rolls', category: 'Packaging', quantity: 120, unit: 'Rolls', reorder_level: 200, unit_cost: 85, status: 'CRITICAL' },
      { name: 'Packing Tape', category: 'Packaging', quantity: 45, unit: 'Rolls', reorder_level: 100, unit_cost: 15, status: 'LOW' },
      { name: 'Carton Boxes', category: 'Packaging', quantity: 200, unit: 'Boxes', reorder_level: 500, unit_cost: 4, status: 'LOW' },
      { name: 'Filtered Water', category: 'Raw Material', quantity: 2500, unit: 'Litres', reorder_level: 1000, unit_cost: 0.04, status: 'ADEQUATE' },
      { name: '500ml Sachet Water (500 pcs/bag)', category: 'Finished Goods', quantity: 3400, unit: 'Bags', reorder_level: 500, unit_cost: 120, status: 'ADEQUATE' },
      { name: '1L Sachet Water (200 pcs/bag)', category: 'Finished Goods', quantity: 850, unit: 'Bags', reorder_level: 200, unit_cost: 160, status: 'ADEQUATE' },
      { name: 'Filter Cartridges', category: 'Consumables', quantity: 0, unit: 'Units', reorder_level: 5, unit_cost: 72, status: 'OUT OF STOCK' }
    ];

    for (const item of inventoryItems) {
      insertInventory.run({
        ...item,
        last_updated: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const machines = [
      { name: 'Koyo #1', status: 'Running', output_per_hour: 850, last_maintenance: '2026-03-20', operator: 'E. Boateng' },
      { name: 'Koyo #2', status: 'Running', output_per_hour: 820, last_maintenance: '2026-03-14', operator: 'A. Darko' },
      { name: 'Seamer A', status: 'Maintenance', output_per_hour: null, last_maintenance: '2026-03-23', operator: 'Maintenance Team' },
      { name: 'Capper 3', status: 'Idle', output_per_hour: null, last_maintenance: '2026-03-22', operator: 'Open Shift' }
    ];

    for (const machine of machines) {
      insertMachine.run({
        ...machine,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const production = [
      { batch_code: 'B-2026-041', product: '500ml Sachet Water (500 pcs/bag)', quantity: 5000, start_time: '2026-03-23T08:00:00.000Z', machine: 'Koyo #1', operator: 'E. Boateng', status: 'In Progress', cost: 470, wastage: 1.6 },
      { batch_code: 'B-2026-042', product: '500ml Sachet Water (500 pcs/bag)', quantity: 5000, start_time: '2026-03-23T08:30:00.000Z', machine: 'Koyo #2', operator: 'A. Darko', status: 'In Progress', cost: 465, wastage: 1.9 },
      { batch_code: 'B-2026-040', product: '1L Sachet Water (200 pcs/bag)', quantity: 2000, start_time: '2026-03-22T10:00:00.000Z', machine: 'Koyo #1', operator: 'M. Essel', status: 'Completed', cost: 380, wastage: 1.2 }
    ];

    for (const batch of production) {
      insertProduction.run({
        ...batch,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const customerMap = Object.fromEntries(db.prepare('SELECT id, name FROM customers').all().map((row) => [row.name, row.id]));
    const vendorMap = Object.fromEntries(db.prepare('SELECT id, name FROM vendors').all().map((row) => [row.name, row.id]));

    const sales = [
      { order_code: 'SO-2026-118', customer_id: customerMap['Accra Fresh Drinks'], product: '500ml Sachet Water (500 pcs/bag)', quantity: 10, amount: 1200, order_date: '2026-03-23', source: 'Website', status: 'Fulfilled' },
      { order_code: 'SO-2026-117', customer_id: customerMap['Kwame Distributors'], product: '1L Sachet Water (200 pcs/bag)', quantity: 5, amount: 800, order_date: '2026-03-23', source: 'Walk-in', status: 'Pending' },
      { order_code: 'SO-2026-116', customer_id: customerMap['GH Water Depot'], product: '500ml Sachet Water (500 pcs/bag)', quantity: 20, amount: 2400, order_date: '2026-03-17', source: 'Website', status: 'Fulfilled' },
      { order_code: 'SO-2026-115', customer_id: customerMap['Tema Cold Room'], product: '500ml Sachet Water (500 pcs/bag)', quantity: 15, amount: 1750, order_date: '2026-03-17', source: 'Walk-in', status: 'Cancelled' }
    ];

    for (const sale of sales) {
      const saleResult = insertSale.run({
        ...sale,
        invoice_id: null,
        created_at: timestamp,
        updated_at: timestamp,
      });

      if (sale.status !== 'Cancelled') {
        const invoiceStatus = sale.order_code === 'SO-2026-117' ? 'Pending' : sale.order_code === 'SO-2026-116' ? 'Overdue' : 'Paid';
        const invoiceCode = sale.order_code.replace('SO', 'INV');
        const issueDate = sale.order_date;
        const dueDate = sale.order_code === 'SO-2026-116' ? '2026-03-27' : '2026-03-28';
        const invoiceResult = insertInvoice.run({
          invoice_code: invoiceCode,
          customer_id: sale.customer_id,
          sales_order_id: saleResult.lastInsertRowid,
          amount: sale.amount,
          issue_date: issueDate,
          due_date: dueDate,
          status: invoiceStatus,
          created_at: timestamp,
          updated_at: timestamp,
        });

        updateSaleInvoice.run(invoiceResult.lastInsertRowid, timestamp, saleResult.lastInsertRowid);
      }
    }

    const purchaseOrders = [
      { po_code: 'PO-2026-031', vendor_id: vendorMap['PackRight Ltd'], item: 'Sachet Film Rolls', quantity: 500, amount: 2100, required_by: '2026-03-22', status: 'Pending', notes: 'Urgent replenishment for packaging line' },
      { po_code: 'PO-2026-030', vendor_id: vendorMap['AquaFilter GH'], item: 'Filter Cartridges', quantity: 20, amount: 1440, required_by: '2026-03-20', status: 'Ordered', notes: 'Replacement filters for purification system' },
      { po_code: 'PO-2026-029', vendor_id: vendorMap['GH Cartons Co.'], item: 'Carton Boxes', quantity: 1000, amount: 800, required_by: '2026-03-18', status: 'Received', notes: 'March restock' }
    ];

    for (const po of purchaseOrders) {
      insertPurchaseOrder.run({
        ...po,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const accountingEntries = [
      { type: 'Income', category: 'Sales Revenue', amount: 1200, entry_date: '2026-03-18', description: 'Sales - Accra Fresh Drinks' },
      { type: 'Expense', category: 'Electricity', amount: 450, entry_date: '2026-03-18', description: 'Electricity Bill' },
      { type: 'Income', category: 'Sales Revenue', amount: 2400, entry_date: '2026-03-17', description: 'Sales - GH Water Depot' },
      { type: 'Expense', category: 'Salaries', amount: 4200, entry_date: '2026-03-17', description: 'Staff Salaries' },
      { type: 'Expense', category: 'Supplier Payment', amount: 2100, entry_date: '2026-03-16', description: 'PackRight Ltd - Packaging Supply' },
      { type: 'Income', category: 'Sales Revenue', amount: 5600, entry_date: '2026-03-15', description: 'Sales - Various Customers' }
    ];

    for (const entry of accountingEntries) {
      insertAccounting.run({
        ...entry,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const approvals = [
      {
        request_type: 'Edit',
        module_name: 'inventory',
        record_id: 1,
        submitted_by: 'Kweku Asare (Supervisor)',
        reason: 'Physical stock count conducted at 8am. Correcting system quantity to match actual count.',
        status: 'Pending',
        old_values: JSON.stringify({ quantity: 180 }),
        new_values: JSON.stringify({ quantity: 120 }),
        decided_by: null,
        submitted_at: timestamp,
        decided_at: null,
      },
      {
        request_type: 'Delete',
        module_name: 'sales',
        record_id: 4,
        submitted_by: 'Abena Frimpong (Supervisor)',
        reason: 'Customer cancelled order before fulfilment. Invoice not yet sent. Requesting removal from register.',
        status: 'Pending',
        old_values: JSON.stringify({ order_code: 'SO-2026-115', amount: 1750 }),
        new_values: JSON.stringify({ deleted: true }),
        decided_by: null,
        submitted_at: timestamp,
        decided_at: null,
      },
      {
        request_type: 'Edit',
        module_name: 'vendors',
        record_id: 1,
        submitted_by: 'K. Mensah',
        reason: 'Updated vendor price after negotiation',
        status: 'Approved',
        old_values: JSON.stringify({ unit_cost: 88 }),
        new_values: JSON.stringify({ unit_cost: 85 }),
        decided_by: 'CEO',
        submitted_at: '2026-03-16T09:00:00.000Z',
        decided_at: '2026-03-16T09:30:00.000Z',
      }
    ];

    for (const approval of approvals) {
      insertApproval.run(approval);
    }

    // Seed store products
    const insertStoreProduct = db.prepare(`
      INSERT INTO store_products (name, description, price, unit, min_order, image, available, sort_order, created_at, updated_at)
      VALUES (@name, @description, @price, @unit, @min_order, @image, @available, @sort_order, @created_at, @updated_at)
    `);

    const storeProducts = [
      { name: '500ml Sachet Water', description: 'Pure, filtered sachet water — 500ml bags. Sold per bag (500 pcs per bag).', price: 120, unit: 'bag', min_order: 1, image: null, available: 1, sort_order: 1 },
    ];

    for (const product of storeProducts) {
      insertStoreProduct.run({
        ...product,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
  });

  transaction();
  refreshCustomerStats();
  refreshInventoryStatuses();
}

function initDatabase() {
  createSchema();
  seedDatabase();
}

module.exports = {
  db,
  initDatabase,
  nowIso,
  computeInventoryStatus,
  refreshCustomerStats,
  refreshInventoryStatuses,
};