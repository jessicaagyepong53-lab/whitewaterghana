require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');
const { connectDB, AppData } = require('./db');

const FILE_PATH = process.argv[2] || 'C:/Users/ADMIN/Downloads/White_Water_Wells_Mar_Apr_Sales.xlsx';
const SHEET_NAME = process.argv[3] || 'March Daily Sales';
const PRODUCT_NAME = '500ml Sachet Water (500 pcs/bag)';

function pad3(n) {
  return String(n).padStart(3, '0');
}

function toIsoDate(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  // Handle Excel serial dates
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      const y = String(parsed.y).padStart(4, '0');
      const m = String(parsed.m).padStart(2, '0');
      const d = String(parsed.d).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  const raw = String(value).trim();
  if (!raw) return '';

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Parse known date text like 16-Mar-26
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return '';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  await connectDB();

  const workbook = XLSX.readFile(path.resolve(FILE_PATH), { cellDates: true });
  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) {
    throw new Error(`Sheet not found: ${SHEET_NAME}`);
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const entries = rows
    .map((r) => {
      const date = toIsoDate(r.Date);
      const customer = String(r.Customer || '').trim();
      const bags = toNumber(r.Bags);
      const rate = toNumber(r['Price/Bag (GHS)']);
      const amount = toNumber(r['Amount (GHS)']);
      const promo = toNumber(r['Promo Bags']);
      const paymentMode = String(r['Payment Mode'] || '').trim();
      return { date, customer, bags, rate, amount, promo, paymentMode };
    })
    .filter((r) => r.date.startsWith('2026-03') && r.customer && r.bags > 0);

  const invoices = entries.map((r, i) => {
    const idx = i + 1;
    return {
      id: `INV-2026-${pad3(idx)}`,
      customer: r.customer,
      product: PRODUCT_NAME,
      date: r.date,
      entryTime: '',
      paidDate: r.date,
      status: 'paid',
      amount: r.amount,
      rate: r.rate,
      paymentMode: r.paymentMode,
      promo: r.promo || 0,
      items: [{ name: PRODUCT_NAME, qty: r.bags, unitPrice: r.rate }],
      deliveryFee: 0,
    };
  });

  const salesOrders = entries.map((r, i) => {
    const idx = i + 1;
    return {
      id: `SO-2026-${pad3(idx)}`,
      customer: r.customer,
      orderDate: r.date,
      deliveryDate: r.date,
      amount: r.amount,
      bags: r.bags,
      rate: r.rate,
      paymentMode: r.paymentMode,
      promo: r.promo || 0,
      status: 'delivered',
      sourceInvoiceId: `INV-2026-${pad3(idx)}`,
    };
  });

  await AppData.updateOne(
    { key: 'ww_sales_2026-03' },
    {
      key: 'ww_sales_2026-03',
      data: {
        invoices,
        salesOrders,
        deletedInvoiceIds: [],
        deletedOrderIds: [],
      },
    },
    { upsert: true }
  );

  const monthsDoc = await AppData.findOne({ key: 'ww_sales_months' }).lean();
  const months = Array.isArray(monthsDoc?.data) ? monthsDoc.data : [];
  if (!months.includes('2026-03')) {
    months.push('2026-03');
    months.sort();
    await AppData.updateOne({ key: 'ww_sales_months' }, { key: 'ww_sales_months', data: months }, { upsert: true });
  }

  console.log(`Imported ${entries.length} March entries from sheet \"${SHEET_NAME}\".`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
