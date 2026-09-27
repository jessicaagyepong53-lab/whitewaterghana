/* ═══════════════════════════════════════════════════════════════════
   SEASONAL OUTLOOK WIDGET — drop-in widget
   ───────────────────────────────────────────────────────────────────
   Shows which demand season the water factory is currently in and why,
   combining two distinct layers so neither is mistaken for the other:

     1. CALENDAR PATTERN — general seasonality for water sachet/bottled
        demand in Ghana (Harmattan/dry heat drives peak demand, rains
        soften it). This is industry knowledge, not something derived
        from this business's own numbers, and is labeled as such.

     2. YOUR OWN DATA — this month's paid revenue, compared either to
        the same calendar month in a prior year (once that history
        exists) or, until then, to this business's own trailing
        3-month daily rate. States plainly whether the real numbers
        are tracking with or diverging from the expected season.

   Nothing here is invented — the calendar layer is stated as a general
   pattern, and the data layer is computed live from getAllSalesData(),
   the same source the rest of the dashboard already reads from.

   DISPLAY — renders collapsed by default as a single-line teaser (icon +
   title + one-line summary + chevron), matching the visual weight of the
   Business Value Clock banner above it. Tapping the row expands it in
   place to show the full seasonal reasoning, the "your numbers" data
   check, and the footnote. This keeps the dashboard's KPI grid and charts
   from being pushed further down the page by a fully-expanded card.

   USAGE — on any page inside /pages/:
     1) Add a mount point:
          <div id="seasonal-outlook-widget"></div>
     2) Include this script after script.js:
          <script src="../src/seasonal-outlook-widget.js"></script>

   Auto-initializes on DOMContentLoaded if the mount point exists.
   To mount into a different element id, call:
          initSeasonalOutlookWidget('my-custom-id');
   ═══════════════════════════════════════════════════════════════════ */
(function () {
	'use strict';

	var STYLE_ID = 'seasonal-outlook-widget-styles';

	// Last computed context, kept so other widgets on the page (e.g. the
	// Business Value Clock) can read "what season are we in and does the
	// real revenue agree" without recomputing it themselves. See
	// getSeasonalOutlookContext() and the 'seasonal-outlook-context' event
	// dispatched at the bottom of render().
	var lastContext = null;

	// Month index (0 = Jan) → { key, label, tone, reason }
	// This is the general industry pattern for Ghana, not derived from
	// this business's own sales — see the "About this" note in the panel.
	var SEASON_CALENDAR = [
		{ key: 'peak', label: 'Peak Season', tone: 'peak', reason: 'Harmattan and dry-season heat (Dec\u2013Mar) typically drive the highest demand for drinking water nationwide.' },
		{ key: 'peak', label: 'Peak Season', tone: 'peak', reason: 'Harmattan and dry-season heat (Dec\u2013Mar) typically drive the highest demand for drinking water nationwide.' },
		{ key: 'peak', label: 'Peak Season', tone: 'peak', reason: 'Harmattan and dry-season heat (Dec\u2013Mar) typically drive the highest demand for drinking water nationwide.' },
		{ key: 'transition-down', label: 'Transition \u2014 Softening', tone: 'mid', reason: 'Demand is usually still fairly strong in April, but rains begin picking up and start easing consumption.' },
		{ key: 'transition-down', label: 'Transition \u2014 Softening', tone: 'mid', reason: 'Rainfall becomes more frequent through May, gradually easing outdoor water consumption.' },
		{ key: 'transition-down', label: 'Transition \u2014 Softening', tone: 'mid', reason: 'By June, wetter weather has usually settled in, continuing to soften demand ahead of the lean months.' },
		{ key: 'lean', label: 'Lean Season', tone: 'lean', reason: 'Jul\u2013Sep is typically the wettest stretch of the year \u2014 more time indoors generally means lower demand for chilled/drinking water.' },
		{ key: 'lean', label: 'Lean Season', tone: 'lean', reason: 'Jul\u2013Sep is typically the wettest stretch of the year \u2014 more time indoors generally means lower demand for chilled/drinking water.' },
		{ key: 'lean', label: 'Lean Season', tone: 'lean', reason: 'Jul\u2013Sep is typically the wettest stretch of the year \u2014 more time indoors generally means lower demand for chilled/drinking water.' },
		{ key: 'transition-up', label: 'Transition \u2014 Rising', tone: 'mid', reason: 'Weather starts turning hotter and drier again in October, and demand typically begins climbing back up.' },
		{ key: 'transition-up', label: 'Transition \u2014 Rising', tone: 'mid', reason: 'Demand keeps building through November as the dry season approaches, plus early holiday-season activity.' },
		{ key: 'peak', label: 'Peak Season', tone: 'peak', reason: 'December combines dry-season heat with Christmas/New Year demand from events, gatherings, and retail \u2014 usually the strongest month of the year.' },
	];

	var TONE_META = {
		peak: { icon: 'fa-fire', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
		mid: { icon: 'fa-arrow-right-arrow-left', color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
		lean: { icon: 'fa-cloud-rain', color: '#0369a1', bg: '#eff6ff', border: '#bfdbfe' },
	};

	function ensureStyles() {
		if (document.getElementById(STYLE_ID)) return;
		var style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = [
			'.swo-card{background:#fff;border:1px solid #cde3f3;border-radius:14px;',
			'box-shadow:0 6px 18px rgba(8,54,84,0.07);margin-bottom:16px;overflow:hidden;}',
			// Collapsed teaser row — same visual weight as the Business Value
			// Clock banner: icon, title/subtitle, chevron, nothing else.
			'.swo-teaser{display:flex;align-items:center;gap:12px;padding:14px 16px;cursor:pointer;',
			'background:none;border:none;width:100%;text-align:left;font:inherit;}',
			'.swo-teaser:hover{background:#f8fbfd;}',
			'.swo-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;',
			'font-size:1.15rem;flex-shrink:0;}',
			'.swo-teaser-text{flex:1;min-width:0;}',
			'.swo-teaser-title{margin:0;font-size:0.95rem;font-weight:700;color:#0f172a;}',
			'.swo-teaser-sub{margin:2px 0 0;font-size:0.82rem;color:#64748b;',
			'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
			'.swo-chevron{color:#94a3b8;font-size:0.85rem;flex-shrink:0;transition:transform 0.15s ease;}',
			'.swo-card.is-open .swo-chevron{transform:rotate(180deg);}',
			// Expanded detail — hidden until the teaser is tapped.
			'.swo-details{display:none;padding:0 16px 16px;border-top:1px solid #eef2f6;}',
			'.swo-card.is-open .swo-details{display:block;padding-top:14px;}',
			'.swo-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
			'.swo-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;',
			'font-size:0.78rem;font-weight:700;}',
			'.swo-month{font-size:0.82rem;color:#64748b;}',
			'.swo-reason{margin:10px 0 0;font-size:0.87rem;color:#334155;line-height:1.55;}',
			'.swo-datacheck{margin-top:12px;padding:10px 12px;border-radius:10px;background:#f8fafc;',
			'border:1px solid #e2e8f0;font-size:0.85rem;color:#334155;line-height:1.5;}',
			'.swo-datacheck strong{color:#0f172a;}',
			'.swo-datacheck.agree{background:#f0fdf4;border-color:#bbf7d0;}',
			'.swo-datacheck.diverge{background:#fff7ed;border-color:#fed7aa;}',
			'.swo-datacheck.nodata{color:#64748b;}',
			'.swo-footnote{margin:10px 0 0;font-size:0.72rem;color:#94a3b8;line-height:1.5;}',
			'.swo-crosslink{display:inline-flex;align-items:center;gap:6px;margin-top:12px;',
			'background:none;border:none;padding:0;font:inherit;font-size:0.82rem;font-weight:600;',
			'color:#0077b6;cursor:pointer;}',
			'.swo-crosslink:hover{text-decoration:underline;}',
		].join('');
		document.head.appendChild(style);
	}

	function pad2(n) { return String(n).padStart(2, '0'); }

	function getSalesDataSafe() {
		try {
			return (typeof getAllSalesData === 'function') ? getAllSalesData() : { invoices: [] };
		} catch (_e) {
			return { invoices: [] };
		}
	}

	function fmtMoney(v) {
		try {
			if (typeof formatCurrency === 'function') return formatCurrency(v);
		} catch (_e) { /* fall through */ }
		return 'GH\u20B5' + Math.round(Number(v) || 0).toLocaleString();
	}

	// Sums paid invoice revenue for a given year+month (0-indexed month),
	// optionally only counting days up to `throughDay` (for partial-month
	// "so far" comparisons).
	function sumPaidRevenueForMonth(invoices, year, monthIdx, throughDay) {
		var total = 0;
		for (var i = 0; i < invoices.length; i += 1) {
			var inv = invoices[i];
			if (!inv || inv.status !== 'paid') continue;
			var d = new Date(inv.date);
			if (isNaN(d)) continue;
			if (d.getFullYear() !== year || d.getMonth() !== monthIdx) continue;
			if (throughDay && d.getDate() > throughDay) continue;
			total += Number(inv.amount) || 0;
		}
		return total;
	}

	function daysInMonth(year, monthIdx) {
		return new Date(year, monthIdx + 1, 0).getDate();
	}

	// Builds the "your own data" comparison. Prefers a true year-over-year
	// comparison (same calendar month, a prior year) once that history
	// exists; otherwise falls back to this business's own trailing
	// 3-month daily rate so the widget is still useful in year one.
	function computeDataCheck() {
		var sales = getSalesDataSafe();
		var invoices = Array.isArray(sales.invoices) ? sales.invoices : [];
		if (!invoices.some(function (inv) { return inv && inv.status === 'paid'; })) {
			return { mode: 'nodata' };
		}

		var now = new Date();
		var y = now.getFullYear();
		var m = now.getMonth();
		var today = now.getDate();

		var thisMonthSoFar = sumPaidRevenueForMonth(invoices, y, m, today);

		// Try year-over-year: same month, most recent prior year with any
		// paid revenue recorded for that month.
		for (var back = 1; back <= 5; back += 1) {
			var priorYear = y - back;
			var priorFullMonth = sumPaidRevenueForMonth(invoices, priorYear, m, null);
			if (priorFullMonth > 0) {
				var priorThroughSameDay = sumPaidRevenueForMonth(invoices, priorYear, m, Math.min(today, daysInMonth(priorYear, m)));
				if (priorThroughSameDay > 0) {
					var pct = ((thisMonthSoFar - priorThroughSameDay) / priorThroughSameDay) * 100;
					return {
						mode: 'yoy',
						pct: pct,
						thisValue: thisMonthSoFar,
						compareValue: priorThroughSameDay,
						compareLabel: String(priorYear),
					};
				}
			}
		}

		// Fallback: trailing 3 full months' average daily rate vs. this
		// month's daily rate so far.
		var trailingDailyRates = [];
		for (var offset = 1; offset <= 3; offset += 1) {
			var refDate = new Date(y, m - offset, 1);
			var ry = refDate.getFullYear();
			var rm = refDate.getMonth();
			var monthTotal = sumPaidRevenueForMonth(invoices, ry, rm, null);
			if (monthTotal > 0) {
				trailingDailyRates.push(monthTotal / daysInMonth(ry, rm));
			}
		}
		if (!trailingDailyRates.length || today === 0) {
			return { mode: 'nodata' };
		}
		var avgDailyRate = trailingDailyRates.reduce(function (a, b) { return a + b; }, 0) / trailingDailyRates.length;
		var thisMonthDailyRate = thisMonthSoFar / today;
		var trailingPct = avgDailyRate > 0 ? ((thisMonthDailyRate - avgDailyRate) / avgDailyRate) * 100 : null;
		if (trailingPct === null) return { mode: 'nodata' };

		return {
			mode: 'trailing',
			pct: trailingPct,
			thisValue: thisMonthSoFar,
			compareDailyRate: avgDailyRate,
		};
	}

	function buildDataCheckHtml(seasonKey, check) {
		if (check.mode === 'nodata') {
			return '<div class="swo-datacheck nodata"><i class="fa-solid fa-circle-info"></i> Not enough recorded sales yet to compare this month against your own history.</div>';
		}

		var pct = check.pct;
		var rounded = Math.round(Math.abs(pct));
		var direction = pct >= 0 ? 'above' : 'below';
		var expectedUp = (seasonKey === 'peak' || seasonKey === 'transition-up');
		var expectedDown = (seasonKey === 'lean' || seasonKey === 'transition-down');
		var agrees = (pct >= 0 && expectedUp) || (pct < 0 && expectedDown);
		var toneClass = Math.abs(pct) < 5 ? '' : (agrees ? 'agree' : 'diverge');

		var basisText = check.mode === 'yoy'
			? ('the same point in ' + check.compareLabel)
			: ('your own trailing 3-month average');

		var verdict = Math.abs(pct) < 5
			? 'roughly in line with'
			: (agrees ? 'consistent with the expected seasonal pattern \u2014 tracking' : 'running counter to the expected seasonal pattern \u2014 tracking');

		return '<div class="swo-datacheck ' + toneClass + '">' +
			'<strong>Your numbers:</strong> revenue so far this month is <strong>' + rounded + '% ' + direction + '</strong> ' + basisText + '. That\u2019s ' + verdict + ' ' + direction + '.' +
			'</div>';
	}

	// One-line summary for the collapsed teaser row — condenses the season
	// label plus the "your numbers" verdict into a single glanceable line,
	// mirroring how the Business Value Clock teaser reads before it's opened.
	function buildSummaryLine(season, check) {
		if (check.mode === 'nodata') {
			return season.label + ' \u2014 tap for what this typically means for demand.';
		}
		var pct = check.pct;
		var rounded = Math.round(Math.abs(pct));
		var direction = pct >= 0 ? 'above' : 'below';
		var basisText = check.mode === 'yoy'
			? ('vs. ' + check.compareLabel)
			: ('vs. your 3-month average');

		if (Math.abs(pct) < 5) {
			return season.label + ' \u2014 revenue roughly in line ' + basisText + '.';
		}
		return season.label + ' \u2014 revenue ' + rounded + '% ' + direction + ' ' + basisText + '.';
	}

	// Packages the season and data-check into a plain object other widgets
	// can consume — e.g. the Business Value Clock explaining a revenue dip
	// as "expected, it's lean season" rather than an unexplained shortfall.
	function buildContext(season, check) {
		var expectedDirection = (season.key === 'peak' || season.key === 'transition-up') ? 'up'
			: (season.key === 'lean' || season.key === 'transition-down') ? 'down' : 'flat';

		var dataCheck = null;
		if (check.mode !== 'nodata') {
			var agrees = (check.pct >= 0 && expectedDirection === 'up') || (check.pct < 0 && expectedDirection === 'down');
			dataCheck = {
				mode: check.mode,
				pctVsExpected: check.pct,
				agreesWithSeason: Math.abs(check.pct) < 5 ? null : agrees,
				compareLabel: check.mode === 'yoy' ? check.compareLabel : 'trailing 3-month average',
			};
		}

		return {
			seasonKey: season.key,
			seasonLabel: season.label,
			seasonReason: season.reason,
			expectedDirection: expectedDirection,
			dataCheck: dataCheck,
		};
	}

	function render(container) {
		var now = new Date();
		var season = SEASON_CALENDAR[now.getMonth()];
		var toneMeta = TONE_META[season.tone];
		var monthName = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
		var check = computeDataCheck();

		lastContext = buildContext(season, check);
		// Let anything already listening (including a Business Value Clock
		// iframe that's set up a message listener) know the latest reading.
		document.dispatchEvent(new CustomEvent('seasonal-outlook-context', { detail: lastContext }));

		var iconStyle = 'background:' + toneMeta.bg + ';color:' + toneMeta.color + ';border:1px solid ' + toneMeta.border + ';';
		var summaryLine = buildSummaryLine(season, check);

		// Only offer the cross-link if the Business Value Clock widget is
		// actually on this page (it exposes window.openBusinessValueClock).
		var crossLinkHtml = (typeof window.openBusinessValueClock === 'function')
			? '<button type="button" class="swo-crosslink" id="swo-crosslink">See how this factors into your Business Value Clock <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>'
			: '';

		container.innerHTML =
			'<div class="swo-card">' +
			'<button type="button" class="swo-teaser" aria-expanded="false">' +
			'<div class="swo-icon" style="' + iconStyle + '"><i class="fa-solid ' + toneMeta.icon + '"></i></div>' +
			'<div class="swo-teaser-text">' +
			'<p class="swo-teaser-title">Seasonal Outlook</p>' +
			'<p class="swo-teaser-sub">' + summaryLine + '</p>' +
			'</div>' +
			'<i class="fa-solid fa-chevron-down swo-chevron"></i>' +
			'</button>' +
			'<div class="swo-details">' +
			'<div class="swo-title-row">' +
			'<span class="swo-badge" style="' + iconStyle + '">' + season.label + '</span>' +
			'<span class="swo-month">' + monthName + '</span>' +
			'</div>' +
			'<p class="swo-reason">' + season.reason + '</p>' +
			buildDataCheckHtml(season.key, check) +
			'<p class="swo-footnote">The season above reflects general demand patterns for water production in Ghana, not this business\u2019s own figures. The "Your numbers" line is computed live from your recorded sales.</p>' +
			crossLinkHtml +
			'</div>' +
			'</div>';

		var card = container.querySelector('.swo-card');
		var teaser = container.querySelector('.swo-teaser');
		teaser.addEventListener('click', function () {
			var isOpen = card.classList.toggle('is-open');
			teaser.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
		});

		var crossLink = container.querySelector('#swo-crosslink');
		if (crossLink) {
			crossLink.addEventListener('click', function (e) {
				e.stopPropagation();
				window.openBusinessValueClock();
			});
		}
	}

	function initSeasonalOutlookWidget(containerId) {
		var container = document.getElementById(containerId || 'seasonal-outlook-widget');
		if (!container) return;
		ensureStyles();
		render(container);
	}

	window.initSeasonalOutlookWidget = initSeasonalOutlookWidget;
	window.refreshSeasonalOutlookWidget = function () { initSeasonalOutlookWidget(); };
	// Read-only snapshot of the current season + "your numbers" check, so
	// e.g. business-value-clock-widget.js can reference it without
	// depending on this widget's internals. Returns null until the widget
	// has rendered at least once.
	window.getSeasonalOutlookContext = function () { return lastContext; };
	// General calendar pattern for ANY month (0 = Jan), not just the current
	// one — used by the Business Value Clock to explain a specific past
	// month, since getSeasonalOutlookContext() only covers "now". Safe to
	// call even on pages that don't have a #seasonal-outlook-widget mount
	// point (e.g. business-value-clock.html), since this doesn't touch the
	// DOM.
	window.getSeasonMeta = function (monthIndex) {
		var entry = SEASON_CALENDAR[monthIndex];
		if (!entry) return null;
		return { key: entry.key, label: entry.label, reason: entry.reason };
	};

	document.addEventListener('DOMContentLoaded', function () {
		if (document.getElementById('seasonal-outlook-widget')) initSeasonalOutlookWidget();
	});

	// Refresh alongside the rest of the dashboard when sales data changes,
	// mirroring how business-value-clock-widget.js stays passive and lets
	// the host page decide when to re-render.
	document.addEventListener('ww-refresh-page', function () {
		if (document.getElementById('seasonal-outlook-widget')) initSeasonalOutlookWidget();
	});
})();