require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');
const { connectDB, AppData } = require('./db');

const FILE_PATH = process.argv[2] || 'C:/Users/ADMIN/Downloads/White_Water_Wells_Mar_Apr_Sales.xlsx';
const SHEET_NAME = process.argv[3] || 'March Daily Sales';
const TARGET_MONTH = process.argv[4] || '2026-03';
const PRODUCT_NAME = '500ml Sachet Water (500 pcs/bag)';

function pad3(n) {
  return String(n).padStart(3, '0');
}

function assertValidMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    throw new Error(`Invalid target month: ${month}. Expected YYYY-MM`);
  }
}

function getYearFromMonth(month) {
  return String(month).slice(0, 4);
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

async function getNextInvoiceNumberForYear(year) {
  const docs = await AppData.find({ key: /^ww_sales_\d{4}-\d{2}$/ }, 'key data').lean();
  let max = 0;
  for (const doc of docs) {
    const data = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
    const invoices = Array.isArray(data.invoices) ? data.invoices : [];
    for (const inv of invoices) {
      const id = String(inv && inv.id || '');
      const m = id.match(new RegExp(`^INV-${year}-(\\d{3,})$`));
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

async function main() {
  assertValidMonth(TARGET_MONTH);
  const targetYear = getYearFromMonth(TARGET_MONTH);
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
    .filter((r) => r.date.startsWith(TARGET_MONTH) && r.customer && r.bags > 0);

  const firstInvoiceNum = await getNextInvoiceNumberForYear(targetYear);

  const invoices = entries.map((r, i) => {
    const idx = firstInvoiceNum + i;
    return {
      id: `INV-${targetYear}-${pad3(idx)}`,
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });

  const salesOrders = entries.map((r, i) => {
    const idx = firstInvoiceNum + i;
    const invoiceId = `INV-${targetYear}-${pad3(idx)}`;
    return {
      id: `SO-${targetYear}-${pad3(idx)}`,
      customer: r.customer,
      orderDate: r.date,
      deliveryDate: r.date,
      amount: r.amount,
      bags: r.bags,
      rate: r.rate,
      paymentMode: r.paymentMode,
      promo: r.promo || 0,
      status: 'delivered',
      sourceInvoiceId: invoiceId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });

  await AppData.updateOne(
    { key: `ww_sales_${TARGET_MONTH}` },
    {
      key: `ww_sales_${TARGET_MONTH}`,
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
  if (!months.includes(TARGET_MONTH)) {
    months.push(TARGET_MONTH);
    months.sort();
    await AppData.updateOne({ key: 'ww_sales_months' }, { key: 'ww_sales_months', data: months }, { upsert: true });
  }

  console.log(`Imported ${entries.length} entries for ${TARGET_MONTH} from sheet \"${SHEET_NAME}\".`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
