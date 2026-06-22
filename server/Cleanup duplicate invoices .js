/**
 * Finds invoices that are very likely system-generated duplicates:
 *   same content (customer, date, amount, items, payment mode, etc.)
 *   AND created within a short time window of each other.
 *
 * WHY the time window matters
 * ───────────────────────────
 * Content-matching alone can't tell apart:
 *   A) Two invoices the browser saved twice in quick succession (a race
 *      condition — the real bug we're trying to catch, typically < 60 sec)
 *   B) A wholesale customer (Charlotte, Aboboyaa, etc.) who genuinely
 *      places the same-size order twice in one day (hours apart)
 *
 * A 5-minute window catches (A) while being extremely unlikely to
 * affect (B). If two invoices have identical content but were entered
 * more than 5 minutes apart, we leave them alone.
 *
 * By default this is a DRY RUN — it only prints a report.
 * Re-run with --apply to move duplicates to the recoverable Trash bin.
 *
 * Usage:
 *   node server/cleanup-duplicate-invoices.js                     # report only
 *   node server/cleanup-duplicate-invoices.js --apply             # archive duplicates
 *   node server/cleanup-duplicate-invoices.js --apply --month=2026-06
 *   node server/cleanup-duplicate-invoices.js --window=10         # 10-minute window
 */
require('dotenv').config();
const { connectDB, AppData, TrashBin } = require('./db');

const TRASH_TTL_DAYS   = 30;
const APPLY            = process.argv.includes('--apply');
const monthArg         = process.argv.find((a) => a.startsWith('--month='));
const windowArg        = process.argv.find((a) => a.startsWith('--window='));
const ONLY_MONTH       = monthArg ? monthArg.split('=')[1] : null;
const WINDOW_MINUTES   = windowArg ? Number(windowArg.split('=')[1]) : 5;
const WINDOW_MS        = WINDOW_MINUTES * 60 * 1000;

function invoiceContentFingerprint(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const firstItem = Array.isArray(inv.items) && inv.items[0] ? inv.items[0] : null;
  const itemName  = String((firstItem && firstItem.name) || inv.product || '').trim().toLowerCase();
  const qty       = Number((firstItem && firstItem.qty) || 0);
  const unitPrice = Number((firstItem && firstItem.unitPrice) || inv.rate || 0);
  // Deliberately excludes createdAt/entryTime — we use the time window separately.
  return [
    String(inv.customer    || '').trim().toLowerCase(),
    String(inv.date        || '').trim(),
    String(inv.phone       || '').trim(),
    String(inv.address     || '').trim(),
    String(inv.paidDate    || '').trim(),
    Number(inv.amount      || 0),
    itemName, qty, unitPrice,
    String(inv.paymentMode || '').trim().toLowerCase(),
    String(inv.carType     || '').trim().toLowerCase(),
    String(inv.carNumber   || '').trim().toLowerCase(),
    Number(inv.promo       || 0),
    String(inv.promoNote   || '').trim(),
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
    record_data:  record,
    restore_meta: restoreMeta,
    deleted_by:   deletedBy,
    deleted_at:   new Date(),
    expires_at:   expiresAt,
  });
}

function findSystemDuplicates(invoices) {
  // Group by content fingerprint
  const groups = new Map();
  for (const inv of invoices) {
    const fp = invoiceContentFingerprint(inv);
    if (!fp) continue;
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(inv);
  }

  const trashedIds         = new Set();
  const survivorByDupId    = new Map();
  const duplicateGroups    = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Sort by createdAt ascending so the earliest is the "original"
    const sorted = [...group].sort((a, b) => {
      return new Date(a.createdAt || a.date || 0) - new Date(b.createdAt || b.date || 0);
    });

    const survivor = sorted[0];
    const survivorTime = new Date(survivor.createdAt || survivor.date || 0).getTime();
    const flagged = [];

    for (const candidate of sorted.slice(1)) {
      const candidateTime = new Date(candidate.createdAt || candidate.date || 0).getTime();
      const diffMs = Math.abs(candidateTime - survivorTime);

      if (diffMs <= WINDOW_MS) {
        // Within the time window → very likely a system duplicate
        flagged.push({ inv: candidate, diffMs });
      }
      // Outside window → leave it alone (could be a legitimate repeat order)
    }

    if (!flagged.length) continue;

    duplicateGroups.push({ survivor, flagged });
    for (const { inv: dup } of flagged) {
      const dupId = String(dup.id || '').trim();
      if (!dupId) continue;
      trashedIds.add(dupId);
      survivorByDupId.set(dupId, String(survivor.id || '').trim());
    }
  }

  return { trashedIds, survivorByDupId, duplicateGroups };
}

async function processMonth(doc) {
  const key      = doc.key;
  const payload  = doc.data && typeof doc.data === 'object' ? doc.data : {};
  const invoices = Array.isArray(payload.invoices)    ? payload.invoices.filter((i) => i && i.id)    : [];
  const orders   = Array.isArray(payload.salesOrders) ? payload.salesOrders.filter((o) => o && o.id) : [];

  const { trashedIds, survivorByDupId, duplicateGroups } = findSystemDuplicates(invoices);

  if (!duplicateGroups.length) return { key, archived: 0, groups: 0 };

  console.log(`\n${key} — ${duplicateGroups.length} likely system-duplicate group(s) found:`);
  for (const { survivor, flagged } of duplicateGroups) {
    console.log(`  • ${survivor.customer || '(no name)'} | ${survivor.date || '?'} | ${fmtMoney(survivor.amount)}`);
    console.log(`      keep:    ${survivor.id}  (created ${survivor.createdAt || 'n/a'})`);
    for (const { inv: dup, diffMs } of flagged) {
      const secs = (diffMs / 1000).toFixed(1);
      console.log(`      ${APPLY ? 'archive:' : 'would archive:'} ${dup.id}  (created ${dup.createdAt || 'n/a'}, ${secs}s later — within ${WINDOW_MINUTES}-min window)`);
    }
  }

  if (!APPLY) return { key, archived: trashedIds.size, groups: duplicateGroups.length };

  // Archive each system-duplicate to the trash bin (recoverable from Trash page)
  for (const inv of invoices) {
    const id = String(inv.id || '').trim();
    if (!trashedIds.has(id)) continue;
    await moveToTrash('invoices', inv, 'system (cleanup-duplicate-invoices script)', {
      kind: 'appDataArray', key, arrayPath: 'invoices',
    });
  }

  const remainingInvoices   = invoices.filter((inv) => !trashedIds.has(String(inv.id || '').trim()));
  const remainingInvoiceIds = new Set(remainingInvoices.map((inv) => String(inv.id || '').trim()));

  // Repoint any sales order pointing at a now-archived invoice to the survivor
  const repointedOrders = orders
    .map((ord) => {
      const src = String(ord.sourceInvoiceId || '').trim();
      return src && survivorByDupId.has(src) ? { ...ord, sourceInvoiceId: survivorByDupId.get(src) } : ord;
    })
    .filter((ord) => {
      const src = String(ord.sourceInvoiceId || '').trim();
      return src && remainingInvoiceIds.has(src);
    });

  const nextDeletedInvoiceIds = Array.from(new Set([
    ...(Array.isArray(payload.deletedInvoiceIds) ? payload.deletedInvoiceIds : []),
    ...trashedIds,
  ].map((id) => String(id || '').trim()).filter((id) => id && !remainingInvoiceIds.has(id))));

  await AppData.updateOne(
    { key },
    { key, data: { ...payload, invoices: remainingInvoices, salesOrders: repointedOrders, deletedInvoiceIds: nextDeletedInvoiceIds } },
    { upsert: true }
  );

  return { key, archived: trashedIds.size, groups: duplicateGroups.length };
}

async function main() {
  await connectDB();
  console.log(APPLY
    ? `Running in APPLY mode (${WINDOW_MINUTES}-min window) — system duplicates will be moved to trash.`
    : `DRY RUN (${WINDOW_MINUTES}-min window) — no changes. Re-run with --apply to archive.\n` +
      `Only flags invoices with identical content created within ${WINDOW_MINUTES} minutes of each other.`
  );

  const filter  = ONLY_MONTH ? { key: `ww_sales_${ONLY_MONTH}` } : { key: /^ww_sales_\d{4}-\d{2}$/ };
  const docs    = await AppData.find(filter).lean();

  let totalArchived = 0;
  let totalGroups   = 0;
  const touched     = [];

  for (const doc of docs) {
    const result = await processMonth(doc);
    if (result.archived > 0) {
      totalArchived += result.archived;
      totalGroups   += result.groups;
      touched.push(result.key);
    }
  }

  console.log('\n──────────────────────────────────────────');
  if (!totalGroups) {
    console.log(`No system duplicates found within a ${WINDOW_MINUTES}-minute window. Nothing to do.`);
  } else if (APPLY) {
    console.log(`Archived ${totalArchived} duplicate invoice(s) across ${totalGroups} group(s) in: ${touched.join(', ')}`);
    console.log('Recoverable from the Trash page for 30 days.');
  } else {
    console.log(`Found ${totalArchived} likely system duplicate(s) across ${totalGroups} group(s) in: ${touched.join(', ')}`);
    console.log(`Dry run only — re-run with --apply to archive them.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });