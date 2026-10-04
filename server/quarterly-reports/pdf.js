/* ═══════════════════════════════════════════════════════════════════
   REPORT PDF RENDERER  (quarterly + annual)
   ───────────────────────────────────────────────────────────────────
   Pure rendering layer: takes the analysis object from analysis.js and
   returns a PDF Buffer. No business logic lives here.

   Fixes versus the first version:
   1. Blank / missing content. Two pdfkit traps caused this:
      - text drawn at an explicit x moves doc.x, so each "label: value"
        row drifted further right until it ran off the page. This file
        never relies on doc.x/doc.y; every element is placed from an
        explicit cursor (L.y) and the left margin.
      - the page footer was written below the bottom margin, which makes
        pdfkit silently add extra blank pages. Footers now zero the
        bottom margin first.
   2. The "GH₵" sign printed as "µ" because the built-in Helvetica font
      has no cedi glyph. We embed DejaVu Sans (npm: dejavu-fonts-ttf).
      If it is not installed the renderer falls back to Helvetica and
      prints "GHS" instead, so the report never shows garbage.
   3. Adds real charts drawn as vectors (no image libraries needed).
   ═══════════════════════════════════════════════════════════════════ */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const C = {
  brand: '#0077b6',
  brandDark: '#0a3858',
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',
  line: '#dbe7f3',
  tint: '#f3f9fe',
  good: '#15803d',
  goodTint: '#dcfce7',
  bad: '#b91c1c',
  badTint: '#fee2e2',
  warn: '#b45309',
  warnTint: '#fef3c7',
  bars: ['#0077b6', '#22c55e', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6', '#64748b', '#ec4899'],
};

/* ── Fonts ─────────────────────────────────────────────────────── */

function locateFontDir() {
  const candidates = [];
  try { candidates.push(path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'))); } catch (_e) { /* not installed */ }
  candidates.push(path.join(process.cwd(), 'node_modules', 'dejavu-fonts-ttf', 'ttf'));
  candidates.push(path.join(__dirname, '..', 'node_modules', 'dejavu-fonts-ttf', 'ttf'));
  candidates.push(path.join(__dirname, 'fonts'));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'DejaVuSans.ttf')) && fs.existsSync(path.join(dir, 'DejaVuSans-Bold.ttf'))) return dir;
    } catch (_e) { /* keep looking */ }
  }
  return null;
}

function setupFonts(doc) {
  const dir = locateFontDir();
  if (dir) {
    doc.registerFont('Body', path.join(dir, 'DejaVuSans.ttf'));
    doc.registerFont('Bold', path.join(dir, 'DejaVuSans-Bold.ttf'));
    const obl = path.join(dir, 'DejaVuSans-Oblique.ttf');
    doc.registerFont('Italic', fs.existsSync(obl) ? obl : path.join(dir, 'DejaVuSans.ttf'));
    return { unicode: true };
  }
  doc.registerFont('Body', 'Helvetica');
  doc.registerFont('Bold', 'Helvetica-Bold');
  doc.registerFont('Italic', 'Helvetica-Oblique');
  console.warn('[Report PDF] dejavu-fonts-ttf not found; falling back to Helvetica with "GHS" currency. Run: npm install dejavu-fonts-ttf');
  return { unicode: false };
}

function makeSanitizer(unicode) {
  if (unicode) return (s) => String(s === null || s === undefined ? '' : s);
  return (s) => String(s === null || s === undefined ? '' : s)
    .replace(/GH₵/g, 'GHS ')
    .replace(/₵/g, 'GHS ')
    .replace(/→/g, '->')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/²/g, '2')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x00-\xFF]/g, '');
}

/* ── Logo ──────────────────────────────────────────────────────── */
// Looks for the company logo in the project's images folder. If it cannot
// be found or read, a drawn water-drop mark is used so the header never
// breaks. To force a specific file set REPORT_LOGO_PATH in the environment.

const LOGO_FILE_NAMES = ['New Logo.jpeg', 'Final Logo.jpg', 'New Logo.jpg', 'logo.png', 'logo.jpg'];

function findLogoPath(meta) {
  const candidates = [];
  if (meta && meta.logoPath) candidates.push(meta.logoPath);
  if (process.env.REPORT_LOGO_PATH) candidates.push(process.env.REPORT_LOGO_PATH);
  const dirs = [
    path.join(__dirname, '..', 'images'),
    path.join(__dirname, '..', 'public', 'images'),
    path.join(process.cwd(), 'images'),
    path.join(process.cwd(), 'public', 'images'),
    path.join(__dirname, 'images'),
  ];
  for (const dir of dirs) for (const name of LOGO_FILE_NAMES) candidates.push(path.join(dir, name));
  for (const file of candidates) {
    try { if (file && fs.existsSync(file)) return file; } catch (_e) { /* keep looking */ }
  }
  return null;
}

// Draws the logo (or fallback mark) inside a rounded white tile.
function drawLogoTile(doc, x, y, size, logoPath) {
  doc.save();
  doc.roundedRect(x, y, size, size, 12).fill('#ffffff');
  doc.restore();
  let drawn = false;
  if (logoPath) {
    try {
      doc.save();
      doc.roundedRect(x, y, size, size, 12).clip();
      doc.image(logoPath, x + 5, y + 5, { fit: [size - 10, size - 10], align: 'center', valign: 'center' });
      doc.restore();
      drawn = true;
    } catch (_e) {
      try { doc.restore(); } catch (_e2) { /* ignore */ }
    }
  }
  if (!drawn) {
    const cx = x + size / 2;
    const cy = y + size / 2;
    doc.save();
    doc.moveTo(cx, cy - size * 0.30)
      .bezierCurveTo(cx + size * 0.30, cy + size * 0.02, cx + size * 0.22, cy + size * 0.30, cx, cy + size * 0.30)
      .bezierCurveTo(cx - size * 0.22, cy + size * 0.30, cx - size * 0.30, cy + size * 0.02, cx, cy - size * 0.30)
      .fill(C.brand);
    doc.restore();
  }
  doc.roundedRect(x, y, size, size, 12).lineWidth(0.8).strokeColor('#ffffff').opacity(0.35).stroke().opacity(1);
}

/* ── Formatting ────────────────────────────────────────────────── */

function money(v) {
  const n = Number(v) || 0;
  return `${n < 0 ? '-' : ''}GH₵${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function moneyShort(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(0)}k` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : (a < 100 && a % 1 !== 0) ? a.toFixed(2).replace(/0$/, '') : a.toFixed(0);
  return `${n < 0 ? '-' : ''}${s}`;
}
function pct(v, d = 1) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return 'n/a';
  return `${Number(v).toFixed(d)}%`;
}
function num(v) { return Number(v || 0).toLocaleString('en-GB'); }
function signedPct(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return 'n/a';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
}

/* ── Layout toolkit (explicit cursor; never trusts doc.x / doc.y) ── */

class Layout {
  constructor(doc, S, meta) {
    this.doc = doc;
    this.S = S;
    this.meta = meta;
    this.left = 40;
    this.right = doc.page.width - 40;
    this.width = this.right - this.left;
    this.top = 62;
    this.bottom = doc.page.height - 52;
    this.y = this.top;
  }

  newPage() {
    this.doc.addPage();
    this.y = this.top;
  }

  ensure(h) {
    if (this.y + h > this.bottom) this.newPage();
  }

  gap(h = 8) { this.y += h; }

  text(str, opts = {}) {
    const { doc, S } = this;
    const x = opts.x !== undefined ? opts.x : this.left;
    const w = opts.width !== undefined ? opts.width : this.width;
    doc.font(opts.font || 'Body').fontSize(opts.size || 9.5).fillColor(opts.color || C.body);
    const t = S(str);
    const h = doc.heightOfString(t, { width: w, align: opts.align || 'left', lineGap: opts.lineGap === undefined ? 1.5 : opts.lineGap });
    if (!opts.noEnsure) this.ensure(h);
    doc.text(t, x, this.y, { width: w, align: opts.align || 'left', lineGap: opts.lineGap === undefined ? 1.5 : opts.lineGap });
    if (!opts.stay) this.y += h + (opts.after === undefined ? 4 : opts.after);
    return h;
  }

  h1(title, subtitle) {
    this.ensure(46);
    const { doc, S } = this;
    doc.rect(this.left, this.y, 4, 20).fill(C.brand);
    doc.font('Bold').fontSize(15).fillColor(C.brandDark).text(S(title), this.left + 12, this.y + 2, { width: this.width - 12, lineBreak: false });
    this.y += 26;
    if (subtitle) this.text(subtitle, { size: 8.5, color: C.muted, after: 6 });
    else this.y += 2;
  }

  h2(title) {
    this.ensure(28);
    this.text(title, { font: 'Bold', size: 10.5, color: C.brandDark, after: 3 });
  }

  bullets(items, opts = {}) {
    const { doc, S } = this;
    for (const item of items) {
      const w = this.width - 14;
      doc.font('Body').fontSize(opts.size || 9.5);
      const h = doc.heightOfString(S(item), { width: w, lineGap: 1.5 });
      this.ensure(h + 3);
      doc.circle(this.left + 4, this.y + 5, 1.8).fill(opts.color || C.brand);
      doc.font('Body').fontSize(opts.size || 9.5).fillColor(C.body).text(S(item), this.left + 14, this.y, { width: w, lineGap: 1.5 });
      this.y += h + 4;
    }
    this.y += 2;
  }

  callout(str, tone = 'info') {
    const { doc, S } = this;
    const tones = { info: [C.tint, C.brand], good: [C.goodTint, C.good], bad: [C.badTint, C.bad], warn: [C.warnTint, C.warn] };
    const [bg, fg] = tones[tone] || tones.info;
    doc.font('Body').fontSize(9);
    const h = doc.heightOfString(S(str), { width: this.width - 24, lineGap: 1.5 }) + 14;
    this.ensure(h + 4);
    doc.roundedRect(this.left, this.y, this.width, h, 5).fill(bg);
    doc.rect(this.left, this.y, 3, h).fill(fg);
    doc.font('Body').fontSize(9).fillColor(C.ink).text(S(str), this.left + 12, this.y + 7, { width: this.width - 24, lineGap: 1.5 });
    this.y += h + 8;
  }

  kv(rows, opts = {}) {
    const { doc, S } = this;
    const lw = opts.labelWidth || 230;
    for (const row of rows) {
      const [label, value, color] = row;
      doc.font('Body').fontSize(9.5);
      const vh = doc.heightOfString(S(value), { width: this.width - lw });
      const lh = doc.heightOfString(S(label), { width: lw - 8 });
      const h = Math.max(vh, lh) + 5;
      this.ensure(h);
      doc.font('Body').fontSize(9.5).fillColor(C.muted).text(S(label), this.left, this.y, { width: lw - 8 });
      doc.font('Bold').fontSize(9.5).fillColor(color || C.ink).text(S(value), this.left + lw, this.y, { width: this.width - lw });
      doc.moveTo(this.left, this.y + h - 2).lineTo(this.right, this.y + h - 2).lineWidth(0.4).strokeColor(C.line).stroke();
      this.y += h;
    }
    this.y += 6;
  }

  table(headers, rows, colWidths, opts = {}) {
    const { doc, S } = this;
    const total = colWidths.reduce((a, b) => a + b, 0);
    const scale = (total > this.width || total > this.width * 0.9) ? this.width / total : 1;
    const widths = colWidths.map((w) => w * scale);
    const size = opts.size || 8.5;
    const aligns = opts.align || headers.map(() => 'left');

    const drawHeader = () => {
      doc.font('Bold').fontSize(size);
      const hh = Math.max(...headers.map((h, i) => doc.heightOfString(S(h), { width: widths[i] - 8 }))) + 8;
      this.ensure(hh + 20);
      doc.rect(this.left, this.y, widths.reduce((a, b) => a + b, 0), hh).fill(C.brand);
      let x = this.left;
      headers.forEach((h, i) => {
        doc.font('Bold').fontSize(size).fillColor('#ffffff').text(S(h), x + 4, this.y + 4, { width: widths[i] - 8, align: aligns[i] });
        x += widths[i];
      });
      this.y += hh;
    };
    drawHeader();

    rows.forEach((row, ri) => {
      doc.font('Body').fontSize(size);
      const rh = Math.max(...row.map((cell, i) => doc.heightOfString(S(cell && cell.text !== undefined ? cell.text : cell), { width: widths[i] - 8 }))) + 7;
      if (this.y + rh > this.bottom) { this.newPage(); drawHeader(); }
      if (ri % 2 === 0) doc.rect(this.left, this.y, widths.reduce((a, b) => a + b, 0), rh).fill(C.tint);
      let x = this.left;
      row.forEach((cell, i) => {
        const isObj = cell && typeof cell === 'object' && cell.text !== undefined;
        doc.font(isObj && cell.bold ? 'Bold' : 'Body').fontSize(size).fillColor(isObj && cell.color ? cell.color : C.ink)
          .text(S(isObj ? cell.text : cell), x + 4, this.y + 3.5, { width: widths[i] - 8, align: aligns[i] });
        x += widths[i];
      });
      this.y += rh;
    });
    this.y += 8;
  }

  tiles(items) {
    const { doc, S } = this;
    const cols = 3;
    const gapX = 10;
    const w = (this.width - gapX * (cols - 1)) / cols;
    const h = 58;
    for (let i = 0; i < items.length; i += cols) {
      this.ensure(h + 8);
      items.slice(i, i + cols).forEach((t, j) => {
        const x = this.left + j * (w + gapX);
        doc.roundedRect(x, this.y, w, h, 6).fill('#ffffff');
        doc.roundedRect(x, this.y, w, h, 6).lineWidth(0.8).strokeColor(C.line).stroke();
        doc.rect(x, this.y + 8, 3, h - 16).fill(t.color || C.brand);
        doc.font('Body').fontSize(7.5).fillColor(C.muted).text(S(t.label.toUpperCase()), x + 12, this.y + 8, { width: w - 18, characterSpacing: 0.4, lineBreak: false });
        doc.font('Bold').fontSize(14).fillColor(t.color && t.color !== C.brand ? t.color : C.ink).text(S(t.value), x + 12, this.y + 21, { width: w - 18, lineBreak: false });
        doc.font('Body').fontSize(7.5).fillColor(C.muted).text(S(t.sub || ''), x + 12, this.y + 42, { width: w - 18, lineBreak: false });
      });
      this.y += h + 8;
    }
  }
}

/* ── Charts (vector) ───────────────────────────────────────────── */

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const steps = [1, 1.2, 1.6, 2, 2.4, 3, 4, 6, 8, 10];
  const step = steps.find((x) => x >= n * 0.999) || 10;
  return step * p;
}

function chartFrame(L, title, height) {
  const { doc, S } = L;
  L.ensure(height + 22);
  if (title) L.text(title, { font: 'Bold', size: 9.5, color: C.brandDark, after: 2 });
  return { x: L.left, y: L.y, w: L.width, h: height };
}

// Grouped/single vertical bars. series: [{name, color, values[]}]. labels[]. highlight: set of indexes to emphasise.
function barChart(L, { title, labels, series, height = 150, money: isMoney = true, highlight = null, valueLabels = true, legend = true }) {
  const { doc, S } = L;
  const f = chartFrame(L, title, height);
  const padL = 44;
  const padB = 24;
  const padT = 8;
  const cx = f.x + padL;
  const cw = f.w - padL - 6;
  const ch = f.h - padB - padT;
  const maxV = niceMax(Math.max(1, ...series.flatMap((s) => s.values.map((v) => Math.max(0, v || 0)))));

  for (let i = 0; i <= 4; i += 1) {
    const gy = f.y + padT + ch - (ch * i) / 4;
    doc.moveTo(cx, gy).lineTo(cx + cw, gy).lineWidth(0.4).strokeColor(C.line).stroke();
    doc.font('Body').fontSize(7).fillColor(C.muted).text(S(isMoney ? moneyShort((maxV * i) / 4) : num(Math.round((maxV * i) / 4))), f.x, gy - 4, { width: padL - 5, align: 'right', lineBreak: false });
  }
  const groupW = cw / labels.length;
  const barW = Math.min(34, (groupW * 0.7) / series.length);
  labels.forEach((lab, i) => {
    const gx = cx + i * groupW + (groupW - barW * series.length) / 2;
    series.forEach((s, j) => {
      const v = Math.max(0, s.values[i] || 0);
      const bh = (v / maxV) * ch;
      const color = highlight && !highlight.has(i) ? '#b8d4e8' : s.color;
      doc.rect(gx + j * barW, f.y + padT + ch - bh, barW - 1.5, bh).fill(color);
      if (valueLabels && v > 0 && labels.length <= 14) {
        doc.font('Body').fontSize(6.5).fillColor(C.body).text(S(isMoney ? moneyShort(v) : num(v)), gx + j * barW - 6, f.y + padT + ch - bh - 9, { width: barW + 10, align: 'center', lineBreak: false });
      }
    });
    doc.font('Body').fontSize(7).fillColor(C.muted).text(S(lab), cx + i * groupW, f.y + padT + ch + 5, { width: groupW, align: 'center', lineBreak: false });
  });
  L.y = f.y + f.h + 2;
  if (legend && series.length > 1) legendRow(L, series.map((s) => ({ name: s.name, color: s.color })));
  L.y += 6;
}

function legendRow(L, items) {
  const { doc, S } = L;
  let x = L.left + 44;
  L.ensure(14);
  items.forEach((it) => {
    doc.rect(x, L.y + 2, 8, 8).fill(it.color);
    doc.font('Body').fontSize(7.5).fillColor(C.body).text(S(it.name), x + 12, L.y + 2, { lineBreak: false });
    x += 12 + doc.widthOfString(S(it.name)) + 14;
  });
  L.y += 14;
}

function lineChart(L, { title, labels, series, height = 140, money: isMoney = true, bandLine = null }) {
  const { doc, S } = L;
  const f = chartFrame(L, title, height);
  const padL = 44;
  const padB = 22;
  const padT = 8;
  const cx = f.x + padL;
  const cw = f.w - padL - 10;
  const ch = f.h - padB - padT;
  const all = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
  const maxV = niceMax(Math.max(1, ...all, bandLine || 0));
  for (let i = 0; i <= 4; i += 1) {
    const gy = f.y + padT + ch - (ch * i) / 4;
    doc.moveTo(cx, gy).lineTo(cx + cw, gy).lineWidth(0.4).strokeColor(C.line).stroke();
    doc.font('Body').fontSize(7).fillColor(C.muted).text(S(isMoney ? moneyShort((maxV * i) / 4) : num(Math.round((maxV * i) / 4))), f.x, gy - 4, { width: padL - 5, align: 'right', lineBreak: false });
  }
  const step = labels.length > 1 ? cw / (labels.length - 1) : 0;
  if (bandLine !== null) {
    const by = f.y + padT + ch - (bandLine / maxV) * ch;
    doc.moveTo(cx, by).lineTo(cx + cw, by).lineWidth(0.8).dash(3, { space: 3 }).strokeColor(C.faint).stroke().undash();
  }
  series.forEach((s) => {
    let started = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const px = cx + i * step;
      const py = f.y + padT + ch - (v / maxV) * ch;
      if (!started) { doc.moveTo(px, py); started = true; } else doc.lineTo(px, py);
    });
    doc.lineWidth(1.6).strokeColor(s.color).stroke();
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      doc.circle(cx + i * step, f.y + padT + ch - (v / maxV) * ch, 2).fill(s.color);
    });
  });
  const every = Math.max(1, Math.ceil(labels.length / 12));
  labels.forEach((lab, i) => {
    if (i % every !== 0) return;
    doc.font('Body').fontSize(6.8).fillColor(C.muted).text(S(lab), cx + i * step - 22, f.y + padT + ch + 5, { width: 44, align: 'center', lineBreak: false });
  });
  L.y = f.y + f.h + 2;
  if (series.length > 1) legendRow(L, series.map((s) => ({ name: s.name, color: s.color })));
  L.y += 6;
}

function horizontalBars(L, { title, items, height, money: isMoney = true }) {
  const { doc, S } = L;
  const rowH = 17;
  const h = height || items.length * rowH + 6;
  const f = chartFrame(L, title, h);
  const labelW = 130;
  const maxV = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  items.forEach((it, idx) => {
    const y = f.y + idx * rowH;
    const bw = ((f.w - labelW - 90) * Math.abs(it.value)) / maxV;
    doc.font('Body').fontSize(8).fillColor(C.body).text(S(it.label), f.x, y + 3, { width: labelW - 6, lineBreak: false, ellipsis: true });
    doc.rect(f.x + labelW, y + 2, Math.max(1, bw), rowH - 6).fill(it.color || C.bars[idx % C.bars.length]);
    doc.font('Bold').fontSize(8).fillColor(C.ink).text(S(`${isMoney ? money(it.value) : num(it.value)}${it.note ? '  ' + it.note : ''}`), f.x + labelW + bw + 5, y + 3, { lineBreak: false });
  });
  L.y = f.y + h + 4;
}

// Bubble scatter for the BCG customer matrix.
// Layout rules: quadrant names sit OUTSIDE the plot, bubbles carry a number
// that matches the table below (no name labels to collide), x and y use a
// square-root scale so small customers spread out, and bubbles are nudged
// apart so none overlap.
function bcgChart(L, portfolio, height = 280) {
  const { doc, S } = L;
  const rows = portfolio.rows;
  const f = chartFrame(L, 'Customer map: share of our sales (across) against growth (up)', height);
  const padL = 50;
  const padR = 12;
  const padT = 16;
  const padB = 46;
  const cx = f.x + padL;
  const cw = f.w - padL - padR;
  const top = f.y + padT;
  const ch = f.h - padT - padB;
  const bandH = rows.some((r) => r.isNew) ? 28 : 0; // strip at the top for new buyers
  const areaTop = top + bandH;
  const areaH = ch - bandH;
  const inset = 14; // keeps bubbles off the frame

  const colorOf = { Star: '#16a34a', 'Cash Cow': '#d97706', 'Question Mark': '#2563eb', Dog: '#dc2626' };
  const bgOf = { 'Question Mark': '#eef6ff', Star: '#e8f8ee', Dog: '#fdeeee', 'Cash Cow': '#fff6e0' };

  const sMax = Math.max(10, Math.ceil((Math.max(...rows.map((r) => r.share)) * 1.1) / 5) * 5);
  const growths = rows.filter((r) => r.growth !== null).map((r) => r.growth);
  const gThr = portfolio.growthThreshold === null || portfolio.growthThreshold === undefined ? 0 : portfolio.growthThreshold;
  const gLo = Math.min(0, gThr, ...growths) - 10;
  const gHi = Math.max(50, gThr, ...growths) + 10;

  const toX = (s) => cx + inset + Math.sqrt(Math.max(0, s) / sMax) * (cw - 2 * inset);
  const toY = (g) => areaTop + areaH - inset - Math.sqrt(Math.max(0, (g - gLo) / (gHi - gLo))) * (areaH - 2 * inset);

  const thrX = toX(portfolio.shareThreshold || 0);
  const thrY = toY(gThr);

  // Quadrant backgrounds
  const quads = [
    ['Question Mark', 'QUESTION MARKS', cx, top, thrX - cx, thrY - top],
    ['Star', 'STARS', thrX, top, cx + cw - thrX, thrY - top],
    ['Dog', 'DOGS', cx, thrY, thrX - cx, top + ch - thrY],
    ['Cash Cow', 'CASH COWS', thrX, thrY, cx + cw - thrX, top + ch - thrY],
  ];
  quads.forEach(([key, label, x, y, w, h]) => {
    doc.rect(x, y, Math.max(0, w), Math.max(0, h)).fill(bgOf[key]);
    // Names live outside the plot: group names above (top row) and below (bottom row).
    const above = key === 'Question Mark' || key === 'Star';
    const ly = above ? f.y + 3 : top + ch + 15;
    doc.font('Bold').fontSize(7.5).fillColor(colorOf[key])
      .text(label, x, ly, { width: Math.max(10, w), align: 'center', lineBreak: false });
  });
  doc.rect(cx, top, cw, ch).lineWidth(0.6).strokeColor(C.line).stroke();
  if (bandH) {
    doc.moveTo(cx, areaTop).lineTo(cx + cw, areaTop).lineWidth(0.5).dash(2, { space: 2 }).strokeColor(C.faint).stroke().undash();
    doc.font('Bold').fontSize(6.5).fillColor(C.muted).text('NEW', f.x, top + bandH / 2 - 3, { width: padL - 6, align: 'right', lineBreak: false });
  }
  // Dividing lines
  doc.moveTo(thrX, top).lineTo(thrX, top + ch).lineWidth(0.7).dash(3, { space: 3 }).strokeColor(C.faint).stroke().undash();
  doc.moveTo(cx, thrY).lineTo(cx + cw, thrY).lineWidth(0.7).dash(3, { space: 3 }).strokeColor(C.faint).stroke().undash();

  // Axis ticks: x (share) and y (growth)
  const xTicks = [0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 60].filter((t) => t <= sMax);
  xTicks.forEach((t) => {
    const tx = toX(t);
    doc.moveTo(tx, top + ch).lineTo(tx, top + ch + 3).lineWidth(0.5).strokeColor(C.faint).stroke();
    doc.font('Body').fontSize(6.8).fillColor(C.muted).text(`${t}%`, tx - 14, top + ch + 5, { width: 28, align: 'center', lineBreak: false });
  });
  [-100, -50, -25, 0, 25, 50, 100, 200, 300, 400, 500].filter((t) => t >= gLo && t <= gHi).forEach((t) => {
    const ty = toY(t);
    if (ty < areaTop + 4 || ty > top + ch - 2) return;
    doc.moveTo(cx - 3, ty).lineTo(cx, ty).lineWidth(0.5).strokeColor(C.faint).stroke();
    doc.font('Body').fontSize(6.8).fillColor(C.muted).text(`${t > 0 ? '+' : ''}${t}%`, f.x, ty - 3.5, { width: padL - 6, align: 'right', lineBreak: false });
  });

  // Place bubbles, then push overlapping ones apart.
  const maxRev = Math.max(1, ...rows.map((r) => r.revenue));
  const nodes = rows.map((r, i) => ({
    r,
    i,
    rad: 7 + 9 * Math.sqrt(r.revenue / maxRev),
    x: toX(r.share),
    y: r.isNew ? top + bandH / 2 + (i % 2 ? 4 : -4) : toY(r.growth),
  }));
  const clamp = (n) => {
    const yMin = n.r.isNew ? top + n.rad + 1 : areaTop + n.rad + 1;
    const yMax = n.r.isNew ? areaTop - n.rad - 1 : top + ch - n.rad - 1;
    n.x = Math.max(cx + n.rad + 2, Math.min(cx + cw - n.rad - 2, n.x));
    n.y = yMax < yMin ? (yMin + yMax) / 2 : Math.max(yMin, Math.min(yMax, n.y));
  };
  nodes.forEach(clamp);
  for (let pass = 0; pass < 120; pass += 1) {
    let moved = false;
    for (let a = 0; a < nodes.length; a += 1) {
      for (let b = a + 1; b < nodes.length; b += 1) {
        const A = nodes[a];
        const B = nodes[b];
        let dx = B.x - A.x;
        let dy = B.y - A.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const need = A.rad + B.rad + 2;
        if (dist < need) {
          if (dist < 0.05) { dx = 1; dy = 0; }
          const push = (need - dist) / 2;
          A.x -= (dx / dist) * push; A.y -= (dy / dist) * push;
          B.x += (dx / dist) * push; B.y += (dy / dist) * push;
          clamp(A); clamp(B);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  nodes.forEach((n) => {
    const col = colorOf[n.r.quadrantBase] || C.brand;
    doc.circle(n.x, n.y, n.rad).fillOpacity(0.6).fill(col).fillOpacity(1);
    doc.circle(n.x, n.y, n.rad).lineWidth(n.r.isNew ? 1.2 : 0.8).strokeColor(col);
    if (n.r.isNew) doc.dash(2, { space: 1.5 });
    doc.stroke().undash();
    doc.font('Bold').fontSize(8).fillColor('#ffffff').text(String(n.i + 1), n.x - 10, n.y - 3.6, { width: 20, align: 'center', lineBreak: false });
  });

  doc.font('Body').fontSize(7).fillColor(C.muted).text(S('Share of our sales (%)'), cx, top + ch + 28, { width: cw, align: 'center', lineBreak: false });
  doc.save();
  doc.rotate(-90, { origin: [f.x + 6, top + ch / 2] });
  doc.font('Body').fontSize(7).fillColor(C.muted).text(S('Growth compared with before (%)'), f.x - 54, top + ch / 2 - 4, { width: 120, align: 'center', lineBreak: false });
  doc.restore();
  L.y = f.y + f.h + 4;
  L.text('Each bubble carries the number of its row in the table below. Bigger bubble = the customer paid us more. A dashed outline means a new buyer: they have nothing to compare with, so they sit in the top strip as growing. Dotted lines show the middle customer\'s share of sales and the growth of the whole business. Scales are stretched for small values so customers do not pile up, so read the table for exact figures.', { size: 7.5, color: C.muted, after: 6 });
}

/* ── Sections ──────────────────────────────────────────────────── */

function periodInfoOf(a) {
  if (a.period) return a.period;
  return { rangeText: a.label, shortText: a.label, monthNames: [], monthKeys: a.months || [], year: a.year };
}

function drawHeaderBand(L, a, meta) {
  const { doc, S } = L;
  const W = doc.page.width;
  const bandH = 168;
  const period = periodInfoOf(a);

  // Background: deep navy with a soft diagonal accent for depth.
  doc.rect(0, 0, W, bandH).fill(C.brandDark);
  doc.save();
  doc.rect(0, 0, W, bandH).clip();
  doc.polygon([W * 0.58, 0], [W, 0], [W, bandH], [W * 0.46, bandH]).fillOpacity(0.10).fill('#ffffff').fillOpacity(1);
  doc.circle(W - 30, -20, 90).fillOpacity(0.08).fill('#38bdf8').fillOpacity(1);
  doc.restore();
  doc.rect(0, bandH, W, 4).fill(C.brand);

  // Brand block (left): logo tile, company name, report type, period label.
  const logoSize = 64;
  drawLogoTile(doc, L.left, 30, logoSize, meta.logoPath);
  const tx = L.left + logoSize + 16;
  doc.font('Bold').fontSize(17).fillColor('#ffffff').text(S(meta.companyName), tx, 32, { width: 280, lineBreak: false });
  doc.font('Body').fontSize(8.5).fillColor('#9fd3ee').text(S('PURE. SAFE. RELIABLE DRINKING WATER'), tx, 54, { width: 280, lineBreak: false, characterSpacing: 0.8 });
  doc.font('Body').fontSize(11).fillColor('#d6eefb').text(S(`${a.periodType === 'quarter' ? 'Quarterly' : 'Annual'} Business & Financial Report`), tx, 72, { width: 300, lineBreak: false });

  // Big period label.
  doc.font('Bold').fontSize(30).fillColor('#ffffff').text(S(a.label), L.left, 112, { width: 260, lineBreak: false });
  doc.font('Body').fontSize(9).fillColor('#9fd3ee').text(S(period.rangeText), L.left, 148, { width: 300, lineBreak: false });

  // Reporting-period card (right).
  const cardW = 212;
  const cardX = W - L.left - cardW;
  const cardY = 30;
  const cardH = 118;
  doc.roundedRect(cardX, cardY, cardW, cardH, 10).fillOpacity(0.12).fill('#ffffff').fillOpacity(1);
  doc.roundedRect(cardX, cardY, cardW, cardH, 10).lineWidth(0.6).strokeColor('#ffffff').opacity(0.28).stroke().opacity(1);
  doc.font('Bold').fontSize(7.5).fillColor('#9fd3ee').text(S('REPORTING PERIOD'), cardX + 14, cardY + 12, { width: cardW - 28, lineBreak: false, characterSpacing: 1.2 });
  doc.font('Bold').fontSize(10.5).fillColor('#ffffff').text(S(period.startText || period.rangeText), cardX + 14, cardY + 26, { width: cardW - 28, lineBreak: false });
  doc.font('Body').fontSize(8).fillColor('#9fd3ee').text(S('to'), cardX + 14, cardY + 40, { width: 20, lineBreak: false });
  doc.font('Bold').fontSize(10.5).fillColor('#ffffff').text(S(period.endText || ''), cardX + 14, cardY + 51, { width: cardW - 28, lineBreak: false });

  // 12-month strip: covered months lit, the rest dimmed, with month initials.
  const stripX = cardX + 14;
  const stripY = cardY + 76;
  const cell = (cardW - 28 - 11 * 3) / 12;
  const covered = new Set((period.monthKeys || []).map((m) => Number(m.slice(5, 7))));
  const initials = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  for (let i = 0; i < 12; i += 1) {
    const x = stripX + i * (cell + 3);
    const on = covered.has(i + 1);
    doc.roundedRect(x, stripY, cell, 20, 3).fillOpacity(on ? 1 : 0.14).fill(on ? '#38bdf8' : '#ffffff').fillOpacity(1);
    doc.font(on ? 'Bold' : 'Body').fontSize(7.5).fillColor(on ? C.brandDark : '#9fd3ee').text(initials[i], x, stripY + 6.5, { width: cell, align: 'center', lineBreak: false });
  }
  const monthLine = (period.monthNames || []).length <= 3 ? period.monthNames.join('  ·  ') : `${period.monthNames[0]} to ${period.monthNames[period.monthNames.length - 1]}`;
  doc.font('Body').fontSize(7.5).fillColor('#d6eefb').text(S(monthLine), cardX + 14, cardY + 102, { width: cardW - 28, lineBreak: false });

  const d = new Date(a.generatedAt);
  L.y = bandH + 22;
  if (a.partialYear) {
    L.callout(`Partial year: sales were recorded in ${a.operatingMonths.length} of the 12 months covered, so totals reflect a shorter operating history than the period shown.`, 'warn');
  }
  L.text(`Data as at ${d.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}   |   Prepared for: CEO and Management`, { size: 8, color: C.muted, after: 8 });
}

/* ── Plain-language building blocks ────────────────────────────── */

const TONE = {
  good: [C.goodTint, C.good],
  warn: [C.warnTint, C.warn],
  bad: [C.badTint, C.bad],
  neutral: [C.tint, C.muted],
};

// Green "In simple words" box that sits under a section title.
function simpleWords(L, text, label = 'In simple words') {
  const { doc, S } = L;
  const w = L.width - 26;
  doc.font('Body').fontSize(9);
  const h = doc.heightOfString(S(text), { width: w, lineGap: 1.5 }) + 28;
  L.ensure(h + 6);
  doc.roundedRect(L.left, L.y, L.width, h, 6).fill('#ecfdf5');
  doc.roundedRect(L.left, L.y, L.width, h, 6).lineWidth(0.6).strokeColor('#a7f3d0').stroke();
  doc.font('Bold').fontSize(7.5).fillColor(C.good).text(S(label.toUpperCase()), L.left + 12, L.y + 8, { width: w, lineBreak: false, characterSpacing: 0.8 });
  doc.font('Body').fontSize(9).fillColor(C.ink).text(S(text), L.left + 12, L.y + 20, { width: w, lineGap: 1.5 });
  L.y += h + 8;
}

function verdictBanner(L, plain) {
  const { doc, S } = L;
  const [bg, fg] = TONE[plain.verdict.tone] || TONE.neutral;
  const labelW = 138; // wide enough for "Needs attention" in DejaVu Sans Bold
  const textW = L.width - labelW - 34;
  doc.font('Body').fontSize(9.5);
  const th = doc.heightOfString(S(plain.verdict.sentence), { width: textW, lineGap: 1.5 });
  const h = Math.max(46, th + 22);
  L.ensure(h + 8);
  doc.roundedRect(L.left, L.y, L.width, h, 8).fill(bg);
  doc.rect(L.left, L.y, 4, h).fill(fg);
  doc.font('Body').fontSize(7).fillColor(fg).text(S('OVERALL HEALTH'), L.left + 16, L.y + 11, { width: labelW, lineBreak: false, characterSpacing: 0.8 });
  // Shrink the verdict label until it fits on ONE line inside the label column,
  // so longer verdicts (e.g. "Needs attention") sit as neatly as "Healthy".
  const verdictText = S(plain.verdict.label);
  let labelSize = 14;
  doc.font('Bold');
  while (labelSize > 9 && doc.fontSize(labelSize).widthOfString(verdictText) > labelW - 4) labelSize -= 0.5;
  doc.font('Bold').fontSize(labelSize).fillColor(fg).text(verdictText, L.left + 16, L.y + 22 + (14 - labelSize) / 2, { width: labelW, lineBreak: false });
  doc.font('Body').fontSize(9.5).fillColor(C.ink).text(S(plain.verdict.sentence), L.left + labelW + 24, L.y + (h - th) / 2, { width: textW, lineGap: 1.5 });
  L.y += h + 10;
}

function scorecard(L, items) {
  const { doc, S } = L;
  const qW = 178;
  const aW = 98;
  const dW = L.width - qW - aW;
  const headH = 18;
  const drawHead = () => {
    L.ensure(headH + 30);
    doc.rect(L.left, L.y, L.width, headH).fill(C.brand);
    doc.font('Bold').fontSize(8).fillColor('#ffffff');
    doc.text(S('Question'), L.left + 20, L.y + 5, { width: qW - 20, lineBreak: false });
    doc.text(S('Answer'), L.left + qW, L.y + 5, { width: aW, lineBreak: false });
    doc.text(S('What the numbers say'), L.left + qW + aW, L.y + 5, { width: dW - 6, lineBreak: false });
    L.y += headH;
  };
  drawHead();
  items.forEach((it, idx) => {
    doc.font('Body').fontSize(8.5);
    const dh = doc.heightOfString(S(it.detail), { width: dW - 10, lineGap: 1 });
    const qh = doc.heightOfString(S(it.question), { width: qW - 24, lineGap: 1 });
    const h = Math.max(dh, qh, 16) + 10;
    if (L.y + h > L.bottom) { L.newPage(); drawHead(); }
    const [bg, fg] = TONE[it.tone] || TONE.neutral;
    if (idx % 2 === 0) doc.rect(L.left, L.y, L.width, h).fill('#f8fbfe');
    doc.circle(L.left + 9, L.y + 11, 4).fill(fg);
    doc.font('Bold').fontSize(8.5).fillColor(C.ink).text(S(it.question), L.left + 20, L.y + 5, { width: qW - 24, lineGap: 1 });
    doc.roundedRect(L.left + qW, L.y + 4, aW - 10, 15, 7).fill(bg);
    doc.font('Bold').fontSize(7.5).fillColor(fg).text(S(it.answer), L.left + qW, L.y + 8, { width: aW - 10, align: 'center', lineBreak: false });
    doc.font('Body').fontSize(8.5).fillColor(C.body).text(S(it.detail), L.left + qW + aW, L.y + 5, { width: dW - 10, lineGap: 1 });
    doc.moveTo(L.left, L.y + h).lineTo(L.right, L.y + h).lineWidth(0.4).strokeColor(C.line).stroke();
    L.y += h;
  });
  L.y += 8;
}

const signedMoney = (v) => `${Number(v) > 0 ? '+' : ''}${money(v)}`;

const READING = {
  up: { text: 'Higher', color: C.good, bold: true },
  down: { text: 'Lower', color: C.bad, bold: true },
  flat: { text: 'About the same', color: C.ink },
  new: { text: 'New (no sales before)', color: C.brand },
  missing: { text: 'No sales this time', color: C.warn },
  none: { text: '-', color: C.faint },
};

// One side-by-side block: story, chart, month table, totals, quarters.
function comparisonBlock(L, a, set) {
  L.ensure(120);
  L.h2(set.title);
  if (!set.hasPrior) {
    L.callout(set.story[0], 'warn');
    return;
  }
  L.bullets(set.story);

  barChart(L, {
    title: `Sales each month: ${set.curLabel} (blue) against ${set.priorLabel} (light)`,
    labels: set.months.map((m) => m.label),
    series: [
      { name: set.priorLabel, color: '#b8d4e8', values: set.months.map((m) => m.priorRevenue) },
      { name: set.curLabel, color: C.brand, values: set.months.map((m) => m.curRevenue) },
    ],
    height: 150,
    valueLabels: false,
  });

  const rows = set.months.map((m) => {
    const r = READING[m.status] || READING.none;
    const diff = (m.status === 'none') ? '-' : signedMoney(m.change);
    return [
      m.label,
      m.curRevenue > 0 ? money(m.curRevenue) : '-',
      m.priorRevenue > 0 ? money(m.priorRevenue) : '-',
      diff,
      m.changePct === null ? 'n/a' : signedPct(m.changePct),
      { text: r.text, bold: !!r.bold, color: r.color },
    ];
  });
  rows.push([
    { text: 'Total', bold: true },
    { text: money(set.totals.revenue.cur), bold: true },
    { text: money(set.totals.revenue.prior), bold: true },
    { text: signedMoney(set.totals.revenue.change), bold: true, color: set.totals.revenue.change >= 0 ? C.good : C.bad },
    { text: set.totals.revenue.pct === null ? 'n/a' : signedPct(set.totals.revenue.pct), bold: true },
    { text: '', bold: false },
  ]);
  L.table(
    ['Month', set.curLabel, set.priorLabel, 'Difference', 'Change', 'Reading'],
    rows,
    [44, 90, 90, 90, 56, 110],
    { align: ['left', 'right', 'right', 'right', 'right', 'left'] },
  );
  L.text('"About the same" means the month moved by less than 5%. "New" means there were no sales in that month last time. "No sales this time" means sales stopped or the month has not happened yet.', { size: 7.5, color: C.muted });

  if (set.likeForLike.months && (set.totals.activeMonths.cur !== set.totals.activeMonths.prior)) {
    L.callout(`Fair comparison: only ${set.likeForLike.months} month(s) have sales on both sides. For those months, ${set.curLabel} made ${money(set.likeForLike.cur)} against ${money(set.likeForLike.prior)} (${set.likeForLike.pct === null ? 'n/a' : signedPct(set.likeForLike.pct)}).`, 'info');
  }

  const t = set.totals;
  L.table(
    ['At a glance', set.curLabel, set.priorLabel, 'Change'],
    [
      ['Sales (paid invoices)', money(t.revenue.cur), money(t.revenue.prior), t.revenue.pct === null ? signedMoney(t.revenue.change) : `${signedMoney(t.revenue.change)} (${signedPct(t.revenue.pct)})`],
      ['Bags sold', num(t.bags.cur), num(t.bags.prior), t.bags.pct === null ? 'n/a' : signedPct(t.bags.pct)],
      ['Average price per bag', t.avgPrice.cur === null ? 'n/a' : money(t.avgPrice.cur), t.avgPrice.prior === null ? 'n/a' : money(t.avgPrice.prior), t.avgPrice.pct === null ? 'n/a' : signedPct(t.avgPrice.pct)],
      ['Total costs', money(t.costs.cur), money(t.costs.prior), t.costs.pct === null ? signedMoney(t.costs.change) : `${signedMoney(t.costs.change)} (${signedPct(t.costs.pct)})`],
      [{ text: 'Profit after costs', bold: true }, { text: money(t.netProfit.cur), bold: true, color: t.netProfit.cur >= 0 ? C.good : C.bad }, { text: money(t.netProfit.prior), bold: true, color: t.netProfit.prior >= 0 ? C.good : C.bad }, { text: signedMoney(t.netProfit.change), bold: true, color: t.netProfit.change >= 0 ? C.good : C.bad }],
      ['Months with sales', String(t.activeMonths.cur), String(t.activeMonths.prior), ''],
    ],
    [170, 120, 120, 105],
    { align: ['left', 'right', 'right', 'right'] },
  );

  if (set.quarters && set.quarters.length && set.quarters.some((q) => q.cur > 0 || q.prior > 0)) {
    L.h2('Quarter by quarter');
    L.table(
      ['Quarter', set.curLabel, set.priorLabel, 'Change', 'Note'],
      set.quarters.map((q) => [
        q.label,
        q.cur > 0 ? money(q.cur) : '-',
        q.prior > 0 ? money(q.prior) : '-',
        q.pct === null ? 'n/a' : signedPct(q.pct),
        q.partial ? `Not a fair match: ${q.priorMonths} of 3 months had sales before, ${q.curMonths} of 3 now` : '',
      ]),
      [50, 100, 100, 60, 205],
      { align: ['left', 'right', 'right', 'right', 'left'], size: 8 },
    );
  }
}

/* ── Sections ──────────────────────────────────────────────────── */

function sectionSummary(L, a) {
  const pr = a.profitRoi;
  const rev = a.revenue;
  const pl = a.plain;
  const isQ = a.periodType === 'quarter';

  L.h1('Your report at a glance');
  verdictBanner(L, pl);

  L.tiles([
    { label: 'Money in (paid sales)', value: money(rev.totalRevenue), sub: pl.growth !== null ? `${signedPct(pl.growth)} vs ${pl.growthAgainst}` : `${a.collections.paidInvoiceCount} paid invoices`, color: C.brand },
    { label: 'Profit after all costs', value: money(pr.netProfit), sub: pr.netMargin === null ? '' : `${pct(pr.netMargin, 0)} of sales kept`, color: pr.netProfit >= 0 ? C.good : C.bad },
    { label: 'Return on what we own', value: pr.roiPercent === null ? 'n/a' : pct(pr.roiPercent), sub: pr.roiPercent === null ? 'No assets recorded' : `${pct(pr.roiAnnualisedPercent)} over a full year`, color: C.brand },
    { label: 'Sales swing month to month', value: pct(rev.coefficientOfVariation, 0), sub: rev.variabilityBand.replace(/ \(.*\)/, ''), color: rev.coefficientOfVariation >= 30 ? C.bad : rev.coefficientOfVariation >= 15 ? C.warn : C.good },
    { label: 'Future profit, worth today', value: money(a.npv.npv), sub: `Next ${a.npv.horizon} ${isQ ? 'quarters' : 'years'}, at ${pct(a.discountRateInfo.rate * 100, 0)} a year`, color: a.npv.npv >= 0 ? C.good : C.bad },
    { label: 'Left over per bag', value: a.unitEconomics.contributionPerBag === null ? 'n/a' : money(a.unitEconomics.contributionPerBag), sub: a.unitEconomics.price === null ? '' : `Sells ${money(a.unitEconomics.price)}, costs ${money(a.unitEconomics.variableCostPerBag)}`, color: C.brand },
  ]);

  L.callout(a.narrative.headline, pr.netProfit >= 0 ? 'good' : 'bad');

  L.h2('Health check in plain questions');
  scorecard(L, pl.scorecard);

  L.h2('What we found');
  L.bullets(a.narrative.findings);
  if (a.narrative.risks.length) {
    L.h2('Things to keep an eye on');
    L.bullets(a.narrative.risks, { color: C.bad });
  }
  L.text('Suggested actions and questions for the next meeting are near the end of the report. Section 2 compares this period with earlier ones, month by month.', { size: 8.5, color: C.muted });
}

function sectionRevenue(L, a) {
  L.ensure(330);
  L.h1('1. Sales: how much came in, and how steady it was', 'A "swing" measures how far months stray from the average month. Under 15% is steady, 15-30% is moderate, and above 30% is bumpy.');
  simpleWords(L, a.plain.sections.sales);

  const hist = a.series.filter((s) => s.hasActivity || a.months.includes(s.month)).slice(-14);
  const set = new Set(a.months);
  barChart(L, {
    title: 'Sales each month (this report\'s months in blue, earlier months greyed)',
    labels: hist.map((s) => s.label),
    series: [{ name: 'Sales', color: C.brand, values: hist.map((s) => s.revenue) }],
    highlight: new Set(hist.map((s, i) => (set.has(s.month) ? i : -1)).filter((i) => i >= 0)),
    height: 150,
  });

  if (a.revenue.weekly.length >= 3) {
    lineChart(L, {
      title: 'Sales each week (weeks start on Monday)',
      labels: a.revenue.weekly.map((w) => w.weekStart.slice(5)),
      series: [{ name: 'Weekly sales', color: C.brand, values: a.revenue.weekly.map((w) => w.revenue) }],
      height: 125,
      bandLine: a.revenue.weekly.length ? a.revenue.weekly.reduce((s, w) => s + w.revenue, 0) / a.revenue.weekly.length : null,
    });
    L.text('The dashed line is the average week.', { size: 7.5, color: C.muted, after: 4 });
  }

  L.table(
    ['Month', 'Sales', 'Bags sold', 'Average price', 'Days with sales', 'Buyers', 'Biggest buyer'],
    a.periodSeries.map((s) => [s.label, money(s.revenue), num(s.bags), s.avgPrice === null ? 'n/a' : money(s.avgPrice), String(s.tradingDays), String(s.activeCustomers), s.topCustomer ? `${s.topCustomer.name} (${pct(s.topCustomer.share, 0)})` : 'n/a']),
    [64, 82, 58, 64, 56, 44, 120],
    { align: ['left', 'right', 'right', 'right', 'right', 'right', 'left'] },
  );

  const r = a.revenue;
  L.kv([
    ['Average sales in a month', money(r.mean)],
    ['Usual distance from that average', money(r.stdDev)],
    ['Sales swing (as % of the average)', pct(r.coefficientOfVariation), r.coefficientOfVariation >= 30 ? C.bad : r.coefficientOfVariation >= 15 ? C.warn : C.good],
    ['Best month vs weakest month (gap as % of an average month)', pct(r.rangePctOfMean)],
    ['Day-to-day swing', r.daily.cv === null ? 'n/a' : `${pct(r.daily.cv)} over ${r.daily.tradingDays} days with sales`],
    ['Week-to-week swing', pct(r.weeklyCv)],
    ['Our rating', r.variabilityBand],
  ], { labelWidth: 270 });

  if (a.comparison && a.comparison.volumeEffect !== null) {
    const c = a.comparison;
    L.h2(`Why sales changed since ${a.previousLabel}: more bags, or a better price?`);
    L.kv([
      ['Sales per active month', `${signedPct(c.revenueGrowthPerMonthPct)}`],
      ['Bags sold per active month', signedPct(c.bagsGrowthPerMonthPct)],
      ['Price per bag', `${signedPct(c.priceChangePct)}  (${money(c.previousAvgPrice)} to ${money(a.unitEconomics.price)})`],
      ['Effect of selling more or fewer bags', signedMoney(c.volumeEffect), c.volumeEffect >= 0 ? C.good : C.bad],
      ['Effect of a higher or lower price', signedMoney(c.priceEffect), c.priceEffect >= 0 ? C.good : C.bad],
    ], { labelWidth: 270 });
  }

  const wd = a.revenue.weekday;
  if (wd.some((d) => d.revenue > 0)) {
    barChart(L, {
      title: 'Which days of the week bring in the most sales',
      labels: wd.map((d) => d.label),
      series: [{ name: 'Sales', color: '#5aa9d6', values: wd.map((d) => d.revenue) }],
      height: 110,
    });
  }
}

function sectionCompare(L, a) {
  const isAnnual = a.periodType === 'year';
  L.ensure(300);
  L.h1(
    isAnnual ? '2. This year against last year, month by month' : '2. Compared with earlier periods',
    isAnnual
      ? 'Each month of this year is placed next to the same month last year, so you can see where we gained and where we slipped.'
      : 'Each month is placed next to the matching month of the quarter before, and of the same quarter last year (which is a fairer test because the weather repeats each year).',
  );
  const intro = (a.compareSets || []).find((s) => s.hasPrior);
  if (intro) {
    simpleWords(L, isAnnual
      ? `Comparing years is the fairest test of whether the business is really growing, because it removes the effect of the seasons. Where last year has fewer months of sales than this year, we also show a like-for-like total that uses only the months present in both.`
      : `Comparing with the quarter before shows the latest direction, but seasons can distort it. Comparing with the same quarter last year removes the seasons, so it is the better test of real growth.`);
  }
  (a.compareSets || []).forEach((set) => comparisonBlock(L, a, set));
}

function sectionSeasonality(L, a) {
  L.ensure(300);
  L.h1('3. Seasons: why some months are high and some are low', 'Weather and holidays make some months busy and others slow. That is not the same as the business doing better or worse.');
  simpleWords(L, a.plain.sections.seasons);
  L.callout(a.narrative.seasonalText, 'info');

  L.table(
    ['Month', 'Season', 'Weather usually means', 'Sales', 'Change on last month', 'Did sales follow the season?', 'Index*', 'Verdict'],
    a.seasonality.months.map((m) => [
      m.label,
      m.season,
      m.expected === 'up' ? 'More sales' : 'Fewer sales',
      money(m.revenue),
      m.momPct === null ? 'n/a' : `${signedPct(m.momPct)}${m.momBasis === 'per trading day' ? '†' : ''}`,
      m.agreesWithSeason === null ? (m.momPct === null ? 'n/a' : 'Neutral') : m.agreesWithSeason ? { text: 'Yes', bold: true, color: C.good } : { text: 'No', bold: true, color: C.bad },
      m.index === null ? 'n/a' : m.index.toFixed(0),
      { text: m.status === 'low' ? 'LOW' : m.status === 'high' ? 'HIGH' : 'Normal', bold: m.status !== 'normal', color: m.status === 'low' ? C.bad : m.status === 'high' ? C.good : C.ink },
    ]),
    [42, 80, 56, 74, 54, 50, 40, 58],
    { align: ['left', 'left', 'left', 'right', 'right', 'left', 'right', 'left'], size: 8 },
  );
  L.text('*Index: 100 is an average month of this report. Below 85 is marked LOW and above 115 is marked HIGH. "Did sales follow the season?" checks whether sales moved the way the season would suggest (moves under 5% count as neutral). †Compared per day with sales, because the two months had very different numbers of selling days.', { size: 7.5, color: C.muted });

  const flagged = a.seasonality.months.filter((m) => m.status !== 'normal');
  if (flagged.length) {
    L.h2('Why some months stand out');
    flagged.forEach((m) => {
      L.text(`${m.label}: ${m.status === 'low' ? 'below' : 'above'} the average month (index ${m.index === null ? 'n/a' : m.index.toFixed(0)})`, { font: 'Bold', size: 9.5, color: m.status === 'low' ? C.bad : C.good, after: 1 });
      L.bullets(m.reasons, { size: 9 });
    });
  } else {
    L.text('No month was more than 15% away from the average month, so no single month needs a special explanation.', { after: 6 });
  }

  L.h2('What each month of the year usually does to sales');
  L.table(
    ['Month', 'Season', 'Sales', 'Why, and what is happening'],
    a.seasonality.calendar.map((c) => [c.name, c.season, c.expected === 'up' ? 'Up' : 'Down', `${c.why} ${c.events || ''}`.trim()]),
    [36, 104, 40, 348],
    { size: 7.5 },
  );
}

function sectionProfitability(L, a) {
  L.ensure(420);
  L.h1('4. Profit: what was left after paying for everything', 'Profit is sales minus every cost. Return on assets tells you how well the things the company owns (machines, vehicles and so on) are working for you.');
  simpleWords(L, a.plain.sections.profit);
  const pr = a.profitRoi;
  const revTotal = a.revenue.totalRevenue;
  L.table(
    ['Money in and money out', 'Amount', '% of sales'],
    [
      ['Sales (paid invoices)', money(revTotal), '100.0%'],
      ['Cost of making the water (production)', money(-pr.cogs), pct(revTotal ? (pr.cogs / revTotal) * 100 : null)],
      [{ text: 'Left after making the water', bold: true }, { text: money(pr.grossProfit), bold: true }, { text: pct(pr.grossMargin), bold: true }],
      ['Running costs (salaries, utilities, rent and so on)', money(-pr.operatingExpenses), pct(revTotal ? (pr.operatingExpenses / revTotal) * 100 : null)],
      [{ text: 'Left after running costs', bold: true }, { text: money(pr.operatingProfit), bold: true }, { text: pct(revTotal ? (pr.operatingProfit / revTotal) * 100 : null), bold: true }],
      ['Free promotional bags (valued at the selling price)', money(-a.revenue.promoExpense), pct(revTotal ? (a.revenue.promoExpense / revTotal) * 100 : null)],
      [{ text: 'Final profit', bold: true, color: pr.netProfit >= 0 ? C.good : C.bad }, { text: money(pr.netProfit), bold: true, color: pr.netProfit >= 0 ? C.good : C.bad }, { text: pct(pr.netMargin), bold: true }],
    ],
    [270, 120, 100],
    { align: ['left', 'right', 'right'] },
  );

  if (pr.accounts.length) {
    horizontalBars(L, {
      title: 'Where the money went (costs by account)',
      items: pr.accounts.slice(0, 8).map((x, i) => ({ label: `${x.account}${x.variable ? ' (rises with sales)' : ' (fixed)'}`, value: x.amount, color: C.bars[i % C.bars.length], note: pr.totalCosts ? pct((x.amount / pr.totalCosts) * 100, 0) : '' })),
    });
  }

  L.h2('Return on what the company owns');
  L.kv([
    ['Value of assets recorded (what the company owns)', pr.totalAssets ? money(pr.totalAssets) : 'None recorded'],
    ['Profit earned on those assets in this period (ROI)', pr.roiPercent === null ? 'n/a' : pct(pr.roiPercent)],
    ['Same, if this pace lasted a full year (simple estimate)', pr.roiAnnualisedPercent === null ? 'n/a' : pct(pr.roiAnnualisedPercent)],
    ['Profit kept from every GH₵100 sold', pr.netMargin === null ? 'n/a' : money(pr.netMargin)],
    ['Sales made for every GH₵1 of assets', pr.assetTurnover === null ? 'n/a' : `${pr.assetTurnover.toFixed(2)} times`],
    ['Profit for every GH₵100 spent on costs', pr.returnOnCostPercent === null ? 'n/a' : money(pr.returnOnCostPercent)],
  ], { labelWidth: 290 });

  const ue = a.unitEconomics;
  L.h2('The cost of one bag, and the break-even point');
  L.kv([
    ['Selling price per bag', ue.price === null ? 'n/a' : money(ue.price)],
    ['Materials, fuel and delivery per bag (rises with each bag)', ue.variableCostPerBag === null ? 'n/a' : money(ue.variableCostPerBag)],
    ['Left over per bag', ue.contributionPerBag === null ? 'n/a' : `${money(ue.contributionPerBag)} (${pct(ue.contributionMarginPct, 0)} of the price)`, ue.contributionPerBag > 0 ? C.good : C.bad],
    ['Full cost per bag (including salaries, rent and so on)', ue.averageTotalCostPerBag === null ? 'n/a' : money(ue.averageTotalCostPerBag)],
    ['Costs that stay the same however much we sell', money(pr.fixedCosts)],
    ['Break-even: bags we must sell just to cover all costs', ue.breakEvenBags === null ? 'n/a' : `${num(ue.breakEvenBags)} bags`],
    ['Bags actually sold (paid)', num(ue.bags)],
    ['Safety cushion: how far sales can fall before profit reaches zero', ue.marginOfSafetyPct === null ? 'n/a' : pct(ue.marginOfSafetyPct)],
    ['If sales change by 1%, profit changes by about', ue.operatingLeverage === null ? 'n/a' : pct(ue.operatingLeverage, 1)],
  ], { labelWidth: 320 });
  L.text('How costs are sorted: accounts in the ledger with words like production, materials, packaging, film, cartons, fuel, transport, delivery or commission are treated as costs that rise with each bag. Everything else (salaries, utilities, rent) is treated as fixed.', { size: 7.5, color: C.muted });
}

function sectionMarginal(L, a) {
  L.ensure(300);
  L.h1('5. What one more bag adds', 'Should we push to sell more? Yes, as long as each extra bag earns more than it costs us to make and deliver.');
  simpleWords(L, a.plain.sections.perBag);
  const m = a.marginal;
  const ue = a.unitEconomics;
  barChart(L, {
    title: 'Per bag: what we earn against what we spend (GH₵)',
    labels: ['Selling price', 'Extra cost of one more bag', 'Full average cost'],
    series: [{ name: 'GH₵ per bag', color: C.brand, values: [ue.price || 0, ue.variableCostPerBag || 0, ue.averageTotalCostPerBag || 0] }],
    height: 105,
    legend: false,
  });
  L.kv([
    ['Extra money from one more bag (its price)', ue.price === null ? 'n/a' : money(ue.price)],
    ['Extra cost of one more bag', ue.variableCostPerBag === null ? 'n/a' : money(ue.variableCostPerBag)],
    ['Extra benefit from one more bag', ue.contributionPerBag === null ? 'n/a' : money(ue.contributionPerBag), ue.contributionPerBag > 0 ? C.good : C.bad],
    [`Same, measured from ${m.observations} months of real figures (sales)`, m.empiricalMarginalRevenue === null ? 'n/a' : `${money(m.empiricalMarginalRevenue)} per bag (fit ${m.revenueR2})`],
    ['Same, measured from real figures (costs)', m.empiricalMarginalCost === null ? 'n/a' : `${money(m.empiricalMarginalCost)} per bag (fit ${m.costR2})${m.empiricalReliable ? '' : ', low confidence'}`],
  ], { labelWidth: 290 });
  L.callout(m.verdict, ue.contributionPerBag !== null && ue.contributionPerBag > 0 ? 'good' : 'warn');
  L.text('"Fit" runs from 0 to 1. The closer to 1, the more the months line up neatly, and the more we can trust the number.', { size: 7.5, color: C.muted });
}

function sectionPortfolio(L, a) {
  L.ensure(420);
  L.h1('6. Our customers', 'Who buys the most, who is growing, and how much we depend on a few names.');
  simpleWords(L, a.plain.sections.customers);
  L.callout(a.narrative.bcgText, 'info');
  if (a.portfolio.rows.length) {
    bcgChart(L, a.portfolio);
    L.table(
      ['#', 'Customer', 'Paid us', 'Bags', 'Share of sales', `Change vs ${a.previousLabel}`, 'Group'],
      a.portfolio.rows.map((r, i) => [String(i + 1), r.customer, money(r.revenue), num(r.bags), pct(r.share), r.growth === null ? 'New buyer' : signedPct(r.growth), r.quadrant]),
      [22, 98, 80, 50, 55, 85, 85],
      { align: ['left', 'left', 'right', 'right', 'right', 'right', 'left'] },
    );
    L.text('Star = big and growing: keep investing. Cash Cow = big but steady: protect it. Question Mark = small but growing: nurture it. Dog = small and not growing: serve it cheaply, or let it go.', { size: 8, color: C.muted });
  }
  const p = a.portfolio;
  L.h2('How much do we depend on a few buyers?');
  L.kv([
    ['Biggest customer, as % of sales', pct(p.top1Share)],
    ['Top three customers together', pct(p.top3Share)],
    ['Dependence score (0 to 10,000; above 2,500 is high)', `${p.hhi}: ${p.concentrationBand}`, p.hhi >= 2500 ? C.bad : p.hhi >= 1500 ? C.warn : C.good],
    ['Walk-in and unnamed buyers', p.walkIn ? `${money(p.walkIn.revenue)} (${pct(p.walkIn.share)})` : 'None'],
    ['Named customers this period', String(p.namedCustomerCount)],
  ], { labelWidth: 290 });
  if (p.lostCustomers.length) {
    L.h2(`Customers who bought in ${a.previousLabel} but not this time`);
    L.table(['Customer', `Paid us in ${a.previousLabel}`], p.lostCustomers.map((c) => [c.customer, money(c.priorRevenue)]), [220, 140], { align: ['left', 'right'] });
  }
}

function sectionSupplyDemand(L, a) {
  L.ensure(230);
  L.h1('7. Bags made against bags ordered', 'Ordered = bags on invoices (leaving out cancelled and unapproved ones). Made = bags produced, taken from the daily production log, Inventory, or completed batches, whichever is most complete for each month.');
  simpleWords(L, a.plain.sections.supply);
  const ds = a.demandSupply;
  const months = a.months.filter((m) => a.periodSeries.some((s) => s.month === m));
  barChart(L, {
    title: 'Bags made against bags ordered',
    labels: months.map((m) => a.periodSeries.find((s) => s.month === m).label),
    series: [
      { name: 'Made', color: '#22c55e', values: months.map((m) => ds.monthly.find((x) => x.month === m)?.supply || 0) },
      { name: 'Ordered', color: C.brand, values: months.map((m) => a.periodSeries.find((s) => s.month === m).billedBags) },
    ],
    money: false,
    height: 140,
  });
  L.kv([
    ['Bags made', ds.recorded ? num(ds.supplyBags) : 'Not recorded'],
    ['Bags ordered', num(ds.demandBags)],
    ['Share of what we made that customers ordered', ds.sellThroughRate === null ? 'n/a' : pct(ds.sellThroughRate)],
    ['Change in stock (made minus ordered)', ds.netStockMovement === null ? 'n/a' : `${ds.netStockMovement >= 0 ? '+' : ''}${num(ds.netStockMovement)} bags`],
    ['Where the production figures came from', ds.sourceNames.length ? ds.sourceNames.join('; ') : 'None'],
  ], { labelWidth: 290 });
  L.callout(ds.condition, ds.recorded ? 'info' : 'warn');
  const c = a.collections;
  L.h2('Getting paid');
  L.kv([
    ['Total billed (all valid invoices)', money(c.billed)],
    ['Paid so far', money(c.paid)],
    ['Still owed to us', money(c.outstanding), c.outstanding > 0 ? C.warn : C.good],
    ['Share of billing that has been paid', pct(c.efficiencyPct)],
  ], { labelWidth: 290 });
}

/* ── Bags section: smooth curves ───────────────────────────────── */

// Draws a smooth curve through a run of points. Control points are kept inside
// the vertical range of each segment, so the curve never swings below zero or
// above a real value (no overshoot), which keeps it honest.
function smoothPath(doc, pts, baseY) {
  const area = baseY !== undefined && baseY !== null;
  if (area) { doc.moveTo(pts[0].x, baseY); doc.lineTo(pts[0].x, pts[0].y); } else doc.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const lo = Math.min(p1.y, p2.y);
    const hi = Math.max(p1.y, p2.y);
    const c1y = Math.min(hi, Math.max(lo, p1.y + (p2.y - p0.y) / 6));
    const c2y = Math.min(hi, Math.max(lo, p2.y - (p3.y - p1.y) / 6));
    const c1x = Math.min(p2.x, Math.max(p1.x, p1.x + (p2.x - p0.x) / 6));
    const c2x = Math.min(p2.x, Math.max(p1.x, p2.x - (p3.x - p1.x) / 6));
    doc.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
  if (area) { doc.lineTo(pts[pts.length - 1].x, baseY); doc.closePath(); }
}

function runsOf(values, xOf, yOf) {
  const runs = [];
  let cur = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined) { if (cur.length) runs.push(cur); cur = []; return; }
    cur.push({ x: xOf(i), y: yOf(v), v, i });
  });
  if (cur.length) runs.push(cur);
  return runs;
}

// Smooth multi-curve chart. series: [{name,color,values[],width,dash,dots,area,labels:'above'|'below'|false}]
// inBand: Set of indexes (this report's months) to shade. Gaps (null) break the line.
function curveChart(L, { title, labels, series, height = 150, inBand = null }) {
  const { doc, S } = L;
  const live = series.filter((s) => s.values.some((v) => v !== null && v !== undefined));
  const f = chartFrame(L, title, height);
  const padL = 46;
  const padB = 22;
  const padT = 10;
  const cx = f.x + padL;
  const cw = f.w - padL - 8;
  const ch = f.h - padB - padT;
  const all = live.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
  const maxV = niceMax(Math.max(1, ...all));
  const n = labels.length;
  const step = cw / n;
  const xOf = (i) => cx + (i + 0.5) * step;
  const yOf = (v) => f.y + padT + ch - (Math.max(0, v) / maxV) * ch;

  if (inBand && inBand.size) {
    const idx = [...inBand].sort((a, b) => a - b);
    const x0 = cx + idx[0] * step;
    const x1 = cx + (idx[idx.length - 1] + 1) * step;
    doc.rect(x0, f.y + padT, x1 - x0, ch).fill('#eaf4fb');
  }
  for (let i = 0; i <= 4; i += 1) {
    const gy = f.y + padT + ch - (ch * i) / 4;
    doc.moveTo(cx, gy).lineTo(cx + cw, gy).lineWidth(0.4).strokeColor(C.line).stroke();
    doc.font('Body').fontSize(7).fillColor(C.muted).text(S(num(Math.round((maxV * i) / 4))), f.x, gy - 4, { width: padL - 5, align: 'right', lineBreak: false });
  }

  live.forEach((s) => {
    const runs = runsOf(s.values, xOf, yOf);
    if (s.area) {
      runs.filter((r) => r.length > 1).forEach((r) => {
        doc.save();
        doc.fillOpacity(0.1);
        smoothPath(doc, r, f.y + padT + ch);
        doc.fill(s.color);
        doc.restore();
      });
    }
    runs.forEach((r) => {
      if (r.length > 1) {
        smoothPath(doc, r);
        if (s.dash) doc.dash(s.dash, { space: s.dash }); else doc.undash();
        doc.lineWidth(s.width || 1.8).strokeColor(s.color).stroke();
        doc.undash();
      }
      if (s.dots !== false) r.forEach((pt) => doc.circle(pt.x, pt.y, 2.2).fill(s.color));
    });
    if (s.labels) {
      runs.flat().filter((pt) => !inBand || inBand.has(pt.i)).forEach((pt) => {
        const ty = s.labels === 'below' ? pt.y + 4 : pt.y - 10;
        doc.font('Bold').fontSize(6.5).fillColor(s.color).text(S(num(Math.round(pt.v))), pt.x - 22, ty, { width: 44, align: 'center', lineBreak: false });
      });
    }
  });

  const every = Math.max(1, Math.ceil(n / 12));
  labels.forEach((lab, i) => {
    if (i % every !== 0) return;
    doc.font('Body').fontSize(6.8).fillColor(inBand && inBand.has(i) ? C.brandDark : C.muted).text(S(lab), xOf(i) - 22, f.y + padT + ch + 6, { width: 44, align: 'center', lineBreak: false });
  });
  L.y = f.y + f.h + 2;
  if (live.length > 1) legendRow(L, live.map((s) => ({ name: s.name, color: s.color })));
  L.y += 6;
}

// Bars that can go above and below zero (stock built up / drawn down).
function signedBarChart(L, { title, labels, values, height = 120, inBand = null, posColor = '#22c55e', negColor = '#ef4444' }) {
  const { doc, S } = L;
  const f = chartFrame(L, title, height);
  const padL = 46;
  const padB = 22;
  const padT = 10;
  const cx = f.x + padL;
  const cw = f.w - padL - 8;
  const ch = f.h - padB - padT;
  const real = values.filter((v) => v !== null && v !== undefined);
  const maxAbs = niceMax(Math.max(1, ...real.map((v) => Math.abs(v))));
  const zeroY = f.y + padT + ch / 2;
  const half = ch / 2;
  const n = labels.length;
  const step = cw / n;
  const barW = Math.min(30, step * 0.6);
  [-1, -0.5, 0, 0.5, 1].forEach((k) => {
    const gy = zeroY - k * half;
    doc.moveTo(cx, gy).lineTo(cx + cw, gy).lineWidth(k === 0 ? 0.8 : 0.4).strokeColor(k === 0 ? C.faint : C.line).stroke();
    doc.font('Body').fontSize(7).fillColor(C.muted).text(S(`${k > 0 ? '+' : ''}${num(Math.round(maxAbs * k))}`), f.x, gy - 4, { width: padL - 5, align: 'right', lineBreak: false });
  });
  values.forEach((v, i) => {
    const mid = cx + (i + 0.5) * step;
    if (v !== null && v !== undefined) {
      const bh = (Math.abs(v) / maxAbs) * half;
      const bright = !inBand || inBand.has(i);
      doc.save();
      doc.fillOpacity(bright ? 1 : 0.4);
      doc.rect(mid - barW / 2, v >= 0 ? zeroY - bh : zeroY, barW, Math.max(0.5, bh)).fill(v >= 0 ? posColor : negColor);
      doc.restore();
      if (bright) {
        const ty = v >= 0 ? zeroY - bh - 9 : zeroY + bh + 2;
        doc.font('Bold').fontSize(6.5).fillColor(v >= 0 ? C.good : C.bad).text(S(`${v > 0 ? '+' : ''}${num(Math.round(v))}`), mid - 24, ty, { width: 48, align: 'center', lineBreak: false });
      }
    }
    const every = Math.max(1, Math.ceil(n / 12));
    if (i % every === 0) doc.font('Body').fontSize(6.8).fillColor(inBand && inBand.has(i) ? C.brandDark : C.muted).text(S(labels[i]), mid - 22, f.y + padT + ch + 6, { width: 44, align: 'center', lineBreak: false });
  });
  L.y = f.y + f.h + 2;
  legendRow(L, [{ name: 'More made than went out (stock builds)', color: posColor }, { name: 'More went out than was made (stock falls)', color: negColor }]);
  L.y += 6;
}

const signedNum = (v) => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${num(Math.round(v))}`);

function sectionBags(L, a) {
  const b = a.bags;
  if (!b || !b.window || !b.window.length) return;
  L.ensure(330);
  L.h1('8. Bags: made, sold and given away', 'Sold = bags on paid invoices. Promo = free bags given on those invoices, counted separately from sold. Made = production records. Shaded months belong to this report.');
  simpleWords(L, b.reading.slice(0, 2).join(' '));

  const p = b.period;
  L.tiles([
    { label: 'Bags made', value: b.producedRecorded ? num(p.made) : 'Not recorded', sub: b.producedRecorded ? 'From production records' : 'Add finished products in Inventory', color: '#22c55e' },
    { label: 'Bags sold (paid)', value: num(p.sold), sub: p.sellThroughPct === null ? '' : `${pct(p.sellThroughPct, 0)} of bags made`, color: C.brand },
    { label: 'Promo bags (free)', value: num(p.promo), sub: p.promoPer100Sold === null ? '' : `${p.promoPer100Sold.toFixed(1)} per 100 bags sold`, color: '#f59e0b' },
    { label: 'Total that left', value: num(p.dispatched), sub: 'Sold plus promo', color: C.brandDark },
    { label: 'Promo share', value: p.promoSharePct === null ? 'n/a' : pct(p.promoSharePct, 1), sub: 'Of all bags that left', color: '#f59e0b' },
    { label: 'Stock gap', value: p.gap === null ? 'n/a' : signedNum(p.gap), sub: p.gap === null ? 'Needs production records' : p.gap >= 0 ? 'Made more than went out' : 'Went out more than made', color: p.gap === null ? C.faint : p.gap >= 0 ? C.good : C.bad },
  ]);

  const labels = b.window.map((r) => r.label);
  const band = new Set(b.window.map((r, i) => (r.inPeriod ? i : -1)).filter((i) => i >= 0));
  const col = (key) => b.window.map((r) => r[key]);

  curveChart(L, {
    title: 'Bags made, sold and given away, month by month',
    labels,
    inBand: band,
    height: 165,
    series: [
      { name: 'Made', color: '#22c55e', values: col('made'), area: true, labels: 'above' },
      { name: 'Sold (paid)', color: C.brand, values: col('sold'), area: true, labels: 'below' },
      { name: 'Promo (free)', color: '#f59e0b', values: col('promo'), labels: 'above' },
    ],
  });
  L.text('All three curves share one scale, so you can see how small the promo giveaway is next to production and sales.', { size: 7.5, color: C.muted, after: 4 });

  curveChart(L, {
    title: 'The direction of travel: 3-month average and trend line',
    labels,
    inBand: band,
    height: 150,
    series: [
      { name: 'Made (3-month average)', color: '#22c55e', values: col('maMade'), width: 2.2, dots: false },
      { name: 'Made (trend line)', color: '#22c55e', values: col('trendMade'), width: 1.2, dash: 3, dots: false },
      { name: 'Sold (3-month average)', color: C.brand, values: col('maSold'), width: 2.2, dots: false },
      { name: 'Sold (trend line)', color: C.brand, values: col('trendSold'), width: 1.2, dash: 3, dots: false },
    ],
  });
  L.text('The 3-month average smooths out one-off busy or slow weeks. The dashed trend line is the straight line that best fits all the months shown, so its slope is the overall direction.', { size: 7.5, color: C.muted, after: 4 });

  curveChart(L, {
    title: 'Promo (free) bags on their own scale',
    labels,
    inBand: band,
    height: 125,
    series: [
      { name: 'Promo bags', color: '#f59e0b', values: col('promo'), area: true, labels: 'above' },
      { name: 'Promo (3-month average)', color: '#b45309', values: col('maPromo'), width: 1.4, dash: 3, dots: false },
    ],
  });

  if (b.producedRecorded) {
    signedBarChart(L, { title: 'Stock gap each month (bags made minus bags sold minus promo)', labels, values: col('gap'), inBand: band, height: 125 });
  }

  L.h2('Month by month');
  const rows = b.periodRows.map((r) => [
    r.label,
    r.made === null ? 'n/r' : num(r.made),
    num(r.sold),
    num(r.promo),
    r.gap === null ? 'n/a' : signedNum(r.gap),
    r.sellThroughPct === null ? 'n/a' : pct(r.sellThroughPct, 0),
    r.promoPer100Sold === null ? 'n/a' : r.promoPer100Sold.toFixed(1),
  ]);
  rows.push([
    { text: 'Total', bold: true }, { text: b.producedRecorded ? num(p.made) : 'n/r', bold: true }, { text: num(p.sold), bold: true }, { text: num(p.promo), bold: true },
    { text: p.gap === null ? 'n/a' : signedNum(p.gap), bold: true }, { text: p.sellThroughPct === null ? 'n/a' : pct(p.sellThroughPct, 0), bold: true }, { text: p.promoPer100Sold === null ? 'n/a' : p.promoPer100Sold.toFixed(1), bold: true },
  ]);
  L.table(
    ['Month', 'Made', 'Sold', 'Promo', 'Stock gap', 'Sold as % of made', 'Promo per 100 sold'],
    rows,
    [80, 62, 62, 56, 64, 80, 80],
    { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] },
  );
  L.text('n/r = production not recorded for that month. n/a = cannot be worked out without it.', { size: 7.5, color: C.muted, after: 4 });

  const cmpRows = [];
  [b.vsPrevious, b.vsYearAgo].forEach((c) => {
    if (!c) return;
    [['Bags made', c.made], ['Bags sold', c.sold], ['Promo bags', c.promo]].forEach(([name, v]) => {
      if (name === 'Bags made' && !b.producedRecorded) return;
      cmpRows.push([`${name} vs ${c.label}`, num(v.cur), num(v.prior), signedNum(v.change), v.pct === null ? 'n/a' : signedPct(v.pct)]);
    });
  });
  if (cmpRows.length) {
    L.h2('Compared with earlier periods');
    L.table(['Measure', 'This report', 'Earlier', 'Change', 'Change %'], cmpRows, [200, 80, 80, 80, 70], { align: ['left', 'right', 'right', 'right', 'right'] });
  }

  L.h2('What the curves tell us');
  L.bullets(b.reading);
}

function sectionNpv(L, a) {
  L.ensure(400);
  const isQ = a.periodType === 'quarter';
  L.h1('9. What future profit is worth today', 'A cedi received next year is worth a bit less than a cedi in your hand today. This section shrinks expected future profit to its value today, so different years can be compared fairly.');
  simpleWords(L, a.plain.sections.future);
  L.callout(a.narrative.npvText, 'info');
  L.kv([
    ['Rate used to shrink future money (benchmark)', a.discountRateInfo.benchmark],
    ['Yearly rate used', pct(a.discountRateInfo.rate * 100)],
    ['Where the rate came from, and date', `${a.discountRateInfo.source}, ${String(a.discountRateInfo.asOf).slice(0, 10)}`],
    [`Same rate, per ${isQ ? 'quarter' : 'year'}`, pct(a.npv.periodicDiscountRate)],
    [`Profit growth assumed per ${isQ ? 'quarter' : 'year'}`, `${pct(a.npv.assumedGrowthPerPeriod)} (recent change was ${pct(a.npv.trailingGrowthRaw)}, kept within safe limits)`],
    ['Starting point (profit of this period)', money(a.profitRoi.netProfit)],
  ], { labelWidth: 270 });

  L.table(
    [isQ ? 'Future quarter' : 'Future year', 'Expected profit (if trend continues)', 'Worth today'],
    a.npv.projectedCashFlows.map((f) => [`+${f.period}`, money(f.projectedCashFlow), money(f.discountedValue)]),
    [130, 170, 170],
    { align: ['left', 'right', 'right'] },
  );

  L.h2('Three possible futures');
  const nameOf = { Downside: 'Profit falls', 'Flat (no growth)': 'Profit stays the same', Trend: 'Profit follows the recent trend' };
  L.table(
    ['What happens', `Change in profit per ${isQ ? 'quarter' : 'year'}`, 'Worth today'],
    a.npv.scenarios.map((s) => [nameOf[s.name] || s.name, pct(s.growthPerPeriod), { text: money(s.npv), bold: true, color: s.npv >= 0 ? C.good : C.bad }]),
    [200, 140, 130],
    { align: ['left', 'right', 'right'] },
  );
  L.h2('What if the yearly rate were different? (profit stays the same)');
  L.table(
    ['Yearly rate', 'Worth today'],
    a.npv.sensitivity.map((s) => [pct(s.rate), money(s.npvFlat)]),
    [200, 170],
    { align: ['left', 'right'] },
  );
  L.text('Please note: this looks at ongoing profit only. It does not subtract any starting investment, and it treats profit as if it were cash in the bank (it ignores the timing of payments, tax and big purchases). It is a rough guide to value and not a price for selling the business.', { size: 8, color: C.muted });
}

function sectionAnalyst(L, a) {
  L.ensure(400);
  L.h1('10. Looking ahead, and what to do next', 'Our best guess for the next period, the main risks, and practical steps. All guesses come from a short history, so treat them as a guide.');
  const o = a.outlook;
  L.callout(a.narrative.outlookText, 'info');
  if (o) {
    L.table(
      [`Sales expected for ${o.label}`, 'Estimate'],
      [
        ['If we carry on at the recent pace', money(o.runRate)],
        ['If we follow the recent trend line', o.trend === null ? 'n/a (needs 4+ months of sales)' : money(o.trend)],
        ['Adjustment for the season', `${o.seasonalFactor.toFixed(2)} times`],
        [{ text: 'Our best estimate', bold: true }, { text: money(o.seasonAdjusted), bold: true }],
        ['Likely range: low end', money(o.low)],
        ['Likely range: high end', money(o.high)],
      ],
      [300, 170],
      { align: ['left', 'right'] },
    );
    const hist = a.series.filter((s) => s.hasActivity).slice(-9);
    lineChart(L, {
      title: 'Recent monthly sales, and where they may go next (monthly equivalent)',
      labels: [...hist.map((s) => s.label), ...o.seasonalDetail.slice(0, 3).map((s) => `${s.label}*`)],
      series: [
        { name: 'What happened', color: C.brand, values: [...hist.map((s) => s.revenue), null, null, null] },
        { name: 'Best estimate', color: '#f59e0b', values: [...hist.map((_, i) => (i === hist.length - 1 ? hist[hist.length - 1].revenue : null)), ...o.seasonalDetail.slice(0, 3).map(() => o.seasonAdjusted / (o.months.length || 1))] },
      ],
      height: 130,
    });
    L.text('*Months still to come. The season for those months (from the dashboard calendar): ' + o.seasonalDetail.map((s) => `${s.label} - ${s.season}`).join('; ') + '.', { size: 7.5, color: C.muted });
    L.h2('What these estimates assume');
    L.bullets(o.assumptions, { size: 8.5 });
  }

  if (a.narrative.risks.length) { L.h2('Main risks'); L.bullets(a.narrative.risks, { color: C.bad }); }
  L.h2('What we suggest doing');
  L.bullets(a.narrative.actions, { color: C.good });
  if (a.plain.questions.length) {
    L.h2('Questions worth asking at the next meeting');
    L.bullets(a.plain.questions, { color: C.brand });
  }
}

function sectionAbout(L, a) {
  L.ensure(300);
  L.h1('About the numbers in this report');
  L.bullets([
    'Sales means invoices that are marked as paid, counted on the invoice date. Invoices waiting for approval, cancelled, or still unpaid are not counted as sales.',
    'Costs come from the expense entries in Accounting. Salary entries appear on the date they were saved, so the month they land in is approximate.',
    'Production comes from the daily production log, Inventory finished products, or completed batches, whichever is most complete each month.',
    'Comparisons line up months by position (for example January with January). Where one side has fewer months of sales, we also show a like-for-like figure.',
  ], { size: 8.5 });
  if (a.dataQuality.length) {
    L.h2('Notes on the data for this period');
    L.bullets(a.dataQuality, { size: 8.5, color: C.faint });
  }

  L.h2('Words used in this report');
  L.table(
    ['Term', 'What it means, in plain words'],
    [
      ['Sales swing (coefficient of variation)', 'How far monthly sales stray from the average month, shown as a percentage. Small means steady, large means bumpy.'],
      ['Left over per bag (contribution)', 'The selling price minus the cost that rises with every bag. It is what each bag adds towards salaries, rent and profit.'],
      ['Break-even', 'The number of bags we must sell just to cover all our costs, with no profit and no loss.'],
      ['Safety cushion (margin of safety)', 'How far sales can fall before the business stops making a profit.'],
      ['Return on assets (ROI)', 'Profit divided by the value of what the company owns. It shows how hard the assets are working.'],
      ['One more bag (marginal)', 'What one extra bag adds in money (marginal revenue) and costs (marginal cost).'],
      ['Worth today (NPV)', 'Future profit reduced to its value in today\'s money, because money later is worth less than money now.'],
      ['Discount rate', 'The yearly percentage used to shrink future money. We use a Bank of Ghana benchmark rate.'],
      ['Dependence score (HHI)', 'Adds up how big each customer\'s share is. Above 2,500 means a few customers matter too much.'],
      ['Season index', 'A month\'s sales divided by the average month of the report, times 100. 100 is a normal month.'],
      ['Like-for-like', 'Comparing only the months that have sales on both sides, so a short period is not unfairly matched against a long one.'],
      ['Paid, billed, still owed', 'Billed is everything invoiced. Paid is what customers have paid. Still owed is the difference.'],
    ],
    [160, 355],
    { size: 8 },
  );

  // Sign-off block, so the printed copy can be reviewed and approved.
  // Prepared by / Reviewed by are filled in from meta.signoff (built in
  // index.js); Approved by stays blank for a wet signature.
  const { doc, S } = L;
  const so = (L.meta && L.meta.signoff) || null;
  L.ensure(96);
  L.h2('Review and approval');
  const colW = (L.width - 20) / 3;
  const columns = [
    { label: 'Prepared by', person: so && so.preparer },
    { label: 'Reviewed by', person: so && so.reviewer },
    { label: 'Approved by', person: null },
  ];
  columns.forEach(({ label, person }, i) => {
    const x = L.left + i * (colW + 10);
    doc.font('Body').fontSize(8).fillColor(C.muted).text(S(label), x, L.y, { width: colW, lineBreak: false });
    if (person && person.initials) {
      // Initials stand in for the signature, sitting just above the line.
      doc.font('Italic').fontSize(15).fillColor(C.ink).text(S(person.initials), x + 4, L.y + 16, { width: colW - 8, lineBreak: false });
    }
    doc.moveTo(x, L.y + 34).lineTo(x + colW, L.y + 34).lineWidth(0.6).strokeColor(C.faint).stroke();
    const caption = person
      ? (String(person.name).trim().toLowerCase() === String(person.role).trim().toLowerCase() ? person.role : `${person.name} (${person.role})`)
      : 'Name and signature';
    doc.font('Body').fontSize(7.5).fillColor(person ? C.body : C.faint).text(S(caption), x, L.y + 38, { width: colW, lineBreak: false });
    const dateText = person && so && so.dateText ? so.dateText : '____ / ____ / ________';
    doc.font('Body').fontSize(7.5).fillColor(person ? C.body : C.faint).text(S(`Date: ${dateText}`), x, L.y + 50, { width: colW, lineBreak: false });
  });
  L.y += 68;
  L.text('This is an internal management report built from the live operating system. It has not been audited and is not investment advice.', { size: 7.5, color: C.faint });
}

/* ── Entry points ──────────────────────────────────────────────── */

function buildReportPDF(analysis, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${meta.companyName || 'White Water Wells Ltd'} - ${analysis.label} Report`, Author: meta.companyName || 'White Water Wells Ltd', Subject: `${analysis.periodType === 'quarter' ? 'Quarterly' : 'Annual'} business and financial report` } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const fonts = setupFonts(doc);
      const S = makeSanitizer(fonts.unicode);
      const companyName = meta.companyName || 'White Water Wells Ltd';
      meta = { ...meta, companyName, logoPath: findLogoPath(meta) };
      const L = new Layout(doc, S, meta);

      drawHeaderBand(L, analysis, meta);
      sectionSummary(L, analysis);
      sectionRevenue(L, analysis);
      sectionCompare(L, analysis);
      sectionSeasonality(L, analysis);
      sectionProfitability(L, analysis);
      sectionMarginal(L, analysis);
      sectionPortfolio(L, analysis);
      sectionSupplyDemand(L, analysis);
      sectionBags(L, analysis);
      sectionNpv(L, analysis);
      sectionAnalyst(L, analysis);
      sectionAbout(L, analysis);

      // Running header (pages 2+) and footer (all pages). The top and bottom
      // margins are zeroed while drawing; text below the bottom margin would
      // otherwise make pdfkit append a blank page for every footer.
      const period = periodInfoOf(analysis);
      const range = doc.bufferedPageRange();
      const logoPath = meta.logoPath;
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const oldBottom = doc.page.margins.bottom;
        const oldTop = doc.page.margins.top;
        doc.page.margins.bottom = 0;
        doc.page.margins.top = 0;

        if (i > 0) {
          drawLogoTile(doc, 40, 15, 26, logoPath);
          doc.font('Bold').fontSize(9).fillColor(C.brandDark).text(S(companyName), 74, 17, { width: 260, lineBreak: false });
          doc.font('Body').fontSize(7.5).fillColor(C.muted).text(S(`${analysis.periodType === 'quarter' ? 'Quarterly' : 'Annual'} report  |  ${analysis.label}  |  ${period.rangeText}`), 74, 29, { width: 400, lineBreak: false });
          doc.roundedRect(doc.page.width - 40 - 74, 18, 74, 20, 10).fill(C.tint);
          doc.font('Bold').fontSize(8).fillColor(C.brand).text(S(analysis.label), doc.page.width - 40 - 74, 24, { width: 74, align: 'center', lineBreak: false });
          doc.moveTo(40, 46).lineTo(doc.page.width - 40, 46).lineWidth(0.6).strokeColor(C.brand).stroke();
        }

        doc.moveTo(40, doc.page.height - 38).lineTo(doc.page.width - 40, doc.page.height - 38).lineWidth(0.4).strokeColor(C.line).stroke();
        doc.font('Body').fontSize(7.5).fillColor(C.faint)
          .text(S(`${companyName}  |  ${analysis.label} (${period.shortText})  |  Confidential  |  Page ${i + 1} of ${range.count}`), 40, doc.page.height - 30, { width: doc.page.width - 80, align: 'center', lineBreak: false });
        doc.page.margins.bottom = oldBottom;
        doc.page.margins.top = oldTop;
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

const buildQuarterlyReportPDF = (analysis, meta) => buildReportPDF(analysis, meta);
const buildAnnualReportPDF = (analysis, meta) => buildReportPDF(analysis, meta);

module.exports = { buildQuarterlyReportPDF, buildAnnualReportPDF, buildReportPDF };