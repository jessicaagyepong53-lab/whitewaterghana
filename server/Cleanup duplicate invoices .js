/**
 * Finds invoices that are content-duplicates of each other (same customer,
 * date, amount, items, payment mode, etc.) but were saved under different
 * IDs — the pattern that produces the "invoices keep repeating" symptom.
 *
 * By default this is a DRY RUN: it only prints a report, it changes nothing.
 * Re-run with --apply to actually move the duplicates to the trash bin
 * (Users with the right role can review and restore them from the Trash
 * page in the app — nothing is permanently deleted).
 *
 * Usage:
 *   node server/cleanup-duplicate-invoices.js            # report only
 *   node server/cleanup-duplicate-invoices.js --apply     # archive duplicates to trash
 *   node server/cleanup-duplicate-invoices.js --apply --month=2026-06   # limit to one month
 */
require('dotenv').config();
const { connectDB, AppData, TrashBin } = require('./db');

const TRASH_TTL_DAYS = 30;
const APPLY = process.argv.includes('--apply');
const monthArg = process.argv.find((a) => a.startsWith('--month='));
const ONLY_MONTH = monthArg ? monthArg.split('=')[1] : null;

function invoiceContentFingerprint(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const firstItem = Array.isArray(inv.items) && inv.items[0] ? inv.items[0] : null;
  const itemName = String((firstItem && firstItem.name) || inv.product || '').trim().toLowerCase();
  const qty = Number((firstItem && firstItem.qty) || 0);
  const unitPrice = Number((firstItem && firstItem.unitPrice) || inv.rate || 0);
  // Deliberately excludes createdAt/entryTime — those describe when the record
  // was saved, not what the transaction was, so a genuine duplicate entered
  // minutes or hours apart would otherwise never match.
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
  ].join('|');
}

function fmtMoney(n) {
  return `GH₵${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function moveToTrash(module, record, deletedBy, restoreMeta) {
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

async function processMonth(doc) {
  const key = doc.key;
  const payload = doc.data && typeof doc.data === 'object' ? doc.data : {};
  const invoices = Array.isArray(payload.invoices) ? payload.invoices.filter((i) => i && i.id) : [];
  const salesOrders = Array.isArray(payload.salesOrders) ? payload.salesOrders.filter((o) => o && o.id) : [];

  const groups = new Map();
  for (const inv of invoices) {
    const fp = invoiceContentFingerprint(inv);
    if (!fp) continue;
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(inv);
  }

  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);
  if (!duplicateGroups.length) return { key, archived: 0, groups: 0 };

  console.log(`\n${key} — ${duplicateGroups.length} duplicate group(s) found:`);

  const trashedIds = new Set();
  const survivorByDuplicateId = new Map();

  for (const group of duplicateGroups) {
    const sorted = [...group].sort((a, b) => {
      const ta = new Date(a.createdAt || a.date || 0).getTime();
      const tb = new Date(b.createdAt || b.date || 0).getTime();
      return ta - tb;
    });
    const survivor = sorted[0];
    const dups = sorted.slice(1);
    console.log(`  • ${survivor.customer || '(no name)'} | ${survivor.date || '?'} | ${fmtMoney(survivor.amount)}`);
    console.log(`      keep:    ${survivor.id}  (created ${survivor.createdAt || 'n/a'})`);
    for (const dup of dups) {
      console.log(`      ${APPLY ? 'archive:' : 'would archive:'} ${dup.id}  (created ${dup.createdAt || 'n/a'})`);
      trashedIds.add(String(dup.id).trim());
      survivorByDuplicateId.set(String(dup.id).trim(), String(survivor.id).trim());
    }
  }

  if (!APPLY) {
    return { key, archived: trashedIds.size, groups: duplicateGroups.length };
  }

  // Archive each duplicate to the trash bin (recoverable from the Trash page).
  for (const inv of invoices) {
    const id = String(inv.id || '').trim();
    if (!trashedIds.has(id)) continue;
    await moveToTrash('invoices', inv, 'system (auto-dedup cleanup script)', {
      kind: 'appDataArray',
      key,
      arrayPath: 'invoices',
    });
  }

  const remainingInvoices = invoices.filter((inv) => !trashedIds.has(String(inv.id || '').trim()));
  const remainingInvoiceIds = new Set(remainingInvoices.map((inv) => String(inv.id || '').trim()));

  // Repoint any sales order that pointed at a now-archived duplicate to the surviving invoice.
  const repointedOrders = salesOrders.map((ord) => {
    const src = String(ord.sourceInvoiceId || '').trim();
    if (src && survivorByDuplicateId.has(src)) {
      return { ...ord, sourceInvoiceId: survivorByDuplicateId.get(src) };
    }
    return ord;
  }).filter((ord) => {
    const src = String(ord.sourceInvoiceId || '').trim();
    return src && remainingInvoiceIds.has(src);
  });

  const nextDeletedInvoiceIds = Array.from(new Set([
    ...(Array.isArray(payload.deletedInvoiceIds) ? payload.deletedInvoiceIds : []),
    ...trashedIds,
  ].map((id) => String(id || '').trim()).filter((id) => id && !remainingInvoiceIds.has(id))));

  await AppData.updateOne(
    { key },
    {
      key,
      data: {
        ...payload,
        invoices: remainingInvoices,
        salesOrders: repointedOrders,
        deletedInvoiceIds: nextDeletedInvoiceIds,
      },
    },
    { upsert: true }
  );

  return { key, archived: trashedIds.size, groups: duplicateGroups.length };
}

async function main() {
  await connectDB();
  console.log(APPLY ? 'Running in APPLY mode — duplicates will be moved to trash.' : 'Running in DRY RUN mode — no changes will be made. Re-run with --apply to archive duplicates.');

  const filter = ONLY_MONTH ? { key: `ww_sales_${ONLY_MONTH}` } : { key: /^ww_sales_\d{4}-\d{2}$/ };
  const docs = await AppData.find(filter).lean();

  let totalArchived = 0;
  let totalGroups = 0;
  const touchedMonths = [];

  for (const doc of docs) {
    const result = await processMonth(doc);
    if (result.archived > 0) {
      totalArchived += result.archived;
      totalGroups += result.groups;
      touchedMonths.push(result.key);
    }
  }

  console.log('\n──────────────────────────────────────────');
  if (!totalGroups) {
    console.log('No duplicate invoices found. Nothing to do.');
  } else if (APPLY) {
    console.log(`Archived ${totalArchived} duplicate invoice(s) across ${totalGroups} group(s) in: ${touchedMonths.join(', ')}`);
    console.log('They are recoverable from the Trash page for 30 days.');
  } else {
    console.log(`Found ${totalArchived} duplicate invoice(s) across ${totalGroups} group(s) in: ${touchedMonths.join(', ')}`);
    console.log('This was a dry run — nothing was changed. Re-run with --apply to archive them to trash.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });