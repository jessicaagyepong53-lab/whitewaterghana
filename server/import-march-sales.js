/**
 * Import March 2026 sales data from spreadsheet.
 * Run: node server/import-march-sales.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  connectDB,
  Customer,
  SalesOrder,
  Invoice,
  AccountingEntry,
} = require('./db');

const PRODUCT = '500ml Sachet Water (500 pcs/bag)';

// All rows from the spreadsheet
const rows = [
  // 16/03/26
  { date: '2026-03-16', customer: 'Mon (driver)', bags: 60, rate: 7.5, amount: 450, status: 'Paid' },
  { date: '2026-03-16', customer: 'Mon (driver)', bags: 15, rate: 7.5, amount: 113, status: 'Paid' },
  { date: '2026-03-16', customer: 'Charlotte', bags: 950, rate: 6, amount: 5700, status: 'Paid', notes: 'sacks' },
  { date: '2026-03-16', customer: 'JMK', bags: 745, rate: null, amount: 1500, status: 'Paid', notes: '126 + 8, zero total supplied' },
  // 17/03/26
  { date: '2026-03-17', customer: 'Client', bags: 1, rate: 7.5, amount: 7.50, status: 'Pending', notes: '15¢ @ 7.5' },
  { date: '2026-03-17', customer: 'Charlotte', bags: 500, rate: 6, amount: 3000, status: 'Pending' },
  { date: '2026-03-17', customer: 'Musa', bags: 250, rate: 6.5, amount: 1500, status: 'Pending', notes: '250 bags @ 6.5, +12' },
  { date: '2026-03-17', customer: 'Flarc', bags: 15, rate: null, amount: 112.50, status: 'Paid' },
  { date: '2026-03-17', customer: 'Chef', bags: 3, rate: 7.5, amount: 22.50, status: 'Paid' },
  { date: '2026-03-17', customer: 'Charlotte / Stzpr', bags: 258, rate: null, amount: 4500, status: 'Pending', notes: '250 bags + 8 bags' },
  { date: '2026-03-17', customer: 'Aboboyaa', bags: 114, rate: null, amount: 660, status: 'Pending', notes: 'Received 18/3/26' },
  // 18/03/26
  { date: '2026-03-18', customer: 'Michael Defadu', bags: 90, rate: 7, amount: 560, status: 'Pending', notes: '80 + 10 (clear)' },
  { date: '2026-03-18', customer: 'Michael Defadu', bags: 50, rate: 7.5, amount: 365, status: 'Pending', notes: 'Correct 30@7.5=¢225, leakage 20@7.0+2=¢140' },
  { date: '2026-03-18', customer: 'Charlotte', bags: 500, rate: 6, amount: 2520, status: 'Paid', notes: '420 pieces' },
  { date: '2026-03-18', customer: 'Aboboyaa', bags: 110, rate: 7.5, amount: 660, status: 'Paid', notes: '@¢6.0' },
  { date: '2026-03-18', customer: 'Aboboyaa', bags: 110, rate: 6, amount: 660, status: 'Paid' },
  { date: '2026-03-18', customer: 'Ismael', bags: 25, rate: 7.5, amount: 187.50, status: 'Paid', notes: 'Momo ¢105, Cash ¢2.5, Total=795, Grand Total=4,930' },
  // 19/03/26
  { date: '2026-03-19', customer: 'Michael Dafadu', bags: 80, rate: 7, amount: 560, status: 'Paid', notes: '@ ¢7' },
  { date: '2026-03-19', customer: 'Charlotte', bags: 300, rate: 6, amount: 1800, status: 'Paid' },
  { date: '2026-03-19', customer: 'Aboboyaa', bags: 120, rate: 6, amount: 720, status: 'Paid' },
  { date: '2026-03-19', customer: 'Aboboyaa', bags: 110, rate: 6, amount: 660, status: 'Paid' },
  { date: '2026-03-19', customer: 'Individual', bags: 5, rate: 7, amount: 35, status: 'Paid', notes: 'Total bags=615; Total=¢3,775.00' },
  // 20/03/26
  { date: '2026-03-20', customer: 'Kia', bags: 50, rate: 6, amount: 300, status: 'Paid' },
  { date: '2026-03-20', customer: 'Charlotte', bags: 500, rate: 6, amount: 3000, status: 'Pending' },
  { date: '2026-03-20', customer: 'Michael Dze', bags: 50, rate: 7.5, amount: 375, status: 'Paid', notes: '¢305 cash, ¢70 momo' },
  { date: '2026-03-20', customer: 'Carida', bags: 16, rate: null, amount: 120, status: 'Paid', notes: '0540944885' },
  // 21/03/26
  { date: '2026-03-21', customer: 'Charlotte', bags: 500, rate: 6, amount: 3000, status: 'Paid' },
  { date: '2026-03-21', customer: 'Dafadu', bags: 20, rate: 7.5, amount: 150, status: 'Paid' },
  { date: '2026-03-21', customer: 'Dzepedu', bags: 4, rate: 7.5, amount: 30, status: 'Paid' },
  { date: '2026-03-21', customer: 'Kukua', bags: 6, rate: 6, amount: 36, status: 'Paid' },
  { date: '2026-03-21', customer: 'Christpha', bags: 2, rate: 6, amount: 12, status: 'Paid' },
  { date: '2026-03-21', customer: 'Dzepedu', bags: 20, rate: 7.5, amount: 150, status: 'Paid' },
  { date: '2026-03-21', customer: 'Individual', bags: 110, rate: 6, amount: 660, status: 'Paid' },
  // 23/03/26
  { date: '2026-03-23', customer: 'Charlotte', bags: 350, rate: 6, amount: 2100, status: 'Paid' },
  { date: '2026-03-23', customer: 'Charlotte', bags: 134, rate: 6, amount: 804, status: 'Paid' },
  { date: '2026-03-23', customer: 'Aboboyaa', bags: 40, rate: 6, amount: 240, status: 'Paid', notes: '40 bags + 16' },
  { date: '2026-03-23', customer: 'Apostle Dab', bags: 20, rate: 7.5, amount: 150, status: 'Paid' },
  { date: '2026-03-23', customer: 'Individual', bags: 5, rate: 7.5, amount: 37.50, status: 'Paid' },
  // 24/03/26
  { date: '2026-03-24', customer: 'Charlotte', bags: 364, rate: 6, amount: 2100, status: 'Paid', notes: '350 + 14 bags; 2:00am' },
  { date: '2026-03-24', customer: 'Charlotte', bags: 116, rate: 6, amount: 2400, status: 'Paid', notes: '100 + 16 bags; Crossed out' },
  { date: '2026-03-24', customer: 'Boyit', bags: 7, rate: 6, amount: 42, status: 'Paid' },
  { date: '2026-03-24', customer: 'Aboboyaa', bags: 116, rate: 6, amount: 660, status: 'Paid', notes: '110 + 6 bags; Momo' },
  { date: '2026-03-24', customer: 'Individual', bags: 20, rate: 7, amount: 140, status: 'Paid' },
  // 25/03/26
  { date: '2026-03-25', customer: 'Charlotte', bags: 400, rate: 6, amount: 2400, status: 'Paid' },
  { date: '2026-03-25', customer: 'Dafadu', bags: 70, rate: 7.5, amount: 525, status: 'Paid' },
  { date: '2026-03-25', customer: 'Dagadu', bags: 100, rate: 7.5, amount: 750, status: 'Paid', notes: '¢650 cash, ¢100 momo' },
  { date: '2026-03-25', customer: 'Client (walk-in)', bags: 20, rate: 7.5, amount: 150, status: 'Paid' },
  { date: '2026-03-25', customer: 'Client', bags: 10, rate: 7.5, amount: 75, status: 'Paid' },
  { date: '2026-03-25', customer: 'Walk-in', bags: 1, rate: 6, amount: 6, status: 'Paid' },
  { date: '2026-03-25', customer: 'Charlotte', bags: 400, rate: 6, amount: 2400, status: 'Paid' },
  { date: '2026-03-25', customer: 'Dafadu', bags: 70, rate: 7.5, amount: 525, status: 'Paid' },
  { date: '2026-03-25', customer: 'Dafadu', bags: 50, rate: 7.5, amount: 375, status: 'Paid' },
  // 26/03/26
  { date: '2026-03-26', customer: 'Grace MTN (Eve)', bags: 20, rate: 7.5, amount: 150, status: 'Paid', notes: '0244430869' },
  { date: '2026-03-26', customer: 'Charlotte', bags: 400, rate: 6, amount: 2400, status: 'Paid', notes: '10:00am' },
  { date: '2026-03-26', customer: 'Walk-in', bags: 4, rate: 6, amount: 24, status: 'Paid' },
  { date: '2026-03-26', customer: 'Walk-in', bags: 4, rate: 6, amount: 24, status: 'Paid' },
  { date: '2026-03-26', customer: 'Madam Mamuko / Apr', bags: 100, rate: 7.5, amount: 750, status: 'Paid', notes: 'Momo; 0244274050; Dafadu' },
  { date: '2026-03-26', customer: 'Walk-in (Delney)', bags: 3, rate: 7.5, amount: 22.50, status: 'Paid', notes: 'Momo' },
  { date: '2026-03-26', customer: 'Michael', bags: 50, rate: 7, amount: 250, status: 'Paid' },
  { date: '2026-03-26', customer: 'Aboboyaa', bags: 100, rate: 6, amount: 600, status: 'Paid' },
  { date: '2026-03-26', customer: 'Walk-in', bags: 4, rate: 6, amount: 24, status: 'Paid' },
  // 27/03/26
  { date: '2026-03-27', customer: 'Charlotte', bags: 450, rate: 6, amount: 2700, status: 'Paid', notes: '10am' },
  { date: '2026-03-27', customer: 'Walk-in', bags: 4, rate: 6, amount: 24, status: 'Paid', notes: 'Momo' },
  { date: '2026-03-27', customer: 'Walk-in', bags: 7, rate: 6, amount: 42, status: 'Paid' },
  { date: '2026-03-27', customer: 'Client', bags: 15, rate: 7.5, amount: 112.50, status: 'Paid' },
  { date: '2026-03-27', customer: 'Laulas', bags: 8, rate: 6, amount: null, status: 'Pending', notes: 'No amount recorded' },
  { date: '2026-03-27', customer: 'Charlotte', bags: 350, rate: 6, amount: 2000, status: 'Paid', notes: '350 bags (2 bags @ 6)' },
  { date: '2026-03-27', customer: 'Aboboyaa', bags: 100, rate: 6, amount: 600, status: 'Paid' },
  // 28/03/26
  { date: '2026-03-28', customer: 'Charlotte', bags: 450, rate: 6, amount: 2700, status: 'Paid', notes: '8:00am; FPO' },
  { date: '2026-03-28', customer: 'Amos', bags: 100, rate: 7, amount: 700, status: 'Paid', notes: '6:30am' },
  { date: '2026-03-28', customer: 'Aboboyaa', bags: 110, rate: 6, amount: 660, status: 'Paid', notes: '10:00am' },
  { date: '2026-03-28', customer: 'Aboboyaa', bags: 100, rate: 6, amount: 600, status: 'Paid', notes: '11:07am' },
  { date: '2026-03-28', customer: 'Walk-in', bags: 3, rate: 6, amount: 18, status: 'Paid' },
  { date: '2026-03-28', customer: 'Walk-in', bags: 10, rate: 6, amount: 60, status: 'Paid' },
  { date: '2026-03-28', customer: 'Walk-in', bags: 6, rate: 7, amount: 40, status: 'Paid' },
  { date: '2026-03-28', customer: 'Carida Okadaahu', bags: 10, rate: 7.5, amount: 75, status: 'Paid', notes: '0544285402' },
  { date: '2026-03-28', customer: 'Charlotte', bags: 389, rate: 6, amount: 2250, status: 'Paid', notes: '375 + 14 bags; 3:00pm' },
  { date: '2026-03-28', customer: 'Aboboyaa', bags: 110, rate: 6, amount: 660, status: 'Paid' },
  { date: '2026-03-28', customer: 'Aboboyaa', bags: 100, rate: 6, amount: 600, status: 'Paid' },
  { date: '2026-03-28', customer: 'Walk-in / Police', bags: 6, rate: 5, amount: 30, status: 'Paid' },
  { date: '2026-03-28', customer: 'Daapaadu', bags: 47, rate: 7.5, amount: 352.50, status: 'Paid', notes: 'Saturday additional' },
  { date: '2026-03-28', customer: 'Amos', bags: 7, rate: 7.5, amount: 42, status: 'Paid' },
  { date: '2026-03-28', customer: 'Amos', bags: 44, rate: 7, amount: 208, status: 'Paid' },
  { date: '2026-03-28', customer: 'Aboboyaa', bags: 100, rate: 6, amount: 600, status: 'Paid' },
  { date: '2026-03-28', customer: 'Walk-in', bags: 10, rate: 7.5, amount: 75, status: 'Paid' },
  { date: '2026-03-28', customer: 'Walk-in', bags: 6, rate: 6, amount: 36, status: 'Paid' },
  { date: '2026-03-28', customer: 'Walk-in', bags: 1, rate: 6, amount: 6, status: 'Paid' },
];

function padCode(n) {
  return String(n).padStart(3, '0');
}

async function run() {
  await connectDB();
  console.log('Connected. Starting import...');

  // Get existing max SO and INV codes
  const allSO = await SalesOrder.find({}, 'order_code').lean();
  let maxSO = 0;
  for (const s of allSO) {
    const parts = String(s.order_code).split('-');
    const n = Number(parts[parts.length - 1]);
    if (n > maxSO) maxSO = n;
  }

  const allINV = await Invoice.find({}, 'invoice_code').lean();
  let maxINV = 0;
  for (const i of allINV) {
    const parts = String(i.invoice_code).split('-');
    const n = Number(parts[parts.length - 1]);
    if (n > maxINV) maxINV = n;
  }

  let soCounter = maxSO;
  let invCounter = maxINV;

  // Build customer cache - find or create
  const customerCache = {};
  for (const row of rows) {
    const name = row.customer;
    if (customerCache[name]) continue;

    let cust = await Customer.findOne({ name });
    if (!cust) {
      // Determine type from name hints
      let type = 'Walk-in';
      const lower = name.toLowerCase();
      if (lower.includes('charlotte') || lower.includes('aboboyaa') || lower.includes('jmk')) {
        type = 'Wholesale';
      } else if (lower.includes('walk-in') || lower.includes('client') || lower.includes('individual')) {
        type = 'Walk-in';
      } else {
        type = 'Retail';
      }
      cust = await Customer.create({ name, type, phone: '', email: '', address: '', status: 'Active' });
      console.log(`  Created customer: ${name} (${type})`);
    }
    customerCache[name] = cust._id;
  }

  let imported = 0;
  let totalAmount = 0;

  for (const row of rows) {
    soCounter++;
    invCounter++;

    const orderCode = `SO-2026-${padCode(soCounter)}`;
    const invoiceCode = `INV-2026-${padCode(invCounter)}`;
    const amount = row.amount || 0;
    const invoiceStatus = row.status === 'Paid' ? 'Paid' : 'Pending';

    const so = await SalesOrder.create({
      order_code: orderCode,
      customer_id: customerCache[row.customer],
      product: PRODUCT,
      quantity: row.bags,
      amount,
      order_date: row.date,
      source: 'Walk-in',
      status: row.status === 'Paid' ? 'Fulfilled' : 'Pending',
    });

    const inv = await Invoice.create({
      invoice_code: invoiceCode,
      customer_id: customerCache[row.customer],
      sales_order_id: so._id,
      amount,
      issue_date: row.date,
      due_date: row.date,
      status: invoiceStatus,
    });

    await SalesOrder.updateOne({ _id: so._id }, { invoice_id: inv._id });

    // Create accounting entry for paid sales
    if (amount > 0) {
      await AccountingEntry.create({
        type: 'Income',
        category: 'Sales Revenue',
        amount,
        entry_date: row.date,
        description: `Sales - ${row.customer} (${row.bags} bags)${row.notes ? ' - ' + row.notes : ''}`,
      });
    }

    imported++;
    totalAmount += amount;
  }

  // Refresh customer stats
  const { refreshCustomerStats } = require('./db');
  await refreshCustomerStats();

  console.log(`\nImport complete!`);
  console.log(`  ${imported} sales orders created`);
  console.log(`  ${imported} invoices created`);
  console.log(`  Total amount: ¢${totalAmount.toLocaleString('en', { minimumFractionDigits: 2 })}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
