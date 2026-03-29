const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

function nowIso() {
  return new Date().toISOString();
}

function computeInventoryStatus(quantity, reorderLevel) {
  if (quantity <= 0) return 'OUT OF STOCK';
  if (quantity <= reorderLevel * 0.5) return 'CRITICAL';
  if (quantity <= reorderLevel) return 'LOW';
  return 'ADEQUATE';
}

/* ═══════════════════════════════════════════════
   SCHEMAS & MODELS
   ═══════════════════════════════════════════════ */

const toJSONOpts = {
  virtuals: true,
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret.__v;
  },
};

const userSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  role:          { type: String, required: true },
  status:        { type: String, default: 'Active' },
  last_login:    { type: String, default: null },
}, { timestamps: true, toJSON: toJSONOpts });

const sessionSchema = new mongoose.Schema({
  token:      { type: String, required: true, unique: true },
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expires_at: { type: String, required: true },
}, { timestamps: true, toJSON: toJSONOpts });

const customerSchema = new mongoose.Schema({
  name:         { type: String, required: true },
  type:         { type: String, required: true },
  phone:        { type: String, default: '' },
  email:        { type: String, default: '' },
  address:      { type: String, default: '' },
  total_orders: { type: Number, default: 0 },
  outstanding:  { type: Number, default: 0 },
  status:       { type: String, default: 'Active' },
}, { timestamps: true, toJSON: toJSONOpts });

const vendorSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  category: { type: String, required: true },
  phone:    { type: String, default: '' },
  email:    { type: String, default: '' },
  address:  { type: String, default: '' },
  status:   { type: String, default: 'Active' },
}, { timestamps: true, toJSON: toJSONOpts });

const inventoryItemSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  category:      { type: String, required: true },
  quantity:      { type: Number, default: 0 },
  unit:          { type: String, required: true },
  reorder_level: { type: Number, default: 0 },
  unit_cost:     { type: Number, default: 0 },
  status:        { type: String, required: true },
  last_updated:  { type: String, required: true },
}, { timestamps: true, toJSON: toJSONOpts });

const machineSchema = new mongoose.Schema({
  name:             { type: String, required: true },
  status:           { type: String, required: true },
  output_per_hour:  { type: Number, default: null },
  last_maintenance: { type: String, default: null },
  operator:         { type: String, default: '' },
}, { timestamps: true, toJSON: toJSONOpts });

const productionBatchSchema = new mongoose.Schema({
  batch_code: { type: String, required: true, unique: true },
  product:    { type: String, required: true },
  quantity:   { type: Number, required: true },
  start_time: { type: String, required: true },
  machine:    { type: String, required: true },
  operator:   { type: String, default: '' },
  status:     { type: String, required: true },
  cost:       { type: Number, default: 0 },
  wastage:    { type: Number, default: 0 },
}, { timestamps: true, toJSON: toJSONOpts });

const salesOrderSchema = new mongoose.Schema({
  order_code:  { type: String, required: true, unique: true },
  customer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  product:     { type: String, required: true },
  quantity:    { type: Number, required: true },
  amount:      { type: Number, required: true },
  order_date:  { type: String, required: true },
  source:      { type: String, required: true },
  status:      { type: String, required: true },
  invoice_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
}, { timestamps: true, toJSON: toJSONOpts });

const invoiceSchema = new mongoose.Schema({
  invoice_code:   { type: String, required: true, unique: true },
  customer_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  sales_order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', default: null },
  amount:         { type: Number, required: true },
  issue_date:     { type: String, required: true },
  due_date:       { type: String, required: true },
  status:         { type: String, required: true },
}, { timestamps: true, toJSON: toJSONOpts });

const purchaseOrderSchema = new mongoose.Schema({
  po_code:     { type: String, required: true, unique: true },
  vendor_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
  item:        { type: String, required: true },
  quantity:    { type: Number, required: true },
  amount:      { type: Number, required: true },
  required_by: { type: String, default: null },
  status:      { type: String, required: true },
  notes:       { type: String, default: '' },
}, { timestamps: true, toJSON: toJSONOpts });

const accountingEntrySchema = new mongoose.Schema({
  type:        { type: String, required: true },
  category:    { type: String, required: true },
  amount:      { type: Number, required: true },
  entry_date:  { type: String, required: true },
  description: { type: String, required: true },
}, { timestamps: true, toJSON: toJSONOpts });

const approvalSchema = new mongoose.Schema({
  request_type: { type: String, required: true },
  module_name:  { type: String, required: true },
  record_id:    { type: mongoose.Schema.Types.ObjectId, default: null },
  submitted_by: { type: String, required: true },
  reason:       { type: String, required: true },
  status:       { type: String, required: true },
  old_values:   { type: mongoose.Schema.Types.Mixed, default: null },
  new_values:   { type: mongoose.Schema.Types.Mixed, default: null },
  decided_by:   { type: String, default: null },
  submitted_at: { type: String, required: true },
  decided_at:   { type: String, default: null },
}, { timestamps: true, toJSON: toJSONOpts });

const storeCustomerSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone:         { type: String, required: true },
  password_hash: { type: String, required: true },
  address:       { type: String, default: null },
  city:          { type: String, default: null },
  region:        { type: String, default: null },
  status:        { type: String, default: 'Active' },
}, { timestamps: true, toJSON: toJSONOpts });

const storeOrderSchema = new mongoose.Schema({
  order_code:       { type: String, required: true, unique: true },
  customer_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'StoreCustomer', required: true },
  items:            { type: mongoose.Schema.Types.Mixed, required: true },
  subtotal:         { type: Number, required: true },
  delivery_fee:     { type: Number, default: 0 },
  total:            { type: Number, required: true },
  delivery_address: { type: String, required: true },
  delivery_city:    { type: String, default: null },
  delivery_region:  { type: String, default: null },
  phone:            { type: String, required: true },
  notes:            { type: String, default: null },
  status:           { type: String, default: 'Pending' },
}, { timestamps: true, toJSON: toJSONOpts });

const storeProductSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  price:       { type: Number, required: true },
  unit:        { type: String, default: 'bag' },
  min_order:   { type: Number, default: 1 },
  image:       { type: String, default: null },
  available:   { type: Boolean, default: true },
  sort_order:  { type: Number, default: 0 },
}, { timestamps: true, toJSON: toJSONOpts });

const storeSessionSchema = new mongoose.Schema({
  token:       { type: String, required: true, unique: true },
  customer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreCustomer', required: true },
  expires_at:  { type: String, required: true },
}, { timestamps: true, toJSON: toJSONOpts });

const factoryEquipmentSchema = new mongoose.Schema({
  code:             { type: String, required: true, unique: true },
  equipment:        { type: String, required: true },
  details:          { type: String, default: '' },
  status:           { type: String, required: true },
  lastMaintenance:  { type: String, default: null },
  nextMaintenance:  { type: String, default: null },
}, { timestamps: true, toJSON: toJSONOpts });

const appDataSchema = new mongoose.Schema({
  key:  { type: String, required: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true, toJSON: toJSONOpts });

/* ── Register models ── */

const User            = mongoose.model('User', userSchema);
const Session         = mongoose.model('Session', sessionSchema);
const Customer        = mongoose.model('Customer', customerSchema);
const Vendor          = mongoose.model('Vendor', vendorSchema);
const InventoryItem   = mongoose.model('InventoryItem', inventoryItemSchema);
const Machine         = mongoose.model('Machine', machineSchema);
const ProductionBatch = mongoose.model('ProductionBatch', productionBatchSchema);
const SalesOrder      = mongoose.model('SalesOrder', salesOrderSchema);
const Invoice         = mongoose.model('Invoice', invoiceSchema);
const PurchaseOrder   = mongoose.model('PurchaseOrder', purchaseOrderSchema);
const AccountingEntry = mongoose.model('AccountingEntry', accountingEntrySchema);
const Approval        = mongoose.model('Approval', approvalSchema);
const StoreCustomer   = mongoose.model('StoreCustomer', storeCustomerSchema);
const StoreOrder      = mongoose.model('StoreOrder', storeOrderSchema);
const StoreProduct    = mongoose.model('StoreProduct', storeProductSchema);
const StoreSession    = mongoose.model('StoreSession', storeSessionSchema);
const FactoryEquipment = mongoose.model('FactoryEquipment', factoryEquipmentSchema);
const AppData          = mongoose.model('AppData', appDataSchema);

/* ═══════════════════════════════════════════════
   HELPER FUNCTIONS
   ═══════════════════════════════════════════════ */

async function refreshCustomerStats() {
  const customers = await Customer.find({}, '_id');
  for (const c of customers) {
    const orderCount = await SalesOrder.countDocuments({ customer_id: c._id });
    const outstandingAgg = await Invoice.aggregate([
      { $match: { customer_id: c._id, status: { $ne: 'Paid' } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const outstanding = outstandingAgg.length ? outstandingAgg[0].total : 0;
    await Customer.updateOne({ _id: c._id }, { total_orders: orderCount, outstanding });
  }
}

async function refreshInventoryStatuses() {
  const items = await InventoryItem.find({}, 'quantity reorder_level');
  const timestamp = nowIso();
  for (const item of items) {
    await InventoryItem.updateOne({ _id: item._id }, {
      status: computeInventoryStatus(item.quantity, item.reorder_level),
      last_updated: timestamp,
    });
  }
}

/* ═══════════════════════════════════════════════
   SEED DATABASE
   ═══════════════════════════════════════════════ */

async function seedDatabase() {
  // Always seed factory equipment if missing
  const eqCount = await FactoryEquipment.countDocuments();
  if (eqCount === 0) {
    await FactoryEquipment.insertMany([
      { code: 'EQ-101', equipment: 'Koyo Packaging Machine #1', details: 'with UV, pump, and stainless housing', status: 'operational', lastMaintenance: '2026-03-18', nextMaintenance: '2026-04-18' },
      { code: 'EQ-102', equipment: 'Koyo Packaging Machine #2', details: 'with UV, pump, and stainless housing', status: 'operational', lastMaintenance: '2026-03-17', nextMaintenance: '2026-04-17' },
      { code: 'EQ-103', equipment: 'Koyo Packaging Machine #3', details: 'with UV, pump, and stainless housing', status: 'operational', lastMaintenance: '2026-03-16', nextMaintenance: '2026-04-16' },
      { code: 'EQ-104', equipment: 'Koyo Packaging Machine #4', details: 'with UV, pump, and stainless housing', status: 'needs_repair', lastMaintenance: '2026-03-09', nextMaintenance: '2026-04-09' },
      { code: 'EQ-105', equipment: 'Koyo Packaging Machine #5', details: 'with UV, pump, and stainless housing', status: 'operational', lastMaintenance: '2026-03-14', nextMaintenance: '2026-04-14' },
      { code: 'EQ-106', equipment: 'Reverse Osmosis (R/O) Machine', details: '4-ton capacity incl. filtration apparatus', status: 'operational', lastMaintenance: '2026-03-12', nextMaintenance: '2026-04-12' },
      { code: 'EQ-107', equipment: 'Reverse Osmosis (R/O) Machine', details: '6-ton capacity incl. filtration apparatus', status: 'faulty', lastMaintenance: '2026-03-05', nextMaintenance: '2026-04-05' },
    ]);
    console.log('Factory equipment seeded');
  }

  const count = await Customer.countDocuments();
  if (count > 0) {
    await refreshCustomerStats();
    await refreshInventoryStatuses();
    return;
  }

  const timestamp = nowIso();

  /* ── Customers ── */
  const customers = await Customer.insertMany([
    { name: 'Accra Fresh Drinks', type: 'Wholesale', phone: '024-000-1101', email: 'sales@accrafresh.com', address: 'North Industrial Area, Accra', status: 'Active' },
    { name: 'Kwame Distributors', type: 'Wholesale', phone: '020-000-2202', email: 'orders@kwamedistributors.com', address: 'Spintex Road, Accra', status: 'Active' },
    { name: 'GH Water Depot', type: 'Retail Chain', phone: '026-000-3303', email: 'contact@ghwaterdepot.com', address: 'Community 1, Tema', status: 'Owing' },
    { name: 'Tema Cold Room', type: 'Retail', phone: '050-000-4404', email: 'hello@temacoldroom.com', address: 'Tema Harbour Road', status: 'Active' },
    { name: 'KNUST Campus Store', type: 'Institutional', phone: '032-000-5505', email: 'procurement@knustcampus.edu', address: 'KNUST Campus, Kumasi', status: 'Active' },
  ]);
  const customerMap = {};
  for (const c of customers) customerMap[c.name] = c._id;

  /* ── Vendors ── */
  const vendors = await Vendor.insertMany([
    { name: 'PackRight Ltd', category: 'Packaging', phone: '024-111-1111', email: 'supply@packright.com', address: 'Tema Free Zones', status: 'Active' },
    { name: 'AquaFilter GH', category: 'Filtration', phone: '020-222-2222', email: 'service@aquafiltergh.com', address: 'Kumasi Industrial Park', status: 'Active' },
    { name: 'GH Cartons Co.', category: 'Packaging', phone: '026-333-3333', email: 'orders@ghcartons.com', address: 'Accra Central', status: 'Active' },
    { name: 'PolyFilm GH', category: 'Raw Material', phone: '050-444-4444', email: 'support@polyfilmgh.com', address: 'Kasoa Industrial Area', status: 'On Hold' },
  ]);
  const vendorMap = {};
  for (const v of vendors) vendorMap[v.name] = v._id;

  /* ── Inventory Items ── */
  await InventoryItem.insertMany([
    { name: 'Sachet Film Rolls', category: 'Packaging', quantity: 120, unit: 'Rolls', reorder_level: 200, unit_cost: 85, status: 'CRITICAL', last_updated: timestamp },
    { name: 'Packing Tape', category: 'Packaging', quantity: 45, unit: 'Rolls', reorder_level: 100, unit_cost: 15, status: 'LOW', last_updated: timestamp },
    { name: 'Carton Boxes', category: 'Packaging', quantity: 200, unit: 'Boxes', reorder_level: 500, unit_cost: 4, status: 'LOW', last_updated: timestamp },
    { name: 'Filtered Water', category: 'Raw Material', quantity: 2500, unit: 'Litres', reorder_level: 1000, unit_cost: 0.04, status: 'ADEQUATE', last_updated: timestamp },
    { name: '500ml Sachet Water (500 pcs/bag)', category: 'Finished Goods', quantity: 3400, unit: 'Bags', reorder_level: 500, unit_cost: 120, status: 'ADEQUATE', last_updated: timestamp },
    { name: '1L Sachet Water (200 pcs/bag)', category: 'Finished Goods', quantity: 850, unit: 'Bags', reorder_level: 200, unit_cost: 160, status: 'ADEQUATE', last_updated: timestamp },
    { name: 'Filter Cartridges', category: 'Consumables', quantity: 0, unit: 'Units', reorder_level: 5, unit_cost: 72, status: 'OUT OF STOCK', last_updated: timestamp },
  ]);

  /* ── Machines ── */
  await Machine.insertMany([
    { name: 'Koyo #1', status: 'Running', output_per_hour: 850, last_maintenance: '2026-03-20', operator: 'E. Boateng' },
    { name: 'Koyo #2', status: 'Running', output_per_hour: 820, last_maintenance: '2026-03-14', operator: 'A. Darko' },
    { name: 'Seamer A', status: 'Maintenance', output_per_hour: null, last_maintenance: '2026-03-23', operator: 'Maintenance Team' },
    { name: 'Capper 3', status: 'Idle', output_per_hour: null, last_maintenance: '2026-03-22', operator: 'Open Shift' },
  ]);

  /* ── Production Batches ── */
  await ProductionBatch.insertMany([
    { batch_code: 'B-2026-041', product: '500ml Sachet Water (500 pcs/bag)', quantity: 5000, start_time: '2026-03-23T08:00:00.000Z', machine: 'Koyo #1', operator: 'E. Boateng', status: 'In Progress', cost: 470, wastage: 1.6 },
    { batch_code: 'B-2026-042', product: '500ml Sachet Water (500 pcs/bag)', quantity: 5000, start_time: '2026-03-23T08:30:00.000Z', machine: 'Koyo #2', operator: 'A. Darko', status: 'In Progress', cost: 465, wastage: 1.9 },
    { batch_code: 'B-2026-040', product: '1L Sachet Water (200 pcs/bag)', quantity: 2000, start_time: '2026-03-22T10:00:00.000Z', machine: 'Koyo #1', operator: 'M. Essel', status: 'Completed', cost: 380, wastage: 1.2 },
  ]);

  /* ── Sales Orders + Invoices ── */
  const salesData = [
    { order_code: 'SO-2026-118', cn: 'Accra Fresh Drinks', product: '500ml Sachet Water (500 pcs/bag)', quantity: 10, amount: 1200, order_date: '2026-03-23', source: 'Website', status: 'Fulfilled' },
    { order_code: 'SO-2026-117', cn: 'Kwame Distributors', product: '1L Sachet Water (200 pcs/bag)', quantity: 5, amount: 800, order_date: '2026-03-23', source: 'Walk-in', status: 'Pending' },
    { order_code: 'SO-2026-116', cn: 'GH Water Depot', product: '500ml Sachet Water (500 pcs/bag)', quantity: 20, amount: 2400, order_date: '2026-03-17', source: 'Website', status: 'Fulfilled' },
    { order_code: 'SO-2026-115', cn: 'Tema Cold Room', product: '500ml Sachet Water (500 pcs/bag)', quantity: 15, amount: 1750, order_date: '2026-03-17', source: 'Walk-in', status: 'Cancelled' },
  ];

  for (const s of salesData) {
    const so = await SalesOrder.create({
      order_code: s.order_code, customer_id: customerMap[s.cn],
      product: s.product, quantity: s.quantity, amount: s.amount,
      order_date: s.order_date, source: s.source, status: s.status,
    });

    if (s.status !== 'Cancelled') {
      const invoiceStatus = s.order_code === 'SO-2026-117' ? 'Pending'
        : s.order_code === 'SO-2026-116' ? 'Overdue' : 'Paid';
      const inv = await Invoice.create({
        invoice_code: s.order_code.replace('SO', 'INV'),
        customer_id: customerMap[s.cn], sales_order_id: so._id,
        amount: s.amount, issue_date: s.order_date,
        due_date: s.order_code === 'SO-2026-116' ? '2026-03-27' : '2026-03-28',
        status: invoiceStatus,
      });
      await SalesOrder.updateOne({ _id: so._id }, { invoice_id: inv._id });
    }
  }

  /* ── Purchase Orders ── */
  await PurchaseOrder.insertMany([
    { po_code: 'PO-2026-031', vendor_id: vendorMap['PackRight Ltd'], item: 'Sachet Film Rolls', quantity: 500, amount: 2100, required_by: '2026-03-22', status: 'Pending', notes: 'Urgent replenishment for packaging line' },
    { po_code: 'PO-2026-030', vendor_id: vendorMap['AquaFilter GH'], item: 'Filter Cartridges', quantity: 20, amount: 1440, required_by: '2026-03-20', status: 'Ordered', notes: 'Replacement filters for purification system' },
    { po_code: 'PO-2026-029', vendor_id: vendorMap['GH Cartons Co.'], item: 'Carton Boxes', quantity: 1000, amount: 800, required_by: '2026-03-18', status: 'Received', notes: 'March restock' },
  ]);

  /* ── Accounting Entries ── */
  await AccountingEntry.insertMany([
    { type: 'Income', category: 'Sales Revenue', amount: 1200, entry_date: '2026-03-18', description: 'Sales - Accra Fresh Drinks' },
    { type: 'Expense', category: 'Electricity', amount: 450, entry_date: '2026-03-18', description: 'Electricity Bill' },
    { type: 'Income', category: 'Sales Revenue', amount: 2400, entry_date: '2026-03-17', description: 'Sales - GH Water Depot' },
    { type: 'Expense', category: 'Salaries', amount: 4200, entry_date: '2026-03-17', description: 'Staff Salaries' },
    { type: 'Expense', category: 'Supplier Payment', amount: 2100, entry_date: '2026-03-16', description: 'PackRight Ltd - Packaging Supply' },
    { type: 'Income', category: 'Sales Revenue', amount: 5600, entry_date: '2026-03-15', description: 'Sales - Various Customers' },
  ]);

  /* ── Approvals ── */
  const firstInv = await InventoryItem.findOne({ name: 'Sachet Film Rolls' });
  const cancelledSale = await SalesOrder.findOne({ order_code: 'SO-2026-115' });
  await Approval.insertMany([
    { request_type: 'Edit', module_name: 'inventory', record_id: firstInv?._id, submitted_by: 'Kweku Asare (Supervisor)', reason: 'Physical stock count conducted at 8am. Correcting system quantity to match actual count.', status: 'Pending', old_values: { quantity: 180 }, new_values: { quantity: 120 }, submitted_at: timestamp },
    { request_type: 'Delete', module_name: 'sales', record_id: cancelledSale?._id, submitted_by: 'Abena Frimpong (Supervisor)', reason: 'Customer cancelled order before fulfilment. Invoice not yet sent. Requesting removal from register.', status: 'Pending', old_values: { order_code: 'SO-2026-115', amount: 1750 }, new_values: { deleted: true }, submitted_at: timestamp },
    { request_type: 'Edit', module_name: 'vendors', record_id: vendorMap['PackRight Ltd'], submitted_by: 'K. Mensah', reason: 'Updated vendor price after negotiation', status: 'Approved', old_values: { unit_cost: 88 }, new_values: { unit_cost: 85 }, decided_by: 'CEO', submitted_at: '2026-03-16T09:00:00.000Z', decided_at: '2026-03-16T09:30:00.000Z' },
  ]);

  /* ── Store Products ── */
  await StoreProduct.create({ name: '500ml Sachet Water', description: 'Pure, filtered sachet water — 500ml bags. Sold per bag (500 pcs per bag).', price: 120, unit: 'bag', min_order: 1, available: true, sort_order: 1 });

  await refreshCustomerStats();
  await refreshInventoryStatuses();
  console.log('Database seeded');
}

/* ═══════════════════════════════════════════════
   CONNECT + INIT
   ═══════════════════════════════════════════════ */

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set in .env');
  await mongoose.connect(uri, { dbName: 'whitewater' });
  console.log('MongoDB connected');
  await seedDatabase();
}

module.exports = {
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
};
