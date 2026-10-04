/* ═══════════════════════════════════════════════════════════════════
   QUARTERLY REPORTS MODULE — ROUTES + MAILER + SCHEDULER
   ───────────────────────────────────────────────────────────────────
   Mirrors the dependency-injection pattern already used by
   mountAssistantRoutes(app, deps) in server.js, so wiring this in is
   a two-line change there.

   CEO/Manager only, matching every other financial module in the app
   (Accounting, Reports). Uses req.user, which attachUser() already
   populates on every request before this module's routes run.
   ═══════════════════════════════════════════════════════════════════ */

const nodemailer = require('nodemailer');
const cron = require('node-cron');
const crypto = require('crypto');

const {
  justCompletedQuarter,
  quarterEndingToday,
  quarterLabel,
  buildQuarterlyAnalysis,
  justCompletedYear,
  yearLabel,
  buildAnnualAnalysis,
  checkPeriodAvailability,
} = require('./analysis');
const { buildQuarterlyReportPDF, buildAnnualReportPDF } = require('./pdf');
const {
  resolveDiscountRate,
  setManualOverride,
  clearManualOverride,
  readConfig,
  writeConfig,
} = require('./discount-rate');

function isManagerOrCeo(user, specialAccessOverrides) {
  if (!user) return false;
  const role = String(user.role || '').trim().toLowerCase();
  if (role === 'ceo' || role === 'manager') return true;
  const overrides = (specialAccessOverrides && specialAccessOverrides[String(user.email || '').toLowerCase()]) || [];
  return overrides.includes('ceo');
}

// ── Review & approval sign-off ──
// Reviewed by is always the CEO. Prepared by is whoever generated the
// report manually (the logged-in user), or the CEO when the report is
// generated automatically by the cron. Dates are the generation date.
const CEO_EMAIL = 'ceo9@whitewaterghana.com';

function displayRole(role) {
  const r = String(role || '').trim();
  if (!r) return 'User';
  if (r.toLowerCase() === 'ceo') return 'CEO';
  return r.charAt(0).toUpperCase() + r.slice(1).toLowerCase();
}

function initialsOf(name) {
  const parts = String(name || '').split(/[\s.\-_]+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.slice(0, 3).map((part) => part.charAt(0).toUpperCase()).join('');
}

// Ghana is on UTC all year (Africa/Accra), so the UTC date is the Accra date.
function formatSignoffDate(date) {
  const d = date instanceof Date ? date : new Date();
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd} / ${mm} / ${d.getUTCFullYear()}`;
}

async function buildSignoff({ User }, generatedBy) {
  let ceoDoc = null;
  if (User) {
    try { ceoDoc = await User.findOne({ email: CEO_EMAIL }).lean(); } catch (_error) { ceoDoc = null; }
  }
  const ceoName = (ceoDoc && ceoDoc.name) || 'CEO';
  const reviewer = { name: ceoName, role: 'CEO', initials: initialsOf(ceoName) };

  const generatorName = generatedBy && (generatedBy.name || generatedBy.email);
  const preparer = generatorName
    ? { name: generatorName, role: displayRole(generatedBy.role), initials: initialsOf(generatorName) }
    : { ...reviewer };

  return { preparer, reviewer, dateText: formatSignoffDate(new Date()) };
}

function buildMailTransport() {
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailAppPassword) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD environment variables must be set to send quarterly reports.');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailAppPassword },
  });
}

async function resolveRecipients(AppData) {
  const config = await readConfig(AppData);
  const fromConfig = Array.isArray(config.recipientEmails) ? config.recipientEmails.filter(Boolean) : [];
  if (fromConfig.length) return fromConfig;
  const fromEnv = String(process.env.REPORT_RECIPIENT_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return fromEnv;
}

/* ── Record Vault archiving ───────────────────────────────────────────
   Every generated report is saved into Record Vault → Financial Reports
   BEFORE the email is attempted, so a lapsed Gmail app password, a
   missing recipient config, or any other mail failure can never cause a
   report to simply not exist anywhere. The vault entry is written with
   emailed:false first, then patched with the real outcome once the send
   attempt (succeeds or fails) — so even a hard crash mid-send still
   leaves an honest "not emailed" record behind rather than nothing.
   Deliberately reads/writes the same 'ww_record_vault' AppData document
   server.js uses, in the same shape the vault UI already expects
   (fileId/fileName/category/uploadDate/... plus the report-specific
   periodLabel/summary/emailed/recipients/emailError fields).
   ═══════════════════════════════════════════════════════════════════ */

const RECORD_VAULT_KEY = 'ww_record_vault';

async function readVaultData(AppData) {
  const doc = await AppData.findOne({ key: RECORD_VAULT_KEY }).lean();
  const data = (doc && doc.data && typeof doc.data === 'object') ? doc.data : {};
  return {
    companyDocuments: Array.isArray(data.companyDocuments) ? data.companyDocuments : [],
    receipts: Array.isArray(data.receipts) ? data.receipts : [],
    financialReports: Array.isArray(data.financialReports) ? data.financialReports : [],
    folders: Array.isArray(data.folders) ? data.folders : [],
  };
}

async function writeVaultData(AppData, data, broadcastRealtimeUpdate) {
  await AppData.updateOne({ key: RECORD_VAULT_KEY }, { key: RECORD_VAULT_KEY, data }, { upsert: true });
  if (typeof broadcastRealtimeUpdate === 'function') {
    broadcastRealtimeUpdate({ key: RECORD_VAULT_KEY, source: 'quarterly-reports' });
  }
}

// Finds (or creates) a root-level Financial Reports folder named after the
// report's year — e.g. "2026" — so quarterly and annual reports for the
// same year land side by side instead of piling up flat at the section
// root. Mutates vaultData.folders in place (caller writes it back along
// with the new file record in a single AppData write) and matches the
// exact folder shape server.js's own "New Folder" route creates, so it's
// indistinguishable from a folder a person made by hand — renameable,
// deletable, browsable the same way.
function findOrCreateYearFolder(vaultData, year, section, nowIso) {
  if (!Number.isFinite(Number(year))) return null;
  const folderName = String(year);
  const existing = vaultData.folders.find((f) => (
    String(f.section || '') === section
    && !String(f.parentFolderId || '').trim()
    && String(f.name || '') === folderName
  ));
  if (existing) return existing.folderId;

  const folder = {
    folderId: crypto.randomUUID(),
    section,
    name: folderName,
    parentFolderId: null,
    createdAt: nowIso(),
  };
  vaultData.folders.push(folder);
  return folder.folderId;
}

async function archiveReportToVault({ AppData, getGridFSBucket, broadcastRealtimeUpdate, nowIso }, {
  pdfBuffer, fileName, category, periodLabel, year, summary,
}) {
  if (typeof getGridFSBucket !== 'function') {
    // GridFS wasn't wired up for this deployment — don't let a missing
    // dependency crash report generation, just skip the archive step.
    console.warn('[Reports] getGridFSBucket not available — skipping Record Vault archive.');
    return null;
  }

  const bucket = getGridFSBucket();
  const uploadStream = bucket.openUploadStream(fileName, {
    contentType: 'application/pdf',
    metadata: { section: 'financialReports', uploadedBy: 'System (auto-generated)', uploadedAt: nowIso() },
  });
  await new Promise((resolve, reject) => {
    uploadStream.on('error', reject);
    uploadStream.on('finish', resolve);
    uploadStream.end(pdfBuffer);
  });

  const vaultData = await readVaultData(AppData);
  const folderId = findOrCreateYearFolder(vaultData, year, 'financialReports', nowIso);

  const record = {
    fileId: String(uploadStream.id),
    fileName,
    storageFileName: fileName,
    category,
    uploadDate: nowIso(),
    uploadedBy: 'System (auto-generated)',
    fileSize: pdfBuffer.length,
    contentType: 'application/pdf',
    folderId,
    periodLabel,
    year,
    summary,
    emailed: false,
    recipients: [],
    emailError: null,
  };

  vaultData.financialReports = [...vaultData.financialReports, record]
    .sort((a, b) => new Date(a.uploadDate || 0) - new Date(b.uploadDate || 0));
  await writeVaultData(AppData, vaultData, broadcastRealtimeUpdate);

  return record;
}

async function updateVaultReportEmailStatus({ AppData, broadcastRealtimeUpdate }, fileId, { emailed, recipients, emailError }) {
  if (!fileId) return;
  try {
    const vaultData = await readVaultData(AppData);
    let changed = false;
    vaultData.financialReports = vaultData.financialReports.map((entry) => {
      if (entry.fileId !== fileId) return entry;
      changed = true;
      return { ...entry, emailed, recipients, emailError: emailError || null };
    });
    if (changed) await writeVaultData(AppData, vaultData, broadcastRealtimeUpdate);
  } catch (error) {
    // Non-fatal: the report is already safely archived either way, this
    // just means its emailed/recipients fields stay at their initial
    // (false/empty) placeholder values until the next successful update.
    console.error('[Reports] Failed to update vault record email status:', error && error.message ? error.message : error);
  }
}

function buildEmailBody(analysis, kind) {
  const n = analysis.narrative || {};
  const lines = [
    `Attached is the ${kind} business and financial report for ${analysis.label}.`,
    analysis.period ? `Reporting period: ${analysis.period.rangeText} (${analysis.period.monthNames.join(', ')}).` : '',
    '',
    n.headline || `Revenue: ${analysis.revenue.totalRevenue.toLocaleString()} | Net profit: ${analysis.profitRoi.netProfit.toLocaleString()}`,
    '',
    `ROI on assets: ${analysis.profitRoi.roiPercent === null ? 'n/a' : analysis.profitRoi.roiPercent + '%'} | Revenue variability (CV): ${analysis.revenue.coefficientOfVariation}% - ${analysis.revenue.variabilityBand}`,
    `Indicative NPV: ${analysis.npv.npv.toLocaleString()} at a ${(analysis.discountRateInfo.rate * 100).toFixed(1)}% discount rate (${analysis.discountRateInfo.benchmark})`,
    `Demand vs. supply: ${analysis.demandSupply.condition}`,
  ];
  if (analysis.partialYear) lines.push(`Note: operations ran for ${analysis.operatingMonths.length} of 12 months this year.`);
  if (n.risks && n.risks.length) {
    lines.push('', 'Risks to watch:');
    n.risks.slice(0, 4).forEach((r) => lines.push(`  - ${r}`));
  }
  if (n.actions && n.actions.length) {
    lines.push('', 'Recommended actions:');
    n.actions.slice(0, 3).forEach((r) => lines.push(`  - ${r}`));
  }
  lines.push('', 'The attached PDF contains the charts, seasonality diagnosis, BCG customer matrix, marginal analysis, NPV scenarios and the analyst outlook.', '', 'This is an automated message from the White Water Wells factory management system.');
  return lines.join('\n');
}

async function generateAndSendQuarterlyReport(deps, { year, quarter, dryRun = false, generatedBy = null }) {
  const { AppData, ProductionBatch, User, nowIso, getGridFSBucket, broadcastRealtimeUpdate } = deps;
  const discountRateInfo = await resolveDiscountRate({ AppData, nowIso });
  const analysis = await buildQuarterlyAnalysis({ AppData, ProductionBatch }, { year, quarter, discountRateInfo });
  if (!analysis.collections || !analysis.collections.invoiceCount) {
    const err = new Error(`No sales were recorded for ${analysis.label} (${analysis.period ? analysis.period.rangeText : ''}), so there is nothing to report on yet. Record the period's invoices in Sales & Invoicing and try again.`);
    err.status = 422;
    err.code = 'NO_DATA';
    throw err;
  }
  const signoff = await buildSignoff({ User }, generatedBy);
  const pdfBuffer = await buildQuarterlyReportPDF(analysis, { companyName: 'White Water Wells Ltd', signoff });

  if (dryRun) {
    return { analysis, pdfBuffer, emailed: false, recipients: [] };
  }

  // Archive first — this is the safety net, so it happens before we even
  // attempt to send mail, and its success does not depend on the email
  // step below succeeding.
  const vaultRecord = await archiveReportToVault({ AppData, getGridFSBucket, broadcastRealtimeUpdate, nowIso }, {
    pdfBuffer,
    fileName: `WWW-Quarterly-Report-${analysis.year}-Q${analysis.quarter}.pdf`,
    category: 'Quarterly Report',
    periodLabel: analysis.label,
    year: analysis.year,
    summary: { revenue: analysis.revenue.totalRevenue, netProfit: analysis.profitRoi.netProfit },
  });

  let recipients = [];
  let emailError = null;
  try {
    recipients = await resolveRecipients(AppData);
    if (!recipients.length) {
      throw new Error('No recipient email configured. Set one via PUT /api/reports/quarterly/config before sending.');
    }

    const transport = buildMailTransport();
    const subject = `White Water Wells — Quarterly Report — ${analysis.label}`;
    const emailText = buildEmailBody(analysis, 'quarterly');

    await transport.sendMail({
      from: `"White Water Wells Reports" <${process.env.GMAIL_USER}>`,
      to: recipients.join(', '),
      subject,
      text: emailText,
      attachments: [{
        filename: `WWW-Quarterly-Report-${analysis.year}-Q${analysis.quarter}.pdf`,
        content: pdfBuffer,
      }],
    });

    await writeConfig(AppData, { lastSentQuarterLabel: analysis.label, lastSentAt: nowIso() });
  } catch (error) {
    emailError = error && error.message ? error.message : String(error);
  }

  if (vaultRecord) {
    await updateVaultReportEmailStatus({ AppData, broadcastRealtimeUpdate }, vaultRecord.fileId, {
      emailed: !emailError,
      recipients,
      emailError,
    });
  }

  if (emailError) {
    throw new Error(emailError);
  }

  return { analysis, pdfBuffer, emailed: true, recipients };
}

async function generateAndSendAnnualReport(deps, { year, dryRun = false, generatedBy = null }) {
  const { AppData, ProductionBatch, User, nowIso, getGridFSBucket, broadcastRealtimeUpdate } = deps;
  const discountRateInfo = await resolveDiscountRate({ AppData, nowIso });
  const analysis = await buildAnnualAnalysis({ AppData, ProductionBatch }, { year, discountRateInfo });
  if (!analysis.collections || !analysis.collections.invoiceCount) {
    const err = new Error(`No sales were recorded for ${analysis.label} (${analysis.period ? analysis.period.rangeText : ''}), so there is nothing to report on yet. Record the period's invoices in Sales & Invoicing and try again.`);
    err.status = 422;
    err.code = 'NO_DATA';
    throw err;
  }
  const signoff = await buildSignoff({ User }, generatedBy);
  const pdfBuffer = await buildAnnualReportPDF(analysis, { companyName: 'White Water Wells Ltd', signoff });

  if (dryRun) {
    return { analysis, pdfBuffer, emailed: false, recipients: [] };
  }

  const vaultRecord = await archiveReportToVault({ AppData, getGridFSBucket, broadcastRealtimeUpdate, nowIso }, {
    pdfBuffer,
    fileName: `WWW-Annual-Report-${analysis.year}.pdf`,
    category: 'Annual Report',
    periodLabel: analysis.label,
    year: analysis.year,
    summary: { revenue: analysis.revenue.totalRevenue, netProfit: analysis.profitRoi.netProfit },
  });

  let recipients = [];
  let emailError = null;
  try {
    recipients = await resolveRecipients(AppData);
    if (!recipients.length) {
      throw new Error('No recipient email configured. Set one via PUT /api/reports/quarterly/config before sending.');
    }

    const transport = buildMailTransport();
    const subject = `White Water Wells — Annual Report — ${analysis.label}`;
    const emailText = buildEmailBody(analysis, 'annual');

    await transport.sendMail({
      from: `"White Water Wells Reports" <${process.env.GMAIL_USER}>`,
      to: recipients.join(', '),
      subject,
      text: emailText,
      attachments: [{
        filename: `WWW-Annual-Report-${analysis.year}.pdf`,
        content: pdfBuffer,
      }],
    });

    await writeConfig(AppData, { lastSentAnnualLabel: analysis.label, lastSentAnnualAt: nowIso() });
  } catch (error) {
    emailError = error && error.message ? error.message : String(error);
  }

  if (vaultRecord) {
    await updateVaultReportEmailStatus({ AppData, broadcastRealtimeUpdate }, vaultRecord.fileId, {
      emailed: !emailError,
      recipients,
      emailError,
    });
  }

  if (emailError) {
    throw new Error(emailError);
  }

  return { analysis, pdfBuffer, emailed: true, recipients };
}

function mountQuarterlyReportRoutes(app, deps) {
  const { AppData, ProductionBatch, nowIso, createError, ensureAuthenticated, SPECIAL_ACCESS_OVERRIDES } = deps;

  function requireFinanceAccess(req, _res, next) {
    if (!req.user) { next(createError(401, 'Authentication required')); return; }
    if (!isManagerOrCeo(req.user, SPECIAL_ACCESS_OVERRIDES)) {
      next(createError(403, 'Only CEO or Manager can access quarterly reports'));
      return;
    }
    next();
  }

  const authGuards = ensureAuthenticated ? [ensureAuthenticated, requireFinanceAccess] : [requireFinanceAccess];

  app.get('/api/reports/quarterly/config', ...authGuards, async (_req, res, next) => {
    try {
      const config = await readConfig(AppData);
      res.json({
        recipientEmails: Array.isArray(config.recipientEmails) ? config.recipientEmails : [],
        discountRateManualOverride: config.discountRateManualOverride || null,
        discountRateManualSetAt: config.discountRateManualSetAt || null,
        discountRateCacheAnnual: config.discountRateCacheAnnual || null,
        discountRateCacheAt: config.discountRateCacheAt || null,
        lastSentQuarterLabel: config.lastSentQuarterLabel || null,
        lastSentAt: config.lastSentAt || null,
        lastSentAnnualLabel: config.lastSentAnnualLabel || null,
        lastSentAnnualAt: config.lastSentAnnualAt || null,
      });
    } catch (error) { next(error); }
  });

  app.put('/api/reports/quarterly/config', ...authGuards, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (Array.isArray(body.recipientEmails)) {
        const cleaned = body.recipientEmails
          .map((e) => String(e || '').trim())
          .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        await writeConfig(AppData, { recipientEmails: cleaned });
      }
      if (body.discountRateManualOverride === null) {
        await clearManualOverride(AppData);
      } else if (body.discountRateManualOverride !== undefined) {
        await setManualOverride(AppData, nowIso, body.discountRateManualOverride);
      }
      const config = await readConfig(AppData);
      res.json({ ok: true, config });
    } catch (error) {
      if (error && error.message && !error.status) { next(createError(400, error.message)); return; }
      next(error);
    }
  });

  // ── Manual generation guards ──
  // The period-availability rule lives here (not in generateAnd*), so the
  // automatic cron, which deliberately fires at 23:55 on the final day of
  // a period, is never blocked by it.
  function parseQuarterParams(source) {
    const fallback = justCompletedQuarter(new Date());
    const year = Number(source && source.year) || fallback.year;
    const quarter = Number(source && source.quarter) || fallback.quarter;
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return { error: 'Please choose a valid year.' };
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) return { error: 'Please choose a quarter between Q1 and Q4.' };
    return { year, quarter };
  }

  function parseYearParam(source) {
    const fallback = justCompletedYear(new Date());
    const year = Number(source && source.year) || fallback.year;
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return { error: 'Please choose a valid year.' };
    return { year };
  }

  // Sends the structured "not available yet" response. Returns true if it
  // responded, so callers can stop.
  function respondIfNotAvailable(res, spec) {
    const availability = checkPeriodAvailability(spec, new Date());
    if (availability.available) return false;
    res.status(409).json({
      ok: false,
      code: 'PERIOD_NOT_ENDED',
      message: availability.message,
      label: availability.label,
      periodStart: availability.periodStart,
      periodEnd: availability.periodEnd,
      opensOn: availability.opensOn,
      opensOnText: availability.opensOnText,
      daysUntil: availability.daysUntil,
      inProgress: availability.inProgress,
      autoSendText: availability.autoSendText,
    });
    return true;
  }

  function respondKnownError(res, error) {
    if (error && error.code === 'NO_DATA') {
      res.status(422).json({ ok: false, code: 'NO_DATA', message: error.message });
      return true;
    }
    return false;
  }

  app.get('/api/reports/quarterly/preview', ...authGuards, async (req, res, next) => {
    try {
      const parsed = parseQuarterParams(req.query);
      if (parsed.error) { res.status(400).json({ ok: false, code: 'BAD_INPUT', message: parsed.error }); return; }
      const { year, quarter } = parsed;
      if (respondIfNotAvailable(res, { periodType: 'quarter', year, quarter })) return;
      const result = await generateAndSendQuarterlyReport(deps, { year, quarter, dryRun: true, generatedBy: req.user });
      res.json({ label: quarterLabel(year, quarter), analysis: result.analysis });
    } catch (error) {
      if (respondKnownError(res, error)) return;
      next(error);
    }
  });

  app.post('/api/reports/quarterly/send-now', ...authGuards, async (req, res, next) => {
    try {
      const parsed = parseQuarterParams(req.body);
      if (parsed.error) { res.status(400).json({ ok: false, code: 'BAD_INPUT', message: parsed.error }); return; }
      const { year, quarter } = parsed;
      if (respondIfNotAvailable(res, { periodType: 'quarter', year, quarter })) return;
      const result = await generateAndSendQuarterlyReport(deps, { year, quarter, dryRun: false, generatedBy: req.user });
      res.json({ ok: true, label: result.analysis.label, recipients: result.recipients });
    } catch (error) {
      if (respondKnownError(res, error)) return;
      if (error && error.message && !error.status) { next(createError(400, error.message)); return; }
      next(error);
    }
  });

  app.get('/api/reports/annual/preview', ...authGuards, async (req, res, next) => {
    try {
      const parsed = parseYearParam(req.query);
      if (parsed.error) { res.status(400).json({ ok: false, code: 'BAD_INPUT', message: parsed.error }); return; }
      const { year } = parsed;
      if (respondIfNotAvailable(res, { periodType: 'year', year })) return;
      const result = await generateAndSendAnnualReport(deps, { year, dryRun: true, generatedBy: req.user });
      res.json({ label: yearLabel(year), analysis: result.analysis });
    } catch (error) {
      if (respondKnownError(res, error)) return;
      next(error);
    }
  });

  app.post('/api/reports/annual/send-now', ...authGuards, async (req, res, next) => {
    try {
      const parsed = parseYearParam(req.body);
      if (parsed.error) { res.status(400).json({ ok: false, code: 'BAD_INPUT', message: parsed.error }); return; }
      const { year } = parsed;
      if (respondIfNotAvailable(res, { periodType: 'year', year })) return;
      const result = await generateAndSendAnnualReport(deps, { year, dryRun: false, generatedBy: req.user });
      res.json({ ok: true, label: result.analysis.label, recipients: result.recipients });
    } catch (error) {
      if (respondKnownError(res, error)) return;
      if (error && error.message && !error.status) { next(createError(400, error.message)); return; }
      next(error);
    }
  });

  // Lets the Accounting page show which periods are open before anyone clicks.
  app.get('/api/reports/availability', ...authGuards, (req, res) => {
    const now = new Date();
    const year = Number(req.query.year) || now.getUTCFullYear();
    const quarters = [1, 2, 3, 4].map((quarter) => checkPeriodAvailability({ periodType: 'quarter', year, quarter }, now));
    res.json({ year, quarters, annual: checkPeriodAvailability({ periodType: 'year', year }, now) });
  });

  // ── Automatic quarterly cron ──
  // Fires at 23:55 on the LAST DAY of each quarter (Mar 31, Jun 30, Sep 30,
  // Dec 31) rather than the 1st of the following month. This is deliberate:
  // it leaves Jan 1st free and unambiguous for the annual cron below —
  // previously both the Q4 report (firing Jan 1st) and, if an annual cron
  // were added, the annual report would land on the same day and could be
  // confused for a duplicate. Two separate cron expressions are needed
  // because months don't share a "last day" number: 31 for Mar/Dec, 30 for
  // Jun/Sep — each only fires in months that actually have that date.
  // Because we're firing ON the closing day itself (not after it), the
  // quarter is derived directly from today's month (quarterEndingToday),
  // not from justCompletedQuarter()'s "most recently finished quarter as of
  // today" logic — that would incorrectly look one quarter too far back if
  // used on the closing day itself. Only runs on the persistent Render
  // service, mirroring the same reasoning already documented for
  // Socket.IO/SSE in this app: Vercel's serverless functions do not stay
  // alive to host a cron timer.
  if (!process.env.VERCEL) {
    const runQuarterlyCron = async () => {
      try {
        const { year, quarter } = quarterEndingToday(new Date());
        console.log(`[QuarterlyReport] Auto-sending report for ${quarterLabel(year, quarter)}...`);
        const result = await generateAndSendQuarterlyReport(deps, { year, quarter, dryRun: false });
        console.log(`[QuarterlyReport] Sent ${result.analysis.label} to: ${result.recipients.join(', ')}`);
      } catch (error) {
        console.error('[QuarterlyReport] Automatic send failed:', error && error.message ? error.message : error);
      }
    };
    cron.schedule('55 23 31 3,12 *', runQuarterlyCron); // Mar 31 (Q1), Dec 31 (Q4)
    cron.schedule('55 23 30 6,9 *', runQuarterlyCron); // Jun 30 (Q2), Sep 30 (Q3)

    // ── Automatic annual cron ──
    // Fires at 00:15 on Jan 1st — 20 minutes after the Dec 31 quarterly
    // cron above, giving it a clear run before the annual one starts, and
    // squarely on "the 1st of January" as requested, with no same-day
    // clash against any quarterly report.
    cron.schedule('15 0 1 1 *', async () => {
      try {
        const { year } = justCompletedYear(new Date());
        console.log(`[AnnualReport] Auto-sending report for ${yearLabel(year)}...`);
        const result = await generateAndSendAnnualReport(deps, { year, dryRun: false });
        console.log(`[AnnualReport] Sent ${result.analysis.label} to: ${result.recipients.join(', ')}`);
      } catch (error) {
        console.error('[AnnualReport] Automatic send failed:', error && error.message ? error.message : error);
      }
    });
  }
}

module.exports = { mountQuarterlyReportRoutes, generateAndSendQuarterlyReport, generateAndSendAnnualReport };