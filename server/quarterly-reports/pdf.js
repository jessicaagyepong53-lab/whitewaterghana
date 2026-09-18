/* ═══════════════════════════════════════════════════════════════════
   QUARTERLY REPORT — PDF RENDERER
   ───────────────────────────────────────────────────────────────────
   Pure rendering layer: takes the analysis object produced by
   analysis.js and lays it out as a PDF Buffer. No business logic
   lives here — if a number looks wrong, the bug is in analysis.js,
   not here.
   ═══════════════════════════════════════════════════════════════════ */

const PDFDocument = require('pdfkit');

const CURRENCY = 'GH₵';
const BRAND_COLOR = '#0077b6';
const MUTED_COLOR = '#587289';
const DANGER_COLOR = '#b91c1c';
const OK_COLOR = '#15803d';

function fmtMoney(value) {
  const n = Number(value) || 0;
  return `${CURRENCY}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  return `${Number(value).toFixed(1)}%`;
}

function fmtNum(value) {
  return Number(value || 0).toLocaleString();
}

function sectionHeader(doc, title) {
  doc.moveDown(0.8);
  doc.fillColor(BRAND_COLOR).fontSize(14).font('Helvetica-Bold').text(title);
  doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor('#dbeafe').lineWidth(1).stroke();
  doc.moveDown(0.6);
  doc.fillColor('#0f172a').font('Helvetica').fontSize(10);
}

function kvRow(doc, label, value, opts = {}) {
  const labelWidth = opts.labelWidth || 220;
  const startX = doc.x;
  const startY = doc.y;
  doc.font('Helvetica').fillColor(MUTED_COLOR).fontSize(10).text(label, startX, startY, { width: labelWidth, continued: false });
  doc.font('Helvetica-Bold').fillColor(opts.color || '#0f172a').fontSize(10)
    .text(String(value), startX + labelWidth, startY, { width: 260 });
  doc.moveDown(0.3);
}

function paragraph(doc, text, opts = {}) {
  doc.font('Helvetica').fillColor(opts.color || '#334155').fontSize(opts.fontSize || 10)
    .text(text, { align: opts.align || 'left', width: opts.width });
  doc.moveDown(0.5);
}

function simpleTable(doc, headers, rows, colWidths) {
  const startX = doc.x;
  let y = doc.y;
  const rowHeight = 18;

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(BRAND_COLOR);
  let cursorX = startX;
  headers.forEach((header, idx) => {
    doc.fillColor('#ffffff').text(header, cursorX + 4, y + 5, { width: colWidths[idx] - 8 });
    cursorX += colWidths[idx];
  });
  y += rowHeight;

  doc.font('Helvetica').fontSize(9);
  rows.forEach((row, rowIdx) => {
    if (y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (rowIdx % 2 === 0) {
      doc.rect(startX, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill('#f3f9fe');
    }
    cursorX = startX;
    row.forEach((cell, idx) => {
      doc.fillColor('#0f172a').text(String(cell), cursorX + 4, y + 5, { width: colWidths[idx] - 8 });
      cursorX += colWidths[idx];
    });
    y += rowHeight;
  });

  doc.y = y + 6;
  doc.x = startX;
}

function buildQuarterlyReportPDF(analysis, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const companyName = meta.companyName || 'White Water Wells Ltd';

      /* ── Cover ── */
      doc.fillColor(BRAND_COLOR).font('Helvetica-Bold').fontSize(22).text(companyName, { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor('#0f172a').fontSize(16).text('Quarterly Business & Financial Report', { align: 'center' });
      doc.moveDown(0.2);
      doc.fillColor(MUTED_COLOR).fontSize(12).text(analysis.label, { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(9).text(`Generated ${new Date(analysis.generatedAt).toLocaleString('en-GB')}`, { align: 'center' });
      doc.moveDown(1.2);
      doc.fontSize(8).fillColor('#94a3b8')
        .text('Internal management report. Figures are drawn directly from the operating system\'s live records and are not a substitute for audited financial statements.', { align: 'center' });

      /* ── Executive summary ── */
      sectionHeader(doc, 'Executive Summary');
      kvRow(doc, 'Total revenue (paid invoices)', fmtMoney(analysis.revenue.totalRevenue));
      kvRow(doc, 'Net profit', fmtMoney(analysis.profitRoi.netProfit), {
        color: analysis.profitRoi.netProfit >= 0 ? OK_COLOR : DANGER_COLOR,
      });
      kvRow(doc, 'Return on assets (ROI)', analysis.profitRoi.roiPercent === null ? 'N/A (no assets recorded)' : fmtPct(analysis.profitRoi.roiPercent));
      kvRow(doc, 'Revenue variability', analysis.revenue.variabilityBand);
      kvRow(doc, 'Demand vs. supply', analysis.demandSupply.condition);
      kvRow(doc, 'Indicative forward NPV (next 4 qtrs)', fmtMoney(analysis.npv.npv), {
        color: analysis.npv.npv >= 0 ? OK_COLOR : DANGER_COLOR,
      });

      /* ── Revenue & variability ── */
      sectionHeader(doc, 'Revenue Trend & Variability');
      paragraph(doc, `Revenue was compared across the three months of ${analysis.label} to measure consistency, using the coefficient of variation (CV) — the standard deviation of monthly revenue divided by its mean. A lower CV means steadier, more predictable revenue; a higher CV means the business is more exposed to swings from any single customer or order.`);
      simpleTable(
        doc,
        ['Month', 'Revenue'],
        analysis.months.map((m) => [m, fmtMoney(analysis.revenue.monthlyRevenue[m])]),
        [200, 200],
      );
      kvRow(doc, 'Mean monthly revenue', fmtMoney(analysis.revenue.mean));
      kvRow(doc, 'Standard deviation', fmtMoney(analysis.revenue.stdDev));
      kvRow(doc, 'Coefficient of variation (CV)', fmtPct(analysis.revenue.coefficientOfVariation));
      paragraph(doc, `Interpretation: ${analysis.revenue.variabilityBand}. (CV under 15% = low variability, 15–30% = moderate, above 30% = high — a standard operating-management heuristic, not a formal statistical test.)`);

      /* ── Profitability & ROI ── */
      sectionHeader(doc, 'Profitability & Return on Assets');
      kvRow(doc, 'Total revenue', fmtMoney(analysis.revenue.totalRevenue));
      kvRow(doc, 'Cost of goods sold (production cost)', fmtMoney(analysis.profitRoi.cogs));
      kvRow(doc, 'Operating expenses (ledger)', fmtMoney(analysis.profitRoi.operatingExpenses));
      kvRow(doc, 'Promotional expense (free/discounted bags)', fmtMoney(analysis.revenue.promoExpense));
      kvRow(doc, 'Net profit', fmtMoney(analysis.profitRoi.netProfit));
      kvRow(doc, 'Total company assets', fmtMoney(analysis.profitRoi.totalAssets));
      kvRow(doc, 'ROI = Net Profit ÷ Total Assets', analysis.profitRoi.roiPercent === null ? 'N/A' : fmtPct(analysis.profitRoi.roiPercent));

      /* ── Marginal benefit vs marginal cost ── */
      sectionHeader(doc, 'Marginal Benefit vs. Marginal Cost');
      paragraph(doc, `Compares ${analysis.marginal.firstMonth} (start of quarter) against ${analysis.marginal.lastMonth} (end of quarter) to see whether expanding output is still adding more value than it costs.`);
      kvRow(doc, `Bags produced, ${analysis.marginal.firstMonth}`, fmtNum(analysis.marginal.qtyFirst));
      kvRow(doc, `Bags produced, ${analysis.marginal.lastMonth}`, fmtNum(analysis.marginal.qtyLast));
      kvRow(doc, 'Marginal cost per additional bag', analysis.marginal.marginalCostPerBag === null ? 'N/A' : fmtMoney(analysis.marginal.marginalCostPerBag));
      kvRow(doc, 'Marginal revenue per additional bag', analysis.marginal.marginalRevenuePerBag === null ? 'N/A' : fmtMoney(analysis.marginal.marginalRevenuePerBag));
      paragraph(doc, analysis.marginal.verdict);

      /* ── BCG-adapted customer matrix ── */
      doc.addPage();
      sectionHeader(doc, 'Internally-Adapted BCG Customer Portfolio Matrix');
      paragraph(doc, 'A standard BCG matrix benchmarks business units against external market share and competitors\' growth. That data is not available for this business, so this matrix instead treats each top customer account as a "unit", plotted by revenue growth quarter-over-quarter against that customer\'s share of this quarter\'s total revenue. Star = high share, high growth. Cash Cow = high share, slowing growth (reliable but maturing). Question Mark = low share, high growth (worth nurturing). Dog = low share, low/no growth.');
      simpleTable(
        doc,
        ['Customer', 'Revenue', 'Share of Qtr', 'Growth vs Prior Qtr', 'Quadrant'],
        analysis.bcgMatrix.map((row) => [
          row.customer,
          fmtMoney(row.revenue),
          fmtPct(row.share),
          row.growth === null ? 'New this period' : fmtPct(row.growth),
          row.quadrant,
        ]),
        [110, 90, 80, 110, 100],
      );

      /* ── Demand vs supply ── */
      sectionHeader(doc, 'Demand vs. Supply');
      paragraph(doc, 'Supply is bags actually produced (completed production batches); demand is bags actually ordered (all invoices raised, regardless of payment status), the classic operations-economics comparison for spotting stockout or overproduction risk.');
      kvRow(doc, 'Supply (bags produced)', fmtNum(analysis.demandSupply.supplyBags));
      kvRow(doc, 'Demand (bags ordered)', fmtNum(analysis.demandSupply.demandBags));
      kvRow(doc, 'Fulfilment rate (Demand ÷ Supply)', analysis.demandSupply.fulfillmentRate === null ? 'N/A' : fmtPct(analysis.demandSupply.fulfillmentRate));
      paragraph(doc, analysis.demandSupply.condition);

      /* ── NPV & discount rate methodology ── */
      doc.addPage();
      sectionHeader(doc, 'Net Present Value & Discount Rate Methodology');
      paragraph(doc, 'This is an indicative, short-horizon NPV of expected future operating cash flow — projecting this quarter\'s net profit forward for four quarters at the trailing growth rate (capped between -50% and +100% per quarter to avoid unrealistic compounding off one volatile quarter), discounted at the rate below. This is NOT a capital-project NPV, which would net an initial investment outlay against future inflows — it is a forward view of ongoing operations only.');
      kvRow(doc, 'Discount rate benchmark', analysis.discountRateInfo.benchmark);
      kvRow(doc, 'Annual discount rate used', fmtPct(analysis.discountRateInfo.rate * 100));
      kvRow(doc, 'Rate source', analysis.discountRateInfo.source);
      kvRow(doc, 'Rate as of', String(analysis.discountRateInfo.asOf));
      kvRow(doc, 'Quarterly discount rate applied', fmtPct(analysis.npv.quarterlyDiscountRate));
      kvRow(doc, 'Assumed quarterly growth rate', fmtPct(analysis.npv.assumedGrowthRatePerQuarter));
      simpleTable(
        doc,
        ['Future Quarter', 'Projected Cash Flow', 'Discounted Value'],
        analysis.npv.projectedCashFlows.map((row) => [`+${row.quarter}`, fmtMoney(row.projectedCashFlow), fmtMoney(row.discountedValue)]),
        [140, 180, 180],
      );
      kvRow(doc, 'NPV (sum of discounted cash flows)', fmtMoney(analysis.npv.npv), {
        color: analysis.npv.npv >= 0 ? OK_COLOR : DANGER_COLOR,
      });

      /* ── Footer / methodology note on every page ── */
      const pageRange = doc.bufferedPageRange();
      for (let i = 0; i < pageRange.count; i += 1) {
        doc.switchToPage(pageRange.start + i);
        doc.fontSize(7.5).fillColor('#94a3b8')
          .text(`${companyName} — ${analysis.label} Quarterly Report — Page ${i + 1} of ${pageRange.count}`,
            doc.page.margins.left, doc.page.height - 28,
            { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center' });
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function buildAnnualReportPDF(analysis, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const companyName = meta.companyName || 'White Water Wells Ltd';

      /* ── Cover ── */
      doc.fillColor(BRAND_COLOR).font('Helvetica-Bold').fontSize(22).text(companyName, { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor('#0f172a').fontSize(16).text('Annual Business & Financial Report', { align: 'center' });
      doc.moveDown(0.2);
      doc.fillColor(MUTED_COLOR).fontSize(12).text(analysis.label, { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(9).text(`Generated ${new Date(analysis.generatedAt).toLocaleString('en-GB')}`, { align: 'center' });
      doc.moveDown(1.2);
      doc.fontSize(8).fillColor('#94a3b8')
        .text('Internal management report. Figures are drawn directly from the operating system\'s live records and are not a substitute for audited financial statements.', { align: 'center' });

      if (analysis.partialYear) {
        doc.moveDown(0.4);
        doc.fontSize(8.5).fillColor(MUTED_COLOR)
          .text(`Note: ${companyName} was operational for ${analysis.operatingMonths.length} of 12 months this year (${analysis.operatingMonths[0]} to ${analysis.operatingMonths[analysis.operatingMonths.length - 1]}). Trend and marginal figures below are calculated over those operating months only; idle months before start-up are excluded so they don't distort the variability and marginal-output comparisons. Full-year revenue and profit totals still include the whole calendar year.`, { align: 'center' });
      }

      /* ── Executive summary ── */
      sectionHeader(doc, 'Executive Summary');
      kvRow(doc, 'Total revenue (paid invoices)', fmtMoney(analysis.revenue.totalRevenue));
      kvRow(doc, 'Net profit', fmtMoney(analysis.profitRoi.netProfit), {
        color: analysis.profitRoi.netProfit >= 0 ? OK_COLOR : DANGER_COLOR,
      });
      kvRow(doc, 'Return on assets (ROI)', analysis.profitRoi.roiPercent === null ? 'N/A (no assets recorded)' : fmtPct(analysis.profitRoi.roiPercent));
      kvRow(doc, 'Revenue variability', analysis.revenue.variabilityBand);
      kvRow(doc, 'Demand vs. supply', analysis.demandSupply.condition);
      kvRow(doc, 'Indicative forward NPV (next 3 years)', fmtMoney(analysis.npv.npv), {
        color: analysis.npv.npv >= 0 ? OK_COLOR : DANGER_COLOR,
      });

      /* ── Revenue & variability ── */
      sectionHeader(doc, 'Revenue Trend & Variability');
      paragraph(doc, `Revenue was compared across the operating months of ${analysis.label} to measure consistency, using the coefficient of variation (CV) — the standard deviation of monthly revenue divided by its mean. A lower CV means steadier, more predictable revenue; a higher CV means the business is more exposed to swings from any single customer or order.`);
      simpleTable(
        doc,
        ['Month', 'Revenue'],
        analysis.months.filter((m) => Object.prototype.hasOwnProperty.call(analysis.revenue.monthlyRevenue, m)).map((m) => [m, fmtMoney(analysis.revenue.monthlyRevenue[m])]),
        [200, 200],
      );
      kvRow(doc, 'Mean monthly revenue', fmtMoney(analysis.revenue.mean));
      kvRow(doc, 'Standard deviation', fmtMoney(analysis.revenue.stdDev));
      kvRow(doc, 'Coefficient of variation (CV)', fmtPct(analysis.revenue.coefficientOfVariation));
      paragraph(doc, `Interpretation: ${analysis.revenue.variabilityBand}. (CV under 15% = low variability, 15–30% = moderate, above 30% = high — a standard operating-management heuristic, not a formal statistical test.)`);

      /* ── Profitability & ROI ── */
      sectionHeader(doc, 'Profitability & Return on Assets');
      kvRow(doc, 'Total revenue', fmtMoney(analysis.revenue.totalRevenue));
      kvRow(doc, 'Cost of goods sold (production cost)', fmtMoney(analysis.profitRoi.cogs));
      kvRow(doc, 'Operating expenses (ledger)', fmtMoney(analysis.profitRoi.operatingExpenses));
      kvRow(doc, 'Promotional expense (free/discounted bags)', fmtMoney(analysis.revenue.promoExpense));
      kvRow(doc, 'Net profit', fmtMoney(analysis.profitRoi.netProfit));
      kvRow(doc, 'Total company assets', fmtMoney(analysis.profitRoi.totalAssets));
      kvRow(doc, 'ROI = Net Profit ÷ Total Assets', analysis.profitRoi.roiPercent === null ? 'N/A' : fmtPct(analysis.profitRoi.roiPercent));

      /* ── Marginal benefit vs marginal cost ── */
      sectionHeader(doc, 'Marginal Benefit vs. Marginal Cost');
      paragraph(doc, `Compares ${analysis.marginal.firstMonth} (first operating month of the year) against ${analysis.marginal.lastMonth} (last operating month) to see whether expanding output is still adding more value than it costs.`);
      kvRow(doc, `Bags produced, ${analysis.marginal.firstMonth}`, fmtNum(analysis.marginal.qtyFirst));
      kvRow(doc, `Bags produced, ${analysis.marginal.lastMonth}`, fmtNum(analysis.marginal.qtyLast));
      kvRow(doc, 'Marginal cost per additional bag', analysis.marginal.marginalCostPerBag === null ? 'N/A' : fmtMoney(analysis.marginal.marginalCostPerBag));
      kvRow(doc, 'Marginal revenue per additional bag', analysis.marginal.marginalRevenuePerBag === null ? 'N/A' : fmtMoney(analysis.marginal.marginalRevenuePerBag));
      paragraph(doc, analysis.marginal.verdict);

      /* ── BCG-adapted customer matrix ── */
      doc.addPage();
      sectionHeader(doc, 'Internally-Adapted BCG Customer Portfolio Matrix');
      paragraph(doc, `A standard BCG matrix benchmarks business units against external market share and competitors' growth. That data is not available for this business, so this matrix instead treats each top customer account as a "unit", plotted by revenue growth year-over-year (${analysis.label} vs ${analysis.previousYearLabel}) against that customer's share of this year's total revenue. Star = high share, high growth. Cash Cow = high share, slowing growth (reliable but maturing). Question Mark = low share, high growth (worth nurturing) — every customer shows here if this is the business's first year with recorded data. Dog = low share, low/no growth.`);
      simpleTable(
        doc,
        ['Customer', 'Revenue', 'Share of Year', 'Growth vs Prior Year', 'Quadrant'],
        analysis.bcgMatrix.map((row) => [
          row.customer,
          fmtMoney(row.revenue),
          fmtPct(row.share),
          row.growth === null ? 'New this period' : fmtPct(row.growth),
          row.quadrant,
        ]),
        [110, 90, 80, 110, 100],
      );

      /* ── Demand vs supply ── */
      sectionHeader(doc, 'Demand vs. Supply');
      paragraph(doc, 'Supply is bags actually produced (completed production batches); demand is bags actually ordered (all invoices raised, regardless of payment status), the classic operations-economics comparison for spotting stockout or overproduction risk.');
      kvRow(doc, 'Supply (bags produced)', fmtNum(analysis.demandSupply.supplyBags));
      kvRow(doc, 'Demand (bags ordered)', fmtNum(analysis.demandSupply.demandBags));
      kvRow(doc, 'Fulfilment rate (Demand ÷ Supply)', analysis.demandSupply.fulfillmentRate === null ? 'N/A' : fmtPct(analysis.demandSupply.fulfillmentRate));
      paragraph(doc, analysis.demandSupply.condition);

      /* ── NPV & discount rate methodology ── */
      doc.addPage();
      sectionHeader(doc, 'Net Present Value & Discount Rate Methodology');
      paragraph(doc, 'This is an indicative NPV of expected future operating cash flow — projecting this year\'s net profit forward for three years at the trailing year-over-year growth rate (capped between -30% and +50% per year to avoid unrealistic compounding off one volatile year), discounted at the rate below. This is NOT a capital-project NPV, which would net an initial investment outlay against future inflows — it is a forward view of ongoing operations only.');
      kvRow(doc, 'Discount rate benchmark', analysis.discountRateInfo.benchmark);
      kvRow(doc, 'Annual discount rate used', fmtPct(analysis.discountRateInfo.rate * 100));
      kvRow(doc, 'Rate source', analysis.discountRateInfo.source);
      kvRow(doc, 'Rate as of', String(analysis.discountRateInfo.asOf));
      kvRow(doc, 'Assumed annual growth rate', fmtPct(analysis.npv.assumedGrowthRatePerYear));
      simpleTable(
        doc,
        ['Future Year', 'Projected Cash Flow', 'Discounted Value'],
        analysis.npv.projectedCashFlows.map((row) => [`+${row.year}`, fmtMoney(row.projectedCashFlow), fmtMoney(row.discountedValue)]),
        [140, 180, 180],
      );
      kvRow(doc, 'NPV (sum of discounted cash flows)', fmtMoney(analysis.npv.npv), {
        color: analysis.npv.npv >= 0 ? OK_COLOR : DANGER_COLOR,
      });

      /* ── Footer / methodology note on every page ── */
      const pageRange = doc.bufferedPageRange();
      for (let i = 0; i < pageRange.count; i += 1) {
        doc.switchToPage(pageRange.start + i);
        doc.fontSize(7.5).fillColor('#94a3b8')
          .text(`${companyName} — ${analysis.label} Annual Report — Page ${i + 1} of ${pageRange.count}`,
            doc.page.margins.left, doc.page.height - 28,
            { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center' });
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { buildQuarterlyReportPDF, buildAnnualReportPDF };