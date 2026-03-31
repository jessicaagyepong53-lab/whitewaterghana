const API_BASE = '';

/* ── Server persistence helpers ── */
function syncToServer(key, data) {
	const body = JSON.stringify({ data });
	const useKeepalive = body.length < 60000;
	return fetch(API_BASE + '/api/app-data/' + encodeURIComponent(key), {
		method: 'PUT', credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body,
		keepalive: useKeepalive,
	})
	.then(res => {
		if (!res.ok) console.error('[Sync] FAILED to save', key, '— HTTP', res.status);
		else console.log('[Sync] Saved', key, '✓');
		return res.ok;
	})
	.catch(err => {
		console.error('[Sync] Network error saving', key, err);
		return false;
	});
}

/* ── Seed flag helpers (synced to server so flags persist across devices) ── */
function _getSeedFlags() {
	try { return JSON.parse(localStorage.getItem('ww_seed_flags') || '{}'); } catch (_e) { return {}; }
}
function getSeedFlag(name) { return !!_getSeedFlags()[name]; }
function setSeedFlag(name) {
	const flags = _getSeedFlags();
	if (flags[name]) return;
	flags[name] = 1;
	localStorage.setItem('ww_seed_flags', JSON.stringify(flags));
	syncToServer('ww_seed_flags', flags);
}

async function loadFromServer(key) {
	try {
		const res = await fetch(API_BASE + '/api/app-data/' + encodeURIComponent(key), { credentials: 'include', cache: 'no-store' });
		if (res.ok) {
			const json = await res.json();
			if (json.data !== null && json.data !== undefined) {
				localStorage.setItem(key, JSON.stringify(json.data));
				return json.data;
			}
		}
	} catch (_e) { /* fall back to localStorage */ }
	return null;
}

async function loadBulkFromServer(keys) {
	try {
		const res = await fetch(API_BASE + '/api/app-data-bulk?keys=' + keys.map(encodeURIComponent).join(','), { credentials: 'include', cache: 'no-store' });
		if (res.ok) {
			const json = await res.json();
			if (json.items) {
				for (const [k, v] of Object.entries(json.items)) {
					if (v !== null && v !== undefined) localStorage.setItem(k, JSON.stringify(v));
				}
				return json.items;
			}
		}
	} catch (_e) { /* fall back to localStorage */ }
	return {};
}

function formatCurrency(value) {
	return `GH ${Number(value || 0).toLocaleString(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function formatNumber(value) {
	return Number(value || 0).toLocaleString();
}

function formatDateDisplay(dateStr) {
	if (!dateStr) return '—';
	const d = new Date(dateStr + 'T00:00:00');
	if (isNaN(d)) return dateStr;
	return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function statusPillClass(status) {
	const v = String(status || '').toLowerCase();
	if (['paid', 'delivered', 'operational', 'active', 'ready for sale', 'adequate', 'confirmed', 'received'].includes(v)) {
		return 'status-green';
	}
	if (v === 'pending_approval') {
		return 'status-orange';
	}
	if (['pending', 'processing', 'shipped', 'in production', 'low', 'needs_repair', 'needs repair', 'watch'].includes(v)) {
		return 'status-yellow';
	}
	if (['overdue', 'faulty', 'critical', 'faulty_needs_repair', 'inactive', 'delayed'].includes(v)) {
		return 'status-red';
	}
	return 'status-blue';
}

function statusDotClass(status) {
	const v = String(status || '').toLowerCase();
	if (['operational', 'active', 'good'].includes(v)) {
		return 'dot-green';
	}
	if (['needs_repair', 'needs repair', 'watch'].includes(v)) {
		return 'dot-yellow';
	}
	if (['faulty', 'faulty_needs_repair', 'inactive'].includes(v)) {
		return 'dot-red';
	}
	return 'dot-blue';
}

function switchTab(scope, tabName) {
	const allPanels = document.querySelectorAll(`[id^="${scope}-tab-"]`);
	const allButtons = document.querySelectorAll(`button[onclick*="switchTab('${scope}'"]`);

	allPanels.forEach((panel) => panel.classList.remove('tab-active'));
	allButtons.forEach((btn) => btn.classList.remove('tab-active'));

	const nextPanel = document.getElementById(`${scope}-tab-${tabName}`);
	if (nextPanel) {
		nextPanel.classList.add('tab-active');
	}

	allButtons.forEach((btn) => {
		if (btn.getAttribute('data-tab') === tabName) {
			btn.classList.add('tab-active');
		}
	});
}

window.switchTab = switchTab;

function renderProgressBars(container, rows) {
	if (!container) {
		return;
	}
	container.innerHTML = rows.map((row) => {
		return `
			<div class="progress-row">
				<div class="progress-label">${row.label}</div>
				<div class="progress-track"><div class="progress-fill ${row.color || ''}" style="width:${row.value}%"></div></div>
				<div class="progress-val">${row.value}%</div>
			</div>
		`;
	}).join('');
}

function renderVerticalBars(container, rows, config) {
	if (!container) {
		return;
	}

	const maxValue = Math.max(...rows.map((r) => r.value), 1);
	container.innerHTML = `
		<div style="display:flex;align-items:flex-end;gap:10px;height:180px;padding-top:8px;position:relative;">
			${rows.map((r) => {
				const height = Math.max(12, Math.round((r.value / maxValue) * 100));
				const displayVal = config.valueFormatter ? config.valueFormatter(r.value) : r.value;
				return `
					<div class="vbar-col" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;position:relative;cursor:pointer;" data-tooltip="${r.label}: ${displayVal}">
						<div class="vbar-value" style="font-size:11px;color:#64748b;opacity:0;transition:opacity .2s;">${displayVal}</div>
						<div class="vbar-bar" style="width:100%;height:${height}%;max-height:140px;background:${config.color || 'linear-gradient(180deg,#38bdf8,#0077b6)'};border-radius:8px 8px 3px 3px;transition:filter .2s,transform .2s;"></div>
						<div style="font-size:11px;color:#334155;font-weight:600;">${r.label}</div>
					</div>
				`;
			}).join('')}
		</div>
	`;
}

function renderDualBars(container, rows) {
	if (!container) {
		return;
	}
	const maxValue = Math.max(...rows.flatMap((r) => [r.revenue, r.cost]), 1);
	container.innerHTML = rows.map((row) => {
		const revPct = (row.revenue / maxValue) * 100;
		const costPct = (row.cost / maxValue) * 100;
		return `
			<div class="dbar-row" style="margin-bottom:10px;cursor:pointer;padding:6px 8px;border-radius:8px;transition:background .2s;">
				<div style="display:flex;justify-content:space-between;font-size:12px;color:#334155;margin-bottom:5px;"><strong>${row.month}</strong><span class="dbar-detail" style="opacity:0.4;transition:opacity .2s;">${formatCurrency(row.revenue)} / ${formatCurrency(row.cost)}</span></div>
				<div style="display:grid;gap:4px;">
					<div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;"><div class="dbar-fill" style="height:100%;width:${revPct}%;background:linear-gradient(90deg,#16a34a,#22c55e);border-radius:999px;transition:transform .2s;"></div></div>
					<div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;"><div class="dbar-fill" style="height:100%;width:${costPct}%;background:linear-gradient(90deg,#d97706,#f59e0b);border-radius:999px;transition:transform .2s;"></div></div>
				</div>
			</div>
		`;
	}).join('');
}

function renderDashboardCharts(revenueData, dailySales) {
	if (typeof Chart === 'undefined') {
		// Fallback to existing lightweight renderers if Chart.js is unavailable.
		renderDualBars(document.getElementById('chart-rev-cost'), revenueData);
		renderVerticalBars(document.getElementById('chart-daily-sales'), dailySales, {
			color: 'linear-gradient(180deg,#60a5fa,#0077b6)',
			valueFormatter: (v) => formatNumber(v),
		});
		return;
	}

	const revContainer = document.getElementById('chart-rev-cost');
	const salesContainer = document.getElementById('chart-daily-sales');
	if (!revContainer || !salesContainer) {
		return;
	}

	revContainer.innerHTML = '<canvas id="rev-cost-canvas" aria-label="Revenue and Cost trend chart"></canvas>';
	salesContainer.innerHTML = '<canvas id="daily-sales-canvas" aria-label="Daily sales bar chart"></canvas>';

	const revCtx = document.getElementById('rev-cost-canvas');
	const salesCtx = document.getElementById('daily-sales-canvas');
	if (!revCtx || !salesCtx) {
		return;
	}

	if (window.__dashRevCostChart) {
		window.__dashRevCostChart.destroy();
	}
	if (window.__dashDailySalesChart) {
		window.__dashDailySalesChart.destroy();
	}

	window.__dashRevCostChart = new Chart(revCtx, {
		type: 'bar',
		data: {
			labels: revenueData.map((d) => d.month),
			datasets: [
				{
					label: 'Revenue',
					data: revenueData.map((d) => d.revenue),
					borderColor: '#16a34a',
					backgroundColor: 'rgba(22,163,74,0.7)',
					borderWidth: 1,
					borderRadius: 6,
				},
				{
					label: 'Costs',
					data: revenueData.map((d) => d.cost),
					borderColor: '#f59e0b',
					backgroundColor: 'rgba(245,158,11,0.7)',
					borderWidth: 1,
					borderRadius: 6,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}`,
					},
				},
			},
			scales: {
				y: {
					beginAtZero: false,
					ticks: {
						callback: (value) => formatCurrency(value),
					},
				},
			},
		},
	});

	window.__dashDailySalesChart = new Chart(salesCtx, {
		type: 'bar',
		data: {
			labels: dailySales.map((d) => d.label),
			datasets: [
				{
					label: 'Daily Sales (Units)',
					data: dailySales.map((d) => d.value),
					backgroundColor: 'rgba(37,99,235,0.75)',
					borderColor: '#1d4ed8',
					borderWidth: 1,
					borderRadius: 6,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => `Units: ${formatNumber(ctx.parsed.y)}`,
					},
				},
			},
			scales: {
				y: {
					beginAtZero: true,
					ticks: {
						callback: (value) => formatNumber(value),
					},
				},
			},
		},
	});
}

function renderProfitLossChart(revenueData) {
	const plContainer = document.getElementById('chart-profit-loss');
	const plSummary = document.getElementById('dash-pl-summary');
	if (!plContainer) return;

	const totalRevenue = revenueData.reduce((s, d) => s + d.revenue, 0);
	const totalCost = revenueData.reduce((s, d) => s + d.cost, 0);
	const totalPL = totalRevenue - totalCost;
	const plClass = totalPL >= 0 ? 'color:#22c55e' : 'color:#ef4444';

	if (plSummary) {
		plSummary.innerHTML = `
			<div style="display:flex;flex-direction:column;gap:14px;padding:10px 0;">
				<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#f0fdf4;border-radius:10px;">
					<span style="font-weight:600;color:#334155;">Total Revenue</span>
					<span style="font-weight:700;color:#16a34a;font-size:1.15rem;">${formatCurrency(totalRevenue)}</span>
				</div>
				<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#fef3c7;border-radius:10px;">
					<span style="font-weight:600;color:#334155;">Total Costs</span>
					<span style="font-weight:700;color:#d97706;font-size:1.15rem;">${formatCurrency(totalCost)}</span>
				</div>
				<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:${totalPL >= 0 ? '#f0fdf4' : '#fef2f2'};border-radius:10px;border:2px solid ${totalPL >= 0 ? '#22c55e' : '#ef4444'};">
					<span style="font-weight:700;color:#0f172a;font-size:1.05rem;">${totalPL >= 0 ? 'Net Profit' : 'Net Loss'}</span>
					<span style="font-weight:800;${plClass};font-size:1.3rem;">${formatCurrency(Math.abs(totalPL))}</span>
				</div>
				<div style="font-size:12px;color:#64748b;text-align:center;">Margin: ${totalRevenue > 0 ? ((totalPL / totalRevenue) * 100).toFixed(1) : '0.0'}%</div>
			</div>
		`;
	}

	if (typeof Chart === 'undefined') {
		// Fallback: simple bar rendering
		const maxAbs = Math.max(...revenueData.map((d) => Math.abs(d.profitLoss)), 1);
		plContainer.innerHTML = revenueData.map((row) => {
			const isProfit = row.profitLoss >= 0;
			const pct = (Math.abs(row.profitLoss) / maxAbs) * 100;
			const color = isProfit ? '#22c55e' : '#ef4444';
			return `
				<div style="margin-bottom:8px;padding:6px 8px;border-radius:8px;">
					<div style="display:flex;justify-content:space-between;font-size:12px;color:#334155;margin-bottom:4px;"><strong>${row.month}</strong><span style="color:${color};font-weight:600;">${isProfit ? '+' : ''}${formatCurrency(row.profitLoss)}</span></div>
					<div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${color};border-radius:999px;"></div></div>
				</div>
			`;
		}).join('');
		return;
	}

	plContainer.innerHTML = '<canvas id="pl-canvas" aria-label="Profit and Loss chart"></canvas>';
	const plCtx = document.getElementById('pl-canvas');
	if (!plCtx) return;

	if (window.__dashPLChart) window.__dashPLChart.destroy();

	const plValues = revenueData.map((d) => d.profitLoss);
	const barColors = plValues.map((v) => v >= 0 ? 'rgba(34,197,94,0.75)' : 'rgba(239,68,68,0.75)');
	const borderColors = plValues.map((v) => v >= 0 ? '#16a34a' : '#dc2626');

	window.__dashPLChart = new Chart(plCtx, {
		type: 'bar',
		data: {
			labels: revenueData.map((d) => d.month),
			datasets: [{
				label: 'Profit / Loss',
				data: plValues,
				backgroundColor: barColors,
				borderColor: borderColors,
				borderWidth: 1,
				borderRadius: 6,
			}],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => {
							const v = ctx.parsed.y;
							return `${v >= 0 ? 'Profit' : 'Loss'}: ${formatCurrency(Math.abs(v))}`;
						},
					},
				},
			},
			scales: {
				y: {
					ticks: { callback: (value) => formatCurrency(value) },
				},
			},
		},
	});
}

const factoryEquipment = [
	{
		code: 'EQ-101',
		equipment: 'Koyo Packaging Machine #1',
		details: 'with UV, pump, and stainless housing',
		status: 'operational',
		lastMaintenance: '2026-03-18',
		nextMaintenance: '2026-04-18',
	},
	{
		code: 'EQ-102',
		equipment: 'Koyo Packaging Machine #2',
		details: 'with UV, pump, and stainless housing',
		status: 'operational',
		lastMaintenance: '2026-03-17',
		nextMaintenance: '2026-04-17',
	},
	{
		code: 'EQ-103',
		equipment: 'Koyo Packaging Machine #3',
		details: 'with UV, pump, and stainless housing',
		status: 'operational',
		lastMaintenance: '2026-03-16',
		nextMaintenance: '2026-04-16',
	},
	{
		code: 'EQ-104',
		equipment: 'Koyo Packaging Machine #4',
		details: 'with UV, pump, and stainless housing',
		status: 'needs_repair',
		lastMaintenance: '2026-03-09',
		nextMaintenance: '2026-04-09',
	},
	{
		code: 'EQ-105',
		equipment: 'Koyo Packaging Machine #5',
		details: 'with UV, pump, and stainless housing',
		status: 'operational',
		lastMaintenance: '2026-03-14',
		nextMaintenance: '2026-04-14',
	},
	{
		code: 'EQ-106',
		equipment: 'Reverse Osmosis (R/O) Machine',
		details: '4-ton capacity incl. filtration apparatus',
		status: 'operational',
		lastMaintenance: '2026-03-12',
		nextMaintenance: '2026-04-12',
	},
	{
		code: 'EQ-107',
		equipment: 'Reverse Osmosis (R/O) Machine',
		details: '6-ton capacity incl. filtration apparatus',
		status: 'faulty',
		lastMaintenance: '2026-03-05',
		nextMaintenance: '2026-04-05',
	},
];

function getFactoryEquipment() {
	return factoryEquipment;
}

function getEquipmentStatusLabel(status, shortLabel) {
	if (status === 'operational') {
		return 'Operational';
	}
	if (status === 'needs_repair') {
		return shortLabel ? 'Needs Repair (R)' : 'Needs Repair';
	}
	if (status === 'faulty') {
		return 'Faulty';
	}
	if (status === 'faulty_needs_repair') {
		return shortLabel ? 'Faulty + Repair (F + R)' : 'Faulty + Repair';
	}
	return 'Watch';
}

function getEquipmentIssues(status) {
	if (status === 'faulty_needs_repair') {
		return 'F + R';
	}
	if (status === 'faulty') {
		return 'F';
	}
	if (status === 'needs_repair') {
		return 'R';
	}
	return '-';
}

function isEquipmentWarningStatus(status) {
	return ['needs_repair', 'faulty', 'faulty_needs_repair'].includes(status);
}

function getEquipmentWarningNote(status) {
	if (status === 'faulty_needs_repair') {
		return 'Faulty and needs repair';
	}
	if (status === 'faulty') {
		return 'Faulty';
	}
	if (status === 'needs_repair') {
		return 'Needs repair';
	}
	return '';
}

function getEquipmentWarningTone(status) {
	if (status === 'faulty' || status === 'faulty_needs_repair') {
		return 'danger';
	}
	if (status === 'needs_repair') {
		return 'warning';
	}
	return '';
}

function renderEquipmentLabel(eq) {
	const tone = getEquipmentWarningTone(eq.status);
	const warningMarkup = isEquipmentWarningStatus(eq.status)
		? `<span class="equipment-warning-flag ${tone ? `equipment-warning-flag-${tone}` : ''}"><i class="fa-solid fa-triangle-exclamation"></i>${getEquipmentWarningNote(eq.status)}</span>`
		: '';

	return `<span class="equipment-main">${eq.equipment}</span><span class="equipment-sub">${eq.details || ''}</span>${warningMarkup}`;
}

function normalizeRole(role) {
	const value = String(role || '').trim().toLowerCase();
	if (value === 'employee') {
		return 'staff';
	}
	return value;
}

async function resolveCurrentUserRole() {
	if (window.__wwUserRole) {
		return window.__wwUserRole;
	}

	const fromQuery = normalizeRole(new URLSearchParams(window.location.search).get('role'));
	if (fromQuery) {
		localStorage.setItem('ww_user_role', fromQuery);
	}

	try {
		const response = await fetch(API_BASE + '/api/auth/me', { credentials: 'include' });
		if (response.ok) {
			const data = await response.json();
			const apiRole = normalizeRole(data?.user?.role);
			if (apiRole) {
				window.__wwUserRole = apiRole;
				localStorage.setItem('ww_user_role', apiRole);
				return apiRole;
			}
		}
	} catch (_error) {
		// Fall back to stored role.
	}

	const storedRole = normalizeRole(localStorage.getItem('ww_user_role'));
	window.__wwUserRole = storedRole || 'staff';
	return window.__wwUserRole;
}

// ── Role-Based Access Control ──
const ROLE_PAGE_ACCESS = {
	ceo:        ['dashboard', 'inventory', 'invoices', 'sales', 'vendors', 'accounting', 'production', 'reports', 'users'],
	manager:    ['dashboard', 'inventory', 'invoices', 'sales', 'vendors', 'accounting', 'production', 'reports', 'users'],
	supervisor: ['inventory', 'invoices', 'sales', 'vendors'],
	staff:      ['inventory', 'invoices', 'sales', 'vendors'],
};

const PAGE_TO_HREF = {
	dashboard: 'dashboard.html',
	inventory: 'inventory.html',
	invoices: 'invoices.html',
	sales: 'sales.html',
	vendors: 'vendors.html',
	accounting: 'accounting.html',
	production: 'production.html',
	reports: 'reports.html',
	users: 'users.html',
};

function resolvePageHref(pageKey) {
	const fileName = PAGE_TO_HREF[pageKey] || 'dashboard.html';
	return window.location.pathname.includes('/pages/') ? fileName : `pages/${fileName}`;
}

function canEditDelete(role) {
	return role === 'ceo' || role === 'manager' || role === 'supervisor';
}

function enforceRoleAccess() {
	// Resolve role from query string first, then localStorage
	const fromQuery = normalizeRole(new URLSearchParams(window.location.search).get('role'));
	if (fromQuery) {
		localStorage.setItem('ww_user_role', fromQuery);
	}
	const role = fromQuery || normalizeRole(localStorage.getItem('ww_user_role')) || 'staff';
	window.__wwUserRole = role;
	const currentPage = document.body.getAttribute('data-page');
	if (!currentPage) return;

	const allowed = ROLE_PAGE_ACCESS[role] || ROLE_PAGE_ACCESS.staff;

	// Redirect if page not allowed
	if (!allowed.includes(currentPage)) {
		const fallback = allowed[0] || 'dashboard';
		window.location.href = resolvePageHref(fallback);
		return;
	}

	// Hide sidebar links for pages not allowed
	const nav = document.querySelector('.ops-nav');
	if (nav) {
		nav.querySelectorAll('a[href]').forEach((link) => {
			const href = link.getAttribute('href');
			if (href.includes('login') || link.classList.contains('logout-link')) return;
			const pageName = Object.entries(PAGE_TO_HREF).find(([, h]) => href.includes(h));
			if (pageName && !allowed.includes(pageName[0])) {
				link.style.display = 'none';
			}
		});
	}

	// Hide edit/delete buttons for supervisor & staff
	if (!canEditDelete(role)) {
		document.querySelectorAll('.btn-edit, .btn-delete, [data-action="edit"], [data-action="delete"]').forEach((btn) => {
			btn.style.display = 'none';
		});

		// Add a class so JS can check permission before showing edit/delete in dynamic content
		document.body.classList.add('role-restricted');
	}

	// Show role badge in topbar
	const topbar = document.querySelector('.ops-topbar');
	if (topbar && !topbar.querySelector('.role-badge')) {
		const badge = document.createElement('span');
		badge.className = 'role-badge';
		badge.textContent = role.charAt(0).toUpperCase() + role.slice(1);
		badge.style.cssText = 'margin-left:auto;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;background:rgba(0,119,182,0.1);color:#0077b6;';
		topbar.appendChild(badge);
	}
}

/* ── Sidebar Collapse Toggle ── */
function initSidebarToggle() {
	const sidebar = document.getElementById('ops-sidebar');
	const brand = sidebar?.querySelector('.sidebar-brand');
	if (!brand) return;

	// Create the expand button (shown when collapsed)
	let expandBtn = document.querySelector('.sidebar-expand-btn');
	if (!expandBtn) {
		expandBtn = document.createElement('button');
		expandBtn.className = 'sidebar-expand-btn';
		expandBtn.title = 'Expand sidebar';
		expandBtn.innerHTML = '<i class="fa-solid fa-bars"></i>';
		document.body.appendChild(expandBtn);
	}

	// Restore previous state
	const storedSidebar = localStorage.getItem('ww_sidebar_collapsed');
	if (storedSidebar === '1') {
		document.body.classList.add('sidebar-collapsed');
	} else if (storedSidebar === null && window.matchMedia('(max-width: 920px)').matches) {
		document.body.classList.add('sidebar-collapsed');
		localStorage.setItem('ww_sidebar_collapsed', '1');
	}

	brand.addEventListener('click', () => {
		document.body.classList.add('sidebar-collapsed');
		localStorage.setItem('ww_sidebar_collapsed', '1');
	});

	expandBtn.addEventListener('click', () => {
		document.body.classList.remove('sidebar-collapsed');
		localStorage.setItem('ww_sidebar_collapsed', '0');
	});
}

function bindLogoutLinks() {
	document.querySelectorAll('.logout-link').forEach((link) => {
		link.addEventListener('click', async (event) => {
			event.preventDefault();
			try {
				await fetch(API_BASE + '/api/auth/logout', { method: 'POST', credentials: 'include' });
			} catch (_error) {
				// Redirect anyway.
			}
			window.location.href = window.location.pathname.includes('/pages/') ? '../login.html' : 'login.html';
		});
	});
}

function getSystemUsers() {
	try { return JSON.parse(localStorage.getItem('ww_system_users') || '[]'); } catch (_e) { return []; }
}

function saveSystemUsers(users) {
	localStorage.setItem('ww_system_users', JSON.stringify(users));
}

function upsertSystemUser(name, email, role) {
	const users = getSystemUsers();
	const now = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	const existing = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
	if (existing) {
		existing.role = role.charAt(0).toUpperCase() + role.slice(1);
		existing.lastLogin = now;
		existing.status = 'Active';
		if (name && name !== existing.name) existing.name = name;
	} else {
		users.push({
			id: 'U' + Date.now(),
			name: name || email.split('@')[0],
			email: email,
			role: role.charAt(0).toUpperCase() + role.slice(1),
			status: 'Active',
			lastLogin: now,
		});
	}
	saveSystemUsers(users);
}

const EYE_CLOSED = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const EYE_OPEN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

function bindPasswordToggles() {
	document.querySelectorAll('.pwd-toggle').forEach((btn) => {
		btn.addEventListener('click', () => {
			const input = btn.parentElement.querySelector('input');
			if (!input) return;
			const visible = input.type === 'text';
			input.type = visible ? 'password' : 'text';
			btn.innerHTML = visible ? EYE_CLOSED : EYE_OPEN;
			btn.classList.toggle('active', !visible);
			btn.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
		});
	});
}

function getRoleLandingPage(role) {
	const ROLE_LANDING = {
		ceo: 'pages/dashboard.html',
		manager: 'pages/dashboard.html',
		supervisor: 'pages/inventory.html',
		staff: 'pages/inventory.html',
	};
	return ROLE_LANDING[role] || 'pages/dashboard.html';
}

function bindRolePersistenceOnAuthForms() {
	// ── Login form ──
	const loginForm = document.getElementById('login-form');
	if (loginForm) {
		loginForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			const formData = new FormData(loginForm);
			const email = String(formData.get('email') || '').trim();
			const password = String(formData.get('password') || '');
			const submitBtn = loginForm.querySelector('button[type="submit"]');

			try {
				if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing in…'; }
				const data = await postJson('/api/auth/login', { email, password });
				const role = normalizeRole(data.user?.role);
				localStorage.setItem('ww_user_role', role);
				upsertSystemUser(data.user?.name || '', email, role);
				setAuthMessage('Login successful! Redirecting…', false);
				if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Redirecting…'; }
				setTimeout(() => { window.location.href = getRoleLandingPage(role); }, 1000);
			} catch (error) {
				setAuthMessage(error.message || 'Invalid email or password.', true);
				if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign In'; }
			}
		});
	}

	// ── Register form ──
	const registerForm = document.getElementById('register-form');
	if (registerForm) {
		registerForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			const formData = new FormData(registerForm);
			const name = String(formData.get('full_name') || '').trim();
			const email = String(formData.get('email') || '').trim();
			const selectedRole = String(formData.get('role') || '');
			const password = String(formData.get('password') || '');
			const confirmPassword = String(formData.get('confirm_password') || '');
			const submitBtn = registerForm.querySelector('button[type="submit"]');

			if (!selectedRole) {
				setAuthMessage('Please select your role.', true);
				return;
			}

			if (password !== confirmPassword) {
				setAuthMessage('Passwords do not match.', true);
				return;
			}

			try {
				if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating account…'; }
				const data = await postJson('/api/auth/register', { name, email, password, role: selectedRole });
				const role = normalizeRole(data.user?.role);
				localStorage.setItem('ww_user_role', role);
				upsertSystemUser(name, email, role);
				setAuthMessage('Account created! Redirecting…', false);
				if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Redirecting…'; }
				setTimeout(() => { window.location.href = getRoleLandingPage(role); }, 1000);
			} catch (error) {
				setAuthMessage(error.message || 'Registration failed.', true);
				if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
			}
		});
	}
}

function getTodayDateStr() {
	return new Date().toISOString().slice(0, 10);
}

function loadFinishedProductsFromStorage() {
	try {
		return JSON.parse(localStorage.getItem('ww_finished_products') || '[]');
	} catch (_e) {
		return [];
	}
}

function saveFinishedProductsToStorage(products) {
	localStorage.setItem('ww_finished_products', JSON.stringify(products));
	syncToServer('ww_finished_products', products);
	rebuildDailyProductionLog(products);
	// Broadcast instantly to any open inventory/dashboard tab
	try {
		const bc = new BroadcastChannel('ww_finished_products_sync');
		bc.postMessage({ type: 'finished_products_updated' });
		bc.close();
	} catch (_e) { /* BroadcastChannel not supported — storage event is the fallback */ }
}

function rebuildDailyProductionLog(products) {
	const log = {};
	products.forEach((p) => {
		const date = p.addedDate || getTodayDateStr();
		log[date] = (log[date] || 0) + Number(p.qty || 0);
	});
	localStorage.setItem('ww_daily_production', JSON.stringify(log));
	syncToServer('ww_daily_production', log);
}

function getDailyProductionLog() {
	try {
		return JSON.parse(localStorage.getItem('ww_daily_production') || '{}');
	} catch (_e) {
		return {};
	}
}

function loadRawMaterialsFromStorage() {
	try {
		return JSON.parse(localStorage.getItem('ww_raw_materials') || '[]');
	} catch (_e) {
		return [];
	}
}

function saveRawMaterialsToStorage(materials) {
	localStorage.setItem('ww_raw_materials', JSON.stringify(materials));
	syncToServer('ww_raw_materials', materials);
	// Broadcast instantly to any open dashboard/inventory tab
	try {
		const bc = new BroadcastChannel('ww_raw_materials_sync');
		bc.postMessage({ type: 'raw_materials_updated' });
		bc.close();
	} catch (_e) { /* BroadcastChannel not supported — storage event is the fallback */ }
}

function loadEquipmentFromStorage() {
	try {
		const stored = JSON.parse(localStorage.getItem('ww_equipment') || '[]');
		if (Array.isArray(stored) && stored.length) {
			return stored;
		}
	} catch (_e) {
		// Fall through to defaults.
	}
	return getFactoryEquipment().map((eq) => ({ ...eq }));
}

async function fetchEquipmentFromServer() {
	try {
		const res = await fetch(API_BASE + '/api/factory-equipment', { credentials: 'include' });
		if (res.ok) {
			const rows = await res.json();
			if (Array.isArray(rows) && rows.length) {
				localStorage.setItem('ww_equipment', JSON.stringify(rows));
				return rows;
			}
		}
	} catch (_e) { /* fall back to localStorage */ }
	return loadEquipmentFromStorage();
}

function saveEquipmentToStorage(equipmentRows) {
	localStorage.setItem('ww_equipment', JSON.stringify(equipmentRows));
	// Broadcast instantly to any open dashboard/inventory tab
	try {
		const bc = new BroadcastChannel('ww_equipment_sync');
		bc.postMessage({ type: 'equipment_updated' });
		bc.close();
	} catch (_e) { /* BroadcastChannel not supported — storage event is the fallback */ }
}

function saveOneEquipmentToServer(eq) {
	if (eq.id) {
		fetch(API_BASE + '/api/factory-equipment/' + eq.id, {
			method: 'PUT', credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: eq.status, equipment: eq.equipment, details: eq.details, lastMaintenance: eq.lastMaintenance, nextMaintenance: eq.nextMaintenance }),
		}).catch(() => {});
	}
}

function calcWeeklyEfficiencyLabel(dailyLog, todayStr) {
	const oneDayMs = 86400000;
	const today = new Date(`${todayStr}T00:00:00`);

	const weekValues = [];
	const previousWeekValues = [];
	for (let i = 6; i >= 0; i -= 1) {
		const currentDate = new Date(today.getTime() - (i * oneDayMs));
		const previousDate = new Date(today.getTime() - ((i + 7) * oneDayMs));
		const currentKey = currentDate.toISOString().slice(0, 10);
		const previousKey = previousDate.toISOString().slice(0, 10);
		weekValues.push(Number(dailyLog[currentKey] || 0));
		previousWeekValues.push(Number(dailyLog[previousKey] || 0));
	}

	const currentWeekTotal = weekValues.reduce((sum, value) => sum + value, 0);
	const previousWeekTotal = previousWeekValues.reduce((sum, value) => sum + value, 0);

	let streakImprovedDays = 0;
	for (let i = 1; i < weekValues.length; i += 1) {
		if (weekValues[i] >= weekValues[i - 1]) {
			streakImprovedDays += 1;
		}
	}
	const streakPercent = Math.round((streakImprovedDays / 6) * 100);

	if (previousWeekTotal === 0) {
		if (currentWeekTotal === 0) {
			return 'No weekly production data yet';
		}
		return `${formatNumber(currentWeekTotal)} units this week • ${streakPercent}% weekly streak`;
	}

	const change = ((currentWeekTotal - previousWeekTotal) / previousWeekTotal) * 100;
	const sign = change >= 0 ? '+' : '';
	const trendText = change >= 0 ? 'going well' : 'not going well';
	return `${sign}${change.toFixed(1)}% vs last week • ${streakPercent}% weekly streak (${trendText})`;
}

function initDashboardPage() {
	if (document.body.getAttribute('data-page') !== 'dashboard') {
		return;
	}

	// ── Build revenue/cost chart from sales + production + accounting data ──
	const buildRevenueData = () => {
		const salesData = getAllSalesData();
		const batches = JSON.parse(localStorage.getItem('ww_production_batches') || '[]');
		const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const byMonth = {};
		const ensureMonth = (key) => { if (!byMonth[key]) byMonth[key] = { revenue: 0, cost: 0 }; };

		// Revenue from invoices (paid only — consistent with Sales & Accounting pages)
		for (const inv of salesData.invoices) {
			if (inv.status !== 'paid') continue;
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
			ensureMonth(key);
			byMonth[key].revenue += Number(inv.amount) || 0;
		}
		// (Sales orders mirror invoices — skip to avoid double-counting)
		// Production batch costs
		for (const b of batches) {
			const d = new Date(b.date);
			if (isNaN(d)) continue;
			const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
			ensureMonth(key);
			byMonth[key].cost += Number(b.cost) || 0;
		}
		// Accounting ledger expenses (operational costs, salaries mirrored to ledger)
		let acctData;
		try { acctData = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || 'null'); } catch (_) { acctData = null; }
		if (acctData) {
			const expenseAccounts = ['Transport', 'Production', 'Maintenance', 'Utilities', 'Administration', 'Marketing', 'Salaries', 'Salaries & Wages'];
			for (const entry of (acctData.ledger || [])) {
				if (!expenseAccounts.includes(entry.account)) continue;
				const d = new Date(entry.date);
				if (isNaN(d)) continue;
				const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
				ensureMonth(key);
				byMonth[key].cost += Number(entry.debit || entry.amount) || 0;
			}
		}

		const keys = Object.keys(byMonth).sort();
		const limit = keys.length <= 1 ? 1 : keys.length <= 3 ? 3 : keys.length <= 6 ? 6 : 12;
		return keys.slice(-limit).map((key) => {
			const mIdx = parseInt(key.split('-')[1], 10);
			const pl = byMonth[key].revenue - byMonth[key].cost;
			return { month: monthNames[mIdx], revenue: byMonth[key].revenue, cost: byMonth[key].cost, profitLoss: pl };
		});
	};

	// ── Build daily sales from last 7 days of sales data ──
	const buildDailySales = () => {
		const salesData = getAllSalesData();
		const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const now = new Date();
		const buckets = {};
		for (let i = 6; i >= 0; i--) {
			const d = new Date(now);
			d.setDate(d.getDate() - i);
			const key = d.toISOString().slice(0, 10);
			buckets[key] = { label: dayLabels[d.getDay()], value: 0 };
		}
		for (const inv of salesData.invoices) {
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			const key = d.toISOString().slice(0, 10);
			if (buckets[key]) {
				buckets[key].value += (inv.items || []).reduce((s, it) => s + it.qty, 0);
			}
		}
		for (const ord of salesData.salesOrders) {
			const d = new Date(ord.orderDate);
			if (isNaN(d)) continue;
			const key = d.toISOString().slice(0, 10);
			if (buckets[key]) {
				buckets[key].value += 1;
			}
		}
		return Object.values(buckets);
	};

	// ── Count active customers (appearing more than 5 times) from sales data ──
	const countActiveCustomers = () => {
		const salesData = getAllSalesData();
		const counts = {};
		salesData.invoices.forEach((inv) => { if (inv.customer) { const k = inv.customer.toLowerCase().trim(); counts[k] = (counts[k] || 0) + 1; } });
		salesData.salesOrders.forEach((ord) => { if (ord.customer) { const k = ord.customer.toLowerCase().trim(); counts[k] = (counts[k] || 0) + 1; } });
		return Object.values(counts).filter((c) => c > 5).length;
	};

	let equipmentStatus = loadEquipmentFromStorage();

	// Fetch fresh equipment from server and re-render when ready
	fetchEquipmentFromServer().then((serverEquipment) => {
		equipmentStatus = serverEquipment;
		renderDashboardEquipmentStatus();
	});

	const buildStockAlerts = () => {
		const liveRawMaterials = loadRawMaterialsFromStorage();
		if (liveRawMaterials.length) {
			return liveRawMaterials.map((m) => ({
				item: m.material || 'Raw Material',
				current: Number(m.quantity || 0),
				min: Number(m.minLevel || 0),
			}));
		}
		return [];
	};

	const renderDashboardLiveSummary = () => {
		const dailyLog = getDailyProductionLog();
		const todayStr = getTodayDateStr();
		const unitsProduced = Number(dailyLog[todayStr] || 0);
		const stockAlerts = buildStockAlerts();
		const stockAlertCount = stockAlerts.filter((a) => a.current < a.min).length;
		const stockCriticalCount = stockAlerts.filter((a) => a.current < a.min * 0.5).length;

		const revenueData = buildRevenueData();
		const revenueMtd = revenueData.length > 0 ? revenueData[revenueData.length - 1].revenue : 0;
		const prevRevenue = revenueData.length > 1 ? revenueData[revenueData.length - 2].revenue : 0;
		const revChange = prevRevenue > 0 ? (((revenueMtd - prevRevenue) / prevRevenue) * 100).toFixed(1) : 0;

		const activeCustomers = countActiveCustomers();

		const kpiCards = [
			{ icon: '<i class="fa-solid fa-cedi-sign"></i>', label: 'Total Revenue', value: formatCurrency(revenueMtd), meta: revenueMtd > 0 ? `${revChange >= 0 ? '+' : ''}${revChange}% vs previous month` : 'No sales data yet', color: 'blue', link: null },
			{ icon: '<i class="fa-solid fa-box"></i>', label: 'Units Produced', value: formatNumber(unitsProduced), meta: calcWeeklyEfficiencyLabel(dailyLog, todayStr), color: 'green', link: null },
			{ icon: '<i class="fa-solid fa-users"></i>', label: 'Active Customers', value: formatNumber(activeCustomers), meta: activeCustomers > 0 ? 'Unique customers from sales' : 'No customers yet', color: 'purple', link: null },
			{ icon: '<i class="fa-solid fa-triangle-exclamation"></i>', label: 'Stock Alerts', value: String(stockAlertCount), meta: `${stockCriticalCount} critically low \u2014 needs reorder`, color: stockCriticalCount > 0 ? 'red' : 'yellow', link: `${resolvePageHref('inventory')}?tab=materials` },
		];

		// Fetch online store stats (non-blocking)
		fetch(API_BASE + '/api/store/admin/stats').then((r) => r.ok ? r.json() : null).then((stats) => {
			if (!stats) return;
			const onlineKpi = document.getElementById('kpi-online-orders');
			if (onlineKpi) {
				onlineKpi.querySelector('.kpi-value').textContent = String(stats.pendingOrders);
				onlineKpi.querySelector('.kpi-meta').textContent = `${stats.orderCount} total · ${stats.customerCount} customers`;
			} else {
				const kpiGrid = document.getElementById('dash-kpi-grid');
				if (kpiGrid) {
					const card = document.createElement('article');
					card.className = 'kpi-card-dashboard kpi-card-link';
					card.id = 'kpi-online-orders';
					card.setAttribute('role', 'link');
					card.setAttribute('tabindex', '0');
					card.setAttribute('data-kpi-link', 'invoices.html');
					card.style.cursor = 'pointer';
					card.innerHTML = `
						<div class="kpi-head">
							<div>
								<p class="kpi-label">Online Orders</p>
								<p class="kpi-value">${stats.pendingOrders}</p>
							</div>
							<div class="kpi-icon-square ${stats.pendingOrders > 0 ? 'red' : 'green'}"><i class="fa-solid fa-globe"></i></div>
						</div>
						<p class="kpi-meta">${stats.orderCount} total · ${stats.customerCount} customers</p>
					`;
					card.addEventListener('click', () => { window.location.href = resolvePageHref('invoices'); });
					kpiGrid.appendChild(card);
				}
			}
		}).catch(() => {});

		const kpiGrid = document.getElementById('dash-kpi-grid');
		if (kpiGrid) {
			kpiGrid.innerHTML = kpiCards.map((kpi) => {
				const linkProps = kpi.link ? `role="link" tabindex="0" data-kpi-link="${kpi.link}" style="cursor:pointer;"` : '';
				return `
					<article class="kpi-card-dashboard${kpi.link ? ' kpi-card-link' : ''}" ${linkProps}>
						<div class="kpi-head">
							<div>
								<p class="kpi-label">${kpi.label}</p>
								<p class="kpi-value">${kpi.value}</p>
							</div>
							<div class="kpi-icon-square ${kpi.color}">${kpi.icon}</div>
						</div>
						<p class="kpi-meta">${kpi.meta}</p>
					</article>
				`;
			}).join('');
			kpiGrid.querySelectorAll('[data-kpi-link]').forEach((el) => {
				el.addEventListener('click', () => { window.location.href = el.getAttribute('data-kpi-link'); });
				el.addEventListener('keydown', (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						window.location.href = el.getAttribute('data-kpi-link');
					}
				});
			});
		}

		const alertFeed = document.getElementById('dash-alert-feed');
		if (alertFeed) {
			const criticalItems = stockAlerts.filter((a) => a.current < a.min * 0.5);
			const lowItems = stockAlerts.filter((a) => a.current >= a.min * 0.5 && a.current < a.min);
			const healthyItems = stockAlerts.filter((a) => a.current >= a.min);

			// Determine overall severity colour
			const bannerClass = criticalItems.length > 0 ? 'alert-banner-critical'
				: lowItems.length > 0 ? 'alert-banner-warning'
				: 'alert-banner-ok';
			const bannerIcon = criticalItems.length > 0 ? 'fa-circle-exclamation'
				: lowItems.length > 0 ? 'fa-triangle-exclamation'
				: 'fa-circle-check';
			const bannerText = criticalItems.length > 0
				? `${criticalItems.length} critical · ${lowItems.length} low · ${healthyItems.length} healthy`
				: lowItems.length > 0
				? `${lowItems.length} low stock · ${healthyItems.length} healthy`
				: `All ${healthyItems.length} materials at healthy levels`;

			const rows = stockAlerts.map((a) => {
				const isCritical = a.current < a.min * 0.5;
				const isLow = !isCritical && a.current < a.min;
				const rowClass = isCritical ? 'alert-row-critical' : isLow ? 'alert-row-warning' : 'alert-row-ok';
				const rowIcon = isCritical ? 'fa-circle-exclamation' : isLow ? 'fa-triangle-exclamation' : 'fa-circle-check';
				const level = isCritical ? 'Critical' : isLow ? 'Low' : 'Healthy';
				const pct = a.min > 0 ? Math.round((a.current / a.min) * 100) : 100;
				const barClass = isCritical ? 'alert-bar-critical' : isLow ? 'alert-bar-warning' : 'alert-bar-ok';
				return `
					<li class="alert-row ${rowClass}">
						<i class="fa-solid ${rowIcon} alert-row-icon"></i>
						<div class="alert-row-body">
							<div class="alert-row-top">
								<strong>${a.item}</strong>
								<span class="alert-level-badge alert-badge-${isCritical ? 'critical' : isLow ? 'warning' : 'ok'}">${level}</span>
							</div>
							<div class="alert-row-sub">${a.current} / ${a.min} units</div>
							<div class="alert-progress-track"><div class="alert-progress-bar ${barClass}" style="width:${Math.min(pct, 100)}%"></div></div>
						</div>
					</li>
				`;
			}).join('');

			const isOpen = alertFeed.dataset.open !== 'false'; // default open
			alertFeed.innerHTML = `
				<div class="alert-summary ${bannerClass}" id="dash-alert-summary" role="button" tabindex="0" aria-expanded="${isOpen}">
					<span class="alert-summary-left"><i class="fa-solid ${bannerIcon}"></i> ${bannerText}</span>
					<i class="fa-solid fa-chevron-down alert-chevron${isOpen ? ' open' : ''}"></i>
				</div>
				<ul class="alert-list${isOpen ? ' open' : ''}" id="dash-alert-list">${rows}</ul>
			`;

			const summary = document.getElementById('dash-alert-summary');
			const list = document.getElementById('dash-alert-list');
			const toggle = () => {
				const nowOpen = list.classList.toggle('open');
				alertFeed.dataset.open = String(nowOpen);
				summary.setAttribute('aria-expanded', String(nowOpen));
				summary.querySelector('.alert-chevron').classList.toggle('open', nowOpen);
			};
			summary.addEventListener('click', toggle);
			summary.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); });
		}

		const stamp = document.getElementById('dash-timestamp');
		if (stamp) {
			stamp.textContent = new Date().toLocaleString();
		}
	};

	renderDashboardLiveSummary();

	const revData = buildRevenueData();
	renderDashboardCharts(revData, buildDailySales());
	renderProfitLossChart(revData);

	const equipmentPanel = document.getElementById('dash-equipment-panel');
	const equipmentContent = document.getElementById('dash-equipment-content');
	const renderDashboardEquipmentStatus = () => {
		equipmentStatus = loadEquipmentFromStorage();
		if (!equipmentContent) {
			return;
		}
		const faultyList = equipmentStatus.filter((eq) => ['faulty', 'faulty_needs_repair'].includes(eq.status));
		const repairList = equipmentStatus.filter((eq) => eq.status === 'needs_repair');
		const allOperational = faultyList.length === 0 && repairList.length === 0;
		const criticalFault = faultyList.length > 2;

		if (equipmentPanel) {
			equipmentPanel.classList.remove('eq-panel-all-ok', 'eq-panel-critical');
			if (allOperational) equipmentPanel.classList.add('eq-panel-all-ok');
			else if (criticalFault) equipmentPanel.classList.add('eq-panel-critical');
		}

		const rowsMarkup = equipmentStatus.map((eq, idx) => {
			const issues = getEquipmentIssues(eq.status);
			const tone = getEquipmentWarningTone(eq.status);
			const statusOptions = [
				{ value: 'operational', label: 'Operational' },
				{ value: 'needs_repair', label: 'Needs Repair' },
				{ value: 'faulty', label: 'Faulty' },
				{ value: 'faulty_needs_repair', label: 'Faulty + Repair' },
			].map((o) => `<option value="${o.value}"${eq.status === o.value ? ' selected' : ''}>${o.label}</option>`).join('');
			const selectClass = eq.status === 'operational' ? 'eq-sel-ok' : eq.status === 'needs_repair' ? 'eq-sel-warning' : 'eq-sel-danger';
			return `
				<tr class="${isEquipmentWarningStatus(eq.status) ? `equipment-warning-row equipment-warning-row-${tone}` : ''}">
					<td>${eq.code}</td>
					<td>${renderEquipmentLabel(eq)}</td>
					<td>
						<select class="eq-status-select ${selectClass}" data-dash-eq-idx="${idx}">${statusOptions}</select>
					</td>
					<td><span class="badge ${issues === '-' ? 'badge-green' : issues === 'R' ? 'badge-yellow' : 'badge-red'}">${issues}</span></td>
					<td>${formatDateDisplay(eq.lastMaintenance)}</td>
					<td>${formatDateDisplay(eq.nextMaintenance)}</td>
				</tr>
			`;
		}).join('');

		// Build coloured per-type chips for the footer
		const operationalCount = equipmentStatus.filter((eq) => eq.status === 'operational').length;
		const faultyOnlyCount = equipmentStatus.filter((eq) => eq.status === 'faulty').length;
		const faultyRepairCount = equipmentStatus.filter((eq) => eq.status === 'faulty_needs_repair').length;
		const repairOnlyCount = equipmentStatus.filter((eq) => eq.status === 'needs_repair').length;

		const chips = [];
		if (faultyOnlyCount)   chips.push(`<span class="eq-footer-chip eq-chip-danger"><i class="fa-solid fa-circle-xmark"></i> ${faultyOnlyCount} Faulty</span>`);
		if (faultyRepairCount) chips.push(`<span class="eq-footer-chip eq-chip-danger"><i class="fa-solid fa-circle-xmark"></i> ${faultyRepairCount} Faulty + Repair</span>`);
		if (repairOnlyCount)   chips.push(`<span class="eq-footer-chip eq-chip-warning"><i class="fa-solid fa-triangle-exclamation"></i> ${repairOnlyCount} Needs Repair</span>`);
		if (operationalCount)  chips.push(`<span class="eq-footer-chip eq-chip-ok"><i class="fa-solid fa-circle-check"></i> ${operationalCount} Operational</span>`);

		const footerClass = faultyList.length > 0 ? 'eq-footer-danger' : repairList.length > 0 ? 'eq-footer-warning' : 'eq-footer-ok';

		equipmentContent.innerHTML = `
			<div class="eq-table-wrapper">
				<table class="data-table">
					<thead>
						<tr>
							<th>Code</th>
							<th>Equipment</th>
							<th>Status</th>
							<th>Issues</th>
							<th>Last Maintenance</th>
							<th>Next Maintenance</th>
						</tr>
					</thead>
					<tbody id="dash-equipment-tbody">${rowsMarkup}</tbody>
				</table>
			</div>
			<div class="eq-status-footer ${footerClass}">
				<span class="eq-footer-label"><i class="fa-solid fa-chart-simple"></i> ${equipmentStatus.length} machine${equipmentStatus.length !== 1 ? 's' : ''} total</span>
				<div class="eq-footer-chips">${chips.join('')}</div>
			</div>
		`;

		// Allow editing status directly from dashboard — changes sync back to inventory
		const dashTbody = document.getElementById('dash-equipment-tbody');
		if (dashTbody) {
			dashTbody.onchange = (e) => {
				const sel = e.target.closest('select[data-dash-eq-idx]');
				if (!sel) return;
				const idx = Number(sel.dataset.dashEqIdx);
				if (!equipmentStatus[idx]) return;
				equipmentStatus[idx].status = sel.value;
				saveOneEquipmentToServer(equipmentStatus[idx]);
				saveEquipmentToStorage(equipmentStatus);
				renderDashboardEquipmentStatus();
			};
		}
	};
	renderDashboardEquipmentStatus();

	if (!window.__wwDashboardStorageBound) {
		window.__wwDashboardStorageBound = true;

		// Cross-tab: localStorage storage event
		window.addEventListener('storage', (event) => {
			const dashKeys = ['ww_raw_materials', 'ww_daily_production', 'ww_equipment', 'ww_production_batches', 'ww_accounting_data_v2', 'ww_purchase_data_v2'];
			if (dashKeys.includes(event.key) || (event.key && event.key.startsWith('ww_sales_'))) {
				const rd = buildRevenueData();
				renderDashboardLiveSummary();
				renderDashboardEquipmentStatus();
				renderDashboardCharts(rd, buildDailySales());
				renderProfitLossChart(rd);
			}
		});

		// Instant cross-tab via BroadcastChannel for sales updates
		try {
			const salesDashChannel = new BroadcastChannel('ww_sales_sync');
			salesDashChannel.onmessage = () => {
				const rd = buildRevenueData();
				renderDashboardLiveSummary();
				renderDashboardCharts(rd, buildDailySales());
				renderProfitLossChart(rd);
			};
		} catch (_e) { /* ignore */ }

		// Instant cross-tab via BroadcastChannel (fires the moment inventory saves)
		try {
			const eqChannel = new BroadcastChannel('ww_equipment_sync');
			eqChannel.onmessage = (e) => {
				if (e.data && e.data.type === 'equipment_updated') {
					renderDashboardEquipmentStatus();
				}
			};
			window.__wwEqChannel = eqChannel;
		} catch (_e) { /* fallback to storage event */ }

		try {
			const rawChannel = new BroadcastChannel('ww_raw_materials_sync');
			rawChannel.onmessage = (e) => {
				if (e.data && e.data.type === 'raw_materials_updated') {
					renderDashboardLiveSummary();
				}
			};
			window.__wwRawChannel = rawChannel;
		} catch (_e) { /* fallback to storage event */ }

		// Instant cross-tab: accounting changes
		try {
			const acctChannel = new BroadcastChannel('ww_accounting_sync');
			acctChannel.onmessage = () => {
				const rd = buildRevenueData();
				renderDashboardLiveSummary();
				renderDashboardCharts(rd, buildDailySales());
				renderProfitLossChart(rd);
			};
		} catch (_e) { /* fallback to storage event */ }

		// Instant cross-tab: purchase changes
		try {
			const purchChannel = new BroadcastChannel('ww_purchase_sync');
			purchChannel.onmessage = () => {
				const rd = buildRevenueData();
				renderDashboardLiveSummary();
				renderDashboardCharts(rd, buildDailySales());
				renderProfitLossChart(rd);
			};
		} catch (_e) { /* fallback to storage event */ }
	}

	// Fallback poll every 3 s (same-tab or unsupported browsers)
	if (window.__wwDashboardLiveTimer) {
		clearInterval(window.__wwDashboardLiveTimer);
	}
	window.__wwDashboardLiveTimer = setInterval(() => {
		const rd = buildRevenueData();
		renderDashboardLiveSummary();
		renderDashboardEquipmentStatus();
		renderDashboardCharts(rd, buildDailySales());
		renderProfitLossChart(rd);
	}, 3000);
}

async function initInventoryPage() {
	if (document.body.getAttribute('data-page') !== 'inventory') {
		return;
	}

	const userRole = await resolveCurrentUserRole();
	const canAdd = ['ceo', 'manager', 'supervisor'].includes(userRole);

	let rawMaterials = loadRawMaterialsFromStorage();
	let finishedProducts = loadFinishedProductsFromStorage();
	let equipment = await fetchEquipmentFromServer();
	let customers = [];

	const nextNumericId = (rows) => rows.reduce((maxId, row) => Math.max(maxId, Number(row.id || 0)), 0) + 1;

	const bindStatsCardLink = (cardId, tabName, panelId) => {
		const card = document.getElementById(cardId);
		if (!card || card.dataset.bound === '1') {
			return;
		}
		const openTargetTab = () => {
			switchTab('inv', tabName);
			const tablePanel = document.getElementById(panelId);
			if (tablePanel) {
				tablePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		};

		card.addEventListener('click', openTargetTab);
		card.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				openTargetTab();
			}
		});
		card.dataset.bound = '1';
	};

	const renderStats = () => {
		const lowCount = rawMaterials.filter((m) => m.quantity < m.minLevel).length;
		const criticalCount = rawMaterials.filter((m) => m.quantity < m.minLevel * 0.5).length;
		const rawMaterialUnits = rawMaterials.reduce((sum, m) => sum + Number(m.quantity || 0), 0);
		const readyQty = finishedProducts.filter((p) => p.status === 'ready for sale').reduce((sum, p) => sum + p.qty, 0);
		const statsContainer = document.getElementById('inv-stats-row');
		if (statsContainer) {
			statsContainer.innerHTML = `
				<div class="stat-card stat-card-link" id="inv-raw-materials-card" role="button" tabindex="0" aria-label="Open raw materials table"><div class="s-icon"><i class="fa-solid fa-layer-group"></i></div><p class="s-label">Raw Materials</p><p class="s-value" id="inv-raw-materials-value">${rawMaterials.length}</p><p class="s-meta" id="inv-raw-materials-meta">${formatNumber(rawMaterialUnits)} total units in stock.</p></div>
				<div class="stat-card stat-card-link" id="inv-finished-products-card" role="button" tabindex="0" aria-label="Open finished products table"><div class="s-icon"><i class="fa-solid fa-box-open"></i></div><p class="s-label">Finished Products</p><p class="s-value">${formatNumber(readyQty)}</p><p class="s-meta">Units available for distribution</p></div>
				<a class="stat-card stat-card-link" id="inv-low-stock-card" href="dashboard.html#dash-stock-alerts-panel" aria-label="Open stock alerts on dashboard" style="text-decoration:none;color:inherit;display:block;"><div class="s-icon"><i class="fa-solid fa-triangle-exclamation"></i></div><p class="s-label">Low Stock</p><p class="s-value">${lowCount}</p><p class="s-meta">${criticalCount} critically low \u2014 needs reorder</p></a>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-users"></i></div><p class="s-label">Active Customers</p><p class="s-value">${customers.filter((c) => c.status === 'active').length}</p><p class="s-meta">Distribution partners</p></div>
			`;
		}
		bindStatsCardLink('inv-raw-materials-card', 'materials', 'inv-tab-materials');
		bindStatsCardLink('inv-finished-products-card', 'products', 'inv-tab-products');

		document.querySelectorAll('.table-add-btn').forEach((button) => {
			button.disabled = !canAdd;
			button.title = canAdd ? 'Add a new row' : 'You do not have permission to add rows';
		});
	};

	const renderMaterials = () => {
		const materialsBody = document.getElementById('inv-materials-tbody');
		if (!materialsBody) {
			return;
		}
		materialsBody.innerHTML = rawMaterials.map((m, idx) => {
			const isCritical = m.quantity < m.minLevel * 0.5;
			const isLow = m.quantity < m.minLevel;
			const statusLabel = isCritical ? 'Critical - Auto Reorder' : (isLow ? 'Low Stock' : 'Adequate');
			const statusIcon = isCritical
				? '<i class="fa-solid fa-triangle-exclamation"></i>'
				: isLow
					? '<i class="fa-solid fa-triangle-exclamation"></i>'
					: '<i class="fa-solid fa-circle-check"></i>';
			return `
				<tr>
					<td>${m.material}</td>
					<td><input type="number" min="0" step="1" class="inv-num-input" data-mat-idx="${idx}" data-field="quantity" value="${Number(m.quantity || 0)}"></td>
					<td><input type="number" min="0" step="1" class="inv-num-input" data-mat-idx="${idx}" data-field="minLevel" value="${Number(m.minLevel || 0)}"></td>
					<td>${m.supplier}</td>
					<td>${m.restocked}</td>
					<td><span class="status-pill ${isCritical ? 'status-red' : isLow ? 'status-yellow' : 'status-green'}">${statusIcon} ${statusLabel}</span></td>
					<td><div class="row-actions"><button class="btn-edit inv-edit-btn" data-edit-entity="material" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete inv-delete-btn" data-delete-entity="material" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			`;
		}).join('');

		materialsBody.onchange = (e) => {
			const input = e.target.closest('input[data-mat-idx][data-field]');
			if (!input) return;
			const idx = Number(input.dataset.matIdx);
			const field = input.dataset.field;
			if (!rawMaterials[idx] || !field) return;
			const nextVal = Math.max(0, Number(input.value || 0));
			rawMaterials[idx][field] = Number.isFinite(nextVal) ? nextVal : 0;
			saveRawMaterialsToStorage(rawMaterials);
			rerenderInventory();
		};

		const rawMaterialsValue = document.getElementById('inv-raw-materials-value');
		if (rawMaterialsValue) {
			rawMaterialsValue.textContent = String(materialsBody.querySelectorAll('tr').length);
		}
	};

	const renderProducts = () => {
		const productsBody = document.getElementById('inv-products-tbody');
		if (!productsBody) {
			return;
		}
		productsBody.innerHTML = finishedProducts.map((p, idx) => {
			const isReady = Number(p.qty || 0) > 0;
			const distributionLabel = isReady
				? '<i class="fa-solid fa-circle-check"></i> Ready for Sale'
				: 'In Production';
			const distributionClass = isReady ? 'status-green' : 'status-grey';
			return `
				<tr>
					<td>${p.product}</td>
					<td>${formatNumber(p.qty)}</td>
					<td>${p.location}</td>
					<td>${formatDateDisplay(p.date || p.addedDate)}</td>
					<td><span class="status-pill ${distributionClass}">${distributionLabel}</span></td>
					<td><div class="row-actions"><button class="btn-edit inv-edit-btn" data-edit-entity="product" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete inv-delete-btn" data-delete-entity="product" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			`;
		}).join('');
	};

	const renderEquipment = () => {
		const equipmentBody = document.getElementById('inv-equipment-tbody');
		if (!equipmentBody) {
			return;
		}
		equipmentBody.innerHTML = equipment.map((eq, idx) => {
			const issues = getEquipmentIssues(eq.status);
			const tone = getEquipmentWarningTone(eq.status);
			const statusOptions = [
				{ value: 'operational', label: 'Operational' },
				{ value: 'needs_repair', label: 'Needs Repair' },
				{ value: 'faulty', label: 'Faulty' },
				{ value: 'faulty_needs_repair', label: 'Faulty + Repair' },
			].map((o) => `<option value="${o.value}"${eq.status === o.value ? ' selected' : ''}>${o.label}</option>`).join('');
			const selectClass = eq.status === 'operational' ? 'eq-sel-ok' : eq.status === 'needs_repair' ? 'eq-sel-warning' : 'eq-sel-danger';
			return `
				<tr class="${isEquipmentWarningStatus(eq.status) ? `equipment-warning-row equipment-warning-row-${tone}` : ''}">
					<td>${eq.code}</td>
					<td>${renderEquipmentLabel(eq)}</td>
					<td>
						<select class="eq-status-select ${selectClass}" data-eq-idx="${idx}">${statusOptions}</select>
					</td>
					<td><span class="badge ${issues === '-' ? 'badge-green' : issues === 'R' ? 'badge-yellow' : 'badge-red'}">${issues}</span></td>
					<td>${formatDateDisplay(eq.lastMaintenance)}</td>
					<td>${formatDateDisplay(eq.nextMaintenance)}</td>
					<td><div class="row-actions"><button class="btn-edit inv-edit-btn" data-edit-entity="equipment" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete inv-delete-btn" data-delete-entity="equipment" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			`;
		}).join('');

		// Delegated change handler — update status, save, re-render
		equipmentBody.onchange = (e) => {
			const sel = e.target.closest('select[data-eq-idx]');
			if (!sel) return;
			const idx = Number(sel.dataset.eqIdx);
			if (!equipment[idx]) return;
			equipment[idx].status = sel.value;
			saveOneEquipmentToServer(equipment[idx]);
			saveEquipmentToStorage(equipment);
			rerenderInventory();
		};
	};

	const renderCustomers = () => {
		const customersBody = document.getElementById('inv-customers-tbody');
		if (!customersBody) {
			return;
		}
		customersBody.innerHTML = customers.map((c, idx) => {
			return `
				<tr>
					<td>${c.name}</td>
					<td>${c.contact}</td>
					<td>${c.orders}</td>
					<td>${c.lastOrder}</td>
					<td><span class="status-dot ${statusDotClass(c.status)}"></span>${c.status === 'active' ? 'Active' : 'Inactive'}</td>
					<td><div class="row-actions"><button class="btn-edit inv-edit-btn" data-edit-entity="customer" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete inv-delete-btn" data-delete-entity="customer" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
				</tr>
			`;
		}).join('');
	};

	const renderDeviationAlert = () => {
		const deviationBox = document.getElementById('inv-deviation-box');
		if (!deviationBox) {
			return;
		}

		const faultyList = equipment.filter((eq) => ['faulty', 'faulty_needs_repair'].includes(eq.status));
		const repairList = equipment.filter((eq) => eq.status === 'needs_repair');
		const problemList = [...faultyList, ...repairList];

		deviationBox.classList.remove('danger-box', 'ok-box');
		deviationBox.style.display = 'block';

		if (!equipment.length) {
			deviationBox.style.display = 'none';
			return;
		}

		if (!problemList.length) {
			deviationBox.classList.add('ok-box');
			deviationBox.innerHTML = `
				<div class="deviation-head">
					<i class="fa-solid fa-circle-check"></i>
					<span>Equipment Status Summary</span>
				</div>
				<p>All ${equipment.length} machine${equipment.length > 1 ? 's' : ''} in the table ${equipment.length > 1 ? 'are' : 'is'} fully operational.</p>
			`;
			return;
		}

		deviationBox.classList.add('danger-box');
		deviationBox.innerHTML = `
			<div class="deviation-head danger-head">
				<i class="fa-solid fa-triangle-exclamation"></i>
				<span>Equipment Status Summary &mdash; ${problemList.length} machine${problemList.length > 1 ? 's' : ''} need${problemList.length === 1 ? 's' : ''} attention</span>
			</div>
			<div class="deviation-cards">
				${problemList.map((eq) => {
					const tone = getEquipmentWarningTone(eq.status);
					const label = getEquipmentStatusLabel(eq.status, true);
					return `
						<div class="deviation-card deviation-card-${tone}">
							<div class="deviation-card-left">
								<i class="fa-solid fa-triangle-exclamation"></i>
								<div>
									<strong>${eq.code} &mdash; ${eq.equipment}</strong>
									${eq.details ? `<span>${eq.details}</span>` : ''}
								</div>
							</div>
							<span class="deviation-badge deviation-badge-${tone}">${label}</span>
						</div>
					`;
				}).join('')}
			</div>
		`;
	};

	const rerenderInventory = () => {
		renderStats();
		renderMaterials();
		renderProducts();
		renderEquipment();
		renderCustomers();
		renderDeviationAlert();
	};

	// Do NOT save during init — would overwrite server data with empty localStorage

	rerenderInventory();

	// Auto-switch to tab from URL ?tab= param (e.g. dashboard Stock Alerts link)
	const tabParam = new URLSearchParams(window.location.search).get('tab');
	if (tabParam && document.getElementById(`inv-tab-${tabParam}`)) {
		switchTab('inv', tabParam);
		document.getElementById(`inv-tab-${tabParam}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	const todayForInput = getTodayDateStr();

	const MODAL_CONFIGS = {
		material: {
			title: 'Add Raw Material',
			fields: [
				{ id: 'material', label: 'Material Name', type: 'text', required: true },
				{ id: 'quantity', label: 'In Stock', type: 'number', min: '0', required: true },
				{ id: 'minLevel', label: 'Minimum Level', type: 'number', min: '0', required: true },
				{ id: 'supplier', label: 'Supplier', type: 'text', placeholder: 'N/A' },
				{ id: 'restocked', label: 'Last Restocked', type: 'date', defaultValue: todayForInput, required: true },
			],
		},
		product: {
			title: 'Add Finished Product',
			fields: [
				{ id: 'product', label: 'Product Name', type: 'text', required: true },
				{ id: 'qty', label: 'Quantity', type: 'number', min: '0', required: true },
				{ id: 'location', label: 'Location', type: 'text', placeholder: 'Warehouse A' },
				{ id: 'date', label: 'Date', type: 'date', defaultValue: todayForInput, required: true },
			],
		},
		equipment: {
			title: 'Add Equipment',
			fields: [
				{ id: 'equipmentName', label: 'Equipment Name', type: 'text', required: true },
				{ id: 'details', label: 'Details', type: 'text' },
				{ id: 'lastMaintenance', label: 'Last Maintenance Date', type: 'date', defaultValue: todayForInput, required: true },
				{ id: 'nextMaintenance', label: 'Next Maintenance Date', type: 'date', required: true },
			],
		},
		customer: {
			title: 'Add Customer',
			fields: [
				{ id: 'name', label: 'Customer Name', type: 'text', required: true },
				{ id: 'contact', label: 'Contact', type: 'text', placeholder: '000-000-0000' },
				{ id: 'lastOrder', label: 'Last Order Date', type: 'date' },
			],
		},
	};

	const addModal = document.getElementById('inv-add-modal');
	const modalTitle = document.getElementById('inv-modal-title');
	const modalFieldsEl = document.getElementById('inv-modal-fields');
	const modalForm = document.getElementById('inv-add-form');
	let currentEntity = null;
	let editingIdx = -1;

	const closeModal = () => {
		if (addModal) addModal.style.display = 'none';
		if (modalForm) modalForm.reset();
		currentEntity = null;
		editingIdx = -1;
	};

	const openModal = (entity, editIndex) => {
		const config = MODAL_CONFIGS[entity];
		if (!config || !addModal) return;
		currentEntity = entity;
		editingIdx = typeof editIndex === 'number' ? editIndex : -1;
		if (modalTitle) modalTitle.textContent = editingIdx >= 0 ? config.title.replace('Add', 'Edit') : config.title;
		if (modalFieldsEl) {
			modalFieldsEl.innerHTML = config.fields.map((f) => `
				<div class="inv-modal-field">
					<label for="inv-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label>
					<input
						id="inv-field-${f.id}"
						type="${f.type}"
						name="${f.id}"
						${f.required ? 'required' : ''}
						${f.min !== undefined ? `min="${f.min}"` : ''}
						${f.placeholder ? `placeholder="${f.placeholder}"` : ''}
						${f.defaultValue ? `value="${f.defaultValue}"` : ''}
					>
				</div>
			`).join('');
		}
		/* Pre-fill when editing */
		if (editingIdx >= 0) {
			let row;
			if (entity === 'material') row = rawMaterials[editingIdx];
			else if (entity === 'product') row = finishedProducts[editingIdx];
			else if (entity === 'equipment') row = equipment[editingIdx];
			else if (entity === 'customer') row = customers[editingIdx];
			if (row) {
				config.fields.forEach((f) => {
					const el = document.getElementById(`inv-field-${f.id}`);
					if (!el) return;
					if (entity === 'equipment' && f.id === 'equipmentName') el.value = row.equipment || '';
					else if (row[f.id] !== undefined) el.value = row[f.id];
				});
			}
		}
		addModal.style.display = 'flex';
		const firstInput = modalFieldsEl && modalFieldsEl.querySelector('input');
		if (firstInput) firstInput.focus();
	};

	document.getElementById('inv-modal-close')?.addEventListener('click', closeModal);
	document.getElementById('inv-modal-cancel')?.addEventListener('click', closeModal);
	addModal?.addEventListener('click', (e) => { if (e.target === addModal) closeModal(); });

	if (modalForm && !modalForm.dataset.bound) {
		modalForm.dataset.bound = '1';
		modalForm.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!currentEntity) return;

			const getValue = (id) => {
				const el = document.getElementById(`inv-field-${id}`);
				return el ? el.value.trim() : '';
			};
			const getNum = (id) => {
				const v = Number(getValue(id));
				return Number.isFinite(v) && v >= 0 ? v : 0;
			};

			if (currentEntity === 'material') {
				const material = getValue('material');
				if (!material) return;
				if (editingIdx >= 0 && rawMaterials[editingIdx]) {
					rawMaterials[editingIdx].material = material;
					rawMaterials[editingIdx].quantity = getNum('quantity');
					rawMaterials[editingIdx].minLevel = getNum('minLevel');
					rawMaterials[editingIdx].supplier = getValue('supplier') || 'N/A';
					rawMaterials[editingIdx].restocked = getValue('restocked') || todayForInput;
				} else {
					rawMaterials.push({
						id: nextNumericId(rawMaterials),
						material,
						quantity: getNum('quantity'),
						minLevel: getNum('minLevel'),
						supplier: getValue('supplier') || 'N/A',
						restocked: getValue('restocked') || todayForInput,
					});
				}
				saveRawMaterialsToStorage(rawMaterials);
			}

			if (currentEntity === 'product') {
				const product = getValue('product');
				if (!product) return;
				if (editingIdx >= 0 && finishedProducts[editingIdx]) {
					finishedProducts[editingIdx].product = product;
					finishedProducts[editingIdx].qty = getNum('qty');
					finishedProducts[editingIdx].location = getValue('location') || 'Warehouse A';
					finishedProducts[editingIdx].date = getValue('date') || finishedProducts[editingIdx].date || finishedProducts[editingIdx].addedDate;
				} else {
					finishedProducts.push({
						id: nextNumericId(finishedProducts),
						product,
						qty: getNum('qty'),
						location: getValue('location') || 'Warehouse A',
						date: getValue('date') || getTodayDateStr(),
						status: 'ready for sale',
						addedDate: getTodayDateStr(),
					});
				}
				saveFinishedProductsToStorage(finishedProducts);
			}

			if (currentEntity === 'equipment') {
				const equipmentName = getValue('equipmentName');
				if (!equipmentName) return;
				if (editingIdx >= 0 && equipment[editingIdx]) {
					equipment[editingIdx].equipment = equipmentName;
					equipment[editingIdx].details = getValue('details');
					equipment[editingIdx].lastMaintenance = getValue('lastMaintenance') || todayForInput;
					equipment[editingIdx].nextMaintenance = getValue('nextMaintenance') || todayForInput;
					saveOneEquipmentToServer(equipment[editingIdx]);
				} else {
					const code = `EQ-${String(equipment.length + 101).padStart(3, '0')}`;
					const newEq = {
						code,
						equipment: equipmentName,
						details: getValue('details'),
						status: 'operational',
						lastMaintenance: getValue('lastMaintenance') || todayForInput,
						nextMaintenance: getValue('nextMaintenance') || todayForInput,
					};
					// Create on server and get back the id
					fetch(API_BASE + '/api/factory-equipment', {
						method: 'POST', credentials: 'include',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(newEq),
					}).then((r) => r.ok ? r.json() : null).then((result) => {
						if (result && result.id) {
							newEq.id = result.id;
							saveEquipmentToStorage(equipment);
						}
					}).catch(() => {});
					equipment.push(newEq);
				}
				saveEquipmentToStorage(equipment);
			}

			if (currentEntity === 'customer') {
				const name = getValue('name');
				if (!name) return;
				if (editingIdx >= 0 && customers[editingIdx]) {
					customers[editingIdx].name = name;
					customers[editingIdx].contact = getValue('contact') || '000-000-0000';
					customers[editingIdx].lastOrder = getValue('lastOrder') || '-';
				} else {
					customers.push({
						id: nextNumericId(customers),
						name,
						contact: getValue('contact') || '000-000-0000',
						orders: 0,
						lastOrder: getValue('lastOrder') || '-',
						status: 'active',
					});
				}
			}

			closeModal();
			rerenderInventory();
		});
	}

	if (!document.__wwInventoryBound) {
		document.__wwInventoryBound = true;
		document.addEventListener('click', (event) => {
			const button = event.target.closest('.table-add-btn[data-add-entity]');
			if (button) {
				if (!canAdd) {
					alert('You do not have permission to add rows.');
					return;
				}
				openModal(button.getAttribute('data-add-entity'));
				return;
			}
			const editBtn = event.target.closest('.inv-edit-btn');
			if (editBtn) {
				event.stopPropagation();
				openModal(editBtn.getAttribute('data-edit-entity'), Number(editBtn.getAttribute('data-edit-idx')));
				return;
			}
			const deleteBtn = event.target.closest('.inv-delete-btn');
			if (deleteBtn) {
				event.stopPropagation();
				const entity = deleteBtn.getAttribute('data-delete-entity');
				const idx = Number(deleteBtn.getAttribute('data-delete-idx'));
				if (!confirm('Delete this ' + entity + '? This cannot be undone.')) return;
				if (entity === 'material') { rawMaterials.splice(idx, 1); saveRawMaterialsToStorage(rawMaterials); }
				else if (entity === 'product') { finishedProducts.splice(idx, 1); saveFinishedProductsToStorage(finishedProducts); }
				else if (entity === 'equipment') {
					const removed = equipment[idx];
					equipment.splice(idx, 1);
					if (removed && removed.id) {
						fetch(API_BASE + '/api/factory-equipment/' + removed.id, { method: 'DELETE', credentials: 'include' }).catch(() => {});
					}
					saveEquipmentToStorage(equipment);
				}
				else if (entity === 'customer') { customers.splice(idx, 1); }
				rerenderInventory();
			}
		});
	}

	/* ── Cross-tab sync: refresh inventory when another tab changes data ── */
	const reloadAndRerender = () => {
		rawMaterials = loadRawMaterialsFromStorage();
		finishedProducts = loadFinishedProductsFromStorage();
		equipment = loadEquipmentFromStorage();
		rerenderInventory();
	};
	window.addEventListener('storage', (e) => {
		if (['ww_raw_materials', 'ww_finished_products', 'ww_equipment'].includes(e.key)) {
			reloadAndRerender();
		}
	});
	try {
		new BroadcastChannel('ww_raw_materials_sync').onmessage = reloadAndRerender;
		new BroadcastChannel('ww_finished_products_sync').onmessage = reloadAndRerender;
		new BroadcastChannel('ww_equipment_sync').onmessage = reloadAndRerender;
	} catch (_e) { /* BroadcastChannel not supported */ }
}

const salesModuleData = {
	invoices: [],
	salesOrders: [],
};

/* ── Monthly storage helpers ── */
const MONTHS_KEY = 'ww_sales_months';
let currentSalesMonth = '';

function getSalesMonths() {
	try { return JSON.parse(localStorage.getItem(MONTHS_KEY) || '[]'); } catch (_e) { return []; }
}

function saveSalesMonths(months) {
	localStorage.setItem(MONTHS_KEY, JSON.stringify(months));
	syncToServer(MONTHS_KEY, months);
}

function monthStorageKey(month) {
	return `ww_sales_${month}`;
}

function monthLabel(month) {
	const [y, m] = month.split('-');
	const names = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
	return `${names[parseInt(m, 10)] || m} ${y}`;
}

/** Aggregate invoices + salesOrders across ALL months (used by Dashboard, Reports, etc.) */
function getAllSalesData() {
	const months = getSalesMonths();
	const allInvoices = [];
	const allOrders = [];
	for (const m of months) {
		try {
			const stored = JSON.parse(localStorage.getItem(monthStorageKey(m)) || 'null');
			if (stored && typeof stored === 'object') {
				if (Array.isArray(stored.invoices)) allInvoices.push(...stored.invoices);
				if (Array.isArray(stored.salesOrders)) allOrders.push(...stored.salesOrders);
			}
		} catch (_e) { /* skip */ }
	}
	return { invoices: allInvoices, salesOrders: allOrders };
}

function ensureMonthExists(month) {
	const months = getSalesMonths();
	if (!months.includes(month)) {
		months.push(month);
		months.sort();
		saveSalesMonths(months);
	}
}

function loadSalesDataFromStorage() {
	/* Clean up any old key */
	try { localStorage.removeItem('ww_sales_data'); } catch(_e) {}

	/* Ensure March 2026 month exists */
	ensureMonthExists('2026-03');

	/* Seed March if it has no data yet, or re-seed if version changed */
	const marchKey = monthStorageKey('2026-03');
	let marchData = null;
	try { marchData = JSON.parse(localStorage.getItem(marchKey)); } catch(_e) {}
	if (!marchData || !marchData.invoices || marchData.invoices.length === 0) {
		if (!getSeedFlag('march2026_sales_v2')) {
			currentSalesMonth = '2026-03';
			salesModuleData.invoices = [];
			salesModuleData.salesOrders = [];
			seedMarchSalesData();
			setSeedFlag('march2026_sales_v2');
			return; /* seedMarchSalesData calls saveSalesDataToStorage, data is already in salesModuleData */
		}
	} else {
		setSeedFlag('march2026_sales_v2');
	}

	/* Pick the month to display */
	if (!currentSalesMonth) {
		const now = new Date();
		const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
		const allMonths = getSalesMonths();
		currentSalesMonth = allMonths.includes(thisMonth) ? thisMonth : (allMonths[allMonths.length - 1] || '2026-03');
	}

	loadMonthData(currentSalesMonth);
}

function loadMonthData(month) {
	currentSalesMonth = month;
	salesModuleData.invoices = [];
	salesModuleData.salesOrders = [];
	try {
		const stored = JSON.parse(localStorage.getItem(monthStorageKey(month)) || 'null');
		if (stored && typeof stored === 'object') {
			salesModuleData.invoices = Array.isArray(stored.invoices) ? stored.invoices : [];
			salesModuleData.salesOrders = Array.isArray(stored.salesOrders) ? stored.salesOrders : [];
		}
	} catch (_e) { /* ignore */ }

	/* ── one-time sync: ensure invoices ↔ salesOrders are mirrored ── */
	let dirty = false;
	const soMap = {};
	salesModuleData.salesOrders.forEach(o => { soMap[o.id] = o; });
	const invMap = {};
	salesModuleData.invoices.forEach(v => { invMap[v.id] = v; });

	// For every invoice, create or update matching SO
	salesModuleData.invoices.forEach(inv => {
		const soId = 'SO' + inv.id.slice(3); // INV-2026-040 → SO-2026-040
		if (!soMap[soId]) {
			// create missing SO
			const so = {
				id: soId,
				customer: inv.customer,
				orderDate: inv.date || inv.orderDate,
				deliveryDate: inv.date || inv.orderDate,
				amount: inv.amount,
				status: inv.status,
				bags: inv.bags,
				rate: inv.rate,
				promo: inv.promo,
				promoNote: inv.promoNote || '',
				paymentMode: inv.paymentMode || '',
				paidDate: inv.paidDate || '',
				items: JSON.parse(JSON.stringify(inv.items || []))
			};
			salesModuleData.salesOrders.push(so);
			soMap[soId] = so;
			dirty = true;
		} else {
			// update existing SO to match invoice
			const so = soMap[soId];
			so.customer = inv.customer;
			so.orderDate = inv.date || inv.orderDate;
			so.deliveryDate = inv.date || inv.orderDate;
			so.amount = inv.amount;
			so.status = inv.status;
			so.bags = inv.bags;
			so.rate = inv.rate;
			so.promo = inv.promo;
			so.promoNote = inv.promoNote || '';
			so.paymentMode = inv.paymentMode || '';
			so.paidDate = inv.paidDate || '';
			so.items = JSON.parse(JSON.stringify(inv.items || []));
			dirty = true;
		}
	});

	// For every SO without a matching invoice, create one
	salesModuleData.salesOrders.forEach(so => {
		const invId = 'INV' + so.id.slice(2); // SO-2026-040 → INV-2026-040
		if (!invMap[invId]) {
			const inv = {
				id: invId,
				customer: so.customer,
				date: so.orderDate || so.deliveryDate,
				amount: so.amount,
				status: so.status,
				bags: so.bags,
				rate: so.rate,
				promo: so.promo,
				promoNote: so.promoNote || '',
				paymentMode: so.paymentMode || '',
				paidDate: so.paidDate || '',
				items: JSON.parse(JSON.stringify(so.items || []))
			};
			salesModuleData.invoices.push(inv);
			invMap[invId] = inv;
			dirty = true;
		}
	});

	if (dirty) saveSalesDataToStorage();
}

function seedMarchSalesData() {
	const rows = [
		// 16/03/26
		{ d:'2026-03-16', c:'Mon (driver)', b:60, r:7.5, a:450, s:'paid' },
		{ d:'2026-03-16', c:'Mon (driver)', b:15, r:7.5, a:113, s:'paid' },
		{ d:'2026-03-16', c:'Charlotte', b:950, r:6, a:5700, s:'paid' },
		{ d:'2026-03-16', c:'JMK', b:745, r:0, a:1500, s:'paid' },
		// 17/03/26
		{ d:'2026-03-17', c:'Client', b:1, r:7.5, a:7.50, s:'paid' },
		{ d:'2026-03-17', c:'Charlotte', b:500, r:6, a:3000, s:'paid', pr:20 },
		{ d:'2026-03-17', c:'Musa', b:250, r:6.5, a:1500, s:'paid', pr:12 },
		{ d:'2026-03-17', c:'Flarc', b:15, r:0, a:112.50, s:'paid' },
		{ d:'2026-03-17', c:'Chef', b:3, r:7.5, a:22.50, s:'paid' },
		{ d:'2026-03-17', c:'Charlotte / Stzpr', b:250, r:0, a:4500, s:'paid', pr:8 },
		{ d:'2026-03-17', c:'Aboboyaa', b:110, r:0, a:660, s:'paid', pr:4 },
		// 18/03/26
		{ d:'2026-03-18', c:'Michael Defadu', b:80, r:7, a:560, s:'paid' },
		{ d:'2026-03-18', c:'Michael Defadu', b:50, r:7.5, a:365, s:'paid' },
		{ d:'2026-03-18', c:'Charlotte', b:500, r:6, a:2520, s:'paid', pr:20 },
		{ d:'2026-03-18', c:'Aboboyaa', b:110, r:6, a:660, s:'paid' },
		{ d:'2026-03-18', c:'Aboboyaa', b:110, r:6, a:660, s:'paid', pr:4 },
		{ d:'2026-03-18', c:'Ismael', b:25, r:7.5, a:187.50, s:'paid', p:'Momo + Cash' },
		// 19/03/26
		{ d:'2026-03-19', c:'Michael Dafadu', b:80, r:7, a:560, s:'paid' },
		{ d:'2026-03-19', c:'Charlotte', b:300, r:6, a:1800, s:'paid', pr:11 },
		{ d:'2026-03-19', c:'Aboboyaa', b:120, r:6, a:720, s:'paid', pr:4 },
		{ d:'2026-03-19', c:'Aboboyaa', b:110, r:6, a:660, s:'paid', pr:4 },
		{ d:'2026-03-19', c:'Individual', b:5, r:7, a:35, s:'paid' },
		// 20/03/26
		{ d:'2026-03-20', c:'Kia', b:50, r:6, a:300, s:'paid' },
		{ d:'2026-03-20', c:'Charlotte', b:500, r:6, a:3000, s:'paid' },
		{ d:'2026-03-20', c:'Michael Dze', b:50, r:7.5, a:375, s:'paid', p:'Cash + Momo' },
		{ d:'2026-03-20', c:'Carida', b:16, r:7.5, a:120, s:'paid' },
		// 21/03/26
		{ d:'2026-03-21', c:'Charlotte', b:500, r:6, a:3000, s:'paid', pr:208 },
		{ d:'2026-03-21', c:'Dafadu', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-21', c:'Dzepedu', b:4, r:7.5, a:30, s:'paid' },
		{ d:'2026-03-21', c:'Kukua', b:6, r:6, a:36, s:'paid' },
		{ d:'2026-03-21', c:'Christpha', b:2, r:6, a:12, s:'paid' },
		{ d:'2026-03-21', c:'Dzepedu', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-21', c:'Individual', b:110, r:6, a:660, s:'paid' },
		// 23/03/26
		{ d:'2026-03-23', c:'Charlotte', b:350, r:6, a:2100, s:'paid', pr:14 },
		{ d:'2026-03-23', c:'Charlotte', b:134, r:6, a:804, s:'paid', pr:10 },
		{ d:'2026-03-23', c:'Aboboyaa', b:40, r:6, a:240, s:'paid', pr:1 },
		{ d:'2026-03-23', c:'Apostle Dab', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-23', c:'Individual', b:5, r:7.5, a:37.50, s:'paid' },
		// 24/03/26
		{ d:'2026-03-24', c:'Charlotte', b:350, r:6, a:2100, s:'paid', pr:14 },
		{ d:'2026-03-24', c:'Charlotte', b:100, r:6, a:2400, s:'paid', pr:16 },
		{ d:'2026-03-24', c:'Boyit', b:7, r:6, a:42, s:'paid' },
		{ d:'2026-03-24', c:'Aboboyaa', b:110, r:6, a:660, s:'paid', p:'Momo', pr:6 },
		{ d:'2026-03-24', c:'Individual', b:20, r:7, a:140, s:'paid' },
		// 25/03/26
		{ d:'2026-03-25', c:'Charlotte', b:400, r:6, a:2400, s:'paid', pr:16 },
		{ d:'2026-03-25', c:'Dafadu', b:70, r:7.5, a:525, s:'paid' },
		{ d:'2026-03-25', c:'Dagadu', b:100, r:7.5, a:750, s:'paid', p:'Cash + Momo' },
		{ d:'2026-03-25', c:'Client (walk-in)', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-25', c:'Client', b:10, r:7.5, a:75, s:'paid' },
		{ d:'2026-03-25', c:'Walk-in', b:1, r:6, a:6, s:'paid' },
		{ d:'2026-03-25', c:'Charlotte', b:400, r:6, a:2400, s:'paid', pr:16 },
		{ d:'2026-03-25', c:'Dafadu', b:70, r:7.5, a:525, s:'paid' },
		{ d:'2026-03-25', c:'Dafadu', b:50, r:7.5, a:375, s:'paid' },
		// 26/03/26
		{ d:'2026-03-26', c:'Grace MTN (Eve)', b:20, r:7.5, a:150, s:'paid' },
		{ d:'2026-03-26', c:'Charlotte', b:400, r:6, a:2400, s:'paid', pr:16 },
		{ d:'2026-03-26', c:'Walk-in', b:4, r:6, a:24, s:'paid' },
		{ d:'2026-03-26', c:'Walk-in', b:4, r:6, a:24, s:'paid' },
		{ d:'2026-03-26', c:'Madam Mamuko / Apmpzn Mofe Dztlts', b:100, r:7.5, a:750, s:'paid', p:'Momo', pr:4 },
		{ d:'2026-03-26', c:'Walk-in (Delney)', b:3, r:7.5, a:22.50, s:'paid', p:'Momo' },
		{ d:'2026-03-26', c:'Michael', b:50, r:7, a:250, s:'paid' },
		{ d:'2026-03-26', c:'Aboboyaa', b:100, r:6, a:600, s:'paid', pr:6 },
		{ d:'2026-03-26', c:'Walk-in', b:4, r:6, a:24, s:'paid' },
		// 27/03/26
		{ d:'2026-03-27', c:'Charlotte', b:450, r:6, a:2700, s:'paid' },
		{ d:'2026-03-27', c:'Walk-in', b:4, r:6, a:24, s:'paid', p:'Momo' },
		{ d:'2026-03-27', c:'Walk-in', b:7, r:6, a:42, s:'paid' },
		{ d:'2026-03-27', c:'Client', b:15, r:7.5, a:112.50, s:'paid' },
		{ d:'2026-03-27', c:'Laulas', b:8, r:6, a:0, s:'paid' },
		{ d:'2026-03-27', c:'Charlotte', b:350, r:6, a:2000, s:'paid' },
		{ d:'2026-03-27', c:'Aboboyaa', b:100, r:6, a:600, s:'paid' },
		// 28/03/26
		{ d:'2026-03-28', c:'Charlotte', b:450, r:6, a:2700, s:'paid', pr:16 },
		{ d:'2026-03-28', c:'Amos', b:100, r:7, a:700, s:'paid', pr:16 },
		{ d:'2026-03-28', c:'Aboboyaa', b:110, r:6, a:660, s:'paid', pr:6 },
		{ d:'2026-03-28', c:'Aboboyaa', b:100, r:6, a:600, s:'paid', pr:6 },
		{ d:'2026-03-28', c:'Walk-in', b:3, r:6, a:18, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in', b:10, r:6, a:60, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in', b:6, r:7, a:40, s:'paid' },
		{ d:'2026-03-28', c:'Carida Okadaahu', b:10, r:7.5, a:75, s:'paid' },
		{ d:'2026-03-28', c:'Charlotte', b:375, r:6, a:2250, s:'paid', pr:14 },
		{ d:'2026-03-28', c:'Aboboyaa', b:110, r:6, a:660, s:'paid' },
		{ d:'2026-03-28', c:'Aboboyaa', b:100, r:6, a:600, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in / Police', b:6, r:5, a:30, s:'paid' },
		{ d:'2026-03-28', c:'Daapaadu', b:47, r:7.5, a:352.50, s:'paid' },
		{ d:'2026-03-28', c:'Amos', b:7, r:7.5, a:42, s:'paid' },
		{ d:'2026-03-28', c:'Amos', b:44, r:7, a:208, s:'paid' },
		{ d:'2026-03-28', c:'Aboboyaa', b:100, r:6, a:600, s:'paid', pr:6 },
		{ d:'2026-03-28', c:'Walk-in', b:10, r:7.5, a:75, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in', b:6, r:6, a:36, s:'paid' },
		{ d:'2026-03-28', c:'Walk-in', b:1, r:6, a:6, s:'paid' },
	];
	const product = '500ml Sachet Water (500 pcs/bag)';
	rows.forEach((r, i) => {
		const idx = String(i + 1).padStart(3, '0');
		const rate = r.r > 0 ? r.r : (r.b > 0 ? +(r.a / r.b).toFixed(2) : 0);
		const promo = r.pr !== undefined ? r.pr : (r.b > 100 ? Math.floor(r.b / 100) * 4 : 0);
		salesModuleData.invoices.push({
			id: `INV-2026-${idx}`, customer: r.c, product,
			date: r.d, paidDate: r.s === 'paid' ? r.d : '', status: r.s, amount: r.a, rate,
			paymentMode: r.p || '', promo,
			items: [{ name: product, qty: r.b, unitPrice: rate }],
			deliveryFee: 0,
		});
		salesModuleData.salesOrders.push({
			id: `SO-2026-${idx}`, customer: r.c,
			orderDate: r.d, deliveryDate: r.d,
			amount: r.a, bags: r.b, rate, paymentMode: r.p || '', promo,
			status: r.s === 'paid' ? 'delivered' : 'pending',
		});
	});
	saveSalesDataToStorage();
}

function saveSalesDataToStorage() {
	const key = monthStorageKey(currentSalesMonth);
	localStorage.setItem(key, JSON.stringify(salesModuleData));
	syncToServer(key, salesModuleData);
	// Notify other tabs instantly
	try {
		if (!window.__wwSalesChannel) window.__wwSalesChannel = new BroadcastChannel('ww_sales_sync');
		window.__wwSalesChannel.postMessage({ type: 'sales_updated', month: currentSalesMonth });
	} catch (_e) { /* fallback to storage event */ }
}

function nextInvoiceId() {
	const nums = salesModuleData.invoices.map((inv) => {
		const match = String(inv.id).match(/(\d+)$/);
		return match ? Number(match[1]) : 0;
	});
	const next = (Math.max(0, ...nums) + 1);
	return `INV-${new Date().getFullYear()}-${String(next).padStart(3, '0')}`;
}

function nextOrderId() {
	const nums = salesModuleData.salesOrders.map((o) => {
		const match = String(o.id).match(/(\d+)$/);
		return match ? Number(match[1]) : 0;
	});
	const next = (Math.max(0, ...nums) + 1);
	return `SO-${new Date().getFullYear()}-${String(next).padStart(3, '0')}`;
}

function invoiceTotal(invoice) {
	if (!invoice.items || !invoice.items.length) return Number(invoice.amount || 0);
	return invoice.items.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
}

function renderInvoiceDetail(invoice) {
	const target = document.getElementById('invoice-detail-content');
	if (!target || !invoice) {
		return;
	}

	const hideMoney = window.__wwUserRole === 'supervisor' || window.__wwUserRole === 'staff';
	const items = invoice.items && invoice.items.length ? invoice.items : [{ name: invoice.product || 'Sale', qty: 1, unitPrice: Number(invoice.amount || 0) }];
	const subTotal = items.reduce((sum, it) => sum + (it.qty * it.unitPrice), 0);
	const deliveryFee = Number(invoice.deliveryFee || 0);
	const total = subTotal + deliveryFee;
	const invNo = String(invoice.id || '').replace(/^INV-\d{4}-/, 'WWW');
	const invIsApprover = canEditDelete(window.__wwUserRole || 'staff');
	const pendingBanner = invoice.status === 'pending_approval'
		? `<div class="approval-banner"><i class="fa-solid fa-hourglass-half"></i> Pending Approval${invIsApprover ? ' — <button class="btn-approve-inline inv-detail-approve-btn">Approve</button>' : ''}</div>`
		: '';

	function fmtDate(d) {
		if (!d) return '';
		const dt = new Date(d + 'T00:00:00');
		if (isNaN(dt)) return d;
		return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
	}

	target.innerHTML = `
		${pendingBanner}
		<div class="inv-doc" id="inv-document">
			<div class="inv-doc-header">
				<div class="inv-doc-logo-area">
					<img src="../images/Final%20Logo.jpg" alt="Logo" class="inv-doc-logo">
				</div>
				<div class="inv-doc-company">
					<h2 class="inv-doc-company-name">White Water Wells LTD</h2>
					<p>Comm 25 Peace B Down, Accra-Prampram Road</p>
					<p>P.O. Box 18204, Accra</p>
					<p>GPS address: GN-0709-4736</p>
					<p>0243108878 / 0244483793</p>
				</div>
				<div class="inv-doc-title-area">
					<h3 class="inv-doc-title">INVOICE</h3>
				</div>
			</div>

			<div class="inv-doc-meta">
				<div class="inv-doc-bill-to">
					<p class="inv-doc-label">BILL TO:</p>
					<p class="inv-doc-val-big">${invoice.customer || ''}</p>
					<p class="inv-doc-val-sub">${invoice.address || ''}</p>
					<p class="inv-doc-val-sub">${invoice.phone ? 'Tel: ' + invoice.phone : ''}</p>
				</div>
				<div class="inv-doc-numbers">
					<div class="inv-doc-num-row"><span>Invoice no:</span><strong>${invNo}</strong></div>
					<div class="inv-doc-num-row"><span>Date:</span><strong>${fmtDate(invoice.date)}</strong></div>
					<div class="inv-doc-num-row"><span>Paid date:</span><strong>${invoice.paidDate ? fmtDate(invoice.paidDate) : '—'}</strong></div>
					${invoice.createdAt ? '<div class="inv-doc-num-row"><span>Created:</span><strong>' + new Date(invoice.createdAt).toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }) + '</strong></div>' : ''}
				</div>
			</div>

			<table class="inv-doc-table">
				<thead><tr><th style="width:8%">S/N</th><th>PRODUCT DESCRIPTION</th><th style="width:10%">QTY</th><th style="width:18%">UNIT PRICE</th><th style="width:18%">TOTAL</th></tr></thead>
				<tbody>
					${items.map((it, i) => `<tr><td>${i + 1}</td><td>${it.name}</td><td>${it.qty}</td><td>${hideMoney ? '—' : 'GH₵' + Number(it.unitPrice).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td><td>${hideMoney ? '—' : 'GH₵' + (it.qty * it.unitPrice).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td></tr>`).join('')}
					${Array(Math.max(0, 5 - items.length)).fill('<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>').join('')}
				</tbody>
			</table>

			<div class="inv-doc-totals" ${hideMoney ? 'style="display:none"' : ''}>
				<div class="inv-doc-total-row"><span>SUB TOTAL</span><span>GH₵${subTotal.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span></div>
				<div class="inv-doc-total-row"><span>DELIVERY FEE</span><span>GH₵${deliveryFee.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span></div>
				<div class="inv-doc-total-row"><span>TOTAL</span><span>GH₵${total.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span></div>
				<div class="inv-doc-total-row inv-doc-grand"><span>GRAND TOTAL</span><span>GH₵${total.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span></div>
			</div>

			<div class="inv-doc-terms">
				<p class="inv-doc-label">Terms &amp; Conditions</p>
				<p>No refunds allowed!</p>
			</div>

			<div class="inv-doc-signatures">
				<div class="inv-doc-sig"><span>Prepared by:</span><div class="inv-doc-sig-line"></div></div>
				<div class="inv-doc-sig"><span>Checked by:</span><div class="inv-doc-sig-line"></div></div>
				<div class="inv-doc-sig"><span>Received by:</span><div class="inv-doc-sig-line"></div></div>
			</div>

			<p class="inv-doc-tagline">Thank you for patronizing our Business!</p>
		</div>
		<div class="inv-doc-actions">
			<button type="button" class="btn-primary inv-doc-print-btn" id="inv-print-btn"><i class="fa-solid fa-print"></i> Print Invoice</button>
		</div>
	`;

	document.getElementById('inv-print-btn')?.addEventListener('click', () => {
		const doc = document.getElementById('inv-document');
		if (!doc) return;
		const printWin = window.open('', '_blank', 'width=800,height=1100');
		printWin.document.write('<!DOCTYPE html><html><head><title>Invoice ' + invNo + '</title><style>' +
			'* { margin:0; padding:0; box-sizing:border-box; }' +
			'body { font-family: "Segoe UI", Arial, sans-serif; padding: 30px; color: #1e293b; font-size: 13px; }' +
			'.inv-doc { max-width: 760px; margin: 0 auto; }' +
			'.inv-doc-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 14px; }' +
			'.inv-doc-logo { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; }' +
			'.inv-doc-company { flex: 1; }' +
			'.inv-doc-company-name { font-size: 1.25rem; font-weight: 700; color: #1a3d5c; margin-bottom: 2px; }' +
			'.inv-doc-company p { font-size: 0.82rem; line-height: 1.5; color: #334155; margin: 0; }' +
			'.inv-doc-title-area { text-align: right; }' +
			'.inv-doc-title { font-size: 1.5rem; color: #1a3d5c; letter-spacing: 2px; }' +
			'.inv-doc-meta { display: flex; justify-content: space-between; margin: 16px 0; gap: 20px; }' +
			'.inv-doc-bill-to { flex: 1; }' +
			'.inv-doc-label { font-weight: 700; font-size: 0.85rem; color: #475569; margin-bottom: 4px; }' +
			'.inv-doc-val-big { font-size: 1rem; font-weight: 600; }' +
			'.inv-doc-val-sub { font-size: 0.85rem; color: #475569; }' +
			'.inv-doc-numbers { text-align: right; }' +
			'.inv-doc-num-row { margin-bottom: 4px; font-size: 0.88rem; }' +
			'.inv-doc-num-row span { color: #64748b; margin-right: 8px; }' +
			'.inv-doc-table { width: 100%; border-collapse: collapse; margin: 16px 0 8px; }' +
			'.inv-doc-table th { background: #1a3d5c; color: #fff; padding: 8px 10px; text-align: left; font-size: 0.82rem; font-weight: 600; }' +
			'.inv-doc-table td { border: 1px solid #cbd5e1; padding: 6px 10px; font-size: 0.85rem; }' +
			'.inv-doc-totals { margin-left: auto; width: 280px; margin-top: 4px; }' +
			'.inv-doc-total-row { display: flex; justify-content: space-between; padding: 5px 10px; font-size: 0.88rem; border-bottom: 1px solid #e2e8f0; }' +
			'.inv-doc-grand { font-weight: 700; background: #f1f5f9; border-bottom: 2px solid #1a3d5c; }' +
			'.inv-doc-terms { margin-top: 20px; }' +
			'.inv-doc-terms p { font-size: 0.82rem; color: #475569; }' +
			'.inv-doc-signatures { display: flex; gap: 24px; margin-top: 28px; }' +
			'.inv-doc-sig { flex: 1; font-size: 0.85rem; font-weight: 600; }' +
			'.inv-doc-sig-line { border-bottom: 1px solid #94a3b8; min-height: 30px; margin-top: 4px; }' +
			'.inv-doc-tagline { text-align: center; font-style: italic; color: #2563eb; margin-top: 28px; font-size: 0.95rem; font-weight: 600; }' +
			'.inv-doc-actions { display: none; }' +
			'@media print { body { padding: 10px; } }' +
		'</style></head><body>' + doc.outerHTML + '</body></html>');
		printWin.document.close();
		setTimeout(() => { printWin.focus(); printWin.print(); }, 300);
	});

	target.querySelector('.inv-detail-approve-btn')?.addEventListener('click', () => {
		const idx = salesModuleData.invoices.findIndex((inv) => inv.id === invoice.id);
		if (idx >= 0) {
			salesModuleData.invoices[idx].status = salesModuleData.invoices[idx].requestedStatus || 'pending';
			delete salesModuleData.invoices[idx].requestedStatus;
			saveSalesDataToStorage();
			renderInvoiceDetail(salesModuleData.invoices[idx]);
			/* refresh table if renderSalesPage exists in scope — trigger via custom event */
			document.dispatchEvent(new Event('ww-refresh-sales'));
		}
	});
}

async function initSalesInvoicesPage() {
  try {
	const page = document.body.getAttribute('data-page');
	if (page !== 'invoices' && page !== 'sales') {
		return;
	}

	const userRole = await resolveCurrentUserRole();
	const isApprover = canEditDelete(userRole);

	loadSalesDataFromStorage();
	console.log('[Sales] Loaded month:', currentSalesMonth, '| Invoices:', salesModuleData.invoices.length, '| Orders:', salesModuleData.salesOrders.length);

	/* ── Cross-tab live sync ── */
	if (!window.__wwSalesSyncBound) {
		window.__wwSalesSyncBound = true;
		// BroadcastChannel (instant, same origin)
		try {
			if (!window.__wwSalesChannel) window.__wwSalesChannel = new BroadcastChannel('ww_sales_sync');
			window.__wwSalesChannel.onmessage = (e) => {
				if (e.data && e.data.type === 'sales_updated') {
					loadMonthData(currentSalesMonth);
					renderSalesPage();
				}
			};
		} catch (_e) { /* ignore */ }
		// Fallback: storage event (fires when another tab writes localStorage)
		window.addEventListener('storage', (event) => {
			if (event.key && event.key.startsWith('ww_sales_')) {
				loadMonthData(currentSalesMonth);
				renderSalesPage();
			}
		});
	}

	/* ── Month selector setup ── */
	const monthSelect = document.getElementById('sales-month-select');
	const newMonthBtn = document.getElementById('new-month-btn');

	function populateMonthSelect() {
		if (!monthSelect) return;
		const months = getSalesMonths();
		monthSelect.innerHTML = months.map((m) =>
			`<option value="${m}" ${m === currentSalesMonth ? 'selected' : ''}>${monthLabel(m)}</option>`
		).join('');
	}
	populateMonthSelect();

	if (monthSelect) {
		monthSelect.addEventListener('change', () => {
			loadMonthData(monthSelect.value);
			renderSalesPage();
		});
	}

	if (newMonthBtn) {
		newMonthBtn.addEventListener('click', () => {
			const input = prompt('Enter month (YYYY-MM):', (() => {
				const d = new Date();
				return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
			})());
			if (!input || !/^\d{4}-\d{2}$/.test(input.trim())) return;
			const month = input.trim();
			const months = getSalesMonths();
			if (months.includes(month)) {
				loadMonthData(month);
			} else {
				ensureMonthExists(month);
				loadMonthData(month);
				saveSalesDataToStorage();
			}
			populateMonthSelect();
			renderSalesPage();
		});
	}

	const todayStr = getTodayDateStr();

	const SI_MODAL_CONFIGS = {
		invoice: {
			title: 'Add Invoice',
			fields: [
				{ id: 'customer', label: 'Customer Name', type: 'text', required: true },
				{ id: 'address', label: 'Address / P.O. Box', type: 'text', placeholder: 'City / Street / P.O. Box' },
				{ id: 'phone', label: 'Telephone', type: 'text', placeholder: '000-000-0000' },
				{ id: 'product', label: 'Product', type: 'text', required: true, placeholder: 'e.g. Mobile Water 500ml' },
				{ id: 'qty', label: 'Quantity', type: 'number', min: '1', required: true },
				{ id: 'promo', label: 'Promo', type: 'number', min: '0', defaultValue: '0' },
				{ id: 'promoNote', label: 'Promo Note', type: 'text', placeholder: 'e.g. leakage, retained' },
				{ id: 'unitPrice', label: 'Unit Price (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'deliveryFee', label: 'Delivery Fee (GH)', type: 'number', min: '0', step: '0.01', defaultValue: '0' },
				{ id: 'date', label: 'Invoice Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'paidDate', label: 'Paid Date', type: 'date' },
				{ id: 'status', label: 'Status', type: 'select', options: ['pending', 'paid', 'overdue'], required: true },
				{ id: 'paymentMode', label: 'Payment Mode', type: 'select', options: ['', 'Cash', 'Momo', 'Cash + Momo'] },
			],
		},
		order: {
			title: 'Add Sales Order',
			fields: [
				{ id: 'customer', label: 'Customer Name', type: 'text', required: true },
				{ id: 'orderDate', label: 'Order Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'deliveryDate', label: 'Delivery Date', type: 'date', required: true },
				{ id: 'amount', label: 'Amount (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'promo', label: 'Promo', type: 'number', min: '0', defaultValue: '0' },
				{ id: 'promoNote', label: 'Promo Note', type: 'text', placeholder: 'e.g. leakage, retained' },
				{ id: 'status', label: 'Status', type: 'select', options: ['confirmed', 'processing', 'shipped', 'delivered'], required: true },
				{ id: 'paymentMode', label: 'Payment Mode', type: 'select', options: ['', 'Cash', 'Momo', 'Cash + Momo'] },
			],
		},
	};

	const addModal = document.getElementById('si-add-modal');
	const modalTitle = document.getElementById('si-modal-title');
	const modalFieldsEl = document.getElementById('si-modal-fields');
	const modalForm = document.getElementById('si-add-form');
	let currentEntity = null;
	let editingSiIdx = -1;

	const closeModal = () => {
		if (addModal) addModal.style.display = 'none';
		if (modalForm) modalForm.reset();
		currentEntity = null;
		editingSiIdx = -1;
	};

	const openModal = (entity, editIdx) => {
		const config = SI_MODAL_CONFIGS[entity];
		if (!config || !addModal) return;
		currentEntity = entity;
		editingSiIdx = typeof editIdx === 'number' ? editIdx : -1;
		if (modalTitle) modalTitle.textContent = editingSiIdx >= 0 ? config.title.replace('Add', 'Edit') : config.title;
		if (modalFieldsEl) {
			modalFieldsEl.innerHTML = config.fields.map((f) => {
				if (f.type === 'select') {
					return `
						<div class="inv-modal-field">
							<label for="si-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label>
							<select id="si-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}>
								${f.options.map((o) => `<option value="${o}">${o.charAt(0).toUpperCase() + o.slice(1)}</option>`).join('')}
							</select>
						</div>
					`;
				}
				return `
					<div class="inv-modal-field">
						<label for="si-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label>
						<input
							id="si-field-${f.id}"
							type="${f.type}"
							name="${f.id}"
							${f.required ? 'required' : ''}
							${f.min !== undefined ? `min="${f.min}"` : ''}
							${f.step ? `step="${f.step}"` : ''}
							${f.placeholder ? `placeholder="${f.placeholder}"` : ''}
							${f.defaultValue ? `value="${f.defaultValue}"` : ''}
						>
					</div>
				`;
			}).join('');
		}
		/* Pre-fill for editing */
		if (editingSiIdx >= 0) {
			let row;
			if (entity === 'invoice') {
				row = salesModuleData.invoices[editingSiIdx];
				if (row) {
					const setVal = (id, v) => { const el = document.getElementById('si-field-' + id); if (el && v !== undefined) el.value = v; };
					setVal('customer', row.customer);
					setVal('address', row.address);
					setVal('phone', row.phone);
					setVal('product', row.product || (row.items && row.items[0] ? row.items[0].name : ''));
					setVal('qty', row.items && row.items[0] ? row.items[0].qty : 1);
					setVal('unitPrice', row.items && row.items[0] ? row.items[0].unitPrice : row.amount);
					setVal('promo', row.promo || 0);
					setVal('promoNote', row.promoNote || '');
					setVal('deliveryFee', row.deliveryFee || 0);
					setVal('date', row.date);
					setVal('paidDate', row.paidDate);
					setVal('status', row.status);
					setVal('paymentMode', row.paymentMode);
				}
			} else if (entity === 'order') {
				row = salesModuleData.salesOrders[editingSiIdx];
				if (row) {
					const setVal = (id, v) => { const el = document.getElementById('si-field-' + id); if (el && v !== undefined) el.value = v; };
					setVal('customer', row.customer);
					setVal('orderDate', row.orderDate);
					setVal('deliveryDate', row.deliveryDate);
					setVal('amount', row.amount);
					setVal('promo', row.promo || 0);
					setVal('promoNote', row.promoNote || '');
					setVal('status', row.status);
					setVal('paymentMode', row.paymentMode);
				}
			}
		}
		addModal.style.display = 'flex';
		/* Auto-calculate promo when qty changes: 4 bags per 100 */
		const qtyField = document.getElementById('si-field-qty');
		const promoField = document.getElementById('si-field-promo');
		if (qtyField && promoField) {
			qtyField.addEventListener('input', () => {
				const qty = parseInt(qtyField.value) || 0;
				promoField.value = qty > 100 ? Math.floor(qty / 100) * 4 : 0;
			});
		}
		const firstInput = modalFieldsEl && modalFieldsEl.querySelector('input, select');
		if (firstInput) firstInput.focus();
	};

	document.getElementById('si-modal-close')?.addEventListener('click', closeModal);
	document.getElementById('si-modal-cancel')?.addEventListener('click', closeModal);
	addModal?.addEventListener('click', (e) => { if (e.target === addModal) closeModal(); });

	const getValue = (id) => {
		const el = document.getElementById(`si-field-${id}`);
		return el ? el.value.trim() : '';
	};
	const getNum = (id) => {
		const v = Number(getValue(id));
		return Number.isFinite(v) && v >= 0 ? v : 0;
	};

	if (modalForm && !modalForm.dataset.bound) {
		modalForm.dataset.bound = '1';
		modalForm.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!currentEntity) return;

			if (currentEntity === 'invoice') {
				const customer = getValue('customer');
				const product = getValue('product');
				if (!customer || !product) return;
				const invDate = getValue('date') || todayStr;
				const chosenStatus = getValue('status') || 'pending';
				const invData = {
					customer,
					address: getValue('address'),
					phone: getValue('phone'),
					date: invDate,
					paidDate: getValue('paidDate') || (chosenStatus === 'paid' ? invDate : ''),
					status: isApprover ? chosenStatus : 'pending_approval',
					requestedStatus: isApprover ? undefined : chosenStatus,
					paymentMode: getValue('paymentMode'),
					promo: getNum('promo'),
					promoNote: getValue('promoNote'),
					product,
					items: [{ name: product, qty: getNum('qty') || 1, unitPrice: getNum('unitPrice') }],
					deliveryFee: getNum('deliveryFee'),
					createdAt: new Date().toISOString(),
				};
				invData.rate = invData.items[0].unitPrice;
				invData.amount = invData.items[0].qty * invData.items[0].unitPrice;
				if (editingSiIdx >= 0 && salesModuleData.invoices[editingSiIdx]) {
					Object.assign(salesModuleData.invoices[editingSiIdx], invData);
					/* Sync matching sales order */
					const matchIdx = salesModuleData.salesOrders.findIndex((o) => o.id === 'SO' + salesModuleData.invoices[editingSiIdx].id.slice(3));
					if (matchIdx >= 0) {
						Object.assign(salesModuleData.salesOrders[matchIdx], {
							customer: invData.customer, orderDate: invData.date, deliveryDate: invData.date,
							amount: invData.amount, bags: invData.items[0].qty, rate: invData.rate,
							paymentMode: invData.paymentMode, promo: invData.promo, promoNote: invData.promoNote,
							status: invData.status === 'paid' ? 'delivered' : invData.status === 'overdue' ? 'overdue' : 'pending',
						});
					}
				} else {
					invData.id = nextInvoiceId();
					if (!invData.createdAt) invData.createdAt = new Date().toISOString();
					salesModuleData.invoices.push(invData);
					/* Auto-create matching sales order */
					const soId = 'SO' + invData.id.slice(3);
					salesModuleData.salesOrders.push({
						id: soId, customer: invData.customer,
						orderDate: invData.date, deliveryDate: invData.date,
						amount: invData.amount, bags: invData.items[0].qty, rate: invData.rate,
						paymentMode: invData.paymentMode, promo: invData.promo, promoNote: invData.promoNote,
						status: invData.status === 'paid' ? 'delivered' : 'pending',
					});
				}
				if (!isApprover) {
					alert('Invoice saved as "Pending Approval". A Manager or CEO will review and approve it.');
				}
			}

			if (currentEntity === 'order') {
				const customer = getValue('customer');
				if (!customer) return;
				const chosenStatus = getValue('status') || 'confirmed';
				const ordData = {
					customer,
					orderDate: getValue('orderDate') || todayStr,
					deliveryDate: getValue('deliveryDate') || todayStr,
					amount: getNum('amount'),
					promo: getNum('promo'),
					promoNote: getValue('promoNote'),
					paymentMode: getValue('paymentMode'),
					status: isApprover ? chosenStatus : 'pending_approval',
					requestedStatus: isApprover ? undefined : chosenStatus,
				};
				if (editingSiIdx >= 0 && salesModuleData.salesOrders[editingSiIdx]) {
					Object.assign(salesModuleData.salesOrders[editingSiIdx], ordData);
					/* Sync matching invoice */
					const matchIdx = salesModuleData.invoices.findIndex((inv) => inv.id === 'INV' + salesModuleData.salesOrders[editingSiIdx].id.slice(2));
					if (matchIdx >= 0) {
						const inv = salesModuleData.invoices[matchIdx];
						inv.customer = ordData.customer;
						inv.date = ordData.orderDate;
						inv.amount = ordData.amount;
						inv.paymentMode = ordData.paymentMode;
						inv.promo = ordData.promo;
						inv.promoNote = ordData.promoNote;
						inv.status = ordData.status === 'delivered' ? 'paid' : ordData.status === 'overdue' ? 'overdue' : 'pending';
						inv.paidDate = inv.status === 'paid' ? inv.date : '';
					}
				} else {
					ordData.id = nextOrderId();
					salesModuleData.salesOrders.push(ordData);
					/* Auto-create matching invoice */
					const invId = 'INV' + ordData.id.slice(2);
					const product = '500ml Sachet Water (500 pcs/bag)';
					const rate = ordData.amount && ordData.bags ? +(ordData.amount / ordData.bags).toFixed(2) : 0;
					salesModuleData.invoices.push({
						id: invId, customer: ordData.customer, product,
						date: ordData.orderDate, paidDate: ordData.status === 'delivered' ? ordData.orderDate : '',
						status: ordData.status === 'delivered' ? 'paid' : 'pending',
						amount: ordData.amount, rate, paymentMode: ordData.paymentMode,
						promo: ordData.promo, promoNote: ordData.promoNote,
						items: [{ name: product, qty: ordData.bags || 1, unitPrice: rate }],
						deliveryFee: 0,
					});
				}
				if (!isApprover) {
					alert('Sales Order saved as "Pending Approval". A Manager or CEO will review and approve it.');
				}
			}

			saveSalesDataToStorage();
			closeModal();
			renderSalesPage();
		});
	}

	document.addEventListener('click', (event) => {
		const button = event.target.closest('.si-add-btn[data-add-entity]');
		if (button) { openModal(button.getAttribute('data-add-entity')); return; }
		const editBtn = event.target.closest('.si-edit-btn');
		if (editBtn) {
			event.stopPropagation();
			openModal(editBtn.getAttribute('data-edit-entity'), Number(editBtn.getAttribute('data-edit-idx')));
			return;
		}
		const deleteBtn = event.target.closest('.si-delete-btn');
		if (deleteBtn) {
			event.stopPropagation();
			const entity = deleteBtn.getAttribute('data-delete-entity');
			const idx = Number(deleteBtn.getAttribute('data-delete-idx'));
			const label = entity === 'invoice' ? 'invoice' : 'sales order';
			if (!confirm('Delete this ' + label + '? This cannot be undone.')) return;
			if (entity === 'invoice') {
				const inv = salesModuleData.invoices[idx];
				salesModuleData.invoices.splice(idx, 1);
				// Also remove matching sales order
				if (inv) {
					const soId = 'SO' + inv.id.slice(3);
					const soIdx = salesModuleData.salesOrders.findIndex(o => o.id === soId);
					if (soIdx !== -1) salesModuleData.salesOrders.splice(soIdx, 1);
				}
			} else if (entity === 'order') {
				const ord = salesModuleData.salesOrders[idx];
				salesModuleData.salesOrders.splice(idx, 1);
				// Also remove matching invoice
				if (ord) {
					const invId = 'INV' + ord.id.slice(2);
					const invIdx = salesModuleData.invoices.findIndex(v => v.id === invId);
					if (invIdx !== -1) salesModuleData.invoices.splice(invIdx, 1);
				}
			}
			saveSalesDataToStorage();
			renderSalesPage();
		}
		const approveBtn = event.target.closest('.si-approve-btn');
		if (approveBtn) {
			event.stopPropagation();
			const entity = approveBtn.getAttribute('data-approve-entity');
			const idx = Number(approveBtn.getAttribute('data-approve-idx'));
			if (entity === 'invoice' && salesModuleData.invoices[idx]) {
				const inv = salesModuleData.invoices[idx];
				inv.status = inv.requestedStatus || 'pending';
				delete inv.requestedStatus;
			} else if (entity === 'order' && salesModuleData.salesOrders[idx]) {
				const ord = salesModuleData.salesOrders[idx];
				ord.status = ord.requestedStatus || 'confirmed';
				delete ord.requestedStatus;
			}
			saveSalesDataToStorage();
			renderSalesPage();
		}
	});

	function autoDetectOverdue() {
		const today = new Date(todayStr);
		salesModuleData.invoices.forEach((inv) => {
			if (inv.status === 'pending' && inv.paidDate && new Date(inv.paidDate) < today) {
				inv.status = 'overdue';
			}
		});
		salesModuleData.salesOrders.forEach((order) => {
			if (['confirmed', 'processing', 'shipped'].includes(order.status) && order.deliveryDate && new Date(order.deliveryDate) < today) {
				order.status = 'overdue';
			}
		});
		saveSalesDataToStorage();
	}

	function handleFollowUp(orderId) {
		const order = salesModuleData.salesOrders.find((o) => o.id === orderId);
		if (!order) return;
		const note = prompt(`Follow-up note for ${orderId}:`);
		if (note === null) return;
		if (!order.followUps) order.followUps = [];
		order.followUps.push({ date: todayStr, note });
		saveSalesDataToStorage();
		renderSalesPage();
	}

	function renderSalesPage() {
		autoDetectOverdue();

		const invoiceRows = salesModuleData.invoices.map((invoice) => {
			return { ...invoice };
		});
		const orders = salesModuleData.salesOrders;

		const totalInvoices = invoiceRows.length;
		const invoiceRevenue = invoiceRows.filter((inv) => inv.status === 'paid').reduce((sum, inv) => sum + inv.amount, 0);
		const salesRevenue = orders.filter((o) => o.status === 'delivered').reduce((sum, o) => sum + Number(o.amount || 0), 0);
		const pendingInvoices = invoiceRows.filter((inv) => inv.status === 'pending').reduce((sum, inv) => sum + inv.amount, 0);
		const pendingSales = orders.filter((o) => ['confirmed', 'processing', 'shipped'].includes(o.status)).reduce((sum, o) => sum + Number(o.amount || 0), 0);
		const overdueInvAmt = invoiceRows.filter((inv) => inv.status === 'overdue').reduce((sum, inv) => sum + inv.amount, 0);
		const overdueOrdAmt = orders.filter((o) => o.status === 'overdue').reduce((sum, o) => sum + Number(o.amount || 0), 0);
		const overdueTotal = overdueInvAmt + overdueOrdAmt;

		const stats = document.getElementById('si-stats-row');
		if (stats) {
			const waybills = (() => { try { return JSON.parse(localStorage.getItem('ww_waybills') || '[]'); } catch(_e) { return []; } })();
			const waybillCount = waybills.length;
			const waybillTotalQty = waybills.reduce((s, w) => s + (w.items || []).reduce((q, i) => q + (parseFloat(i.qty) || 0), 0), 0);
			const waybillPending = waybills.filter((w) => !w.received).length;
			const totalPromoBags = invoiceRows.reduce((sum, inv) => sum + (inv.promo || 0), 0) + orders.reduce((sum, o) => sum + (o.promo || 0), 0);
			const invoicePromo = invoiceRows.reduce((sum, inv) => sum + (inv.promo || 0), 0);
			const totalBagsSold = invoiceRows.reduce((sum, inv) => sum + ((inv.items && inv.items[0] ? inv.items[0].qty : 0) || 0), 0);
			const nonPromoBags = totalBagsSold - invoicePromo;
			const hideMoney = window.__wwUserRole === 'supervisor' || window.__wwUserRole === 'staff';
			stats.innerHTML = `
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-file-invoice"></i></div><p class="s-label">Total Invoices</p><p class="s-value">${totalInvoices}</p><p class="s-meta">${orders.length} sales order${orders.length !== 1 ? 's' : ''}</p></div>
				<div class="stat-card" ${hideMoney ? 'style="display:none"' : ''}><div class="s-icon"><i class="fa-solid fa-dollar-sign"></i></div><p class="s-label">Total Revenue</p><p class="s-value">${formatCurrency(invoiceRevenue + salesRevenue)}</p><p class="s-meta split-meta"><span>Invoices: ${formatCurrency(invoiceRevenue)}</span><span>Sales: ${formatCurrency(salesRevenue)}</span><span>Waybills: ${formatNumber(waybillTotalQty)} units dispatched</span></p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-gift"></i></div><p class="s-label">Total Promo Bags</p><p class="s-value">${formatNumber(invoicePromo)}</p><p class="s-meta split-meta"><span>Total bags: ${formatNumber(totalBagsSold)}</span><span>Non-promo: ${formatNumber(nonPromoBags)}</span><span>Promo: ${formatNumber(invoicePromo)}</span></p></div>
				<div class="stat-card" ${hideMoney ? 'style="display:none"' : ''}><div class="s-icon"><i class="fa-solid fa-clock"></i></div><p class="s-label">Pending</p><p class="s-value">${formatCurrency(pendingInvoices + pendingSales)}</p><p class="s-meta split-meta"><span>Invoices: ${formatCurrency(pendingInvoices)}</span><span>Sales: ${formatCurrency(pendingSales)}</span><span>Waybills: ${waybillPending} pending delivery</span></p></div>
				<div class="stat-card ${overdueTotal > 0 ? 'stat-card-alert' : ''}" ${hideMoney ? 'style="display:none"' : ''}><div class="s-icon"><i class="fa-solid fa-circle-exclamation"></i></div><p class="s-label">Overdue</p><p class="s-value">${formatCurrency(overdueTotal)}</p><p class="s-meta">${overdueInvAmt > 0 ? 'Inv: ' + formatCurrency(overdueInvAmt) + ' ' : ''}${overdueOrdAmt > 0 ? 'Orders: ' + formatCurrency(overdueOrdAmt) : ''}${overdueTotal === 0 ? 'All clear' : ''}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-truck-fast"></i></div><p class="s-label">Total Waybills</p><p class="s-value" id="wb-stat-count">${waybillCount}</p><p class="s-meta">Dispatch documents</p></div>
			`;
		}

		const invoiceBody = document.getElementById('invoice-tbody');
		const hideMoney = window.__wwUserRole === 'supervisor' || window.__wwUserRole === 'staff';
		if (invoiceBody) {
			invoiceBody.innerHTML = invoiceRows.map((invoice, idx) => {
				const statusLabel = invoice.status === 'pending_approval' ? 'Pending Approval' : invoice.status;
				const approveBtn = isApprover && invoice.status === 'pending_approval'
					? `<button class="btn-approve si-approve-btn" data-approve-entity="invoice" data-approve-idx="${idx}" title="Approve"><i class="fa-solid fa-check"></i></button>`
					: '';
				return `
					<tr class="selectable" data-invoice-id="${invoice.id}">
						<td>${invoice.id}</td>
						<td>${invoice.customer}</td>
						<td>${invoice.promo ? invoice.promo + (invoice.promoNote ? ' <small style="color:#6b7280">(' + invoice.promoNote + ')</small>' : '') : ''}</td>
						<td>${invoice.items && invoice.items[0] ? invoice.items[0].qty : ''}</td>
						<td>${hideMoney ? '—' : (invoice.rate ? invoice.rate : (invoice.items && invoice.items[0] && invoice.items[0].qty ? (invoice.amount / invoice.items[0].qty).toFixed(1) : ''))}</td>
						<td>${formatDateDisplay(invoice.date)}</td>
						<td>${hideMoney ? '—' : formatCurrency(invoice.amount)}</td>
						<td>${invoice.paymentMode || ''}</td>
						<td><span class="status-pill ${statusPillClass(invoice.status)}">${statusLabel}</span></td>
						<td><div class="row-actions">${approveBtn}<button class="btn-edit si-edit-btn" data-edit-entity="invoice" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete si-delete-btn" data-delete-entity="invoice" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
					</tr>
				`;
			}).join('');

			invoiceBody.querySelectorAll('tr').forEach((row) => {
				row.addEventListener('click', () => {
					invoiceBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
					row.classList.add('row-selected');
					const invoice = salesModuleData.invoices.find((inv) => inv.id === row.getAttribute('data-invoice-id'));
					renderInvoiceDetail(invoice);
				});
			});
		}

		/* Right-panel: show clickable invoice list instead of empty placeholder */
		const detailContent = document.getElementById('invoice-detail-content');
		if (detailContent) {
			if (invoiceRows.length === 0) {
				detailContent.innerHTML = '<p class="detail-placeholder">No invoices yet. Add one to get started.</p>';
			} else if (!detailContent.querySelector('.detail-section')) {
				detailContent.innerHTML = '<ul class="invoice-quick-list">' + invoiceRows.map((inv) => {
					const statusLabel = inv.status === 'pending_approval' ? 'Pending Approval' : inv.status;
					return `<li class="invoice-quick-item" data-qid="${inv.id}">
						<span class="iq-id">${inv.id}</span>
						<span class="iq-customer">${inv.customer}</span>
						<span class="iq-amount">${formatCurrency(inv.amount)}</span>
						<span class="status-pill ${statusPillClass(inv.status)}">${statusLabel}</span>
					</li>`;
				}).join('') + '</ul>';
				detailContent.querySelectorAll('.invoice-quick-item').forEach((li) => {
					li.addEventListener('click', () => {
						const inv = salesModuleData.invoices.find((i) => i.id === li.getAttribute('data-qid'));
						if (inv) renderInvoiceDetail(inv);
						/* also highlight the table row */
						if (invoiceBody) {
							invoiceBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
							const matchRow = invoiceBody.querySelector(`tr[data-invoice-id="${inv.id}"]`);
							if (matchRow) matchRow.classList.add('row-selected');
						}
					});
				});
			}
		}

		const ordersBody = document.getElementById('orders-tbody');
		if (ordersBody) {
			ordersBody.innerHTML = orders.map((order, idx) => {
				const showFollowUp = ['overdue', 'confirmed', 'processing', 'shipped'].includes(order.status);
				const followUpCount = (order.followUps && order.followUps.length) || 0;
				const statusLabel = order.status === 'pending_approval' ? 'Pending Approval' : order.status;
				const approveBtn = isApprover && order.status === 'pending_approval'
					? `<button class="btn-approve si-approve-btn" data-approve-entity="order" data-approve-idx="${idx}" title="Approve"><i class="fa-solid fa-check"></i></button>`
					: '';
				return `
					<tr>
						<td>${order.id}</td>
						<td>${order.customer}</td>
						<td>${order.promo ? order.promo + (order.promoNote ? ' <small style="color:#6b7280">(' + order.promoNote + ')</small>' : '') : ''}</td>
						<td>${order.bags || ''}</td>
						<td>${hideMoney ? '—' : (order.rate ? order.rate : (order.bags && order.amount ? (order.amount / order.bags).toFixed(1) : ''))}</td>
						<td>${formatDateDisplay(order.orderDate)}</td>
						<td>${hideMoney ? '—' : formatCurrency(order.amount)}</td>
						<td>${order.paymentMode || ''}</td>
						<td><span class="status-pill ${statusPillClass(order.status)}">${statusLabel}</span></td>
						<td><div class="row-actions">${approveBtn}<button class="btn-edit si-edit-btn" data-edit-entity="order" data-edit-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete si-delete-btn" data-delete-entity="order" data-delete-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td>
					</tr>
				`;
			}).join('');

			ordersBody.querySelectorAll('.btn-follow-up').forEach((btn) => {
				btn.addEventListener('click', () => handleFollowUp(btn.getAttribute('data-order-id')));
			});
		}
	}

	renderSalesPage();

	document.addEventListener('ww-refresh-sales', () => renderSalesPage());

	// ── Online Orders Tab ──
	if (document.getElementById('online-orders-tbody')) {
		loadOnlineOrders();
		// Auto-refresh every 30s
		setInterval(loadOnlineOrders, 30000);
	}
  } catch (err) {
    console.error('[Sales] initSalesInvoicesPage CRASHED:', err);
  }
}

// ── Online Store Orders (Management Side) ──
async function loadOnlineOrders() {
	const tbody = document.getElementById('online-orders-tbody');
	const badge = document.getElementById('online-orders-badge');
	if (!tbody) return;

	try {
		const res = await fetch(API_BASE + '/api/store/admin/orders');
		if (!res.ok) {
			tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#587289;padding:24px">Unable to load online orders. Make sure you are logged in.</td></tr>';
			return;
		}
		let orders = await res.json();

		// Apply status filter if set
		const filterSel = document.getElementById('online-status-filter');
		const filterVal = filterSel ? filterSel.value : '';
		if (filterVal) {
			orders = orders.filter((o) => o.status === filterVal);
		}

		// Update badge with pending count
		const pendingCount = orders.filter((o) => o.status === 'Pending').length;
		if (badge) {
			badge.style.display = pendingCount > 0 ? '' : 'none';
			badge.textContent = pendingCount;
		}

		if (!orders.length) {
			tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#587289;padding:24px"><i class="fa-solid fa-inbox"></i> No online orders' + (filterVal ? ' matching this filter' : ' yet') + '.</td></tr>';
			return;
		}

		tbody.innerHTML = orders.map((o) => {
			const items = o.items.map((i) => `${i.name} ×${i.qty}`).join(', ');
			const date = new Date(o.created_at).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' });
			const statusOpts = ['Pending', 'Confirmed', 'Processing', 'Dispatched', 'Delivered', 'Cancelled']
				.map((s) => `<option value="${s}"${o.status === s ? ' selected' : ''}>${s}</option>`).join('');
			const pillClass = o.status === 'Delivered' ? 'status-green' : o.status === 'Cancelled' ? 'status-red' : o.status === 'Pending' ? 'status-yellow' : 'status-blue';
			return `
				<tr>
					<td><strong>${o.order_code}</strong></td>
					<td>${escapeHtml(o.customerName)}<br><small style="color:#587289">${escapeHtml(o.customerEmail)}</small></td>
					<td>${escapeHtml(o.phone || o.customerPhone)}</td>
					<td style="max-width:200px;font-size:0.85rem">${escapeHtml(items)}</td>
					<td><strong>${formatCurrency(o.total)}</strong></td>
					<td>${date}</td>
					<td><span class="status-pill ${pillClass}">${o.status}</span></td>
					<td><select class="online-status-sel" onchange="updateOnlineOrderStatus(${o.id}, this.value)">${statusOpts}</select></td>
				</tr>
			`;
		}).join('');
	} catch (_e) {
		tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#587289;padding:24px">Error loading orders.</td></tr>';
	}
}
window.loadOnlineOrders = loadOnlineOrders;

async function updateOnlineOrderStatus(orderId, newStatus) {
	try {
		const res = await fetch(API_BASE + `/api/store/admin/orders/${orderId}/status`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: newStatus }),
		});
		if (!res.ok) {
			alert('Failed to update status');
			return;
		}
		loadOnlineOrders();
	} catch (_e) {
		alert('Network error updating status');
	}
}
window.updateOnlineOrderStatus = updateOnlineOrderStatus;

/* ═══════════════════  WAYBILL MODULE  ═══════════════════ */
(async function initWaybillModule() {
	const WB_KEY = 'ww_waybills';
	const listTbody = document.getElementById('wb-list-tbody');
	const editorEl = document.getElementById('wb-editor');
	const listSection = document.getElementById('wb-list-section');

	if (!listTbody) return; // not on invoices page

	const wbUserRole = await resolveCurrentUserRole();
	const wbIsApprover = canEditDelete(wbUserRole);

	function loadWaybills() {
		try { return JSON.parse(localStorage.getItem(WB_KEY) || '[]'); } catch (_e) { return []; }
	}
	function saveWaybills(arr) { localStorage.setItem(WB_KEY, JSON.stringify(arr)); syncToServer(WB_KEY, arr); }

	function nextWaybillNo() {
		const year = new Date().getFullYear();
		const prefix = `WWW${year}`;
		const all = loadWaybills();
		const nums = all
			.filter((w) => String(w.no).startsWith(prefix))
			.map((w) => { const m = String(w.no).match(/(\d+)$/); return m ? Number(m[1]) : 0; });
		const next = (Math.max(0, ...nums) + 1);
		return `${prefix}${String(next).padStart(4, '0')}`;
	}

	let editingWbIdx = -1;

	function renderWaybillDetail(w) {
		const target = document.getElementById('wb-detail-content');
		if (!target || !w) return;
		const items = (w.items || []).filter((i) => i.desc || i.qty);
		const wbStatus = w.status || 'approved';
		const pendingBanner = wbStatus === 'pending_approval'
			? `<div class="approval-banner"><i class="fa-solid fa-hourglass-half"></i> Pending Approval${wbIsApprover ? ' — <button class="btn-approve-inline wb-detail-approve-btn">Approve</button>' : ''}</div>`
			: '';
		function fmtDate(d) {
			if (!d) return '';
			const dt = new Date(d + 'T00:00:00');
			if (isNaN(dt)) return d;
			return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
		}
		target.innerHTML = `
			${pendingBanner}
			<div class="waybill-doc wb-detail-doc" id="wb-detail-document">
				<div class="wb-header">
					<div class="wb-logo-area"><img src="../images/Final%20Logo.jpg" alt="Logo" class="wb-logo"></div>
					<div class="wb-company-info">
						<h2 class="wb-company-name">White Water Wells LTD</h2>
						<p>P.O. Box 18204, Accra</p>
						<p>Location: Comm 25 Peace B Down</p>
						<p>Accra-Prampram Road</p>
						<p>GPS Address: GN-0709-4736</p>
						<p>Mobile: 0243108878 / 0244483793</p>
						<p>E-mail: whitewaterwellscompanyltd@gmail.com</p>
					</div>
					<div class="wb-number-area"><label>No:</label> <span style="color:#1a3d5c;font-family:monospace;font-size:1.05rem">${w.no}</span></div>
				</div>
				<h3 class="wb-title">WAYBILL</h3>
				<div class="wb-detail-fields">
					<div class="wb-detail-row"><span class="wb-detail-label">TO:</span><span class="wb-detail-val">${w.to || '—'}</span></div>
					<div class="wb-detail-row"><span class="wb-detail-label">Driver's Name:</span><span class="wb-detail-val">${w.driver || '—'}</span></div>
					<div class="wb-detail-row"><span class="wb-detail-label">Address:</span><span class="wb-detail-val">${w.address || '—'}</span></div>
					<div class="wb-detail-row-split">
						<div class="wb-detail-row"><span class="wb-detail-label">Car Number:</span><span class="wb-detail-val">${w.car || '—'}</span></div>
						<div class="wb-detail-row"><span class="wb-detail-label">Date:</span><span class="wb-detail-val">${fmtDate(w.date)}</span></div>
					</div>
				</div>
				<table class="wb-items-table">
					<thead><tr><th style="width:18%">Quantity</th><th style="width:52%">Description</th><th style="width:30%">Remarks</th></tr></thead>
					<tbody>
						${items.length ? items.map((it) => `<tr><td>${it.qty || ''}</td><td>${it.desc || ''}</td><td>${it.rem || ''}</td></tr>`).join('') : '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:12px">No items</td></tr>'}
					</tbody>
				</table>
				<div class="wb-signatures" style="pointer-events:none">
					<div class="wb-sig-field"><label>Despatched By:</label><span class="wb-detail-val">${w.despatched || ''}</span><div class="wb-sig-line"></div></div>
					<div class="wb-sig-field"><label>Received By:</label><span class="wb-detail-val">${w.received || ''}</span><div class="wb-sig-line"></div></div>
					<div class="wb-sig-field"><label>Driver's Signature:</label><div class="wb-sig-line"></div></div>
				</div>
				<p class="wb-tagline">Pure. Reliable. Refreshing.</p>
			</div>
			<div class="wb-detail-actions">
				<button type="button" class="btn-primary wb-detail-print-btn"><i class="fa-solid fa-print"></i> Print Waybill</button>
			</div>
		`;

		target.querySelector('.wb-detail-approve-btn')?.addEventListener('click', () => {
			const waybills = loadWaybills();
			const idx = waybills.findIndex((wb) => wb.no === w.no);
			if (idx >= 0) {
				waybills[idx].status = 'approved';
				saveWaybills(waybills);
				renderWaybillList();
				updateWaybillStat();
				renderWaybillDetail(waybills[idx]);
			}
		});

		target.querySelector('.wb-detail-print-btn')?.addEventListener('click', () => {
			const doc = document.getElementById('wb-detail-document');
			if (!doc) return;
			const printWin = window.open('', '_blank', 'width=800,height=1000');
			printWin.document.write('<!DOCTYPE html><html><head><title>Waybill ' + w.no + '</title><style>' +
				'* { margin:0; padding:0; box-sizing:border-box; }' +
				'body { font-family: "Segoe UI", Arial, sans-serif; padding: 30px; color: #1e293b; }' +
				'.wb-header { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 10px; }' +
				'.wb-logo { width: 80px; height: 80px; border-radius: 8px; object-fit: cover; }' +
				'.wb-company-info { flex: 1; }' +
				'.wb-company-name { font-size: 1.3rem; font-weight: 700; color: #1a3d5c; margin-bottom: 2px; }' +
				'.wb-company-info p { font-size: 0.82rem; line-height: 1.5; color: #334155; margin: 0; }' +
				'.wb-number-area { text-align: right; font-weight: 700; font-size: 0.95rem; }' +
				'.wb-number-area label { color: #64748b; }' +
				'.wb-title { text-align: center; font-size: 1.3rem; text-decoration: underline; margin: 14px 0; letter-spacing: 2px; color: #1a3d5c; }' +
				'.wb-detail-fields { margin: 10px 0; }' +
				'.wb-detail-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: baseline; }' +
				'.wb-detail-label { font-weight: 600; min-width: 130px; font-size: 0.9rem; color: #334155; }' +
				'.wb-detail-val { font-size: 0.92rem; border-bottom: 1px solid #cbd5e1; flex: 1; padding-bottom: 2px; }' +
				'.wb-detail-row-split { display: flex; gap: 24px; }' +
				'.wb-detail-row-split .wb-detail-row { flex: 1; }' +
				'.wb-items-table { width: 100%; border-collapse: collapse; margin: 14px 0; }' +
				'.wb-items-table th { background: #1a3d5c; color: #fff; padding: 8px 10px; text-align: left; font-size: 0.85rem; }' +
				'.wb-items-table td { border: 1px solid #cbd5e1; padding: 6px 10px; font-size: 0.88rem; }' +
				'.wb-signatures { margin-top: 20px; }' +
				'.wb-sig-field { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }' +
				'.wb-sig-field label { font-weight: 600; min-width: 150px; font-size: 0.9rem; }' +
				'.wb-sig-line { flex: 1; border-bottom: 1px solid #94a3b8; min-height: 20px; }' +
				'.wb-tagline { text-align: center; font-style: italic; color: #2563eb; margin-top: 24px; font-size: 0.95rem; font-weight: 600; }' +
				'.wb-detail-actions { display: none; }' +
				'@media print { body { padding: 10px; } }' +
			'</style></head><body>' + doc.outerHTML + '</body></html>');
			printWin.document.close();
			setTimeout(() => { printWin.focus(); printWin.print(); }, 300);
		});
	}

	function renderWaybillList() {
		const waybills = loadWaybills();
		if (waybills.length === 0) {
			listTbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px">No waybills yet. Click "New Waybill" to create one.</td></tr>';
		} else {
			listTbody.innerHTML = waybills.map((w, idx) => {
				const itemCount = (w.items || []).filter((i) => i.desc).length;
				const wbStatus = w.status || 'approved';
				const statusLabel = wbStatus === 'pending_approval' ? 'Pending Approval' : wbStatus;
				const approveBtn = wbIsApprover && wbStatus === 'pending_approval'
					? `<button class="btn-approve wb-approve-btn" data-idx="${idx}" title="Approve"><i class="fa-solid fa-check"></i></button>`
					: '';
				return `<tr class="selectable" data-wb-idx="${idx}">
					<td><strong>${w.no}</strong></td>
					<td>${w.to || '—'}</td>
					<td>${w.driver || '—'}</td>
					<td>${w.car || '—'}</td>
					<td>${formatDateDisplay(w.date) || '—'}</td>
					<td>${itemCount} item${itemCount !== 1 ? 's' : ''}</td>
					<td><span class="status-pill ${statusPillClass(wbStatus)}">${statusLabel}</span></td>
					<td><div class="row-actions">
						${approveBtn}
						<button class="btn-edit wb-edit-btn" data-idx="${idx}" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
						<button class="btn-delete wb-delete-btn" data-idx="${idx}" title="Delete"><i class="fa-solid fa-trash"></i></button>
					</div></td>
				</tr>`;
			}).join('');
		}
	}

	function showEditor(waybill) {
		listSection.style.display = 'none';
		editorEl.style.display = 'block';
		document.getElementById('wb-new-btn').style.display = 'none';

		document.getElementById('wb-no-display').textContent = waybill.no || nextWaybillNo();
		document.getElementById('wb-to').value = waybill.to || '';
		document.getElementById('wb-driver').value = waybill.driver || '';
		document.getElementById('wb-address').value = waybill.address || '';
		document.getElementById('wb-car').value = waybill.car || '';
		document.getElementById('wb-date').value = waybill.date || new Date().toISOString().slice(0, 10);
		document.getElementById('wb-despatched').value = waybill.despatched || '';
		document.getElementById('wb-received').value = waybill.received || '';

		const itemsTbody = document.getElementById('wb-items-tbody');
		const items = waybill.items && waybill.items.length ? waybill.items : [{ qty: '', desc: '', rem: '' }];
		itemsTbody.innerHTML = items.map((it) => `<tr><td><input type="text" class="wb-input wb-item-qty" value="${it.qty || ''}" placeholder="0"></td><td><input type="text" class="wb-input wb-item-desc" value="${it.desc || ''}" placeholder="Item description"></td><td><input type="text" class="wb-input wb-item-rem" value="${it.rem || ''}" placeholder="Remarks"></td></tr>`).join('');
	}

	function updateWaybillStat() {
		const el = document.getElementById('wb-stat-count');
		if (el) el.textContent = loadWaybills().length;
	}

	function showList() {
		editorEl.style.display = 'none';
		listSection.style.display = 'block';
		document.getElementById('wb-new-btn').style.display = '';
		editingWbIdx = -1;
		renderWaybillList();
		updateWaybillStat();
	}

	function collectFormData() {
		const items = [];
		document.querySelectorAll('#wb-items-tbody tr').forEach((row) => {
			const qty = row.querySelector('.wb-item-qty')?.value.trim() || '';
			const desc = row.querySelector('.wb-item-desc')?.value.trim() || '';
			const rem = row.querySelector('.wb-item-rem')?.value.trim() || '';
			if (qty || desc || rem) items.push({ qty, desc, rem });
		});
		return {
			no: document.getElementById('wb-no-display').textContent,
			to: document.getElementById('wb-to').value.trim(),
			driver: document.getElementById('wb-driver').value.trim(),
			address: document.getElementById('wb-address').value.trim(),
			car: document.getElementById('wb-car').value.trim(),
			date: document.getElementById('wb-date').value,
			despatched: document.getElementById('wb-despatched').value.trim(),
			received: document.getElementById('wb-received').value.trim(),
			items,
		};
	}

	// --- Event listeners ---
	document.getElementById('wb-new-btn')?.addEventListener('click', () => {
		editingWbIdx = -1;
		showEditor({ no: nextWaybillNo() });
	});

	document.getElementById('wb-cancel-btn')?.addEventListener('click', () => {
		editorEl.querySelectorAll('input').forEach((inp) => inp.removeAttribute('readonly'));
		document.getElementById('wb-add-row').style.display = '';
		document.getElementById('wb-save-btn').style.display = '';
		showList();
	});

	document.getElementById('wb-add-row')?.addEventListener('click', () => {
		const tbody = document.getElementById('wb-items-tbody');
		const row = document.createElement('tr');
		row.innerHTML = '<td><input type="text" class="wb-input wb-item-qty" placeholder="0"></td><td><input type="text" class="wb-input wb-item-desc" placeholder="Item description"></td><td><input type="text" class="wb-input wb-item-rem" placeholder="Remarks"></td>';
		tbody.appendChild(row);
	});

	document.getElementById('wb-save-btn')?.addEventListener('click', () => {
		const data = collectFormData();
		if (!data.to && !data.driver) { alert('Please fill in at least the recipient or driver name.'); return; }
		if (!wbIsApprover) {
			data.status = 'pending_approval';
		} else if (!data.status || data.status === 'pending_approval') {
			data.status = 'approved';
		}
		const waybills = loadWaybills();
		if (editingWbIdx >= 0 && waybills[editingWbIdx]) {
			waybills[editingWbIdx] = data;
		} else {
			waybills.push(data);
		}
		saveWaybills(waybills);
		if (!wbIsApprover) {
			alert('Waybill saved as "Pending Approval". A Manager or CEO will review and approve it.');
		}
		showList();
	});

	listTbody.addEventListener('click', (e) => {
		const editBtn = e.target.closest('.wb-edit-btn');
		const deleteBtn = e.target.closest('.wb-delete-btn');
		const approveBtn = e.target.closest('.wb-approve-btn');
		const waybills = loadWaybills();
		if (approveBtn) {
			e.stopPropagation();
			const idx = Number(approveBtn.dataset.idx);
			if (waybills[idx]) {
				waybills[idx].status = 'approved';
				saveWaybills(waybills);
				renderWaybillList();
				updateWaybillStat();
			}
			return;
		}
		if (editBtn) {
			e.stopPropagation();
			const idx = Number(editBtn.dataset.idx);
			if (waybills[idx]) { editingWbIdx = idx; showEditor(waybills[idx]); }
			return;
		}
		if (deleteBtn) {
			e.stopPropagation();
			const idx = Number(deleteBtn.dataset.idx);
			if (!waybills[idx]) return;
			if (!confirm('Delete waybill ' + waybills[idx].no + '?')) return;
			waybills.splice(idx, 1);
			saveWaybills(waybills);
			renderWaybillList();
			updateWaybillStat();
			const detailEl = document.getElementById('wb-detail-content');
			if (detailEl) detailEl.innerHTML = '<p class="detail-placeholder">&#128666; Select a waybill to view full details</p>';
			return;
		}
		/* Row click → show detail */
		const row = e.target.closest('tr[data-wb-idx]');
		if (row) {
			const idx = Number(row.dataset.wbIdx);
			if (waybills[idx]) {
				listTbody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
				row.classList.add('row-selected');
				renderWaybillDetail(waybills[idx]);
			}
		}
	});

	renderWaybillList();
})();

function escapeHtml(str) {
	const d = document.createElement('div');
	d.textContent = str || '';
	return d.innerHTML;
}

function renderPoDetail(po) {
	const target = document.getElementById('po-detail-content');
	if (!target || !po) {
		return;
	}

	target.innerHTML = `
		<div class="detail-section">
			<div class="detail-row"><span class="detail-key">PO Number</span><span class="detail-val">${po.id}</span></div>
			<div class="detail-row"><span class="detail-key">Supplier</span><span class="detail-val">${po.supplier}</span></div>
			<div class="detail-row"><span class="detail-key">Order Date</span><span class="detail-val">${po.date}</span></div>
			<div class="detail-row"><span class="detail-key">Expected</span><span class="detail-val">${po.expectedDate}</span></div>
			<div class="detail-row"><span class="detail-key">Status</span><span class="detail-val"><span class="status-pill ${statusPillClass(po.status)}">${po.status}</span></span></div>
		</div>
		<div class="detail-section">
			<p class="detail-section-label">Items</p>
			${po.items.map((item) => {
				return `<div class="line-item-row"><span>${item.name} x ${item.qty}</span><span>${formatCurrency(item.qty * item.unitCost)}</span></div>`;
			}).join('')}
			<div class="line-total"><span>Total</span><span>${formatCurrency(po.amount)}</span></div>
		</div>
	`;
}

/* ---- Purchase Data Persistence ---- */
const purchaseModuleData = { purchaseOrders: [], suppliers: [] };

/* One-time wipe of old seed data */
(function() { localStorage.removeItem('ww_purchase_data'); })();

function loadPurchaseDataFromStorage() {
	try {
		const stored = JSON.parse(localStorage.getItem('ww_purchase_data_v2') || 'null');
		if (stored && typeof stored === 'object') {
			purchaseModuleData.purchaseOrders = Array.isArray(stored.purchaseOrders) ? stored.purchaseOrders : [];
			purchaseModuleData.suppliers = Array.isArray(stored.suppliers) ? stored.suppliers : [];
		}
	} catch (_e) { /* ignore */ }
}

function savePurchaseDataToStorage() {
	localStorage.setItem('ww_purchase_data_v2', JSON.stringify(purchaseModuleData));
	syncToServer('ww_purchase_data_v2', purchaseModuleData);
	try {
		if (!window.__wwPurchaseChannel) window.__wwPurchaseChannel = new BroadcastChannel('ww_purchase_sync');
		window.__wwPurchaseChannel.postMessage({ type: 'purchase_updated' });
	} catch (_e) { /* fallback to storage event */ }
}

function nextPoId() {
	const nums = purchaseModuleData.purchaseOrders.map((po) => {
		const match = String(po.id).match(/(\d+)$/);
		return match ? Number(match[1]) : 0;
	});
	return `PO-${new Date().getFullYear()}-${String((Math.max(0, ...nums) + 1)).padStart(3, '0')}`;
}

function nextSupplierId() {
	const nums = purchaseModuleData.suppliers.map((s) => {
		const match = String(s.id).match(/(\d+)$/);
		return match ? Number(match[1]) : 0;
	});
	return `SUP-${String((Math.max(0, ...nums) + 1)).padStart(3, '0')}`;
}

function poTotal(po) {
	if (!po.items || !po.items.length) return Number(po.amount || 0);
	return po.items.reduce((sum, item) => sum + (item.qty * item.unitCost), 0);
}

function initPurchasePage() {
	if (document.body.getAttribute('data-page') !== 'vendors') {
		return;
	}

	loadPurchaseDataFromStorage();
	const todayStr = getTodayDateStr();

	const PU_MODAL_CONFIGS = {
		po: {
			title: 'Add Purchase Order',
			fields: [
				{ id: 'supplier', label: 'Supplier', type: 'supplier-select', required: true },
				{ id: 'item', label: 'Item Name', type: 'text', required: true, placeholder: 'e.g. Filter Cartridges' },
				{ id: 'qty', label: 'Quantity', type: 'number', min: '1', required: true },
				{ id: 'unitCost', label: 'Unit Cost (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'date', label: 'Order Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'expectedDate', label: 'Expected Delivery', type: 'date', required: true },
				{ id: 'status', label: 'Status', type: 'select', options: ['pending', 'confirmed', 'shipped', 'delivered'], required: true },
			],
		},
		supplier: {
			title: 'Add Supplier',
			fields: [
				{ id: 'name', label: 'Supplier Name', type: 'text', required: true },
				{ id: 'contact', label: 'Phone', type: 'text', required: true, placeholder: '024-000-0000' },
				{ id: 'email', label: 'Email', type: 'email', required: true, placeholder: 'contact@supplier.com' },
				{ id: 'materials', label: 'Materials Supplied', type: 'text', required: true, placeholder: 'e.g. Packaging, Labels' },
				{ id: 'terms', label: 'Payment Terms', type: 'select', options: ['COD', 'Net 15', 'Net 21', 'Net 30', 'Net 45', 'Net 60'], required: true },
			],
		},
	};

	const addModal = document.getElementById('pu-add-modal');
	const modalTitle = document.getElementById('pu-modal-title');
	const modalFieldsEl = document.getElementById('pu-modal-fields');
	const modalForm = document.getElementById('pu-add-form');
	let currentEntity = null;
	let editingId = null;

	const closeModal = () => {
		if (addModal) addModal.style.display = 'none';
		if (modalForm) modalForm.reset();
		currentEntity = null;
		editingId = null;
	};

	const openModal = (entity, existingId) => {
		const config = PU_MODAL_CONFIGS[entity];
		if (!config || !addModal) return;
		currentEntity = entity;
		editingId = existingId || null;
		if (modalTitle) modalTitle.textContent = editingId ? config.title.replace('Add', 'Edit') : config.title;
		if (modalFieldsEl) {
			modalFieldsEl.innerHTML = config.fields.map((f) => {
				if (f.type === 'supplier-select') {
					const opts = purchaseModuleData.suppliers.map((s) => `<option value="${s.name}">${s.name}</option>`).join('');
					if (!purchaseModuleData.suppliers.length) {
						return `<div class="inv-modal-field"><label for="pu-field-${f.id}">${f.label} <span class="req">*</span></label><select id="pu-field-${f.id}" name="${f.id}" required disabled><option value="">No suppliers yet — add one first</option></select></div>`;
					}
					return `<div class="inv-modal-field"><label for="pu-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><select id="pu-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}><option value="">Select a supplier</option>${opts}</select></div>`;
				}
				if (f.type === 'select') {
					return `<div class="inv-modal-field"><label for="pu-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><select id="pu-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}>${f.options.map((o) => `<option value="${o}">${o.charAt(0).toUpperCase() + o.slice(1)}</option>`).join('')}</select></div>`;
				}
				return `<div class="inv-modal-field"><label for="pu-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><input id="pu-field-${f.id}" type="${f.type}" name="${f.id}" ${f.required ? 'required' : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} ${f.defaultValue ? `value="${f.defaultValue}"` : ''}></div>`;
			}).join('');
		}
		/* Pre-fill fields when editing */
		if (editingId) {
			if (entity === 'po') {
				const po = purchaseModuleData.purchaseOrders.find((p) => p.id === editingId);
				if (po) {
					const setVal = (id, v) => { const el = document.getElementById(`pu-field-${id}`); if (el) el.value = v || ''; };
					setVal('supplier', po.supplier);
					setVal('item', po.items && po.items[0] ? po.items[0].name : '');
					setVal('qty', po.items && po.items[0] ? po.items[0].qty : '');
					setVal('unitCost', po.items && po.items[0] ? po.items[0].unitCost : '');
					setVal('date', po.date);
					setVal('expectedDate', po.expectedDate);
					setVal('status', po.status);
				}
			}
			if (entity === 'supplier') {
				const sup = purchaseModuleData.suppliers.find((s) => s.id === editingId);
				if (sup) {
					const setVal = (id, v) => { const el = document.getElementById(`pu-field-${id}`); if (el) el.value = v || ''; };
					setVal('name', sup.name);
					setVal('contact', sup.contact);
					setVal('email', sup.email);
					setVal('materials', sup.materials);
					setVal('terms', sup.terms);
				}
			}
		}
		addModal.style.display = 'flex';
		const firstInput = modalFieldsEl && modalFieldsEl.querySelector('input, select');
		if (firstInput) firstInput.focus();
	};

	document.getElementById('pu-modal-close')?.addEventListener('click', closeModal);
	document.getElementById('pu-modal-cancel')?.addEventListener('click', closeModal);
	addModal?.addEventListener('click', (e) => { if (e.target === addModal) closeModal(); });

	const getValue = (id) => { const el = document.getElementById(`pu-field-${id}`); return el ? el.value.trim() : ''; };
	const getNum = (id) => { const v = Number(getValue(id)); return Number.isFinite(v) && v >= 0 ? v : 0; };

	if (modalForm && !modalForm.dataset.bound) {
		modalForm.dataset.bound = '1';
		modalForm.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!currentEntity) return;

			if (currentEntity === 'po') {
				const supplier = getValue('supplier');
				const item = getValue('item');
				if (!supplier || !item) return;
				if (editingId) {
					const po = purchaseModuleData.purchaseOrders.find((p) => p.id === editingId);
					if (po) {
						po.supplier = supplier;
						po.date = getValue('date') || todayStr;
						po.expectedDate = getValue('expectedDate') || todayStr;
						po.status = getValue('status') || 'pending';
						po.items = [{ name: item, qty: getNum('qty') || 1, unitCost: getNum('unitCost') }];
					}
				} else {
					purchaseModuleData.purchaseOrders.push({
						id: nextPoId(),
						supplier,
						date: getValue('date') || todayStr,
						expectedDate: getValue('expectedDate') || todayStr,
						status: getValue('status') || 'pending',
						items: [{ name: item, qty: getNum('qty') || 1, unitCost: getNum('unitCost') }],
					});
				}
			}

			if (currentEntity === 'supplier') {
				const name = getValue('name');
				if (!name) return;
				if (editingId) {
					const sup = purchaseModuleData.suppliers.find((s) => s.id === editingId);
					if (sup) {
						sup.name = name;
						sup.contact = getValue('contact');
						sup.email = getValue('email');
						sup.materials = getValue('materials');
						sup.terms = getValue('terms') || 'Net 30';
					}
				} else {
					purchaseModuleData.suppliers.push({
						id: nextSupplierId(),
						name,
						contact: getValue('contact'),
						email: getValue('email'),
						materials: getValue('materials'),
						terms: getValue('terms') || 'Net 30',
						rating: 0,
					});
				}
			}

			savePurchaseDataToStorage();
			closeModal();
			renderPurchasePage();
		});
	}

	document.addEventListener('click', (event) => {
		const addBtn = event.target.closest('.pu-add-btn[data-add-entity]');
		if (addBtn) { openModal(addBtn.getAttribute('data-add-entity')); return; }
		const editBtn = event.target.closest('.pu-edit-btn');
		if (editBtn) {
			event.stopPropagation();
			openModal(editBtn.getAttribute('data-edit-entity'), editBtn.getAttribute('data-edit-id'));
		}
		const deleteBtn = event.target.closest('.pu-delete-btn');
		if (deleteBtn) {
			event.stopPropagation();
			const entity = deleteBtn.getAttribute('data-delete-entity');
			const id = deleteBtn.getAttribute('data-delete-id');
			const label = entity === 'po' ? 'purchase order' : 'supplier';
			if (!confirm('Delete this ' + label + '? This cannot be undone.')) return;
			if (entity === 'po') {
				purchaseModuleData.purchaseOrders = purchaseModuleData.purchaseOrders.filter((po) => po.id !== id);
			} else if (entity === 'supplier') {
				purchaseModuleData.suppliers = purchaseModuleData.suppliers.filter((s) => s.id !== id);
			}
			savePurchaseDataToStorage();
			renderPurchasePage();
		}
	});

	function renderPurchasePage() {
		const orders = purchaseModuleData.purchaseOrders.map((po) => ({ ...po, amount: poTotal(po) }));
		const suppliers = purchaseModuleData.suppliers;

		const activePos = orders.filter((po) => po.status !== 'delivered');
		const pendingCount = orders.filter((po) => po.status === 'pending').length;
		const confirmedCount = orders.filter((po) => po.status === 'confirmed').length;
		const deliveredCount = orders.filter((po) => po.status === 'delivered').length;
		const totalSpent = orders.reduce((sum, po) => sum + po.amount, 0);
		const inTransitOrders = orders.filter((po) => ['confirmed', 'shipped'].includes(po.status));

		const stats = document.getElementById('pu-stats-row');
		if (stats) {
			stats.innerHTML = `
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-file-lines"></i></div><p class="s-label">Active POs</p><p class="s-value">${activePos.length}</p><p class="s-meta split-meta"><span>Pending: ${pendingCount}</span><span>Confirmed: ${confirmedCount}</span><span>Delivered: ${deliveredCount}</span></p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-truck"></i></div><p class="s-label">Suppliers</p><p class="s-value">${suppliers.length}</p><p class="s-meta">Approved vendors</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-coins"></i></div><p class="s-label">Total Spent</p><p class="s-value">${formatCurrency(totalSpent)}</p><p class="s-meta">Across all purchase orders</p></div>
				<div class="stat-card ${inTransitOrders.length > 0 ? 'stat-card-warning' : ''}"><div class="s-icon"><i class="fa-solid fa-truck-moving"></i></div><p class="s-label">In Transit</p><p class="s-value">${inTransitOrders.length}</p><p class="s-meta">${inTransitOrders.length > 0 ? inTransitOrders.map((o) => o.id).join(', ') : 'No orders in transit'}</p></div>
			`;
		}

		const poBody = document.getElementById('po-tbody');
		if (poBody) {
			poBody.innerHTML = orders.map((po) => {
				return `
					<tr class="selectable" data-po-id="${po.id}">
						<td>${po.id}</td>
						<td>${po.supplier}</td>
						<td>${po.date}</td>
						<td>${po.expectedDate}</td>
						<td>${formatCurrency(po.amount)}</td>
						<td><span class="status-pill ${statusPillClass(po.status)}">${po.status}</span></td>
						<td><div class="row-actions"><button class="btn-edit pu-edit-btn" data-edit-entity="po" data-edit-id="${po.id}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete pu-delete-btn" data-delete-entity="po" data-delete-id="${po.id}"><i class="fa-solid fa-trash"></i></button></div></td>
					</tr>
				`;
			}).join('');

			poBody.querySelectorAll('tr').forEach((row) => {
				row.addEventListener('click', () => {
					poBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
					row.classList.add('row-selected');
					const po = orders.find((value) => value.id === row.getAttribute('data-po-id'));
					renderPoDetail(po);
				});
			});
		}

		/* Right panel: list all POs for quick access */
		const detailContent = document.getElementById('po-detail-content');
		if (detailContent) {
			if (orders.length === 0) {
				detailContent.innerHTML = '<p class="detail-placeholder">No purchase orders yet. Add one to get started.</p>';
			} else if (!detailContent.querySelector('.detail-section')) {
				detailContent.innerHTML = '<ul class="invoice-quick-list">' + orders.map((po) => {
					return `<li class="invoice-quick-item" data-qid="${po.id}">
						<span class="iq-id">${po.id}</span>
						<span class="iq-customer">${po.supplier}</span>
						<span class="iq-amount">${formatCurrency(po.amount)}</span>
						<span class="status-pill ${statusPillClass(po.status)}">${po.status}</span>
					</li>`;
				}).join('') + '</ul>';
				detailContent.querySelectorAll('.invoice-quick-item').forEach((li) => {
					li.addEventListener('click', () => {
						const po = orders.find((p) => p.id === li.getAttribute('data-qid'));
						if (po) renderPoDetail(po);
						if (poBody) {
							poBody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
							const matchRow = poBody.querySelector(`tr[data-po-id="${po.id}"]`);
							if (matchRow) matchRow.classList.add('row-selected');
						}
					});
				});
			}
		}

		const suppliersBody = document.getElementById('suppliers-tbody');
		if (suppliersBody) {
			suppliersBody.innerHTML = suppliers.map((supplier) => {
				const orderCount = orders.filter((po) => po.supplier === supplier.name).length;
				const stars = supplier.rating > 0 ? '★'.repeat(Math.round(supplier.rating)) : '—';
				return `
					<tr>
						<td>${supplier.name}</td>
						<td>${supplier.contact}</td>
						<td>${supplier.email}</td>
						<td>${supplier.materials}</td>
						<td>${orderCount}</td>
						<td><span class="badge badge-blue">${supplier.terms}</span></td>
						<td>${supplier.rating > 0 ? `<span class="stars">${stars}</span> ${supplier.rating.toFixed(1)}` : 'New'}</td>
						<td><div class="row-actions"><button class="btn-edit pu-edit-btn" data-edit-entity="supplier" data-edit-id="${supplier.id}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete pu-delete-btn" data-delete-entity="supplier" data-delete-id="${supplier.id}"><i class="fa-solid fa-trash"></i></button></div></td>
					</tr>
				`;
			}).join('');
		}
	}

	renderPurchasePage();
}

/* ---- Accounting Data Persistence ---- */
const accountingData = { ledger: [], cashbook: [], summary: [], currencies: [], salaries: [], assets: [] };

(function() { localStorage.removeItem('ww_accounting_data'); })();

function loadAccountingDataFromStorage() {
	try {
		const stored = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || 'null');
		if (stored && typeof stored === 'object') {
			accountingData.ledger = Array.isArray(stored.ledger) ? stored.ledger : [];
			accountingData.cashbook = Array.isArray(stored.cashbook) ? stored.cashbook : [];
			accountingData.summary = Array.isArray(stored.summary) ? stored.summary : [];
			accountingData.currencies = Array.isArray(stored.currencies) ? stored.currencies : [];
			accountingData.salaries = Array.isArray(stored.salaries) ? stored.salaries : [];
			accountingData.assets = Array.isArray(stored.assets) ? stored.assets : [];
		}
	} catch (_e) { /* ignore */ }

	// One-time seed: March 2026 operational costs
	if (!getSeedFlag('opscost_march2026') && accountingData.ledger.length === 0) {
		seedMarchOperationalCosts();
		setSeedFlag('opscost_march2026');
		saveAccountingDataToStorage();
	} else if (!getSeedFlag('opscost_march2026')) {
		setSeedFlag('opscost_march2026');
	}

	// One-time seed: March 2026 salaries (v5 = 18k/week on Assets sheet)
	if (!getSeedFlag('salaries_march2026_v5')) {
		if (accountingData.salaries.length === 0) {
		// Remove old individual salary ledger entries
		accountingData.ledger = accountingData.ledger.filter(e => !(e.account === 'Salaries' && e.desc && e.desc.startsWith('Salary —')));
		// Remove old aggregate salary ledger/cashbook entries
		accountingData.ledger = accountingData.ledger.filter(e => !(e.account === 'Salaries & Wages'));
		accountingData.cashbook = accountingData.cashbook.filter(e => !(e.desc && e.desc.startsWith('Salaries & Wages')));
		// Remove old salary assets (if any from v4)
		accountingData.assets = accountingData.assets.filter(e => !(e.category === 'Salaries & Wages'));
		accountingData.salaries = [];
		seedMarchSalaries();
		setSeedFlag('salaries_march2026_v5');
		saveAccountingDataToStorage();
		}
		setSeedFlag('salaries_march2026_v5');
	}
}

function seedMarchOperationalCosts() {
	const rows = [
		// 18 March 2026
		{ d:'2026-03-18', desc:'Fuel for Truck 1 (3.5t)', amt:500, acc:'Transport' },
		{ d:'2026-03-18', desc:'Plumbing items', amt:335, acc:'Maintenance' },
		{ d:'2026-03-18', desc:'Filters and delivery', amt:880, acc:'Production' },
		{ d:'2026-03-18', desc:'Banners and delivery', amt:286, acc:'Marketing' },
		{ d:'2026-03-18', desc:'Fuel/Maintenance Tricycles', amt:350, acc:'Transport' },
		{ d:'2026-03-18', desc:'Automated guy', amt:150, acc:'Maintenance' },
		{ d:'2026-03-18', desc:'Pump Delivery', amt:80, acc:'Transport' },
		// 19 March 2026
		{ d:'2026-03-19', desc:'Fuel for Truck 1 (3.0t)', amt:500, acc:'Transport' },
		{ d:'2026-03-19', desc:'Packaging bags (2 bags) + Delivery', amt:920, acc:'Production', note:'840 + 80' },
		{ d:'2026-03-19', desc:'Fuel for Lexus', amt:500, acc:'Transport', note:'Crossed out / queried' },
		// 20 March 2026
		{ d:'2026-03-20', desc:'Fuel for Truck (3.5t)', amt:500, acc:'Transport' },
		{ d:'2026-03-20', desc:'Refuse collection', amt:100, acc:'Administration' },
		{ d:'2026-03-20', desc:'Refreshments for workers', amt:150, acc:'Administration' },
		{ d:'2026-03-20', desc:'Pump for R.O', amt:4200, acc:'Production', note:'Crossed out; c16131 noted' },
		// 21 March 2026
		{ d:'2026-03-21', desc:'Pump Glen for R.O (6.1m)', amt:7200, acc:'Production' },
		{ d:'2026-03-21', desc:'Bore hole pump 2.0hp', amt:2400, acc:'Production' },
		{ d:'2026-03-21', desc:'Electricity', amt:5000, acc:'Utilities' },
		{ d:'2026-03-21', desc:'Truck Clutch (3.0t)', amt:450, acc:'Transport' },
		// 23 March 2026
		{ d:'2026-03-23', desc:'Baskets, crocs, tap bowls', amt:2500, acc:'Production' },
		// 24 March 2026
		{ d:'2026-03-24', desc:'Road control for Kia Mighty (3.5t) + Talo delivery', amt:175, acc:'Transport' },
		{ d:'2026-03-24', desc:'Plumbing items / Pipes', amt:278, acc:'Maintenance', note:'21/3/26' },
		{ d:'2026-03-24', desc:'Plumbing items', amt:270, acc:'Maintenance', note:'23/3/26' },
		{ d:'2026-03-24', desc:'Automated timer + Workmanship', amt:595, acc:'Maintenance', note:'22/3/26; ₵1318 paid to Expo' },
		{ d:'2026-03-24', desc:'Health workers log @₵120/wk x 10 workers', amt:1320, acc:'Salaries', note:'4 baggers, 3 loaders, 2 packers, 1 operator, 1 cleaner' },
		{ d:'2026-03-24', desc:'Transportation', amt:100, acc:'Transport' },
		// 25 March 2026
		{ d:'2026-03-25', desc:'Fuel ① (3.5t truck)', amt:500, acc:'Transport' },
		{ d:'2026-03-25', desc:'Fuel ② (Abofryas)', amt:450, acc:'Transport' },
		{ d:'2026-03-25', desc:'Packaging bags', amt:6030, acc:'Production' },
		{ d:'2026-03-25', desc:'Rolls', amt:23101.20, acc:'Production' },
		{ d:'2026-03-25', desc:'Bank charges', amt:55.60, acc:'Administration' },
		// 27 March 2026
		{ d:'2026-03-27', desc:'Fuel (GT 5t) (3.5t)', amt:500, acc:'Transport' },
		// 28 March 2026
		{ d:'2026-03-28', desc:'Noah - items for R.O', amt:560, acc:'Production' },
		{ d:'2026-03-28', desc:'Noah - cleaner & membrane', amt:1200, acc:'Production' },
		{ d:'2026-03-28', desc:'Fuel - Abofryas', amt:100, acc:'Transport' },
		{ d:'2026-03-28', desc:'Pump tyres - Abofryas', amt:45, acc:'Transport' },
		{ d:'2026-03-28', desc:'2pcs Union x2', amt:52, acc:'Maintenance' },
		{ d:'2026-03-28', desc:'Plumbing supply', amt:46, acc:'Maintenance' },
		{ d:'2026-03-28', desc:'Fuel ~₵500 (GT 5320-24 small truck)', amt:500, acc:'Transport' },
	];

	for (const r of rows) {
		// Add to ledger as expense
		accountingData.ledger.push({
			date: r.d,
			desc: r.note ? `${r.desc} — ${r.note}` : r.desc,
			account: r.acc,
			type: 'expense',
			debit: r.amt,
			credit: 0
		});
		// Add to cashbook as payment
		accountingData.cashbook.push({
			date: r.d,
			desc: r.note ? `${r.desc} — ${r.note}` : r.desc,
			kind: 'payment',
			amount: r.amt
		});
	}
}

function seedMarchSalaries() {
	const rows = [
		// Week of 16 Mar (Mon 16th – Sun 22nd)
		{ d:'2026-03-21', name:'Ernest Boateng', week:'2026-03-16', amt:600, note:'Overpaid; 400 bags @120 to be subtracted next salary' },
		// Week of 23 Mar (Mon 23rd – Sun 29th)
		{ d:'2026-03-28', name:'Ernest Boateng', week:'2026-03-23', amt:240, note:'1,450 bags − 400 bags last week = ₵315 − ₵75 left = ₵240' },
		{ d:'2026-03-28', name:'Michael Dagadu', week:'2026-03-23', amt:1095, note:'₵615 (bags) + ₵480 (trips x2) = ₵1,095' },
		{ d:'2026-03-28', name:'Mary Teye', week:'2026-03-23', amt:829.50, note:'Paid' },
		{ d:'2026-03-28', name:'Ivy Ekemegbe', week:'2026-03-23', amt:802.50, note:'Paid' },
		{ d:'2026-03-28', name:'Vida Sackey', week:'2026-03-23', amt:540, note:'Paid' },
		{ d:'2026-03-28', name:'Love Konotey', week:'2026-03-23', amt:540, note:'Paid' },
		{ d:'2026-03-28', name:'Christopher Lawer', week:'2026-03-23', amt:915, note:'Paid' },
		{ d:'2026-03-28', name:'Augustine Konotey', week:'2026-03-23', amt:720, note:'Minus 3 days (19th, 21st, 22nd)' },
		{ d:'2026-03-28', name:'John Nyarko', week:'2026-03-23', amt:415, note:'Minus 1 day (28th)' },
		{ d:'2026-03-28', name:'Wisdom Xorlali', week:'2026-03-23', amt:1250, note:'Paid' },
		{ d:'2026-03-28', name:'Bright Azaglo', week:'2026-03-23', amt:2500, note:'' },
		{ d:'2026-03-28', name:'Jonas (Loader)', week:'2026-03-23', amt:700, note:'' },
		{ d:'2026-03-28', name:'Ever (Loader)', week:'2026-03-23', amt:700, note:'' },
		{ d:'2026-03-28', name:'Alfred (Loader)', week:'2026-03-23', amt:700, note:'' },
	];

	// Individual salary breakdown (salary tab only — not added to ledger)
	for (const r of rows) {
		accountingData.salaries.push({
			date: r.d,
			employee: r.name,
			week: r.week,
			amount: r.amt,
			note: r.note
		});
	}

	// Aggregate Salaries & Wages — 18k per week → Assets sheet
	const weeklyTotals = [
		{ d:'2026-03-21', desc:'Salaries & Wages — Week 1 (16/03 – 22/03)', amt:18000 },
		{ d:'2026-03-28', desc:'Salaries & Wages — Week 2 (23/03 – 29/03)', amt:18000 },
	];
	for (const w of weeklyTotals) {
		accountingData.assets.push({
			date: w.d,
			name: w.desc,
			category: 'Salaries & Wages',
			value: w.amt,
			note: ''
		});
	}
}

function saveAccountingDataToStorage() {
	localStorage.setItem('ww_accounting_data_v2', JSON.stringify(accountingData));
	syncToServer('ww_accounting_data_v2', accountingData);
	try {
		if (!window.__wwAcctChannel) window.__wwAcctChannel = new BroadcastChannel('ww_accounting_sync');
		window.__wwAcctChannel.postMessage({ type: 'accounting_updated' });
	} catch (_e) { /* fallback to storage event */ }
}

function initAccountingPage() {
	if (document.body.getAttribute('data-page') !== 'accounting') {
		return;
	}

	loadAccountingDataFromStorage();
	const todayStr = getTodayDateStr();

	/* ---- Modal system ---- */
	const ACC_MODAL_CONFIGS = {
		ledger: {
			title: 'Add Ledger Entry',
			fields: [
				{ id: 'date', label: 'Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'desc', label: 'Description', type: 'text', required: true, placeholder: 'e.g. Cash Sale - Customer' },
				{ id: 'account', label: 'Account', type: 'text', required: true, placeholder: 'e.g. Sales Revenue' },
				{ id: 'type', label: 'Type', type: 'select', options: ['asset', 'liability', 'equity', 'revenue', 'expense'], required: true },
				{ id: 'debit', label: 'Debit (GH)', type: 'number', min: '0', step: '0.01' },
				{ id: 'credit', label: 'Credit (GH)', type: 'number', min: '0', step: '0.01' },
			],
		},
		cashbook: {
			title: 'Add Cashbook Entry',
			fields: [
				{ id: 'date', label: 'Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'desc', label: 'Description', type: 'text', required: true, placeholder: 'e.g. Fuel, Packaging, Plumbing' },
				{ id: 'amount', label: 'Amount (GH)', type: 'number', min: '0', step: '0.01', required: true },
			],
		},
		account: {
			title: 'Add Account',
			fields: [
				{ id: 'category', label: 'Category', type: 'select', options: ['Assets', 'Liabilities', 'Equity', 'Revenue', 'Expenses'], required: true },
				{ id: 'name', label: 'Account Name', type: 'text', required: true, placeholder: 'e.g. Bank, Inventory' },
				{ id: 'value', label: 'Balance (GH)', type: 'number', min: '0', step: '0.01', required: true },
			],
		},
		currency: {
			title: 'Add Currency',
			fields: [
				{ id: 'code', label: 'Currency Code', type: 'text', required: true, placeholder: 'e.g. USD' },
				{ id: 'name', label: 'Currency Name', type: 'text', required: true, placeholder: 'e.g. US Dollar' },
				{ id: 'rate', label: 'Rate to GHS', type: 'number', min: '0', step: '0.01', required: true, placeholder: '1 unit = ? GHS' },
			],
		},
		salary: {
			title: 'Add Salary',
			fields: [
				{ id: 'date', label: 'Date Paid', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'employee', label: 'Employee Name', type: 'text', required: true, placeholder: 'e.g. Ernest Boateng' },
				{ id: 'week', label: 'Week Starting', type: 'date', required: true, defaultValue: todayStr },
				{ id: 'amount', label: 'Amount (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'note', label: 'Notes', type: 'text', placeholder: 'e.g. Deductions, adjustments' },
			],
		},
		'asset-item': {
			title: 'Add Asset',
			fields: [
				{ id: 'date', label: 'Date', type: 'date', defaultValue: todayStr, required: true },
				{ id: 'name', label: 'Asset Name', type: 'text', required: true, placeholder: 'e.g. Salaries & Wages — Week 1' },
				{ id: 'category', label: 'Category', type: 'select', options: ['Salaries & Wages', 'Equipment', 'Vehicles', 'Property', 'Inventory', 'Furniture', 'Other'], required: true },
				{ id: 'value', label: 'Value (GH)', type: 'number', min: '0', step: '0.01', required: true },
				{ id: 'note', label: 'Notes', type: 'text', placeholder: 'e.g. Week 1 payroll' },
			],
		},
	};

	/* Helper: get Monday of the week for a given date string */
	function getWeekStart(dateStr) {
		const d = new Date(dateStr + 'T00:00:00');
		const day = d.getDay();
		const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
		d.setDate(diff);
		return d.toISOString().slice(0, 10);
	}
	function getWeekEnd(startStr) {
		const d = new Date(startStr + 'T00:00:00');
		d.setDate(d.getDate() + 6);
		return d.toISOString().slice(0, 10);
	}
	function weekLabel(startStr) {
		const s = new Date(startStr + 'T00:00:00');
		const e = new Date(startStr + 'T00:00:00');
		e.setDate(e.getDate() + 6);
		const fmt = (d) => d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
		return `${fmt(s)} – ${fmt(e)}, ${s.getFullYear()}`;
	}

	let currentSalaryWeek = null;

	const CURRENCY_ICONS = { USD: 'fa-solid fa-dollar-sign', GBP: 'fa-solid fa-sterling-sign', EUR: 'fa-solid fa-euro-sign' };

	const addModal = document.getElementById('acc-add-modal');
	const modalTitle = document.getElementById('acc-modal-title');
	const modalFieldsEl = document.getElementById('acc-modal-fields');
	const modalForm = document.getElementById('acc-add-form');
	let currentEntity = null;
	let editingAccIdx = -1;

	const closeModal = () => { if (addModal) addModal.style.display = 'none'; if (modalForm) modalForm.reset(); currentEntity = null; editingAccIdx = -1; };

	const openModal = (entity, editIdx) => {
		const config = ACC_MODAL_CONFIGS[entity];
		if (!config || !addModal) return;
		currentEntity = entity;
		editingAccIdx = typeof editIdx === 'number' ? editIdx : -1;
		if (modalTitle) modalTitle.textContent = editingAccIdx >= 0 ? config.title.replace('Add', 'Edit') : config.title;
		if (modalFieldsEl) {
			modalFieldsEl.innerHTML = config.fields.map((f) => {
				if (f.type === 'select') {
					return `<div class="inv-modal-field"><label for="acc-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><select id="acc-field-${f.id}" name="${f.id}" ${f.required ? 'required' : ''}>${f.options.map((o) => `<option value="${o}">${o.charAt(0).toUpperCase() + o.slice(1)}</option>`).join('')}</select></div>`;
				}
				return `<div class="inv-modal-field"><label for="acc-field-${f.id}">${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label><input id="acc-field-${f.id}" type="${f.type}" name="${f.id}" ${f.required ? 'required' : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} ${f.defaultValue ? `value="${f.defaultValue}"` : ''}></div>`;
			}).join('');
		}
		/* Pre-fill for editing */
		if (editingAccIdx >= 0) {
			let row;
			if (entity === 'ledger') row = accountingData.ledger[editingAccIdx];
			else if (entity === 'cashbook') row = accountingData.cashbook[editingAccIdx];
			else if (entity === 'account') row = accountingData.summary[editingAccIdx];
			else if (entity === 'currency') row = accountingData.currencies[editingAccIdx];
			else if (entity === 'salary') row = accountingData.salaries[editingAccIdx];
			else if (entity === 'asset-item') row = accountingData.assets[editingAccIdx];
			if (row) {
				const setVal = (id, v) => { const el = document.getElementById('acc-field-' + id); if (el && v !== undefined) el.value = v; };
				Object.keys(row).forEach((k) => setVal(k, row[k]));
			}
		}
		addModal.style.display = 'flex';
		const firstInput = modalFieldsEl && modalFieldsEl.querySelector('input, select');
		if (firstInput) firstInput.focus();
	};

	document.getElementById('acc-modal-close')?.addEventListener('click', closeModal);
	document.getElementById('acc-modal-cancel')?.addEventListener('click', closeModal);
	addModal?.addEventListener('click', (e) => { if (e.target === addModal) closeModal(); });

	const getValue = (id) => { const el = document.getElementById(`acc-field-${id}`); return el ? el.value.trim() : ''; };
	const getNum = (id) => { const v = Number(getValue(id)); return Number.isFinite(v) && v >= 0 ? v : 0; };

	if (modalForm && !modalForm.dataset.bound) {
		modalForm.dataset.bound = '1';
		modalForm.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!currentEntity) return;

			if (currentEntity === 'ledger') {
				const desc = getValue('desc');
				const account = getValue('account');
				if (!desc || !account) return;
				const data = {
					date: getValue('date') || todayStr,
					desc,
					account,
					type: getValue('type') || 'asset',
					debit: getNum('debit'),
					credit: getNum('credit'),
				};
				if (editingAccIdx >= 0 && accountingData.ledger[editingAccIdx]) {
					Object.assign(accountingData.ledger[editingAccIdx], data);
				} else {
					accountingData.ledger.push(data);
				}
			}

			if (currentEntity === 'cashbook') {
				const desc = getValue('desc');
				if (!desc) return;
				const data = {
					date: getValue('date') || todayStr,
					desc,
					amount: getNum('amount'),
				};
				if (editingAccIdx >= 0 && accountingData.cashbook[editingAccIdx]) {
					Object.assign(accountingData.cashbook[editingAccIdx], data);
				} else {
					accountingData.cashbook.push(data);
				}
			}

			if (currentEntity === 'account') {
				const name = getValue('name');
				const category = getValue('category');
				if (!name || !category) return;
				const data = { category, name, value: getNum('value') };
				if (editingAccIdx >= 0 && accountingData.summary[editingAccIdx]) {
					Object.assign(accountingData.summary[editingAccIdx], data);
				} else {
					accountingData.summary.push(data);
				}
			}

			if (currentEntity === 'currency') {
				const code = getValue('code').toUpperCase();
				const name = getValue('name');
				if (!code || !name) return;
				const data = { code, name, rate: getNum('rate') };
				if (editingAccIdx >= 0 && accountingData.currencies[editingAccIdx]) {
					Object.assign(accountingData.currencies[editingAccIdx], data);
				} else {
					accountingData.currencies.push(data);
				}
			}

			if (currentEntity === 'salary') {
				const employee = getValue('employee');
				if (!employee) return;
				const weekRaw = getValue('week') || todayStr;
				const weekStart = getWeekStart(weekRaw);
				const data = {
					date: getValue('date') || todayStr,
					employee,
					week: weekStart,
					amount: getNum('amount'),
					note: getValue('note') || '',
				};
				if (editingAccIdx >= 0 && accountingData.salaries[editingAccIdx]) {
					const old = accountingData.salaries[editingAccIdx];
					const li = accountingData.ledger.findIndex(e => e.account === 'Salaries' && e.desc === `Salary — ${old.employee}` && e.date === old.date);
					if (li >= 0) { accountingData.ledger[li].date = data.date; accountingData.ledger[li].desc = `Salary — ${data.employee}`; accountingData.ledger[li].debit = data.amount; }
					Object.assign(accountingData.salaries[editingAccIdx], data);
				} else {
					accountingData.salaries.push(data);
					accountingData.ledger.push({ date: data.date, desc: `Salary — ${data.employee}`, account: 'Salaries', type: 'expense', debit: data.amount, credit: 0 });
				}
				currentSalaryWeek = weekStart;
			}

			if (currentEntity === 'asset-item') {
				const name = getValue('name');
				if (!name) return;
				const data = {
					date: getValue('date') || todayStr,
					name,
					category: getValue('category') || 'Other',
					value: getNum('value'),
					note: getValue('note') || '',
				};
				if (editingAccIdx >= 0 && accountingData.assets[editingAccIdx]) {
					Object.assign(accountingData.assets[editingAccIdx], data);
				} else {
					accountingData.assets.push(data);
				}
			}

			saveAccountingDataToStorage();
			closeModal();
			renderAccountingPage();
		});
	}

	document.addEventListener('click', (event) => {
		const btn = event.target.closest('.acc-add-btn[data-add-entity]');
		if (btn) { openModal(btn.getAttribute('data-add-entity')); return; }
		const editBtn = event.target.closest('.acc-edit-btn');
		if (editBtn) {
			event.stopPropagation();
			openModal(editBtn.getAttribute('data-edit-entity'), Number(editBtn.getAttribute('data-edit-idx')));
			return;
		}
		const deleteBtn = event.target.closest('.acc-delete-btn');
		if (deleteBtn) {
			event.stopPropagation();
			const entity = deleteBtn.getAttribute('data-delete-entity');
			const idx = Number(deleteBtn.getAttribute('data-delete-idx'));
			if (!confirm('Delete this ' + entity + ' entry? This cannot be undone.')) return;
			if (entity === 'ledger') accountingData.ledger.splice(idx, 1);
			else if (entity === 'cashbook') accountingData.cashbook.splice(idx, 1);
			else if (entity === 'account') accountingData.summary.splice(idx, 1);
			else if (entity === 'currency') accountingData.currencies.splice(idx, 1);
			else if (entity === 'salary') {
				const sal = accountingData.salaries[idx];
				if (sal) {
					const li = accountingData.ledger.findIndex(e => e.account === 'Salaries' && e.desc === `Salary — ${sal.employee}` && e.date === sal.date);
					if (li >= 0) accountingData.ledger.splice(li, 1);
				}
				accountingData.salaries.splice(idx, 1);
			}
			else if (entity === 'asset-item') accountingData.assets.splice(idx, 1);
			saveAccountingDataToStorage();
			renderAccountingPage();
		}
	});

	function renderAccountingPage() {
		const ledger = accountingData.ledger;
		const cashbook = accountingData.cashbook;
		const manualAccounts = accountingData.summary;
		const currencies = accountingData.currencies;

		/* Build account summary: merge manual accounts + auto-computed from ledger */
		const TYPE_TO_CATEGORY = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Revenue', expense: 'Expenses' };
		const categoryOrder = ['Assets', 'Liabilities', 'Equity', 'Revenue', 'Expenses'];
		const accountBalances = {}; /* { "Assets|Bank": value } */

		/* Start with manually added accounts */
		manualAccounts.forEach((a) => {
			const key = a.category + '|' + a.name;
			accountBalances[key] = (accountBalances[key] || 0) + a.value;
		});

		/* Add ledger entries: debits increase assets/expenses, credits increase liabilities/equity/revenue */
		ledger.forEach((entry) => {
			const cat = TYPE_TO_CATEGORY[entry.type];
			if (!cat) return;
			const key = cat + '|' + entry.account;
			if (!accountBalances[key]) accountBalances[key] = 0;
			if (cat === 'Assets' || cat === 'Expenses') {
				accountBalances[key] += (entry.debit || 0) - (entry.credit || 0);
			} else {
				accountBalances[key] += (entry.credit || 0) - (entry.debit || 0);
			}
		});

		const grouped = {};
		categoryOrder.forEach((c) => { grouped[c] = []; });
		Object.keys(accountBalances).forEach((key) => {
			const [cat, name] = key.split('|');
			grouped[cat].push({ name, value: accountBalances[key] });
		});
		const accountSummary = categoryOrder.filter((c) => grouped[c].length > 0).map((c) => {
			const total = grouped[c].reduce((sum, a) => sum + a.value, 0);
			return { category: c, accounts: grouped[c], total };
		});

		/* Stats — auto-computed from all sheets */
		const totalDebits = ledger.reduce((s, e) => s + (e.debit || 0), 0);
		const totalCredits = ledger.reduce((s, e) => s + (e.credit || 0), 0);
		const cashTotal = cashbook.reduce((s, e) => s + (e.amount || 0), 0);
		const revCat = accountSummary.find((x) => x.category === 'Revenue');
		const expCat = accountSummary.find((x) => x.category === 'Expenses');
		const assCat = accountSummary.find((x) => x.category === 'Assets');
		const liaCat = accountSummary.find((x) => x.category === 'Liabilities');

		// Pull sales revenue from invoices (paid only)
		const allSales = getAllSalesData();
		const salesRevenue = allSales.invoices
			.filter((inv) => inv.status === 'paid')
			.reduce((s, inv) => s + (Number(inv.amount) || 0), 0);

		const revenue = (revCat ? revCat.total : 0) + salesRevenue;
		const expense = expCat ? expCat.total : 0;
		const assetsSheetTotal = accountingData.assets.reduce((s, a) => s + (a.value || 0), 0);
		const assets = (assCat ? assCat.total : 0) + assetsSheetTotal;
		const liabilities = liaCat ? liaCat.total : 0;
		const profitLoss = revenue - expense + assetsSheetTotal;
		const plClass = profitLoss >= 0 ? 'color:#22c55e' : 'color:#ef4444';

		const stats = document.getElementById('acc-stats-row');
		if (stats) {
			stats.innerHTML = `
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-book"></i></div><p class="s-label">Ledger Entries</p><p class="s-value">${ledger.length}</p><p class="s-meta">Dr ${formatCurrency(totalDebits)} · Cr ${formatCurrency(totalCredits)}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-wallet"></i></div><p class="s-label">Cashbook Total</p><p class="s-value">${formatCurrency(cashTotal)}</p><p class="s-meta">${cashbook.length} entries</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-money-bill-trend-up"></i></div><p class="s-label">Revenue</p><p class="s-value">${formatCurrency(revenue)}</p><p class="s-meta">Sales ${formatCurrency(salesRevenue)} · Ledger ${formatCurrency(revCat ? revCat.total : 0)}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-file-invoice-dollar"></i></div><p class="s-label">Expenses</p><p class="s-value">${formatCurrency(expense)}</p><p class="s-meta">Operational costs from ledger</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-chart-line"></i></div><p class="s-label">Profit / Loss</p><p class="s-value" style="${plClass}">${formatCurrency(profitLoss)}</p><p class="s-meta">Revenue ${formatCurrency(revenue)} − Expenses ${formatCurrency(expense)}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-scale-balanced"></i></div><p class="s-label">Net Position</p><p class="s-value">${formatCurrency(assets - liabilities)}</p><p class="s-meta">Assets ${formatCurrency(assets)} · Liabilities ${formatCurrency(liabilities)}</p></div>
			`;
		}

		/* General Ledger — grouped by day with subtotals */
		const ledgerBody = document.getElementById('ledger-tbody');
		if (ledgerBody) {
			if (ledger.length === 0) {
				ledgerBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;">No entries yet. Click "Add Entry" to start.</td></tr>';
			} else {
				// Group entries by date
				const byDate = {};
				ledger.forEach((row, idx) => {
					const key = row.date || 'Unknown';
					if (!byDate[key]) byDate[key] = [];
					byDate[key].push({ ...row, _idx: idx });
				});
				const sortedDates = Object.keys(byDate).sort();
				let html = '';
				let grandDebit = 0, grandCredit = 0;
				for (const date of sortedDates) {
					const entries = byDate[date];
					let dayDebit = 0, dayCredit = 0;
					// Date group header
					const dateLabel = (() => { try { const d = new Date(date + 'T00:00:00'); return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' }); } catch(_){ return date; } })();
					html += `<tr class="ledger-date-header"><td colspan="7" style="background:#f0f4ff;font-weight:700;color:#1e40af;padding:10px 14px;border-top:2px solid #bfdbfe;font-size:0.95rem;"><i class="fa-solid fa-calendar-day" style="margin-right:6px;"></i>${dateLabel}</td></tr>`;
					for (const row of entries) {
						const badgeClass = row.type === 'asset' ? 'badge-blue' : row.type === 'liability' ? 'badge-red' : row.type === 'revenue' ? 'badge-green' : row.type === 'expense' ? 'badge-orange' : 'badge-purple';
						dayDebit += row.debit || 0;
						dayCredit += row.credit || 0;
						html += `<tr><td>${row.date}</td><td>${row.desc}</td><td>${row.account}</td><td><span class="badge ${badgeClass}">${row.type}</span></td><td>${row.debit ? formatCurrency(row.debit) : '-'}</td><td>${row.credit ? formatCurrency(row.credit) : '-'}</td><td><div class="row-actions"><button class="btn-edit acc-edit-btn" data-edit-entity="ledger" data-edit-idx="${row._idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete acc-delete-btn" data-delete-entity="ledger" data-delete-idx="${row._idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
					}
					// Day subtotal row
					html += `<tr class="ledger-subtotal"><td colspan="4" style="text-align:right;font-weight:700;background:#f8fafc;color:#475569;padding:8px 14px;">Subtotal — ${dateLabel}</td><td style="font-weight:700;background:#f8fafc;color:#1e40af;">${formatCurrency(dayDebit)}</td><td style="font-weight:700;background:#f8fafc;color:#1e40af;">${formatCurrency(dayCredit)}</td><td style="background:#f8fafc;"></td></tr>`;
					grandDebit += dayDebit;
					grandCredit += dayCredit;
				}
				// Grand total row
				html += `<tr class="ledger-grand-total"><td colspan="4" style="text-align:right;font-weight:800;background:#1e40af;color:#fff;padding:10px 14px;font-size:0.95rem;">GRAND TOTAL</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(grandDebit)}</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(grandCredit)}</td><td style="background:#1e40af;"></td></tr>`;
				ledgerBody.innerHTML = html;
			}
		}

		/* Cashbook — grouped by day with subtotals */
		const cashbookBody = document.getElementById('cashbook-tbody');
		if (cashbookBody) {
			if (cashbook.length === 0) {
				cashbookBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No entries yet. Click "Add Entry" to start.</td></tr>';
			} else {
				const byDate = {};
				cashbook.forEach((entry, idx) => {
					const key = entry.date || 'Unknown';
					if (!byDate[key]) byDate[key] = [];
					byDate[key].push({ ...entry, _idx: idx });
				});
				const sortedDates = Object.keys(byDate).sort();
				let html = '';
				let grandTotal = 0;
				for (const date of sortedDates) {
					const entries = byDate[date];
					let dayTotal = 0;
					const dateLabel = (() => { try { const d = new Date(date + 'T00:00:00'); return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' }); } catch(_){ return date; } })();
					html += `<tr><td colspan="5" style="background:#f0f4ff;font-weight:700;color:#1e40af;padding:10px 14px;border-top:2px solid #bfdbfe;font-size:0.95rem;"><i class="fa-solid fa-calendar-day" style="margin-right:6px;"></i>${dateLabel}</td></tr>`;
					for (const entry of entries) {
						dayTotal += entry.amount || 0;
						grandTotal += entry.amount || 0;
						html += `<tr><td>${entry.date}</td><td>${entry.desc}</td><td>${formatCurrency(entry.amount)}</td><td>${formatCurrency(grandTotal)}</td><td><div class="row-actions"><button class="btn-edit acc-edit-btn" data-edit-entity="cashbook" data-edit-idx="${entry._idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete acc-delete-btn" data-delete-entity="cashbook" data-delete-idx="${entry._idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
					}
					html += `<tr><td colspan="2" style="text-align:right;font-weight:700;background:#f8fafc;color:#475569;padding:8px 14px;">Subtotal — ${dateLabel}</td><td style="font-weight:700;background:#f8fafc;color:#1e40af;">${formatCurrency(dayTotal)}</td><td style="background:#f8fafc;"></td><td style="background:#f8fafc;"></td></tr>`;
				}
				html += `<tr><td colspan="2" style="text-align:right;font-weight:800;background:#1e40af;color:#fff;padding:10px 14px;font-size:0.95rem;">GRAND TOTAL</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(grandTotal)}</td><td style="background:#1e40af;"></td><td style="background:#1e40af;"></td></tr>`;
				cashbookBody.innerHTML = html;
			}

			const totalSpent = cashbook.reduce((sum, e) => sum + (e.amount || 0), 0);
			const cashSummary = document.getElementById('cashbook-summary-cards');
			if (cashSummary) {
				cashSummary.innerHTML = `
					<div class="cashbook-card"><p class="cb-label">Total Expenditure</p><p class="cb-val">${formatCurrency(totalSpent)}</p></div>
					<div class="cashbook-card"><p class="cb-label">Entries</p><p class="cb-val">${cashbook.length}</p></div>
				`;
			}
		}

		/* Account Summary */
		const summaryGrid = document.getElementById('account-summary-grid');
		if (summaryGrid) {
			summaryGrid.innerHTML = accountSummary.length === 0
				? '<p style="color:#94a3b8;text-align:center;grid-column:1/-1;">No accounts yet. Click "Add Account" to start.</p>'
				: accountSummary.map((cat) => {
					return `<div class="category-card"><h4>${cat.category}</h4>${cat.accounts.map((acc) => `<div class="cat-row"><span>${acc.name}</span><span>${formatCurrency(acc.value)}</span></div>`).join('')}<div class="cat-total"><span>Total</span><span>${formatCurrency(cat.total)}</span></div></div>`;
				}).join('');
		}

		/* Multi-Currency */
		const currencyGrid = document.getElementById('currency-grid');
		if (currencyGrid) {
			currencyGrid.innerHTML = currencies.length === 0
				? '<p style="color:#94a3b8;text-align:center;grid-column:1/-1;">No currencies yet. Click "Add Currency" to start.</p>'
				: currencies.map((cur) => {
					const sample = cur.rate > 0 ? (100 / cur.rate).toFixed(2) : '0.00';
					const icon = CURRENCY_ICONS[cur.code] || 'fa-solid fa-coins';
					return `<div class="currency-card"><div class="cur-top"><div class="cur-left"><span class="cur-globe"><i class="fa-solid fa-globe"></i></span><div><p class="cur-code">${cur.code}</p><p class="cur-name">${cur.name}</p></div></div><span class="cur-symbol"><i class="${icon}"></i></span></div><p class="cur-rate">1 ${cur.code} = ${cur.rate.toFixed(2)} GHS</p><p class="cur-sample">100 GHS ≈ ${sample} ${cur.code}</p></div>`;
				}).join('');
		}

		/* Assets Sheet */
		const assetsArr = accountingData.assets;
		const assetsBody = document.getElementById('assets-tbody');
		if (assetsBody) {
			if (assetsArr.length === 0) {
				assetsBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;">No assets yet. Click "Add Asset" to start.</td></tr>';
			} else {
				const sorted = assetsArr.map((a, i) => ({ ...a, _idx: i })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
				let html = '';
				let grandTotal = 0;
				// Group by category
				const byCat = {};
				for (const a of sorted) {
					const cat = a.category || 'Other';
					if (!byCat[cat]) byCat[cat] = [];
					byCat[cat].push(a);
				}
				for (const cat of Object.keys(byCat).sort()) {
					let catTotal = 0;
					html += `<tr><td colspan="6" style="background:#f0f4ff;font-weight:700;color:#1e40af;padding:10px 14px;border-top:2px solid #bfdbfe;font-size:0.95rem;"><i class="fa-solid fa-box" style="margin-right:6px;"></i>${cat}</td></tr>`;
					for (const a of byCat[cat]) {
						catTotal += a.value || 0;
						grandTotal += a.value || 0;
						html += `<tr><td>${a.date}</td><td style="font-weight:600;">${a.name}</td><td>${a.category}</td><td>${formatCurrency(a.value)}</td><td style="color:#64748b;font-size:0.85rem;">${a.note || '—'}</td><td><div class="row-actions"><button class="btn-edit acc-edit-btn" data-edit-entity="asset-item" data-edit-idx="${a._idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete acc-delete-btn" data-delete-entity="asset-item" data-delete-idx="${a._idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
					}
					html += `<tr><td colspan="3" style="text-align:right;font-weight:700;background:#f8fafc;color:#475569;padding:8px 14px;">Subtotal — ${cat}</td><td style="font-weight:700;background:#f8fafc;color:#1e40af;">${formatCurrency(catTotal)}</td><td colspan="2" style="background:#f8fafc;"></td></tr>`;
				}
				html += `<tr><td colspan="3" style="text-align:right;font-weight:800;background:#1e40af;color:#fff;padding:10px 14px;font-size:0.95rem;">TOTAL ASSETS</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(grandTotal)}</td><td colspan="2" style="background:#1e40af;"></td></tr>`;
				assetsBody.innerHTML = html;
			}
			const assetsSummary = document.getElementById('assets-summary-cards');
			if (assetsSummary) {
				const total = assetsArr.reduce((s, a) => s + (a.value || 0), 0);
				const cats = new Set(assetsArr.map(a => a.category || 'Other')).size;
				assetsSummary.innerHTML = `
					<div style="display:flex;gap:16px;flex-wrap:wrap;">
						<div class="cashbook-card"><p class="cb-label">Total Assets Value</p><p class="cb-val">${formatCurrency(total)}</p></div>
						<div class="cashbook-card"><p class="cb-label">Items</p><p class="cb-val">${assetsArr.length}</p></div>
						<div class="cashbook-card"><p class="cb-label">Categories</p><p class="cb-val">${cats}</p></div>
					</div>
				`;
			}
		}

		/* Salaries — filtered by selected week */
		const salaries = accountingData.salaries;
		const salariesBody = document.getElementById('salaries-tbody');
		const weekSelect = document.getElementById('salary-week-select');
		const weekRange = document.getElementById('salary-week-range');

		// Build unique weeks from all salary data
		const allWeeks = [...new Set(salaries.map(s => s.week || getWeekStart(s.date)))].sort();
		if (!currentSalaryWeek && allWeeks.length > 0) currentSalaryWeek = allWeeks[allWeeks.length - 1];

		if (weekSelect) {
			weekSelect.innerHTML = allWeeks.length === 0
				? '<option value="">No weeks</option>'
				: allWeeks.map(w => `<option value="${w}" ${w === currentSalaryWeek ? 'selected' : ''}>${weekLabel(w)}</option>`).join('')
					+ '<option value="__all__">All Weeks</option>';
			if (!weekSelect.dataset.bound) {
				weekSelect.dataset.bound = '1';
				weekSelect.addEventListener('change', () => {
					currentSalaryWeek = weekSelect.value;
					renderAccountingPage();
				});
			}
		}
		if (weekRange && currentSalaryWeek && currentSalaryWeek !== '__all__') {
			weekRange.textContent = `Mon ${currentSalaryWeek} → Sun ${getWeekEnd(currentSalaryWeek)}`;
		} else if (weekRange) {
			weekRange.textContent = '';
		}

		// Filter salaries by selected week
		const filtered = currentSalaryWeek === '__all__'
			? salaries.map((s, idx) => ({ ...s, _idx: idx }))
			: salaries.map((s, idx) => ({ ...s, _idx: idx })).filter(s => (s.week || getWeekStart(s.date)) === currentSalaryWeek);

		if (salariesBody) {
			if (filtered.length === 0) {
				salariesBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;">No salary records for this week.</td></tr>';
			} else {
				let html = '';
				let total = 0;
				for (const s of filtered) {
					total += s.amount || 0;
					const wk = s.week || getWeekStart(s.date);
					html += `<tr><td>${s.date}</td><td style="font-weight:600;">${s.employee}</td><td style="color:#64748b;font-size:0.85rem;">${weekLabel(wk)}</td><td>${formatCurrency(s.amount)}</td><td style="color:#64748b;font-size:0.85rem;">${s.note || '—'}</td><td><div class="row-actions"><button class="btn-edit acc-edit-btn" data-edit-entity="salary" data-edit-idx="${s._idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete acc-delete-btn" data-delete-entity="salary" data-delete-idx="${s._idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
				}
				html += `<tr><td colspan="3" style="text-align:right;font-weight:800;background:#1e40af;color:#fff;padding:10px 14px;font-size:0.95rem;">WEEK TOTAL</td><td style="font-weight:800;background:#1e40af;color:#fff;font-size:0.95rem;">${formatCurrency(total)}</td><td style="background:#1e40af;" colspan="2"></td></tr>`;
				salariesBody.innerHTML = html;
			}

			const salSummary = document.getElementById('salaries-summary-cards');
			if (salSummary) {
				const weekPaid = filtered.reduce((s, e) => s + (e.amount || 0), 0);
				const allPaid = salaries.reduce((s, e) => s + (e.amount || 0), 0);
				const uniqueStaff = new Set(filtered.map(s => s.employee)).size;
				salSummary.innerHTML = `
					<div style="display:flex;gap:16px;flex-wrap:wrap;">
						<div class="cashbook-card"><p class="cb-label">This Week</p><p class="cb-val">${formatCurrency(weekPaid)}</p></div>
						<div class="cashbook-card"><p class="cb-label">Staff Paid</p><p class="cb-val">${uniqueStaff}</p></div>
						<div class="cashbook-card"><p class="cb-label">All-time Total</p><p class="cb-val">${formatCurrency(allPaid)}</p></div>
					</div>
				`;
			}
		}
	}

	renderAccountingPage();
}

function initProductionPage() {
	if (document.body.getAttribute('data-page') !== 'production') {
		return;
	}

	/* ---- BOM data (localStorage) ---- */
	const BOM_KEY = 'ww_bom_data';
	let billOfMaterials = {};
	try {
		const stored = JSON.parse(localStorage.getItem(BOM_KEY));
		if (stored && typeof stored === 'object' && !Array.isArray(stored)) billOfMaterials = stored;
	} catch (_) { /* ignore */ }
	function saveBom() { localStorage.setItem(BOM_KEY, JSON.stringify(billOfMaterials)); syncToServer(BOM_KEY, billOfMaterials); }
	/* ---- Production Batches (localStorage) ---- */
	const BATCH_KEY = 'ww_production_batches';
	let prodBatches = [];
	try {
		const stored = JSON.parse(localStorage.getItem(BATCH_KEY));
		if (Array.isArray(stored)) prodBatches = stored;
	} catch (_) { /* ignore */ }
	function saveBatches() {
		localStorage.setItem(BATCH_KEY, JSON.stringify(prodBatches));
		syncToServer(BATCH_KEY, prodBatches);
		/* Sync daily production log from batches (dashboard reads this) */
		const dailyLog = {};
		for (const b of prodBatches) {
			if (b.status !== 'completed') continue;
			const d = b.date || getTodayDateStr();
			dailyLog[d] = (dailyLog[d] || 0) + (Number(b.qty) || 0);
		}
		localStorage.setItem('ww_daily_production', JSON.stringify(dailyLog));
		syncToServer('ww_daily_production', dailyLog);
		/* Sync finished products from completed batches (inventory reads this) */
		const existing = (() => { try { return JSON.parse(localStorage.getItem('ww_finished_products') || '[]'); } catch(_) { return []; } })();
		const nonBatch = existing.filter((p) => !p._fromBatch);
		const fromBatch = prodBatches.filter((b) => b.status === 'completed').map((b, i) => ({
			id: 'BATCH-' + (i + 1),
			product: b.product,
			qty: b.qty,
			unitCost: b.qty > 0 ? +(b.cost / b.qty).toFixed(2) : 0,
			addedDate: b.date,
			_fromBatch: true,
		}));
		const mergedProducts = [...nonBatch, ...fromBatch];
		localStorage.setItem('ww_finished_products', JSON.stringify(mergedProducts));
		syncToServer('ww_finished_products', mergedProducts);
		/* Broadcast changes so other tabs (inventory, dashboard) refresh */
		try {
			const bc1 = new BroadcastChannel('ww_finished_products_sync');
			bc1.postMessage({ type: 'finished_products_updated' });
			bc1.close();
		} catch (_e) { /* fallback to storage event */ }
	}

	let batchCounter = prodBatches.length;
	function nextBatchId() {
		batchCounter++;
		return 'B-' + new Date().getFullYear() + '-' + String(batchCounter).padStart(3, '0');
	}

	/* Do NOT save during init — would overwrite server data with empty localStorage */
	// saveBatches();

	const todayStr = getTodayDateStr();

	function renderProductionPage() {
		/* Stats — auto-computed from batches + BOM */
		const todayBatches = prodBatches.filter((b) => b.date === todayStr);
		const totalBatches = prodBatches.length;
		const totalUnits = prodBatches.reduce((s, b) => s + b.qty, 0);
		const totalCost = prodBatches.reduce((s, b) => s + b.cost, 0);
		const totalSales = prodBatches.reduce((s, b) => s + (b.sales || 0), 0);
		const productCount = Object.keys(billOfMaterials).length;
		const stats = document.getElementById('prod-stats-row');
		if (stats) {
			stats.innerHTML = `
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-gears"></i></div><p class="s-label">Total Batches</p><p class="s-value">${totalBatches}</p><p class="s-meta">${todayBatches.length} today · ${productCount} product${productCount !== 1 ? 's' : ''}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-industry"></i></div><p class="s-label">Total Output</p><p class="s-value">${formatNumber(totalUnits)}</p><p class="s-meta">${formatNumber(todayBatches.reduce((s, b) => s + b.qty, 0))} units today</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-coins"></i></div><p class="s-label">Total Cost</p><p class="s-value">${formatCurrency(totalCost)}</p><p class="s-meta">${totalBatches > 0 ? 'Avg ' + formatCurrency(totalCost / totalBatches) + '/batch' : 'No batches'}</p></div>
				<div class="stat-card"><div class="s-icon"><i class="fa-solid fa-chart-line"></i></div><p class="s-label">Profit / Loss</p><p class="s-value">${formatCurrency(totalSales - totalCost)}</p><p class="s-meta">Sales ${formatCurrency(totalSales)} · Cost ${formatCurrency(totalCost)}</p></div>
			`;
		}

		/* Batch table */
		const batchBody = document.getElementById('batches-tbody');
		if (batchBody) {
			batchBody.innerHTML = prodBatches.length === 0
				? '<tr><td colspan="9" style="text-align:center;color:#94a3b8;">No batches yet. Click "Add Batch" to start.</td></tr>'
				: prodBatches.map((b, idx) => {
					const pillClass = b.status === 'completed' ? 'status-green' : b.status === 'in-progress' ? 'status-blue' : 'status-orange';
					return `<tr><td>${b.id}</td><td>${b.product}</td><td>${formatNumber(b.qty)}</td><td>${b.date}</td><td>${b.shift}</td><td>${b.time}</td><td>${formatCurrency(b.cost)}</td><td><span class="status-pill ${pillClass}">${b.status}</span></td><td><div class="row-actions"><button class="btn-edit prod-edit-batch" data-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete prod-delete-batch" data-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
				}).join('');
		}

		/* Daily summary cards */
		const dailySummary = document.getElementById('batch-daily-summary');
		if (dailySummary) {
			/* Group by date */
			const byDate = {};
			prodBatches.forEach((b) => {
				if (!byDate[b.date]) byDate[b.date] = { count: 0, units: 0, cost: 0 };
				byDate[b.date].count++;
				byDate[b.date].units += b.qty;
				byDate[b.date].cost += b.cost;
			});
			const dates = Object.keys(byDate).sort().reverse().slice(0, 7);
			dailySummary.innerHTML = dates.length === 0
				? ''
				: '<h4 style="margin:0 0 8px;font-size:0.85rem;color:#64748b;text-transform:uppercase;">Batches Per Day (last 7 days)</h4>' +
				  dates.map((d) => {
					const day = byDate[d];
					return `<div class="cashbook-card" style="text-align:left;display:flex;justify-content:space-between;align-items:center;"><div><p class="cb-label" style="margin:0">${d}</p><p style="margin:2px 0 0;font-size:0.78rem;color:#64748b;">${formatNumber(day.units)} units · ${formatCurrency(day.cost)}</p></div><p class="cb-val" style="margin:0">${day.count} batch${day.count !== 1 ? 'es' : ''}</p></div>`;
				  }).join('');
		}
	}
	renderProductionPage();

	/* ---- Batch Add Modal ---- */
	const batchModal = document.getElementById('batch-add-modal');
	const batchForm = document.getElementById('batch-add-form');
	const batchFields = document.getElementById('batch-modal-fields');
	const batchModalClose = document.getElementById('batch-modal-close');
	const batchAddBtn = document.getElementById('batch-add-btn');

	let editBatchIdx = -1;

	function openBatchModal(editIdx) {
		if (!batchModal || !batchFields) return;
		editBatchIdx = typeof editIdx === 'number' ? editIdx : -1;
		const b = editBatchIdx >= 0 ? prodBatches[editBatchIdx] : null;
		batchFields.innerHTML = `
			<div class="inv-modal-field"><label>Product</label><input type="text" name="product" value="${b ? b.product : 'Mobile Water 500ml'}" required></div>
			<div class="inv-modal-field"><label>Quantity</label><input type="number" name="qty" min="1" value="${b ? b.qty : ''}" required></div>
			<div class="inv-modal-field"><label>Date</label><input type="date" name="date" value="${b ? b.date : todayStr}" required></div>
			<div class="inv-modal-field"><label>Shift</label><select name="shift"><option value="Morning"${b && b.shift === 'Morning' ? ' selected' : ''}>Morning</option><option value="Afternoon"${b && b.shift === 'Afternoon' ? ' selected' : ''}>Afternoon</option><option value="Night"${b && b.shift === 'Night' ? ' selected' : ''}>Night</option></select></div>
			<div class="inv-modal-field"><label>Start Time</label><input type="time" name="time" value="${b ? b.time : '06:00'}" required></div>
			<div class="inv-modal-field"><label>Cost (GH₵)</label><input type="number" name="cost" min="0" step="0.01" value="${b ? b.cost : ''}" required></div>
			<div class="inv-modal-field"><label>Sales Value (GH₵)</label><input type="number" name="sales" min="0" step="0.01" value="${b ? (b.sales || '') : ''}" placeholder="Revenue from this batch" required></div>
			<div class="inv-modal-field"><label>Status</label><select name="status"><option value="completed"${b && b.status === 'completed' ? ' selected' : ''}>Completed</option><option value="in-progress"${b && b.status === 'in-progress' ? ' selected' : ''}>In Progress</option><option value="planned"${b && b.status === 'planned' ? ' selected' : ''}>Planned</option></select></div>
		`;
		batchModal.style.display = 'flex';
	}

	if (batchAddBtn) batchAddBtn.addEventListener('click', () => openBatchModal());
	if (batchModalClose) batchModalClose.addEventListener('click', () => { batchModal.style.display = 'none'; });
	if (batchModal) batchModal.addEventListener('click', (e) => { if (e.target === batchModal) batchModal.style.display = 'none'; });

	if (batchForm) {
		batchForm.addEventListener('submit', (e) => {
			e.preventDefault();
			const fd = new FormData(batchForm);
			const product = (fd.get('product') || '').toString().trim();
			if (!product) return;
			const data = {
				product,
				qty: parseInt(fd.get('qty')) || 0,
				date: fd.get('date') || todayStr,
				shift: fd.get('shift') || 'Morning',
				time: fd.get('time') || '06:00',
				cost: parseFloat(fd.get('cost')) || 0,
				sales: parseFloat(fd.get('sales')) || 0,
				status: fd.get('status') || 'completed',
			};
			if (editBatchIdx >= 0 && prodBatches[editBatchIdx]) {
				Object.assign(prodBatches[editBatchIdx], data);
			} else {
				data.id = nextBatchId();
				prodBatches.push(data);
			}
			saveBatches();
			batchModal.style.display = 'none';
			editBatchIdx = -1;
			renderProductionPage();
			renderProfitabilityChart();
		});
	}

	/* Production edit/delete click handlers */
	document.addEventListener('click', (event) => {
		const editBtn = event.target.closest('.prod-edit-batch');
		if (editBtn) { openBatchModal(Number(editBtn.dataset.idx)); return; }
		const deleteBtn = event.target.closest('.prod-delete-batch');
		if (deleteBtn) {
			if (!confirm('Delete this batch? This cannot be undone.')) return;
			prodBatches.splice(Number(deleteBtn.dataset.idx), 1);
			saveBatches();
			renderProductionPage();
			renderProfitabilityChart();
			return;
		}
		const editComp = event.target.closest('.bom-edit-comp');
		if (editComp && selectedProduct && billOfMaterials[selectedProduct]) {
			const idx = Number(editComp.dataset.idx);
			const comp = billOfMaterials[selectedProduct].components[idx];
			if (!comp) return;
			openCompModal(idx);
			return;
		}
		const deleteComp = event.target.closest('.bom-delete-comp');
		if (deleteComp && selectedProduct && billOfMaterials[selectedProduct]) {
			if (!confirm('Delete this component?')) return;
			billOfMaterials[selectedProduct].components.splice(Number(deleteComp.dataset.idx), 1);
			saveBom();
			renderBom(selectedProduct);
			renderCostAnalysis();
		}
	});

	const selector = document.getElementById('bom-product-selector');
	const bomTitle = document.getElementById('bom-product-title');
	const bomBody = document.getElementById('bom-tbody');
	const bomSummary = document.getElementById('bom-cost-summary');
	let selectedProduct = Object.keys(billOfMaterials)[0];

	function renderBom(productName) {
		selectedProduct = productName;
		const product = billOfMaterials[productName];
		if (!product) {
			if (bomTitle) bomTitle.textContent = 'Bill of Materials';
			if (bomBody) bomBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94a3b8;">No products yet. Click "+ Add Product" on the left to start.</td></tr>';
			if (bomSummary) bomSummary.innerHTML = '';
			return;
		}

		if (bomTitle) {
			bomTitle.textContent = `${productName} BOM`;
		}
		if (bomBody) {
			bomBody.innerHTML = product.components.length === 0
				? '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No components yet. Click "Add Component" below.</td></tr>'
				: product.components.map((c, idx) => {
					return `<tr><td>${c.name}</td><td>${formatNumber(c.qty)}</td><td>${c.unit}</td><td>${formatCurrency(c.cost)}</td><td><div class="row-actions"><button class="btn-edit bom-edit-comp" data-idx="${idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-delete bom-delete-comp" data-idx="${idx}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
				}).join('');
		}
		if (bomSummary) {
			const matTotal = product.components.reduce((sum, c) => sum + c.cost, 0);
			const total = matTotal + product.labor + product.overhead;
			bomSummary.innerHTML = `
				<div class="detail-row"><span class="detail-key">Materials</span><span class="detail-val">${formatCurrency(matTotal)}</span></div>
				<div class="detail-row"><span class="detail-key">Labor</span><span class="detail-val">${formatCurrency(product.labor)}</span></div>
				<div class="detail-row"><span class="detail-key">Overhead</span><span class="detail-val">${formatCurrency(product.overhead)}</span></div>
				<div class="line-total"><span>Total Production Cost</span><span>${formatCurrency(total)}</span></div>
			`;
		}

		if (selector) {
			selector.querySelectorAll('.product-btn').forEach((btn) => {
				btn.classList.toggle('btn-active', btn.getAttribute('data-product') === selectedProduct);
			});
		}
	}

	function rebuildProductSelector() {
		const productNames = Object.keys(billOfMaterials);
		if (!selectedProduct || !billOfMaterials[selectedProduct]) selectedProduct = productNames[0];
		if (selector) {
			selector.innerHTML = productNames.map((name) => {
				return `<button type="button" class="product-btn ${name === selectedProduct ? 'btn-active' : ''}" data-product="${name}">${name}</button>`;
			}).join('') + '<button type="button" class="product-btn btn-add-product" id="bom-add-product-btn" style="border:2px dashed #94a3b8;color:#64748b;"><i class="fa-solid fa-plus"></i> Add Product</button>';
			selector.querySelectorAll('.product-btn:not(.btn-add-product)').forEach((btn) => {
				btn.addEventListener('click', () => {
					renderBom(btn.getAttribute('data-product'));
				});
			});
			const addBtn = document.getElementById('bom-add-product-btn');
			if (addBtn) addBtn.addEventListener('click', openProductModal);
		}
		if (selectedProduct) renderBom(selectedProduct);
	}

	/* ---- Add Product Modal ---- */
	const prodModal = document.getElementById('product-add-modal');
	const prodForm = document.getElementById('product-add-form');
	const prodFields = document.getElementById('product-modal-fields');
	const prodModalClose = document.getElementById('product-modal-close');

	function openProductModal() {
		if (!prodModal || !prodFields) return;
		prodFields.innerHTML = `
			<div class="inv-modal-field"><label>Product Name <span class="req">*</span></label><input type="text" name="name" placeholder="e.g. Mobile Water 1.5L" required></div>
			<p style="margin:6px 0 2px;font-size:0.78rem;font-weight:600;color:#64748b;text-transform:uppercase;">Components (comma-separated rows: name, qty, unit, cost)</p>
			<div class="inv-modal-field"><label>Component 1</label><input type="text" name="comp1" placeholder="Preforms, 5000, pcs, 1200"></div>
			<div class="inv-modal-field"><label>Component 2</label><input type="text" name="comp2" placeholder="Caps, 5200, pcs, 312"></div>
			<div class="inv-modal-field"><label>Component 3</label><input type="text" name="comp3" placeholder="Label Rolls, 18, rolls, 612"></div>
			<div class="inv-modal-field"><label>Component 4</label><input type="text" name="comp4" placeholder="Shrink Wrap, 40, kg, 320"></div>
			<div class="inv-modal-field"><label>Labor Cost (GH₵)</label><input type="number" name="labor" min="0" step="0.01" value="0" required></div>
			<div class="inv-modal-field"><label>Overhead Cost (GH₵)</label><input type="number" name="overhead" min="0" step="0.01" value="0" required></div>
		`;
		prodModal.style.display = 'flex';
	}

	if (prodModalClose) prodModalClose.addEventListener('click', () => { prodModal.style.display = 'none'; });
	if (prodModal) prodModal.addEventListener('click', (e) => { if (e.target === prodModal) prodModal.style.display = 'none'; });

	if (prodForm) {
		prodForm.addEventListener('submit', (e) => {
			e.preventDefault();
			const fd = new FormData(prodForm);
			const name = (fd.get('name') || '').toString().trim();
			if (!name) return;
			const components = [];
			for (let i = 1; i <= 4; i++) {
				const raw = (fd.get('comp' + i) || '').toString().trim();
				if (!raw) continue;
				const parts = raw.split(',').map((s) => s.trim());
				if (parts.length >= 4) {
					components.push({ name: parts[0], qty: parseFloat(parts[1]) || 0, unit: parts[2], cost: parseFloat(parts[3]) || 0 });
				}
			}
			billOfMaterials[name] = {
				components,
				labor: parseFloat(fd.get('labor')) || 0,
				overhead: parseFloat(fd.get('overhead')) || 0,
			};
			saveBom();
			prodModal.style.display = 'none';
			selectedProduct = name;
			rebuildProductSelector();
			renderCostAnalysis();
			renderProductionPage();
		});
	}

	rebuildProductSelector();

	/* ---- Add Component to selected product ---- */
	const compModal = document.getElementById('bom-comp-modal');
	const compForm = document.getElementById('bom-comp-form');
	const compFields = document.getElementById('bom-comp-fields');
	const compModalClose = document.getElementById('bom-comp-modal-close');
	const compModalTitle = document.getElementById('bom-comp-modal-title');
	const compAddBtn = document.getElementById('bom-add-component-btn');

	let editCompIdx = -1;

	function openCompModal(editIdx) {
		if (!compModal || !compFields || !selectedProduct) return;
		editCompIdx = typeof editIdx === 'number' ? editIdx : -1;
		const comp = editCompIdx >= 0 && billOfMaterials[selectedProduct] ? billOfMaterials[selectedProduct].components[editCompIdx] : null;
		if (compModalTitle) compModalTitle.textContent = (comp ? 'Edit' : 'Add') + ' Component — ' + selectedProduct;
		compFields.innerHTML = `
			<div class="inv-modal-field"><label>Component Name <span class="req">*</span></label><input type="text" name="name" value="${comp ? comp.name : ''}" placeholder="e.g. Preforms" required></div>
			<div class="inv-modal-field"><label>Quantity</label><input type="number" name="qty" min="0" value="${comp ? comp.qty : ''}" required></div>
			<div class="inv-modal-field"><label>Unit</label><input type="text" name="unit" value="${comp ? comp.unit : ''}" placeholder="pcs, kg, rolls…" required></div>
			<div class="inv-modal-field"><label>Cost (GH₵)</label><input type="number" name="cost" min="0" step="0.01" value="${comp ? comp.cost : ''}" required></div>
		`;
		compModal.style.display = 'flex';
	}

	if (compAddBtn) compAddBtn.addEventListener('click', () => openCompModal());
	if (compModalClose) compModalClose.addEventListener('click', () => { compModal.style.display = 'none'; });
	if (compModal) compModal.addEventListener('click', (e) => { if (e.target === compModal) compModal.style.display = 'none'; });

	if (compForm) {
		compForm.addEventListener('submit', (e) => {
			e.preventDefault();
			if (!selectedProduct || !billOfMaterials[selectedProduct]) return;
			const fd = new FormData(compForm);
			const name = (fd.get('name') || '').toString().trim();
			if (!name) return;
			const data = {
				name,
				qty: parseFloat(fd.get('qty')) || 0,
				unit: (fd.get('unit') || '').toString().trim(),
				cost: parseFloat(fd.get('cost')) || 0,
			};
			if (editCompIdx >= 0 && billOfMaterials[selectedProduct].components[editCompIdx]) {
				Object.assign(billOfMaterials[selectedProduct].components[editCompIdx], data);
			} else {
				billOfMaterials[selectedProduct].components.push(data);
			}
			saveBom();
			compModal.style.display = 'none';
			editCompIdx = -1;
			renderBom(selectedProduct);
			renderCostAnalysis();
			renderProductionPage();
		});
	}

	/* Cost Analysis — auto-computed from BOM data across all products */
	function renderCostAnalysis() {
		let totalMat = 0, totalLabor = 0, totalOverhead = 0;
		Object.values(billOfMaterials).forEach((p) => {
			totalMat += p.components.reduce((s, c) => s + c.cost, 0);
			totalLabor += p.labor || 0;
			totalOverhead += p.overhead || 0;
		});
		const grand = totalMat + totalLabor + totalOverhead;
		const costData = grand > 0
			? [
				{ label: 'Raw Materials', value: Math.round((totalMat / grand) * 100), amount: totalMat, color: '#22c55e' },
				{ label: 'Labor', value: Math.round((totalLabor / grand) * 100), amount: totalLabor, color: '#3b82f6' },
				{ label: 'Overhead', value: Math.round((totalOverhead / grand) * 100), amount: totalOverhead, color: '#ef4444' },
			]
			: [
				{ label: 'Raw Materials', value: 0, amount: 0, color: '#22c55e' },
				{ label: 'Labor', value: 0, amount: 0, color: '#3b82f6' },
				{ label: 'Overhead', value: 0, amount: 0, color: '#ef4444' },
			];
		const cbEl = document.getElementById('cost-breakdown-bars');
		if (!cbEl) return;
		if (typeof Chart !== 'undefined' && grand > 0) {
			cbEl.innerHTML = '<canvas id="prod-cost-canvas" style="max-width:220px;max-height:220px;margin:0 auto;"></canvas>';
			const cbCtx = document.getElementById('prod-cost-canvas');
			if (window.__prodCostChart) window.__prodCostChart.destroy();
			window.__prodCostChart = new Chart(cbCtx, {
				type: 'doughnut',
				data: {
					labels: costData.map((c) => c.label),
					datasets: [{ data: costData.map((c) => c.value), backgroundColor: costData.map((c) => c.color), borderWidth: 2, borderColor: '#fff' }],
				},
				options: {
					responsive: true,
					maintainAspectRatio: true,
					plugins: {
						legend: { display: true, position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
						tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}% (${formatCurrency(costData[ctx.dataIndex].amount)})` } },
					},
				},
			});
		} else {
			renderProgressBars(cbEl, costData.map((c) => ({ label: c.label, value: c.value, color: c.color === '#22c55e' ? 'green' : c.color === '#3b82f6' ? 'blue' : 'red' })));
		}
	}
	renderCostAnalysis();

	/* Profitability by Batch — auto-computed from batch data */
	function renderProfitabilityChart() {
		const chartEl = document.getElementById('chart-profitability');
		if (!chartEl) return;
		if (prodBatches.length === 0) {
			chartEl.innerHTML = '<p style="text-align:center;color:#94a3b8;padding:20px 0;">No batches yet. Add batches to see profitability.</p>';
			return;
		}
		const rows = prodBatches.slice(-10).map((b) => ({
			label: b.id,
			revenue: b.sales || 0,
			cost: b.cost || 0,
		}));
		if (typeof Chart !== 'undefined') {
			chartEl.innerHTML = '<canvas id="prod-profit-canvas"></canvas>';
			const pfCtx = document.getElementById('prod-profit-canvas');
			if (window.__prodProfitChart) window.__prodProfitChart.destroy();
			window.__prodProfitChart = new Chart(pfCtx, {
				type: 'bar',
				data: {
					labels: rows.map((r) => r.label),
					datasets: [
						{ label: 'Sales', data: rows.map((r) => r.revenue), backgroundColor: 'rgba(22,163,74,0.7)', borderColor: '#16a34a', borderWidth: 1, borderRadius: 6 },
						{ label: 'Cost', data: rows.map((r) => r.cost), backgroundColor: 'rgba(245,158,11,0.7)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 6 },
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { mode: 'index', intersect: false },
					plugins: {
						legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
						tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}` } },
					},
					scales: { y: { beginAtZero: true, ticks: { callback: (v) => formatCurrency(v) } } },
				},
			});
		} else {
			renderDualBars(chartEl, rows.map((r) => ({ month: r.label, revenue: r.revenue, cost: r.cost })));
		}
	}
	renderProfitabilityChart();

	/* ── Cross-tab sync: refresh production when another tab changes batches ── */
	const reloadProductionData = () => {
		try {
			const stored = JSON.parse(localStorage.getItem(BATCH_KEY));
			if (Array.isArray(stored)) prodBatches = stored;
		} catch (_) { /* ignore */ }
		try {
			const stored = JSON.parse(localStorage.getItem(BOM_KEY));
			if (stored && typeof stored === 'object' && !Array.isArray(stored)) billOfMaterials = stored;
		} catch (_) { /* ignore */ }
		renderProductionPage();
		rebuildProductSelector();
		renderCostAnalysis();
		renderProfitabilityChart();
	};
	window.addEventListener('storage', (e) => {
		if ([BATCH_KEY, BOM_KEY, 'ww_finished_products', 'ww_daily_production'].includes(e.key)) {
			reloadProductionData();
		}
	});
	try {
		new BroadcastChannel('ww_finished_products_sync').onmessage = reloadProductionData;
	} catch (_e) { /* BroadcastChannel not supported */ }
}

function initReportsPage() {
	if (document.body.getAttribute('data-page') !== 'reports') {
		return;
	}

	// ── Set up filter controls ──
	const filterType = document.getElementById('rep-filter-type');
	const filterMonth = document.getElementById('rep-filter-month');
	const filterYear = document.getElementById('rep-filter-year');

	if (filterMonth) {
		const now = new Date();
		filterMonth.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	}

	// Populate year dropdown from all data
	if (filterYear) {
		const allDates = [];
		const sd = getAllSalesData();
		sd.invoices.forEach((i) => { const d = new Date(i.date); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		sd.salesOrders.forEach((o) => { const d = new Date(o.orderDate); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		const ad = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || '{"ledger":[]}');
		ad.ledger.forEach((e) => { const d = new Date(e.date); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		const bd = JSON.parse(localStorage.getItem('ww_production_batches') || '[]');
		bd.forEach((b) => { const d = new Date(b.date); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		const pd = JSON.parse(localStorage.getItem('ww_purchase_data_v2') || '{"purchaseOrders":[]}');
		(pd.purchaseOrders || []).forEach((po) => { const d = new Date(po.date); if (!isNaN(d)) allDates.push(d.getFullYear()); });
		const years = [...new Set(allDates)].sort((a, b) => b - a);
		if (years.length === 0) years.push(new Date().getFullYear());
		filterYear.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
	}

	if (filterType) {
		filterType.addEventListener('change', () => {
			if (filterMonth) filterMonth.style.display = filterType.value === 'month' ? '' : 'none';
			if (filterYear) filterYear.style.display = filterType.value === 'year' ? '' : 'none';
		});
	}

	renderReportsData();

	// ── Cross-tab sync: auto-refresh reports when data changes ──
	if (!window.__wwReportsStorageBound) {
		window.__wwReportsStorageBound = true;
		window.addEventListener('storage', (event) => {
			const watchKeys = ['ww_accounting_data_v2', 'ww_production_batches', 'ww_purchase_data_v2', 'ww_raw_materials', 'ww_equipment', 'ww_cost_centre_budgets'];
			if (watchKeys.includes(event.key) || (event.key && event.key.startsWith('ww_sales_'))) {
				renderReportsData();
			}
		});
		const channels = ['ww_sales_sync', 'ww_accounting_sync', 'ww_purchase_sync'];
		for (const ch of channels) {
			try {
				const bc = new BroadcastChannel(ch);
				bc.onmessage = () => renderReportsData();
			} catch (_e) { /* ignore */ }
		}
	}
}

window.applyReportsFilter = function () {
	const filterType = document.getElementById('rep-filter-type');
	const filterMonth = document.getElementById('rep-filter-month');
	const filterYear = document.getElementById('rep-filter-year');
	if (filterMonth) filterMonth.style.display = filterType && filterType.value === 'month' ? '' : 'none';
	if (filterYear) filterYear.style.display = filterType && filterType.value === 'year' ? '' : 'none';
	renderReportsData();
};

function renderReportsData() {
	// ── Determine date range from filter ──
	const filterType = (document.getElementById('rep-filter-type') || {}).value || 'all';
	let filterStart = null;
	let filterEnd = null;
	let filterLabel = 'All Time';

	const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	if (filterType === 'month') {
		const val = (document.getElementById('rep-filter-month') || {}).value || '';
		if (val) {
			const [y, m] = val.split('-').map(Number);
			filterStart = new Date(y, m - 1, 1);
			filterEnd = new Date(y, m, 0, 23, 59, 59, 999);
			filterLabel = `${monthNames[m - 1]} ${y}`;
		}
	} else if (filterType === 'year') {
		const val = Number((document.getElementById('rep-filter-year') || {}).value);
		if (val) {
			filterStart = new Date(val, 0, 1);
			filterEnd = new Date(val, 11, 31, 23, 59, 59, 999);
			filterLabel = String(val);
		}
	}

	function inRange(dateStr) {
		if (!filterStart) return true;
		const d = new Date(dateStr);
		if (isNaN(d)) return false;
		return d >= filterStart && d <= filterEnd;
	}

	// ── Pull real data from localStorage ──
	const salesData = getAllSalesData();
	const accData = JSON.parse(localStorage.getItem('ww_accounting_data_v2') || '{"ledger":[],"cashbook":[],"summary":[],"currencies":[]}');
	const allBatches = JSON.parse(localStorage.getItem('ww_production_batches') || '[]');
	const purchaseData = JSON.parse(localStorage.getItem('ww_purchase_data_v2') || '{"purchaseOrders":[],"suppliers":[]}');
	const rawMaterials = JSON.parse(localStorage.getItem('ww_raw_materials') || '[]');
	const equipment = JSON.parse(localStorage.getItem('ww_equipment') || '[]');
	const finishedProducts = JSON.parse(localStorage.getItem('ww_finished_products') || '[]');

	// Filter by date range
	const invoices = salesData.invoices.filter((i) => inRange(i.date));
	const orders = salesData.salesOrders.filter((o) => inRange(o.orderDate));
	const ledger = accData.ledger.filter((e) => inRange(e.date));
	const cashbook = accData.cashbook.filter((e) => inRange(e.date));
	const batches = allBatches.filter((b) => inRange(b.date));
	const purchaseOrders = (purchaseData.purchaseOrders || []).filter((po) => inRange(po.date));

	// ── Sales Trends: aggregate invoices by month (revenue + bags + promo, paid only) ──
	const salesByMonth = {};
	for (const inv of invoices) {
		if (inv.status !== 'paid') continue;
		const d = new Date(inv.date);
		if (isNaN(d)) continue;
		const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
		if (!salesByMonth[key]) salesByMonth[key] = { sales: 0, units: 0, promo: 0 };
		salesByMonth[key].sales += Number(inv.amount) || 0;
		salesByMonth[key].units += Number(inv.items && inv.items[0] ? inv.items[0].qty : 0) || 0;
		salesByMonth[key].promo += Number(inv.promo) || 0;
	}
	const salesTrends = Object.keys(salesByMonth).sort().slice(-12).map((key) => {
		const monthIdx = parseInt(key.split('-')[1], 10);
		return { month: monthNames[monthIdx], sales: salesByMonth[key].sales, units: salesByMonth[key].units, promo: salesByMonth[key].promo };
	});

	// ── P&L from filtered sales + accounting + production + purchase data ──
	const salesRevenue = invoices.filter((inv) => inv.status === 'paid').reduce((s, inv) => s + (Number(inv.amount) || 0), 0);
	const ledgerRevenue = ledger.filter((e) => e.type === 'revenue').reduce((s, e) => s + ((Number(e.credit) || 0) - (Number(e.debit) || 0)), 0);
	const filteredSummaryRevenue = salesRevenue + ledgerRevenue;
	const filteredSummaryExpenses = ledger.filter((e) => e.type === 'expense').reduce((s, e) => s + ((Number(e.debit) || 0) - (Number(e.credit) || 0)), 0);
	const cogs = batches.reduce((s, b) => s + (Number(b.cost) || 0), 0);
	const purchaseSpend = purchaseOrders.reduce((s, po) => {
		const amt = (po.items && po.items.length) ? po.items.reduce((t, i) => t + ((Number(i.qty) || 0) * (Number(i.unitCost) || 0)), 0) : (Number(po.amount) || 0);
		return s + amt;
	}, 0);
	const netProfit = filteredSummaryRevenue - cogs - filteredSummaryExpenses - purchaseSpend;
	const profitLoss = [
		{ item: 'Sales Revenue', amount: salesRevenue },
		{ item: 'Other Revenue', amount: ledgerRevenue },
		{ item: 'Cost of Goods Sold', amount: cogs ? -cogs : 0 },
		{ item: 'Purchase Orders', amount: purchaseSpend ? -purchaseSpend : 0 },
		{ item: 'Operating Expenses', amount: filteredSummaryExpenses ? -filteredSummaryExpenses : 0 },
		{ item: 'Net Profit', amount: netProfit },
	];

	// ── Cost Centre Performance from filtered ledger ──
	const centreBuckets = { Production: 0, Transport: 0, Maintenance: 0, Utilities: 0, Administration: 0, Salaries: 0, Marketing: 0 };
	for (const entry of ledger) {
		if (entry.type !== 'expense') continue;
		const acc = (entry.account || '').toLowerCase();
		if (acc.includes('production') || acc.includes('manufactur') || acc.includes('factory')) {
			centreBuckets.Production += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('transport') || acc.includes('logistics') || acc.includes('delivery') || acc.includes('shipping')) {
			centreBuckets.Transport += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('maintenance')) {
			centreBuckets.Maintenance += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('utilities') || acc.includes('electric')) {
			centreBuckets.Utilities += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('salar') || acc.includes('wage')) {
			centreBuckets.Salaries += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else if (acc.includes('marketing') || acc.includes('advertis')) {
			centreBuckets.Marketing += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		} else {
			centreBuckets.Administration += (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
		}
	}
	const costCentrePerformance = Object.entries(centreBuckets)
		.filter(([, actual]) => actual !== 0)
		.map(([centre, actual]) => ({ centre, budget: 0, actual }));

	// ── Inventory Distribution (not date-filtered — shows current snapshot) ──
	const rawCount = rawMaterials.length;
	const equipCount = equipment.length;
	const finCount = finishedProducts.length;
	const invTotal = rawCount + equipCount + finCount;
	const inventoryReport = invTotal > 0 ? [
		{ label: 'Raw Materials', value: Math.round((rawCount / invTotal) * 100), color: '#3b82f6' },
		{ label: 'Equipment', value: Math.round((equipCount / invTotal) * 100), color: '#f59e0b' },
		{ label: 'Finished Goods', value: Math.round((finCount / invTotal) * 100), color: '#22c55e' },
	].filter((seg) => seg.value > 0) : [];

	// ── Daily Shift Sales from filtered batches ──
	const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const shiftBuckets = {};
	for (const b of batches) {
		const d = new Date(b.date);
		if (isNaN(d)) continue;
		const dayKey = d.toISOString().slice(0, 10);
		if (!shiftBuckets[dayKey]) shiftBuckets[dayKey] = { morning: 0, afternoon: 0, night: 0 };
		const shift = (b.shift || '').toLowerCase();
		const val = Number(b.sales) || 0;
		if (shift.includes('morning')) shiftBuckets[dayKey].morning += val;
		else if (shift.includes('afternoon')) shiftBuckets[dayKey].afternoon += val;
		else shiftBuckets[dayKey].night += val;
	}
	const dailyShiftSales = Object.keys(shiftBuckets).sort().slice(-7).map((dayKey) => {
		const d = new Date(dayKey);
		return { day: dayLabels[d.getDay()], ...shiftBuckets[dayKey] };
	});

	// ── KPI cards ──
	const allSalesTotal = salesTrends.reduce((s, r) => s + r.sales, 0);
	const latestSales = salesTrends.length > 0 ? salesTrends[salesTrends.length - 1].sales : 0;
	const projected = salesTrends.length >= 2
		? latestSales + Math.round((latestSales - salesTrends[0].sales) / salesTrends.length)
		: latestSales;

	const totalEquip = equipment.length;
	const operationalEquip = equipment.filter((e) => e.status === 'operational').length;
	const opsHealth = totalEquip > 0 ? Math.round((operationalEquip / totalEquip) * 100) : 100;

	const kpis = [
		{ icon: '<i class="fa-solid fa-chart-bar"></i>', label: 'Sales (' + filterLabel + ')', value: formatCurrency(allSalesTotal), meta: filterType === 'all' ? 'All tracked sales' : 'Filtered period', color: '' },
		{ icon: '<i class="fa-solid fa-chart-line"></i>', label: 'Forecast', value: formatCurrency(projected), meta: salesTrends.length >= 2 ? 'Trend-based projection' : 'Need more months', color: 'green' },
		{ icon: '<i class="fa-solid fa-coins"></i>', label: 'Net Profit', value: formatCurrency(netProfit), meta: 'Revenue − COGS − Expenses', color: 'yellow' },
		{ icon: '<i class="fa-solid fa-industry"></i>', label: 'Ops Health', value: `${opsHealth}%`, meta: totalEquip > 0 ? `${operationalEquip}/${totalEquip} equipment up` : 'No equipment tracked', color: 'purple' },
	];

	const kpiGrid = document.getElementById('rep-kpi-grid');
	if (kpiGrid) {
		kpiGrid.innerHTML = kpis.map((kpi) => {
			return `
				<article class="kpi-card-v2 ${kpi.color}">
					<div class="kpi-icon">${kpi.icon}</div>
					<p class="kpi-label">${kpi.label}</p>
					<p class="kpi-value">${kpi.value}</p>
					<p class="kpi-meta">${kpi.meta}</p>
				</article>
			`;
		}).join('');
	}

	// ── Sales Trends chart (Chart.js with tooltips) ──
	const stEl = document.getElementById('chart-sales-trends');
	if (stEl && salesTrends.length > 0) {
		if (typeof Chart !== 'undefined') {
			stEl.innerHTML = '<canvas id="rep-sales-trends-canvas"></canvas>';
			const stCtx = document.getElementById('rep-sales-trends-canvas');
			if (window.__repSalesTrendChart) window.__repSalesTrendChart.destroy();
			window.__repSalesTrendChart = new Chart(stCtx, {
				type: 'bar',
				data: {
					labels: salesTrends.map((r) => r.month),
					datasets: [
						{
							label: 'Revenue',
							data: salesTrends.map((r) => r.sales),
							backgroundColor: 'rgba(22,163,74,0.7)',
							borderColor: '#16a34a',
							borderWidth: 1,
							borderRadius: 6,
							yAxisID: 'y',
						},
						{
							label: 'Bags Sold',
							data: salesTrends.map((r) => r.units),
							backgroundColor: 'rgba(37,99,235,0.6)',
							borderColor: '#1d4ed8',
							borderWidth: 1,
							borderRadius: 6,
							yAxisID: 'y1',
						},
						{
							label: 'Promo Bags',
							data: salesTrends.map((r) => r.promo),
							backgroundColor: 'rgba(245,158,11,0.6)',
							borderColor: '#f59e0b',
							borderWidth: 1,
							borderRadius: 6,
							yAxisID: 'y1',
						},
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { mode: 'index', intersect: false },
					plugins: {
						legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
						tooltip: {
							callbacks: {
								label: (ctx) => {
									if (ctx.dataset.label === 'Revenue') return `Revenue: ${formatCurrency(ctx.parsed.y)}`;
									if (ctx.dataset.label === 'Promo Bags') return `Promo Bags: ${formatNumber(ctx.parsed.y)}`;
									return `Bags Sold: ${formatNumber(ctx.parsed.y)}`;
								},
							},
						},
					},
					scales: {
						y: {
							type: 'linear',
							position: 'left',
							beginAtZero: true,
							ticks: { callback: (v) => formatCurrency(v) },
							title: { display: true, text: 'Revenue (GH₵)', font: { size: 11 } },
						},
						y1: {
							type: 'linear',
							position: 'right',
							beginAtZero: true,
							grid: { drawOnChartArea: false },
							ticks: { callback: (v) => formatNumber(v) },
							title: { display: true, text: 'Bags', font: { size: 11 } },
						},
					},
				},
			});
		} else {
			renderDualBars(stEl, salesTrends.map((row) => ({ month: row.month, revenue: row.sales, cost: row.units })));
		}
	} else if (stEl) {
		stEl.innerHTML = `<p style="color:#64748b;text-align:center;padding:40px 0">No sales data for ${filterLabel}.</p>`;
	}

	// ── Daily Shift Sales chart (Chart.js) ──
	const ssEl = document.getElementById('chart-shift-sales');
	if (ssEl && dailyShiftSales.length > 0) {
		if (typeof Chart !== 'undefined') {
			ssEl.innerHTML = '<canvas id="rep-shift-sales-canvas"></canvas>';
			const ssCtx = document.getElementById('rep-shift-sales-canvas');
			if (window.__repShiftChart) window.__repShiftChart.destroy();
			window.__repShiftChart = new Chart(ssCtx, {
				type: 'bar',
				data: {
					labels: dailyShiftSales.map((d) => d.day),
					datasets: [
						{ label: 'Morning', data: dailyShiftSales.map((d) => d.morning), backgroundColor: 'rgba(251,191,36,0.7)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 4 },
						{ label: 'Afternoon', data: dailyShiftSales.map((d) => d.afternoon), backgroundColor: 'rgba(37,99,235,0.7)', borderColor: '#1d4ed8', borderWidth: 1, borderRadius: 4 },
						{ label: 'Night', data: dailyShiftSales.map((d) => d.night), backgroundColor: 'rgba(100,116,139,0.7)', borderColor: '#475569', borderWidth: 1, borderRadius: 4 },
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { mode: 'index', intersect: false },
					plugins: {
						legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
						tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)}` } },
					},
					scales: {
						x: { stacked: true },
						y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => formatNumber(v) } },
					},
				},
			});
		} else {
			renderVerticalBars(ssEl, dailyShiftSales.map((day) => ({ label: day.day, value: day.morning + day.afternoon + day.night })), { color: 'linear-gradient(180deg,#38bdf8,#2563eb)', valueFormatter: (v) => formatNumber(v) });
		}
	} else if (ssEl) {
		ssEl.innerHTML = `<p style="color:#64748b;text-align:center;padding:40px 0">No batch data for ${filterLabel}.</p>`;
	}

	// ── Sales summary cards (from filtered sales data) ──
	const salesSummary = document.getElementById('sales-summary-cards');
	if (salesSummary) {
		const allEntries = [];
		for (const inv of invoices) {
			if (inv.status !== 'paid') continue;
			const d = new Date(inv.date);
			if (isNaN(d)) continue;
			const amount = Number(inv.amount) || 0;
			allEntries.push({ date: d, amount });
		}

		const totalSales = allEntries.reduce((s, e) => s + e.amount, 0);
		const orderCount = allEntries.length;
		const avgOrder = orderCount > 0 ? Math.round(totalSales / orderCount) : 0;

		if (filterType === 'all') {
			const now = new Date();
			const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
			const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
			const qDate = new Date(now); qDate.setMonth(qDate.getMonth() - 2);
			const quarterStart = new Date(qDate.getFullYear(), qDate.getMonth(), 1);
			const yearStart = new Date(now.getFullYear(), 0, 1);
			const weekTotal = allEntries.filter((e) => e.date >= weekAgo).reduce((s, e) => s + e.amount, 0);
			const monthTotal = allEntries.filter((e) => e.date >= monthStart).reduce((s, e) => s + e.amount, 0);
			const quarterTotal = allEntries.filter((e) => e.date >= quarterStart).reduce((s, e) => s + e.amount, 0);
			const yearTotal = allEntries.filter((e) => e.date >= yearStart).reduce((s, e) => s + e.amount, 0);
			salesSummary.innerHTML = `
				<div class="stat-card"><p class="s-label">Week Sales</p><p class="s-value">${formatCurrency(weekTotal)}</p><p class="s-meta">Last 7 days</p></div>
				<div class="stat-card"><p class="s-label">Month Sales</p><p class="s-value">${formatCurrency(monthTotal)}</p><p class="s-meta">${monthNames[now.getMonth()]} ${now.getFullYear()}</p></div>
				<div class="stat-card"><p class="s-label">Quarter Sales</p><p class="s-value">${formatCurrency(quarterTotal)}</p><p class="s-meta">Last 3 months</p></div>
				<div class="stat-card"><p class="s-label">Year Sales</p><p class="s-value">${formatCurrency(yearTotal)}</p><p class="s-meta">${now.getFullYear()} total</p></div>
				<div class="stat-card"><p class="s-label">Avg Order</p><p class="s-value">${formatCurrency(avgOrder)}</p><p class="s-meta">${orderCount} orders total</p></div>
			`;
		} else {
			salesSummary.innerHTML = `
				<div class="stat-card"><p class="s-label">Total Sales</p><p class="s-value">${formatCurrency(totalSales)}</p><p class="s-meta">${filterLabel}</p></div>
				<div class="stat-card"><p class="s-label">Orders</p><p class="s-value">${orderCount}</p><p class="s-meta">${filterLabel}</p></div>
				<div class="stat-card"><p class="s-label">Avg Order</p><p class="s-value">${formatCurrency(avgOrder)}</p><p class="s-meta">Per invoice/order</p></div>
			`;
		}
	}

	// ── P&L table ──
	const plBody = document.getElementById('pl-tbody');
	if (plBody) {
		if (profitLoss.some((line) => line.amount !== 0)) {
			plBody.innerHTML = profitLoss.map((line) => {
				const cssClass = line.item === 'Net Profit' ? 'status-pill status-green' : '';
				return `<tr><td>${line.item}</td><td>${cssClass ? `<span class="${cssClass}">${formatCurrency(line.amount)}</span>` : formatCurrency(line.amount)}</td></tr>`;
			}).join('');
		} else {
			plBody.innerHTML = `<tr><td colspan="2" style="color:#64748b;text-align:center;padding:20px">No accounting data for ${filterLabel}.</td></tr>`;
		}
	}

	// ── Inventory pie chart (Chart.js doughnut) ──
	const totalInventory = inventoryReport.reduce((sum, segment) => sum + segment.value, 0);
	const pieContainer = document.getElementById('inventory-pie');
	if (pieContainer) {
		if (inventoryReport.length > 0 && totalInventory > 0 && typeof Chart !== 'undefined') {
			pieContainer.innerHTML = '<canvas id="rep-inventory-canvas" style="max-width:220px;max-height:220px;margin:0 auto;"></canvas>';
			const pieCtx = document.getElementById('rep-inventory-canvas');
			if (window.__repInvPieChart) window.__repInvPieChart.destroy();
			window.__repInvPieChart = new Chart(pieCtx, {
				type: 'doughnut',
				data: {
					labels: inventoryReport.map((s) => s.label),
					datasets: [{
						data: inventoryReport.map((s) => s.value),
						backgroundColor: inventoryReport.map((s) => s.color),
						borderWidth: 2,
						borderColor: '#fff',
					}],
				},
				options: {
					responsive: true,
					maintainAspectRatio: true,
					plugins: {
						legend: { display: false },
						tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}%` } },
					},
				},
			});
		} else if (inventoryReport.length > 0 && totalInventory > 0) {
			pieContainer.innerHTML = `
				<div style="width:170px;height:170px;border-radius:50%;background:conic-gradient(
					${inventoryReport.map((segment, index) => {
						const before = inventoryReport.slice(0, index).reduce((sum, s) => sum + s.value, 0);
						const start = (before / totalInventory) * 360;
						const end = ((before + segment.value) / totalInventory) * 360;
						return `${segment.color} ${start}deg ${end}deg`;
					}).join(',')}
				);
				border:8px solid #fff;box-shadow:0 4px 14px rgba(2,6,23,0.12);"></div>
			`;
		} else {
			pieContainer.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px 0">No inventory items tracked yet.</p>';
		}
	}
	const pieLegend = document.getElementById('inventory-pie-legend');
	if (pieLegend) {
		pieLegend.innerHTML = inventoryReport.map((segment) => {
			return `
				<div class="pie-legend-item">
					<span class="pie-swatch" style="background:${segment.color};"></span>
					<span>${segment.label} (${segment.value}%)</span>
				</div>
			`;
		}).join('');
	}

	// ── Cost Centre Performance table ──
	const budgets = JSON.parse(localStorage.getItem('ww_cost_centre_budgets') || '{}');
	const centreBody = document.getElementById('cost-centre-tbody');
	if (centreBody) {
		if (costCentrePerformance.length > 0) {
			centreBody.innerHTML = costCentrePerformance.map((centre) => {
				const bgt = budgets[centre.centre] || 0;
				centre.budget = bgt;
				const variance = centre.actual - bgt;
				const status = bgt === 0 ? 'no budget set' : variance <= 0 ? 'within budget' : variance < 300 ? 'watch' : 'over budget';
				const pillClass = bgt === 0 ? 'status-blue' : variance <= 0 ? 'status-green' : variance < 300 ? 'status-yellow' : 'status-red';
				return `
					<tr>
						<td>${centre.centre}</td>
						<td>${bgt ? formatCurrency(bgt) : '—'}</td>
						<td>${formatCurrency(centre.actual)}</td>
						<td>${bgt ? (variance >= 0 ? '+' : '') + formatCurrency(variance) : '—'}</td>
						<td><span class="status-pill ${pillClass}">${status}</span></td>
						<td><button class="btn-edit rep-budget-btn" data-centre="${centre.centre}" data-budget="${bgt}"><i class="fa-solid fa-pen-to-square"></i></button></td>
					</tr>
				`;
			}).join('');
		} else {
			centreBody.innerHTML = `<tr><td colspan="6" style="color:#64748b;text-align:center;padding:20px">No expense entries for ${filterLabel}.</td></tr>`;
		}
	}

	// Budget edit button handler
	if (centreBody && !centreBody.__budgetBound) {
		centreBody.__budgetBound = true;
		centreBody.addEventListener('click', (e) => {
			const btn = e.target.closest('.rep-budget-btn');
			if (!btn) return;
			const centre = btn.getAttribute('data-centre');
			const current = Number(btn.getAttribute('data-budget')) || 0;
			const modal = document.getElementById('budget-modal');
			document.getElementById('budget-modal-title').textContent = `Set Budget — ${centre}`;
			document.getElementById('budget-centre-key').value = centre;
			document.getElementById('budget-centre-name').value = centre;
			document.getElementById('budget-amount').value = current || '';
			modal.style.display = 'flex';
		});
	}

	// Budget form submit handler
	const budgetForm = document.getElementById('budget-form');
	if (budgetForm && !budgetForm.__bound) {
		budgetForm.__bound = true;
		budgetForm.addEventListener('submit', (e) => {
			e.preventDefault();
			const centre = document.getElementById('budget-centre-key').value;
			const amt = Number(document.getElementById('budget-amount').value) || 0;
			const stored = JSON.parse(localStorage.getItem('ww_cost_centre_budgets') || '{}');
			stored[centre] = amt;
			localStorage.setItem('ww_cost_centre_budgets', JSON.stringify(stored));
			syncToServer('ww_cost_centre_budgets', stored);
			document.getElementById('budget-modal').style.display = 'none';
			renderReportsData();
		});
	}

	// ── Ops metric cards (from filtered batches) ──
	const metricCards = document.getElementById('ops-metric-cards');
	if (metricCards) {
		const completedBatches = batches.filter((b) => b.status === 'completed').length;
		const totalBatches = batches.length;
		const efficiency = totalBatches > 0 ? Math.round((completedBatches / totalBatches) * 100) : 0;
		const lowStock = rawMaterials.filter((m) => m.quantity <= m.minLevel).length;
		metricCards.innerHTML = `
			<div class="metric-card"><span class="m-value">${totalBatches > 0 ? efficiency + '%' : '—'}</span><span class="m-label">Production Efficiency</span></div>
			<div class="metric-card"><span class="m-value">${lowStock}</span><span class="m-label">Stock Alerts</span></div>
			<div class="metric-card"><span class="m-value">${opsHealth}%</span><span class="m-label">Equipment Operational</span></div>
		`;
	}
}

function bindAuthPanels() {
	const toggles = document.querySelectorAll('[data-toggle-target]');
	if (!toggles.length) {
		return;
	}
	for (const toggle of toggles) {
		toggle.addEventListener('click', () => {
			const targetId = toggle.getAttribute('data-toggle-target');
			if (!targetId) {
				return;
			}
			const panel = document.getElementById(targetId);
			if (!panel) {
				return;
			}
			panel.hidden = !panel.hidden;
		});
	}
}

function setAuthMessage(message, isError) {
	const messageNode = document.getElementById('auth-message');
	if (!messageNode) {
		return;
	}
	messageNode.textContent = message;
	if (isError) {
		messageNode.style.cssText = 'color:#b42318;background:#fef3f2;border:1px solid #fecdca;padding:10px 14px;border-radius:8px;font-weight:500;margin-top:12px;';
	} else {
		messageNode.style.cssText = 'color:#027a48;background:#ecfdf3;border:1px solid #a6f4c5;padding:10px 14px;border-radius:8px;font-weight:500;margin-top:12px;';
	}
}

async function postJson(url, payload) {
	let response;
	try {
		response = await fetch(API_BASE + url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(payload),
		});
	} catch (networkError) {
		throw new Error('Cannot reach server. Check your internet connection and try again.');
	}

	let data = {};
	try {
		data = await response.json();
	} catch (_error) {
		data = {};
	}

	if (!response.ok) {
		throw new Error(data.message || `Server error (${response.status})`);
	}
	return data;
}

function bindPasswordAssistanceForms() {
	const forgotForm = document.getElementById('forgot-password-form');
	const resetForm = document.getElementById('reset-password-form');

	if (forgotForm) {
		forgotForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			const formData = new FormData(forgotForm);
			const email = String(formData.get('email') || '').trim();
			try {
				const data = await postJson('/api/auth/forgot-password', { email });
				setAuthMessage(data.message || 'Password assistance sent.', false);
				forgotForm.reset();
				// Auto-open the reset password panel so user can proceed
				const forgotPanel = document.getElementById('forgot-password-panel');
				const resetPanel = document.getElementById('reset-password-panel');
				if (forgotPanel) forgotPanel.hidden = true;
				if (resetPanel) {
					resetPanel.hidden = false;
					resetPanel.scrollIntoView({ behavior: 'smooth' });
				}
			} catch (error) {
				setAuthMessage(error.message || 'Could not process request.', true);
			}
		});
	}

	if (resetForm) {
		resetForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			const formData = new FormData(resetForm);
			const email = String(formData.get('email') || '').trim();
			const currentPassword = String(formData.get('currentPassword') || '');
			const newPassword = String(formData.get('newPassword') || '');
			const confirmPassword = String(formData.get('confirmPassword') || '');

			if (!currentPassword) {
				setAuthMessage('Please enter your current password.', true);
				return;
			}

			if (newPassword !== confirmPassword) {
				setAuthMessage('New password and confirm password must match.', true);
				return;
			}

			try {
				const data = await postJson('/api/auth/reset-password', { email, currentPassword, newPassword });
				setAuthMessage(data.message || 'Password reset successful. Redirecting to login…', false);
				resetForm.reset();
				// Close the reset panel and redirect to login after a short delay
				const resetPanel = document.getElementById('reset-password-panel');
				if (resetPanel) resetPanel.hidden = true;
				setTimeout(() => {
					const loginHref = window.location.pathname.includes('/pages/') ? '../login.html' : 'login.html';
					if (window.location.pathname.includes('login')) {
						// Already on login page — just scroll to login form
						window.scrollTo({ top: 0, behavior: 'smooth' });
					} else {
						window.location.href = loginHref;
					}
				}, 1500);
			} catch (error) {
				setAuthMessage(error.message || 'Could not reset password.', true);
			}
		});
	}
}

document.addEventListener('DOMContentLoaded', async () => {
	initSidebarToggle();
	bindLogoutLinks();
	bindAuthPanels();
	bindRolePersistenceOnAuthForms();
	bindPasswordToggles();
	bindPasswordAssistanceForms();
	enforceRoleAccess();

	// Hydrate localStorage from server before page inits
	let authenticated = false;
	const isOpsPage = document.body.classList.contains('ops-page');
	try {
		const meRes = await fetch(API_BASE + '/api/auth/me', { credentials: 'include', cache: 'no-store' });
		if (meRes.ok) authenticated = true;
	} catch (_e) { /* offline */ }

	// Redirect to login if not authenticated on ops pages
	if (!authenticated && isOpsPage) {
		const loginHref = window.location.pathname.includes('/pages/') ? '../login.html' : 'login.html';
		window.location.href = loginHref;
		return;
	}

	if (authenticated) try {
		await loadFromServer('ww_seed_flags');
		await loadFromServer('ww_sales_months');
		const salesMonths = getSalesMonths();
		const salesKeys = salesMonths.map((m) => 'ww_sales_' + m);
		await loadBulkFromServer([
			'ww_raw_materials', 'ww_finished_products', 'ww_production_batches',
			'ww_daily_production', 'ww_purchase_data_v2', 'ww_accounting_data_v2',
			'ww_waybills', 'ww_cost_centre_budgets', 'ww_bom_data',
			'ww_equipment',
			...salesKeys,
		]);
		// Re-load sales months in case server had more
		const serverMonths = getSalesMonths();
		if (serverMonths.length > salesMonths.length) {
			const extraKeys = serverMonths.filter((m) => !salesMonths.includes(m)).map((m) => 'ww_sales_' + m);
			if (extraKeys.length) await loadBulkFromServer(extraKeys);
		}
		console.log('[Init] Server hydration complete');
	} catch (_e) { console.warn('[Init] Server hydration failed:', _e); }

	initDashboardPage();
	initInventoryPage();
	initSalesInvoicesPage();
	initPurchasePage();
	initAccountingPage();
	initProductionPage();
	initReportsPage();

	// After all pages render, hide edit/delete in dynamic content for restricted roles
	if (document.body.classList.contains('role-restricted')) {
		const observer = new MutationObserver(() => {
			document.querySelectorAll('.btn-edit, .btn-delete, [data-action="edit"], [data-action="delete"]').forEach((btn) => {
				btn.style.display = 'none';
			});
		});
		observer.observe(document.querySelector('.ops-main') || document.body, { childList: true, subtree: true });
	}
});
