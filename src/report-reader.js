/* ═══════════════════════════════════════════════════════════════════
   REPORT READER  (src/report-reader.js)
   ───────────────────────────────────────────────────────────────────
   Opens a quarterly or yearly report full-screen so it can be read
   comfortably on a phone, a tablet or a desktop, and closed again with
   one tap.

   How to close it (all of these work):
     • the "Close" button at the top (always visible, even when scrolling)
     • the big "Close report" button at the very bottom, for when you
       have finished reading and are already down there
     • the Esc key
     • tapping the dark area around the report (on larger screens)
     • the phone's Back button

   Use:  WWReportReader.open(analysis)
   where `analysis` is what /api/reports/.../preview returns.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
	'use strict';
	if (window.WWReportReader) return;

	const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	const money = (n) => 'GH₵' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const num = (n) => Number(n || 0).toLocaleString('en-GH');
	const pct = (n, d = 1) => (n == null || !Number.isFinite(Number(n)) ? 'n/a' : `${Number(n).toFixed(d)}%`);
	const spct = (n) => (n == null || !Number.isFinite(Number(n)) ? 'n/a' : `${Number(n) > 0 ? '+' : ''}${Number(n).toFixed(1)}%`);
	const smoney = (n) => `${Number(n) > 0 ? '+' : ''}${money(n)}`;
	const tone = (n) => (Number(n) > 0 ? 'rr-good' : Number(n) < 0 ? 'rr-bad' : '');

	const CSS = `
	body.rr-lock { overflow: hidden; }
	#rr-overlay { position: fixed; inset: 0; z-index: 100000; background: rgba(8, 20, 36, .66); display: flex; align-items: stretch; justify-content: center; }
	#rr-overlay[hidden] { display: none; }
	.rr-sheet { position: relative; display: flex; flex-direction: column; width: 100%; max-width: 1040px; height: 100%; background: #f4f8fc; color: #13324a; font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; font-size: 16px; line-height: 1.55; -webkit-text-size-adjust: 100%; }
	@media (min-width: 900px) { #rr-overlay { padding: 24px 16px; } .rr-sheet { border-radius: 16px; box-shadow: 0 24px 70px rgba(0,0,0,.4); overflow: hidden; } }
	.rr-top { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; padding: 10px 14px; padding-top: calc(10px + env(safe-area-inset-top, 0px)); background: #fff; border-bottom: 1px solid #c8ddec; box-shadow: 0 2px 8px rgba(8,54,84,.06); }
	.rr-top-title { flex: 1; min-width: 0; }
	.rr-top-title strong { display: block; font-size: 1.02rem; color: #0a3858; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.rr-top-title span { display: block; font-size: .78rem; color: #587289; }
	.rr-btn { appearance: none; border: 1px solid #0077b6; background: #fff; color: #0077b6; font: inherit; font-weight: 700; font-size: .9rem; border-radius: 10px; padding: 9px 14px; cursor: pointer; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
	.rr-btn:hover { background: #eef7ff; }
	.rr-btn-solid { background: #0077b6; color: #fff; }
	.rr-btn-solid:hover { background: #005f92; }
	.rr-nav { flex: 0 0 auto; display: flex; gap: 6px; overflow-x: auto; padding: 8px 14px; background: #fff; border-bottom: 1px solid #dbeafe; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
	.rr-nav::-webkit-scrollbar { display: none; }
	.rr-nav a { flex: 0 0 auto; padding: 7px 13px; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-size: .82rem; font-weight: 700; text-decoration: none; white-space: nowrap; border: 1px solid #bfdbfe; }
	.rr-scroll { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; padding: 14px 14px 8px; scroll-behavior: smooth; overscroll-behavior: contain; }
	.rr-section { background: #fff; border: 1px solid #cde3f3; border-radius: 14px; padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 14px rgba(8,54,84,.05); scroll-margin-top: 8px; }
	.rr-section h2 { margin: 0 0 4px; font-size: 1.2rem; color: #0a3858; }
	.rr-section h3 { margin: 18px 0 8px; font-size: 1rem; color: #0a3858; }
	.rr-sub { margin: 0 0 12px; color: #587289; font-size: .88rem; }
	.rr-simple { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 10px; padding: 11px 13px; margin: 10px 0; font-size: .93rem; }
	.rr-simple b { display: block; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: #15803d; margin-bottom: 3px; }
	.rr-note { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 11px 13px; margin: 10px 0; font-size: .92rem; color: #1e3a8a; }
	.rr-note.rr-warn { background: #fffbeb; border-color: #fde68a; color: #92400e; }
	.rr-small { font-size: .8rem; color: #64748b; }
	.rr-verdict { display: flex; gap: 14px; align-items: center; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
	.rr-verdict .rr-v-label { font-weight: 800; font-size: 1.25rem; }
	.rr-verdict .rr-v-kicker { font-size: .68rem; letter-spacing: .1em; text-transform: uppercase; opacity: .85; font-weight: 700; }
	.rr-t-good { background: #f0fdf4; color: #15803d; } .rr-t-warn { background: #fffbeb; color: #b45309; } .rr-t-bad { background: #fef2f2; color: #b91c1c; } .rr-t-neutral { background: #f1f5f9; color: #475569; }
	.rr-verdict p { margin: 0; color: #13324a; }
	.rr-tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 12px 0; }
	@media (min-width: 700px) { .rr-tiles { grid-template-columns: repeat(3, 1fr); } }
	.rr-tile { border: 1px solid #cde3f3; border-radius: 12px; padding: 11px 12px; background: #fbfdff; min-width: 0; }
	.rr-tile small { display: block; font-size: .68rem; letter-spacing: .05em; text-transform: uppercase; color: #587289; }
	.rr-tile strong { display: block; font-size: 1.18rem; margin: 2px 0; color: #0a3858; overflow-wrap: anywhere; }
	.rr-tile span { font-size: .78rem; color: #64748b; }
	.rr-good { color: #15803d !important; } .rr-bad { color: #b91c1c !important; } .rr-warn-t { color: #b45309 !important; }
	.rr-check { display: grid; gap: 8px; }
	.rr-check-item { display: grid; grid-template-columns: 1fr; gap: 4px; border: 1px solid #e2eef8; border-radius: 10px; padding: 10px 12px; }
	.rr-check-q { font-weight: 700; font-size: .93rem; }
	.rr-pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: .74rem; font-weight: 800; margin-right: 6px; }
	.rr-check-d { font-size: .88rem; color: #3f5d74; }
	@media (min-width: 760px) { .rr-check-item { grid-template-columns: 250px 140px 1fr; align-items: center; gap: 12px; } }
	.rr-list { margin: 6px 0 0; padding-left: 20px; } .rr-list li { margin-bottom: 7px; }
	.rr-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 8px -4px; padding: 0 4px; }
	.rr-table { width: 100%; border-collapse: collapse; font-size: .86rem; min-width: 460px; }
	.rr-table th { background: #f3f9fe; color: #1f4e72; text-align: left; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; padding: 8px 9px; border: 1px solid #daeaf6; white-space: nowrap; }
	.rr-table td { padding: 8px 9px; border: 1px solid #daeaf6; vertical-align: top; }
	.rr-table .r { text-align: right; white-space: nowrap; } .rr-table tr.rr-total td { font-weight: 800; background: #f8fbfe; }
	.rr-kv { display: grid; gap: 0; border: 1px solid #e2eef8; border-radius: 10px; overflow: hidden; }
	.rr-kv div { display: flex; justify-content: space-between; gap: 12px; padding: 9px 12px; border-bottom: 1px solid #eef5fb; font-size: .9rem; }
	.rr-kv div:last-child { border-bottom: 0; } .rr-kv span { color: #587289; } .rr-kv b { text-align: right; }
	.rr-pairs { margin: 10px 0; }
	.rr-pair { display: grid; grid-template-columns: 38px 1fr; gap: 8px; align-items: center; margin-bottom: 6px; font-size: .78rem; }
	.rr-bars { display: grid; gap: 3px; }
	.rr-bar { height: 12px; border-radius: 3px; min-width: 2px; } .rr-bar.cur { background: #0077b6; } .rr-bar.prior { background: #b8d4e8; }
	.rr-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: .8rem; margin: 6px 0; }
	.rr-legend i { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
	.rr-foot { padding: 6px 0 22px; }
	.rr-close-bottom { width: 100%; font-size: 1rem; padding: 14px; }
	.rr-bottom-bar { flex: 0 0 auto; display: flex; gap: 10px; padding: 10px 14px; padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); background: #fff; border-top: 1px solid #c8ddec; }
	.rr-bottom-bar .rr-btn { flex: 1; }
	@media (max-width: 420px) { .rr-section { padding: 13px; border-radius: 12px; } .rr-top-title span { display: none; } }
	@media print { #rr-overlay { position: static; background: none; } .rr-top, .rr-nav, .rr-bottom-bar { display: none !important; } .rr-sheet { max-width: none; height: auto; box-shadow: none; } .rr-scroll { overflow: visible; } .rr-section { break-inside: avoid-page; } }
	`;

	function addStyle() {
		if (document.getElementById('rr-style')) return;
		const s = document.createElement('style');
		s.id = 'rr-style';
		s.textContent = CSS;
		document.head.appendChild(s);
	}

	const section = (id, title, sub, body) => `<section class="rr-section" id="rr-${id}"><h2>${esc(title)}</h2>${sub ? `<p class="rr-sub">${esc(sub)}</p>` : ''}${body}</section>`;
	const simple = (t, label) => `<div class="rr-simple"><b>${esc(label || 'In simple words')}</b>${esc(t)}</div>`;
	const note = (t, warn) => `<div class="rr-note${warn ? ' rr-warn' : ''}">${esc(t)}</div>`;
	const list = (items) => (items && items.length ? `<ul class="rr-list">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
	const kv = (rows) => `<div class="rr-kv">${rows.map(([k, v, c]) => `<div><span>${esc(k)}</span><b class="${c || ''}">${esc(v)}</b></div>`).join('')}</div>`;
	const table = (head, rows, rightFrom = 1) => `<div class="rr-wrap"><table class="rr-table"><thead><tr>${head.map((h, i) => `<th class="${i >= rightFrom ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr class="${r.total ? 'rr-total' : ''}">${r.cells.map((c, i) => `<td class="${i >= rightFrom ? 'r' : ''} ${c && c.cls ? c.cls : ''}">${esc(c && c.t != null ? c.t : c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
	const tile = (label, value, sub, cls) => `<div class="rr-tile"><small>${esc(label)}</small><strong class="${cls || ''}">${esc(value)}</strong><span>${esc(sub || '')}</span></div>`;

	const TONE_LABEL = { good: 'rr-t-good', warn: 'rr-t-warn', bad: 'rr-t-bad', neutral: 'rr-t-neutral' };
	const STATUS = { up: ['Higher', 'rr-good'], down: ['Lower', 'rr-bad'], flat: ['About the same', ''], new: ['New (no sales before)', ''], missing: ['No sales this time', 'rr-warn-t'], none: ['-', ''] };

	function compareBlock(set) {
		if (!set.hasPrior) return `<h3>${esc(set.title)}</h3>${note(set.story[0], true)}`;
		const max = Math.max(1, ...set.months.map((m) => Math.max(m.curRevenue, m.priorRevenue)));
		const bars = set.months.map((m) => `<div class="rr-pair"><b>${esc(m.label)}</b><div class="rr-bars"><div class="rr-bar cur" style="width:${(m.curRevenue / max) * 100}%"></div><div class="rr-bar prior" style="width:${(m.priorRevenue / max) * 100}%"></div></div></div>`).join('');
		const monthRows = set.months.map((m) => {
			const st = STATUS[m.status] || STATUS.none;
			return { cells: [m.label, m.curRevenue > 0 ? money(m.curRevenue) : '-', m.priorRevenue > 0 ? money(m.priorRevenue) : '-', m.status === 'none' ? '-' : smoney(m.change), m.changePct == null ? 'n/a' : spct(m.changePct), { t: st[0], cls: st[1] }] };
		});
		const t = set.totals;
		monthRows.push({ total: true, cells: ['Total', money(t.revenue.cur), money(t.revenue.prior), smoney(t.revenue.change), t.revenue.pct == null ? 'n/a' : spct(t.revenue.pct), ''] });
		const glance = [
			['Sales (paid invoices)', money(t.revenue.cur), money(t.revenue.prior), t.revenue.pct == null ? smoney(t.revenue.change) : `${smoney(t.revenue.change)} (${spct(t.revenue.pct)})`],
			['Bags sold', num(t.bags.cur), num(t.bags.prior), spct(t.bags.pct)],
			['Average price per bag', t.avgPrice.cur == null ? 'n/a' : money(t.avgPrice.cur), t.avgPrice.prior == null ? 'n/a' : money(t.avgPrice.prior), spct(t.avgPrice.pct)],
			['Total costs', money(t.costs.cur), money(t.costs.prior), spct(t.costs.pct)],
			['Profit after costs', money(t.netProfit.cur), money(t.netProfit.prior), smoney(t.netProfit.change)],
			['Months with sales', String(t.activeMonths.cur), String(t.activeMonths.prior), ''],
		].map((c) => ({ cells: c }));
		let q = '';
		if (set.quarters && set.quarters.some((x) => x.cur > 0 || x.prior > 0)) {
			q = `<h3>Quarter by quarter</h3>${table(['Quarter', set.curLabel, set.priorLabel, 'Change', 'Note'], set.quarters.map((x) => ({ cells: [x.label, x.cur > 0 ? money(x.cur) : '-', x.prior > 0 ? money(x.prior) : '-', x.pct == null ? 'n/a' : spct(x.pct), x.partial ? `Not a fair match: ${x.priorMonths} of 3 months had sales before, ${x.curMonths} now` : ''] })))}`;
		}
		const fair = set.likeForLike.months && t.activeMonths.cur !== t.activeMonths.prior
			? note(`Fair comparison: only ${set.likeForLike.months} month(s) have sales on both sides. For those months, ${set.curLabel} made ${money(set.likeForLike.cur)} against ${money(set.likeForLike.prior)} (${spct(set.likeForLike.pct)}).`) : '';
		return `<h3>${esc(set.title)}</h3>${list(set.story)}
			<div class="rr-legend"><span><i style="background:#0077b6"></i>${esc(set.curLabel)}</span><span><i style="background:#b8d4e8"></i>${esc(set.priorLabel)}</span></div>
			<div class="rr-pairs">${bars}</div>
			${table(['Month', set.curLabel, set.priorLabel, 'Difference', 'Change', 'Reading'], monthRows)}
			<p class="rr-small">"About the same" means the month moved by less than 5%. "New" means no sales in that month last time.</p>
			${fair}
			${table(['At a glance', set.curLabel, set.priorLabel, 'Change'], glance)}${q}`;
	}

	function render(a) {
		const pl = a.plain || { verdict: { tone: 'neutral', label: '', sentence: '' }, scorecard: [], sections: {}, questions: [] };
		const pr = a.profitRoi || {}; const rev = a.revenue || {}; const ue = a.unitEconomics || {}; const col = a.collections || {};
		const isQ = a.periodType === 'quarter';
		const nv = a.narrative || {};
		const v = pl.verdict;
		const parts = [];
		const nav = [['glance', 'At a glance'], ['sales', 'Sales'], ['compare', 'Comparison'], ['seasons', 'Seasons'], ['profit', 'Profit'], ['customers', 'Customers'], ['future', 'Looking ahead'], ['words', 'Words used']];

		parts.push(section('glance', 'Your report at a glance', '', `
			<div class="rr-verdict ${TONE_LABEL[v.tone] || 'rr-t-neutral'}"><div><div class="rr-v-kicker">Overall health</div><div class="rr-v-label">${esc(v.label)}</div></div><p>${esc(v.sentence)}</p></div>
			<div class="rr-tiles">
				${tile('Money in (paid sales)', money(rev.totalRevenue), pl.growth != null ? `${spct(pl.growth)} vs ${pl.growthAgainst}` : '')}
				${tile('Profit after all costs', money(pr.netProfit), pr.netMargin == null ? '' : `${pct(pr.netMargin, 0)} of sales kept`, pr.netProfit >= 0 ? 'rr-good' : 'rr-bad')}
				${tile('Return on what we own', pr.roiPercent == null ? 'n/a' : pct(pr.roiPercent), pr.roiAnnualisedPercent == null ? 'No assets recorded' : `${pct(pr.roiAnnualisedPercent)} over a full year`)}
				${tile('Sales swing month to month', pct(rev.coefficientOfVariation, 0), String(rev.variabilityBand || '').replace(/ \(.*\)/, ''))}
				${tile('Future profit, worth today', money(a.npv && a.npv.npv), `Next ${a.npv ? a.npv.horizon : ''} ${isQ ? 'quarters' : 'years'}`)}
				${tile('Left over per bag', ue.contributionPerBag == null ? 'n/a' : money(ue.contributionPerBag), ue.price == null ? '' : `Sells ${money(ue.price)}, costs ${money(ue.variableCostPerBag)}`)}
			</div>
			${nv.headline ? note(nv.headline) : ''}
			<h3>Health check in plain questions</h3>
			<div class="rr-check">${pl.scorecard.map((i) => `<div class="rr-check-item"><div class="rr-check-q">${esc(i.question)}</div><div><span class="rr-pill ${TONE_LABEL[i.tone] || ''}">${esc(i.answer)}</span></div><div class="rr-check-d">${esc(i.detail)}</div></div>`).join('')}</div>
			<h3>What we found</h3>${list(nv.findings)}
			${nv.risks && nv.risks.length ? `<h3>Things to keep an eye on</h3>${list(nv.risks)}` : ''}`));

		const ps = (a.periodSeries || []);
		parts.push(section('sales', '1. Sales: how much came in, and how steady', 'A "swing" shows how far months stray from the average month. Under 15% is steady, 15-30% moderate, above 30% bumpy.', `
			${simple(pl.sections.sales || '')}
			${table(['Month', 'Sales', 'Bags', 'Avg price', 'Buyers', 'Biggest buyer'], ps.map((s) => ({ cells: [s.label, money(s.revenue), num(s.bags), s.avgPrice == null ? 'n/a' : money(s.avgPrice), String(s.activeCustomers), s.topCustomer ? `${s.topCustomer.name} (${pct(s.topCustomer.share, 0)})` : 'n/a'] })), 1)}
			${kv([['Average sales in a month', money(rev.mean)], ['Sales swing', pct(rev.coefficientOfVariation)], ['Our rating', rev.variabilityBand || 'n/a'], ['Day-to-day swing', rev.daily && rev.daily.cv != null ? pct(rev.daily.cv) : 'n/a']])}`));

		parts.push(section('compare', a.periodType === 'year' ? '2. This year against last year, month by month' : '2. Compared with earlier periods',
			a.periodType === 'year' ? 'Each month is placed next to the same month last year.' : 'Each month is placed next to the quarter before, and the same quarter last year (a fairer test because weather repeats each year).',
			(a.compareSets || []).map(compareBlock).join('') || note('No comparison is available yet.', true)));

		const sea = a.seasonality || { months: [] };
		parts.push(section('seasons', '3. Seasons: why some months are high and some low', 'Weather and holidays make some months busy and others slow. That is not the same as the business doing better or worse.', `
			${simple(pl.sections.seasons || '')}${nv.seasonalText ? note(nv.seasonalText) : ''}
			${table(['Month', 'Season', 'Sales', 'Change on last month', 'Followed the season?', 'Verdict'], (sea.months || []).map((m) => ({ cells: [m.label, m.season, money(m.revenue), m.momPct == null ? 'n/a' : spct(m.momPct), m.agreesWithSeason == null ? 'Neutral' : m.agreesWithSeason ? 'Yes' : 'No', m.status === 'low' ? 'LOW' : m.status === 'high' ? 'HIGH' : 'Normal'] })), 2)}`));

		parts.push(section('profit', '4. Profit: what was left after paying for everything', 'Profit is sales minus every cost.', `
			${simple(pl.sections.profit || '')}
			${table(['Money in and out', 'Amount', '% of sales'], [
				{ cells: ['Sales (paid invoices)', money(rev.totalRevenue), '100%'] },
				{ cells: ['Cost of making the water', money(-(pr.cogs || 0)), pct(rev.totalRevenue ? (pr.cogs / rev.totalRevenue) * 100 : null)] },
				{ total: true, cells: ['Left after making the water', money(pr.grossProfit), pct(pr.grossMargin)] },
				{ cells: ['Running costs (salaries, utilities, rent...)', money(-(pr.operatingExpenses || 0)), pct(rev.totalRevenue ? (pr.operatingExpenses / rev.totalRevenue) * 100 : null)] },
				{ cells: ['Free promotional bags', money(-(rev.promoExpense || 0)), pct(rev.totalRevenue ? (rev.promoExpense / rev.totalRevenue) * 100 : null)] },
				{ total: true, cells: ['Final profit', money(pr.netProfit), pct(pr.netMargin)] },
			])}
			<h3>The cost of one bag, and break-even</h3>${simple(pl.sections.perBag || '')}
			${kv([['Selling price per bag', ue.price == null ? 'n/a' : money(ue.price)], ['Materials, fuel and delivery per bag', ue.variableCostPerBag == null ? 'n/a' : money(ue.variableCostPerBag)], ['Left over per bag', ue.contributionPerBag == null ? 'n/a' : money(ue.contributionPerBag), tone(ue.contributionPerBag)], ['Bags needed to break even', ue.breakEvenBags == null ? 'n/a' : num(ue.breakEvenBags)], ['Bags actually sold', num(ue.bags)], ['Safety cushion', ue.marginOfSafetyPct == null ? 'n/a' : pct(ue.marginOfSafetyPct)]])}`));

		const pf = a.portfolio || { rows: [] };
		const ds = a.demandSupply || {};
		parts.push(section('customers', '5. Our customers, and getting paid', '', `
			${simple(pl.sections.customers || '')}${nv.bcgText ? note(nv.bcgText) : ''}
			${pf.rows && pf.rows.length ? table(['Customer', 'Paid us', 'Share', `Change vs ${a.previousLabel}`, 'Group'], pf.rows.map((r) => ({ cells: [r.customer, money(r.revenue), pct(r.share), r.growth == null ? 'New buyer' : spct(r.growth), r.quadrant] })), 1) : ''}
			${kv([['Biggest customer, as % of sales', pct(pf.top1Share)], ['Top three together', pct(pf.top3Share)], ['Total billed', money(col.billed)], ['Paid so far', money(col.paid)], ['Still owed to us', money(col.outstanding), col.outstanding > 0 ? 'rr-warn-t' : 'rr-good'], ['Share of billing paid', pct(col.efficiencyPct)]])}
			<h3>Bags made against bags ordered</h3>${simple(pl.sections.supply || '')}
			${kv([['Bags made', ds.recorded ? num(ds.supplyBags) : 'Not recorded'], ['Bags ordered', num(ds.demandBags)]])}`));

		const o = a.outlook;
		parts.push(section('future', '6. Looking ahead, and what to do next', 'Our best guess for the next period and the practical steps. Guesses come from a short history, so treat them as a guide.', `
			${nv.outlookText ? note(nv.outlookText) : ''}
			<h3>What future profit is worth today</h3>${simple(pl.sections.future || '')}${nv.npvText ? note(nv.npvText) : ''}
			${a.npv && a.npv.scenarios ? table(['What happens', 'Worth today'], a.npv.scenarios.map((s) => ({ cells: [{ 'Downside': 'Profit falls', 'Flat (no growth)': 'Profit stays the same', 'Trend': 'Profit follows the recent trend' }[s.name] || s.name, money(s.npv)] })), 1) : ''}
			${o && o.assumptions ? `<h3>What the estimate assumes</h3>${list(o.assumptions)}` : ''}
			<h3>What we suggest doing</h3>${list(nv.actions)}
			${pl.questions && pl.questions.length ? `<h3>Questions worth asking at the next meeting</h3>${list(pl.questions)}` : ''}`));

		parts.push(section('words', 'Words used in this report, and the data behind it', '', `
			${table(['Term', 'What it means'], [
				['Sales swing', 'How far monthly sales stray from the average month. Small means steady.'],
				['Left over per bag', 'Selling price minus the cost that rises with every bag. It pays for salaries, rent and profit.'],
				['Break-even', 'The bags we must sell just to cover all costs.'],
				['Safety cushion', 'How far sales can fall before profit reaches zero.'],
				['Return on assets (ROI)', 'Profit divided by the value of what the company owns.'],
				['Worth today (NPV)', 'Future profit shrunk to today\'s value, because money later is worth less than money now.'],
				['Like-for-like', 'Comparing only months that have sales on both sides.'],
			].map((r) => ({ cells: r })), 5)}
			${a.dataQuality && a.dataQuality.length ? `<h3>Notes on the data</h3>${list(a.dataQuality)}` : ''}
			<p class="rr-small">Internal management report built from the live system. It is not audited and is not investment advice.</p>`));

		return { html: parts.join(''), nav };
	}

	let overlay = null; let lastFocus = null; let popHandler = null;

	function close() {
		if (!overlay) return;
		overlay.hidden = true;
		overlay.innerHTML = '';
		document.body.classList.remove('rr-lock');
		document.removeEventListener('keydown', onKey, true);
		if (popHandler) { window.removeEventListener('popstate', popHandler); popHandler = null; }
		if (history.state && history.state.rrOpen) { try { history.back(); } catch (_e) { /* ignore */ } }
		if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_e) { /* ignore */ } }
	}
	function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

	function open(analysis) {
		if (!analysis) return;
		addStyle();
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = 'rr-overlay';
			overlay.setAttribute('role', 'dialog');
			overlay.setAttribute('aria-modal', 'true');
			overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
			document.body.appendChild(overlay);
		}
		lastFocus = document.activeElement;
		const { html, nav } = render(analysis);
		const kind = analysis.periodType === 'quarter' ? 'Quarterly report' : 'Yearly report';
		overlay.innerHTML = `
			<div class="rr-sheet">
				<div class="rr-top"><div class="rr-top-title"><strong>${esc(analysis.label)}</strong><span>${esc(kind)} (preview)</span></div>
					<button type="button" class="rr-btn" id="rr-print">Print</button>
					<button type="button" class="rr-btn rr-btn-solid" id="rr-close-top" aria-label="Close report">&times; Close</button></div>
				<div class="rr-nav">${nav.map(([id, t]) => `<a href="#rr-${id}" data-rr-jump="${id}">${esc(t)}</a>`).join('')}</div>
				<div class="rr-scroll" id="rr-scroll">${html}<div class="rr-foot"><button type="button" class="rr-btn rr-btn-solid rr-close-bottom" id="rr-close-bottom">Done reading. Close report</button></div></div>
			</div>`;
		overlay.hidden = false;
		document.body.classList.add('rr-lock');
		overlay.querySelector('#rr-close-top').addEventListener('click', close);
		overlay.querySelector('#rr-close-bottom').addEventListener('click', close);
		overlay.querySelector('#rr-print').addEventListener('click', () => window.print());
		overlay.querySelector('.rr-nav').addEventListener('click', (e) => {
			const a = e.target.closest('[data-rr-jump]');
			if (!a) return;
			e.preventDefault();
			const t = overlay.querySelector('#rr-' + a.getAttribute('data-rr-jump'));
			if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
		document.addEventListener('keydown', onKey, true);
		try { history.pushState({ rrOpen: true }, ''); popHandler = () => { popHandler = null; close(); }; window.addEventListener('popstate', popHandler); } catch (_e) { /* ignore */ }
		overlay.querySelector('#rr-close-top').focus();
	}

	window.WWReportReader = { open, close };
})();