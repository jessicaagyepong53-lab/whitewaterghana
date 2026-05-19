require('dotenv').config();
const { connectDB, AppData } = require('./server/db');

(async () => {
  await connectDB();
  const doc = await AppData.findOne({ key: 'ww_sales_2026-03' }).lean();
  const payload = doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
  const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
  const orders = Array.isArray(payload.salesOrders) ? payload.salesOrders : [];
  const invIds = new Set(invoices.map((i) => String(i.id || '')).filter(Boolean));
  const linkedOrders = orders.filter((o) => o && o.id && o.sourceInvoiceId && invIds.has(String(o.sourceInvoiceId)));
  const orphanOrders = orders.filter((o) => !o || !o.sourceInvoiceId || !invIds.has(String(o.sourceInvoiceId)));
  console.log(JSON.stringify({
    march: {
      invoices: invoices.length,
      salesOrders: orders.length,
      linkedOrders: linkedOrders.length,
      orphans: orphanOrders.length
    },
    sampleOrphans: orphanOrders.slice(0, 5).map((o) => ({ id: o && o.id, sourceInvoiceId: o && o.sourceInvoiceId, customer: o && o.customer }))
  }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
