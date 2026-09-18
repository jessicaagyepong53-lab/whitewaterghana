/* ═══════════════════════════════════════════════════════════════════
   AI ASSISTANT — chat widget with persistent history & sidebar  (v5)
   ───────────────────────────────────────────────────────────────────
   Drop-in replacement for src/assistant.js. Same include position as
   before (after script.js, so the CEO/Manager role gate can read the
   cached role before this file runs):

     <script src="../src/script.js?v=20260704u"></script>
     <script src="../src/assistant.js?v=5"></script>
     <script src="../src/conn-status.js?v=1"></script>

   WHAT'S NEW IN v5
   ─────────────────
   1. Conversation history is now fully persistent on the server (see
      server/assistant.js). Nothing is lost on refresh, logout, or a
      redeploy — a conversation only disappears if the person deletes
      it themselves from the sidebar.
   2. A collapsible sidebar (workspace mode) with New Chat, History
      grouped by recency (Today / Yesterday / Previous 7 Days /
      Previous 30 Days / Older), and Projects for grouping related
      conversations. Deleting a project keeps its conversations —
      they just move back to "General".
   3. Image generation: just ask in plain language ("draw a...",
      "generate an image of..."). The backend detects the request and
      returns a real generated image inline in the reply — no separate
      button needed. Images get their own download action.
   4. Off-topic requests get a short, friendly decline from the
      backend's topic-scope guard ("Sorry, we can't help you with
      that.") — rendered like any other reply, no special handling
      needed here, so it never feels like an error.
   5. Everything from v3 is preserved: per-message Copy/Download/Share,
      chart rendering (now also supports pie/doughnut) with PNG
      download, the persisted token-budget banner, and typed
      client-side error classification.
   ═══════════════════════════════════════════════════════════════════ */

(function () {
	'use strict';

	if (!document.body || !document.body.classList.contains('ops-page')) return;

	function normalizedRole() {
		try {
			return String(window.__wwUserRole || localStorage.getItem('ww_user_role') || '').trim().toLowerCase();
		} catch (_e) {
			return '';
		}
	}

	if (!['ceo', 'manager'].includes(normalizedRole())) {
		setTimeout(() => {
			if (['ceo', 'manager'].includes(normalizedRole()) && !document.getElementById('ww-assistant-launcher')) init();
		}, 1200);
		return;
	}

	const RENDER_API_ORIGIN = 'https://whitewaterghana.onrender.com';
	const API_BASE = (function resolveApiBase() {
		try {
			const host = window.location.hostname;
			if (host === 'localhost' || host === '127.0.0.1') return '';
			if (window.location.origin === RENDER_API_ORIGIN) return '';
			return RENDER_API_ORIGIN;
		} catch (_e) {
			return '';
		}
	})();

	const CHART_CDN_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
	const STORAGE_OPEN_KEY = 'ww_assistant_open';
	const STORAGE_EXPANDED_KEY = 'ww_assistant_expanded';
	const CHART_BLOCK_RE = /```chart\s*([\s\S]*?)```/i;
	const CHART_COLORS = ['#0077b6', '#f59e0b', '#22c55e', '#ef4444', '#8b5cf6', '#14b8a6'];
	const REQUEST_TIMEOUT_MS = 45000;
	const USAGE_POLL_MS = 60000;

	let panelOpen = false;
	let expanded = false;
	let sending = false;
	let root = null;
	let chartLoadPromise = null;
	let chartInstanceCounter = 0;
	let usagePollTimer = null;
	let budgetExceeded = false;
	let currentConversationId = null;
	let activeProjectFilter = null; // null = All
	let sidebarConversations = [];
	let sidebarProjects = [];
	const transcript = []; // { role: 'user'|'assistant'|'error', text }

	/* ─────────────────────────────────────────────────────────────
	   STYLES
	   ───────────────────────────────────────────────────────────── */

	function injectStyles() {
		if (document.getElementById('ww-assistant-styles')) return;
		const style = document.createElement('style');
		style.id = 'ww-assistant-styles';
		style.textContent = `
			#ww-assistant-launcher {
				position: fixed; right: 20px; bottom: 20px; z-index: 9997;
				width: 56px; height: 56px; border-radius: 50%; border: none;
				background: linear-gradient(135deg, #0077b6, #005f92);
				color: #fff; font-size: 1.35rem; cursor: pointer;
				box-shadow: 0 10px 26px rgba(0,89,140,0.38);
				display: flex; align-items: center; justify-content: center;
				transition: transform 0.18s ease, box-shadow 0.18s ease;
			}
			#ww-assistant-launcher:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 14px 32px rgba(0,89,140,0.46); }
			#ww-assistant-panel {
				position: fixed; right: 20px; bottom: 88px; z-index: 9998;
				width: min(430px, calc(100vw - 32px)); height: min(640px, calc(100vh - 140px));
				background: #fff; border-radius: 16px; overflow: hidden;
				box-shadow: 0 24px 60px rgba(8,54,84,0.28); border: 1px solid #d6e7f4;
				display: none; flex-direction: row;
				transition: width 0.2s ease, height 0.2s ease, right 0.2s ease, bottom 0.2s ease;
			}
			#ww-assistant-panel.ww-a-visible { display: flex; }
			#ww-assistant-panel.ww-a-expanded {
				width: min(920px, calc(100vw - 32px)); height: min(720px, calc(100vh - 60px));
				right: 20px; bottom: 20px;
			}
			.ww-a-sidebar {
				display: none; flex-direction: column; width: 230px; flex-shrink: 0;
				background: #f8fbff; border-right: 1px solid #e2eef8; overflow: hidden;
			}
			.ww-a-expanded .ww-a-sidebar { display: flex; }
			.ww-a-sidebar-head { padding: 12px; border-bottom: 1px solid #e2eef8; flex-shrink: 0; }
			.ww-a-new-chat-btn {
				width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
				padding: 8px 10px; border-radius: 9px; border: 1px solid #bfdbfe; background: #eff6ff;
				color: #0369a1; font-weight: 700; font-size: 0.82rem; cursor: pointer;
			}
			.ww-a-new-chat-btn:hover { background: #dbeafe; }
			.ww-a-sidebar-scroll { flex: 1; overflow-y: auto; padding: 8px 8px 12px; }
			.ww-a-sidebar-section { margin-bottom: 12px; }
			.ww-a-sidebar-section-head {
				display: flex; align-items: center; justify-content: space-between; gap: 6px;
				padding: 4px 6px; font-size: 0.68rem; font-weight: 800; text-transform: uppercase;
				letter-spacing: 0.05em; color: #64748b;
			}
			.ww-a-sidebar-add-btn {
				border: none; background: transparent; color: #0369a1; cursor: pointer;
				width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
				font-size: 0.78rem; border-radius: 5px;
			}
			.ww-a-sidebar-add-btn:hover { background: #dbeafe; }
			.ww-a-project-chip {
				display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 7px;
				font-size: 0.78rem; font-weight: 600; color: #334155; cursor: pointer; margin-bottom: 2px;
			}
			.ww-a-project-chip:hover { background: #eef6ff; }
			.ww-a-project-chip.ww-a-active { background: #dbeafe; color: #0c4a6e; }
			.ww-a-project-chip .ww-a-project-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.ww-a-project-del {
				border: none; background: transparent; color: #94a3b8; cursor: pointer; font-size: 0.7rem;
				width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
			}
			.ww-a-project-del:hover { color: #dc2626; }
			.ww-a-history-group-label {
				padding: 6px 6px 3px; font-size: 0.66rem; font-weight: 800; text-transform: uppercase;
				letter-spacing: 0.05em; color: #94a3b8;
			}
			.ww-a-history-row {
				position: relative; display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-radius: 7px;
				font-size: 0.79rem; color: #1e3a56; cursor: pointer; margin-bottom: 1px;
			}
			.ww-a-history-row:hover { background: #eef6ff; }
			.ww-a-history-row.ww-a-active { background: #dbeafe; font-weight: 700; }
			.ww-a-history-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.ww-a-history-menu-btn {
				border: none; background: transparent; color: #94a3b8; cursor: pointer; font-size: 0.78rem;
				width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
			}
			.ww-a-history-menu-btn:hover { color: #0369a1; }
			.ww-a-history-popover {
				position: absolute; right: 4px; top: calc(100% + 2px); z-index: 20; background: #fff;
				border: 1px solid #dbeafe; border-radius: 9px; box-shadow: 0 8px 22px rgba(8,54,84,0.16);
				min-width: 168px; padding: 5px; display: none;
			}
			.ww-a-history-popover.ww-a-open { display: block; }
			.ww-a-history-popover button, .ww-a-history-popover select {
				width: 100%; text-align: left; border: none; background: transparent; padding: 6px 7px;
				font-size: 0.78rem; color: #1e3a56; cursor: pointer; border-radius: 6px; font-family: inherit;
			}
			.ww-a-history-popover button:hover { background: #eef6ff; }
			.ww-a-history-popover .ww-a-danger { color: #dc2626; }
			.ww-a-history-popover .ww-a-danger:hover { background: #fef2f2; }
			.ww-a-history-empty { padding: 10px 6px; font-size: 0.76rem; color: #94a3b8; }
			.ww-a-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
			.ww-a-head {
				background: linear-gradient(135deg, #0077b6, #005f92); color: #fff;
				padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
				flex-shrink: 0;
			}
			.ww-a-head-title { font-size: 0.95rem; font-weight: 800; display: flex; align-items: center; gap: 8px; }
			.ww-a-head-sub { font-size: 0.72rem; opacity: 0.85; margin-top: 2px; font-weight: 500; }
			.ww-a-head-actions { display: flex; gap: 6px; }
			.ww-a-head-btn {
				background: rgba(255,255,255,0.16); border: none; color: #fff; width: 28px; height: 28px;
				border-radius: 7px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
				font-size: 0.9rem;
			}
			.ww-a-head-btn:hover { background: rgba(255,255,255,0.28); }
			.ww-a-head-btn.ww-a-active { background: rgba(255,255,255,0.34); }
			.ww-a-usage-banner {
				display: none; padding: 7px 14px; font-size: 0.74rem; font-weight: 700; text-align: center;
				border-bottom: 1px solid transparent; flex-shrink: 0;
			}
			.ww-a-usage-banner.ww-a-usage-warning { display: block; background: #fffbeb; color: #92400e; border-bottom-color: #fcd34d; }
			.ww-a-usage-banner.ww-a-usage-exceeded { display: block; background: #fef2f2; color: #991b1b; border-bottom-color: #fecaca; }
			.ww-a-body {
				flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px;
				background: #f6fafd;
			}
			.ww-a-msg-block { max-width: 90%; align-self: flex-start; display: flex; flex-direction: column; gap: 4px; }
			.ww-a-msg-block.ww-a-align-user { align-self: flex-end; align-items: flex-end; }
			.ww-a-msg { padding: 9px 12px; border-radius: 12px; font-size: 0.86rem; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
			.ww-a-msg-user { background: #0077b6; color: #fff; border-bottom-right-radius: 4px; }
			.ww-a-msg-assistant { background: #fff; color: #13324a; border: 1px solid #dbeafe; border-bottom-left-radius: 4px; }
			.ww-a-msg-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
			.ww-a-msg-actions { display: flex; gap: 4px; flex-wrap: wrap; }
			.ww-a-msg-action-btn {
				border: 1px solid #dbeafe; background: #fff; color: #0369a1; border-radius: 6px;
				padding: 3px 7px; font-size: 0.7rem; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
			}
			.ww-a-msg-action-btn:hover { background: #eff6ff; }
			.ww-a-msg-action-btn.ww-a-action-done { color: #15803d; border-color: #86efac; background: #f0fdf4; }
			.ww-a-chart-wrap {
				align-self: stretch; background: #fff; border: 1px solid #dbeafe; border-radius: 12px;
				padding: 12px 12px 6px; box-shadow: 0 4px 12px rgba(8,54,84,0.06); width: 100%;
			}
			.ww-a-chart-title { font-size: 0.8rem; font-weight: 700; color: #0a3858; margin: 0 0 8px; }
			.ww-a-chart-canvas-wrap { position: relative; height: 220px; }
			.ww-a-chart-error { font-size: 0.78rem; color: #991b1b; }
			.ww-a-image-wrap {
				align-self: flex-start; max-width: 90%; background: #fff; border: 1px solid #dbeafe; border-radius: 12px;
				padding: 8px; box-shadow: 0 4px 12px rgba(8,54,84,0.06); display: flex; flex-direction: column; gap: 6px;
			}
			.ww-a-image-wrap img { max-width: 100%; border-radius: 8px; display: block; }
			.ww-a-typing { align-self: flex-start; display: flex; gap: 4px; padding: 10px 12px; }
			.ww-a-typing span { width: 6px; height: 6px; border-radius: 50%; background: #94a3b8; animation: ww-a-bounce 1.1s infinite ease-in-out; }
			.ww-a-typing span:nth-child(2) { animation-delay: 0.15s; }
			.ww-a-typing span:nth-child(3) { animation-delay: 0.3s; }
			@keyframes ww-a-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
			.ww-a-suggestions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; flex-shrink: 0; }
			.ww-a-chip {
				border: 1px solid #bfdbfe; background: #eff6ff; color: #0369a1; border-radius: 999px;
				padding: 5px 11px; font-size: 0.76rem; font-weight: 600; cursor: pointer; white-space: nowrap;
			}
			.ww-a-chip:hover { background: #dbeafe; }
			.ww-a-inputbar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e2eef8; flex-shrink: 0; background: #fff; }
			.ww-a-input {
				flex: 1; resize: none; border: 1px solid #c8ddec; border-radius: 10px; padding: 9px 11px;
				font: inherit; font-size: 0.86rem; max-height: 84px; min-height: 38px; line-height: 1.35;
			}
			.ww-a-input:focus { outline: none; border-color: #0077b6; box-shadow: 0 0 0 3px rgba(0,119,182,0.12); }
			.ww-a-input:disabled { background: #f1f5f9; color: #94a3b8; cursor: not-allowed; }
			.ww-a-send {
				border: none; background: #0077b6; color: #fff; width: 38px; height: 38px; border-radius: 10px;
				cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 1rem;
			}
			.ww-a-send:hover { background: #005f92; }
			.ww-a-send:disabled { opacity: 0.5; cursor: not-allowed; }
			@media (max-width: 480px) {
				#ww-assistant-panel { right: 16px; left: 16px; width: auto; bottom: 82px; }
				#ww-assistant-panel.ww-a-expanded { right: 8px; left: 8px; top: 8px; bottom: 8px; height: auto; width: auto; }
				#ww-assistant-launcher { right: 16px; bottom: 16px; }
				.ww-a-sidebar { width: 180px; }
			}
		`;
		document.head.appendChild(style);
	}

	/* ─────────────────────────────────────────────────────────────
	   Chart.js loading (unchanged from v3)
	   ───────────────────────────────────────────────────────────── */

	function ensureChartJs() {
		if (window.Chart) return Promise.resolve();
		if (chartLoadPromise) return chartLoadPromise;
		chartLoadPromise = new Promise((resolve, reject) => {
			const existing = document.querySelector('script[data-ww-assistant-chartjs="1"]');
			if (existing) {
				existing.addEventListener('load', () => resolve(), { once: true });
				existing.addEventListener('error', () => reject(new Error('chart.js failed to load')), { once: true });
				return;
			}
			const script = document.createElement('script');
			script.src = CHART_CDN_URL;
			script.async = true;
			script.dataset.wwAssistantChartjs = '1';
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('chart.js failed to load'));
			document.head.appendChild(script);
		});
		return chartLoadPromise;
	}

	/* ─────────────────────────────────────────────────────────────
	   Fetch with timeout + friendly error classification
	   ───────────────────────────────────────────────────────────── */

	async function fetchJson(url, options) {
		const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
		const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
		try {
			const res = await fetch(url, { credentials: 'include', ...options, signal: controller ? controller.signal : undefined });
			let data = {};
			try { data = await res.json(); } catch (_e) { /* non-JSON error body, keep data = {} */ }
			return { ok: res.ok, status: res.status, data };
		} catch (err) {
			if (err && err.name === 'AbortError') {
				return { ok: false, status: 0, data: { message: 'The assistant is taking too long to respond. Please try again.', code: 'CLIENT_TIMEOUT' } };
			}
			return { ok: false, status: 0, data: { message: 'Could not reach the assistant. Check your connection and try again.', code: 'NETWORK_ERROR' } };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	function friendlyErrorMessage(status, data) {
		const code = data && data.code;
		if (code === 'FORBIDDEN_ROLE') return data.message || 'This assistant is only available to CEO and Manager accounts.';
		if (code === 'TOKEN_BUDGET_EXCEEDED') return data.message || 'The assistant\u2019s usage budget is fully used for now.';
		if (code === 'IMAGE_BUDGET_EXCEEDED') return data.message || 'Today\u2019s image generation limit has been reached.';
		if (code === 'RATE_LIMITED' || code === 'UPSTREAM_RATE_LIMITED') return data.message || 'Too many requests right now \u2014 please slow down a little.';
		if (code === 'NOT_CONFIGURED') return data.message || 'The assistant isn\u2019t fully set up yet \u2014 please let an admin know.';
		if (code === 'UPSTREAM_TIMEOUT' || code === 'CLIENT_TIMEOUT') return data.message || 'That took too long. Please try again.';
		if (code === 'NETWORK_ERROR') return data.message || 'Could not reach the assistant. Check your connection.';
		if (code === 'CONVERSATION_NOT_FOUND') return 'That conversation is no longer available.';
		if (status === 401) return 'Your session may have expired. Please refresh the page and sign in again.';
		return data.message || 'Something went wrong. Please try again.';
	}

	/* ─────────────────────────────────────────────────────────────
	   Usage banner (unchanged from v3, plus `period` from server)
	   ───────────────────────────────────────────────────────────── */

	function applyUsage(usage) {
		if (!root || !usage) return;
		const banner = root.querySelector('.ww-a-usage-banner');
		const input = root.querySelector('.ww-a-input');
		const sendBtn = root.querySelector('.ww-a-send');
		budgetExceeded = usage.warningLevel === 'exceeded';

		banner.classList.remove('ww-a-usage-warning', 'ww-a-usage-exceeded');
		if (usage.warningLevel === 'none') {
			banner.style.display = 'none';
			banner.textContent = '';
		} else {
			const resetLabel = formatResetTime(usage.resetAt);
			const period = usage.period || 'day';
			if (usage.warningLevel === 'warning') {
				banner.classList.add('ww-a-usage-warning');
				banner.textContent = `\u26A0\uFE0F ${usage.percentUsed}% of the ${period} assistant budget used \u2014 resets ${resetLabel}.`;
			} else {
				banner.classList.add('ww-a-usage-exceeded');
				banner.textContent = `\u26D4 Assistant budget fully used for this ${period} \u2014 resets ${resetLabel}.`;
			}
		}

		if (input) input.disabled = budgetExceeded;
		if (sendBtn) sendBtn.disabled = budgetExceeded || sending;
	}

	function formatResetTime(iso) {
		try {
			return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
		} catch (_e) {
			return 'soon';
		}
	}

	async function pollUsage() {
		const result = await fetchJson(API_BASE + '/api/assistant/usage', { method: 'GET' });
		if (result.ok && result.data && result.data.usage) applyUsage(result.data.usage);
	}

	function startUsagePolling() {
		if (usagePollTimer) return;
		pollUsage();
		usagePollTimer = setInterval(() => { if (panelOpen) pollUsage(); }, USAGE_POLL_MS);
	}

	/* ─────────────────────────────────────────────────────────────
	   Page context + suggestions (unchanged from v3)
	   ───────────────────────────────────────────────────────────── */

	function pageContextLabel() {
		return String(document.body.getAttribute('data-page') || '').trim();
	}

	function suggestionsForPage(page) {
		const byPage = {
			dashboard: ['What\u2019s our stock alert count?', 'Min/max daily sales range this month', 'Monthly performance report for the water system'],
			inventory: ['What\u2019s low on stock?', 'Which items are critical?'],
			invoices: ['Which invoices are overdue?', 'Weekly-to-monthly sales breakdown'],
			sales: ['Min/max daily sales range this month', 'Weekly-to-monthly sales breakdown', 'Why weren\u2019t sales good this month?'],
			vendors: ['Who are our top vendors by spend?', 'Any purchase orders still open?'],
			accounting: ['What are we spending the most on?', 'Full expense breakdown by category', 'Chart revenue vs expenditure, last 6 months'],
			production: ['Production summary for this month', 'Monthly performance report for the water system'],
			reports: ['Chart revenue vs expenditure, last 6 months', 'Monthly performance report for the water system'],
			users: ['Recent staff actions'],
		};
		return byPage[page] || ['Min/max daily sales range this month', 'Monthly performance report for the water system', 'Why weren\u2019t sales good this month?'];
	}

	function escapeHtml(str) {
		const d = document.createElement('div');
		d.textContent = str || '';
		return d.innerHTML;
	}

	/* ─────────────────────────────────────────────────────────────
	   Download / copy / share helpers (unchanged from v3)
	   ───────────────────────────────────────────────────────────── */

	function downloadTextFile(filename, text) {
		const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1500);
	}

	function downloadCanvasAsPng(canvas, filename) {
		try {
			const url = canvas.toDataURL('image/png');
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
		} catch (_e) { /* canvas may be tainted in rare edge cases; download button simply no-ops */ }
	}

	async function downloadImageUrl(url, filename) {
		try {
			if (url.startsWith('data:')) {
				const a = document.createElement('a');
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				a.remove();
				return;
			}
			const res = await fetch(url);
			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = objectUrl;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
		} catch (_e) { /* the image itself is still viewable inline even if download fails */ }
	}

	async function copyToClipboard(text, btn) {
		let copied = false;
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
				copied = true;
			}
		} catch (_e) { /* fall through to legacy fallback */ }
		if (!copied) {
			try {
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				copied = document.execCommand('copy');
				ta.remove();
			} catch (_e) { copied = false; }
		}
		if (btn) {
			const original = btn.innerHTML;
			btn.innerHTML = copied ? '<i class="fa-solid fa-check"></i> Copied' : '<i class="fa-solid fa-xmark"></i> Failed';
			btn.classList.toggle('ww-a-action-done', copied);
			setTimeout(() => { btn.innerHTML = original; btn.classList.remove('ww-a-action-done'); }, 1800);
		}
	}

	function timestampSlug() {
		return new Date().toISOString().replace(/[:.]/g, '-');
	}

	function buildMessageActions(text) {
		const row = document.createElement('div');
		row.className = 'ww-a-msg-actions';

		const copyBtn = document.createElement('button');
		copyBtn.type = 'button';
		copyBtn.className = 'ww-a-msg-action-btn';
		copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy';
		copyBtn.addEventListener('click', () => copyToClipboard(text, copyBtn));
		row.appendChild(copyBtn);

		const downloadBtn = document.createElement('button');
		downloadBtn.type = 'button';
		downloadBtn.className = 'ww-a-msg-action-btn';
		downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download';
		downloadBtn.addEventListener('click', () => downloadTextFile(`assistant-reply-${timestampSlug()}.txt`, text));
		row.appendChild(downloadBtn);

		if (navigator.share) {
			const shareBtn = document.createElement('button');
			shareBtn.type = 'button';
			shareBtn.className = 'ww-a-msg-action-btn';
			shareBtn.innerHTML = '<i class="fa-solid fa-share-nodes"></i> Share';
			shareBtn.addEventListener('click', async () => {
				try { await navigator.share({ title: 'Ops Assistant reply', text }); } catch (_e) { /* user cancelled share sheet \u2014 not an error */ }
			});
			row.appendChild(shareBtn);
		}

		return row;
	}

	/* ─────────────────────────────────────────────────────────────
	   Message + image + chart rendering
	   ───────────────────────────────────────────────────────────── */

	function appendTextMessage(role, text, withActions) {
		const body = root.querySelector('.ww-a-body');
		const wrap = document.createElement('div');
		wrap.className = 'ww-a-msg-block' + (role === 'user' ? ' ww-a-align-user' : '');

		const bubble = document.createElement('div');
		bubble.className = 'ww-a-msg ' + (role === 'user' ? 'ww-a-msg-user' : role === 'error' ? 'ww-a-msg-error' : 'ww-a-msg-assistant');
		bubble.textContent = text;
		wrap.appendChild(bubble);

		if (withActions && text) wrap.appendChild(buildMessageActions(text));

		body.appendChild(wrap);
		body.scrollTop = body.scrollHeight;
		transcript.push({ role, text });
		return wrap;
	}

	function appendImageMessage(imageInfo) {
		if (!imageInfo || !imageInfo.url) return;
		const body = root.querySelector('.ww-a-body');
		const wrap = document.createElement('div');
		wrap.className = 'ww-a-image-wrap';

		const img = document.createElement('img');
		img.src = imageInfo.url;
		img.alt = imageInfo.prompt || 'Generated image';
		wrap.appendChild(img);

		const actions = document.createElement('div');
		actions.className = 'ww-a-msg-actions';
		const dlBtn = document.createElement('button');
		dlBtn.type = 'button';
		dlBtn.className = 'ww-a-msg-action-btn';
		dlBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download image';
		dlBtn.addEventListener('click', () => downloadImageUrl(imageInfo.url, `assistant-image-${timestampSlug()}.png`));
		actions.appendChild(dlBtn);
		wrap.appendChild(actions);

		body.appendChild(wrap);
		body.scrollTop = body.scrollHeight;
	}

	async function renderChartBlock(spec) {
		const body = root.querySelector('.ww-a-body');
		if (!spec || !Array.isArray(spec.labels) || !Array.isArray(spec.datasets)) {
			appendTextMessage('error', 'The assistant tried to draw a chart but its data was malformed.', false);
			return;
		}

		const wrap = document.createElement('div');
		wrap.className = 'ww-a-chart-wrap';
		chartInstanceCounter += 1;
		const canvasId = 'ww-a-chart-canvas-' + chartInstanceCounter;
		const title = String(spec.title || 'Chart');
		wrap.innerHTML = `
			<p class="ww-a-chart-title">${escapeHtml(title)}</p>
			<div class="ww-a-chart-canvas-wrap"><canvas id="${canvasId}"></canvas></div>
		`;
		body.appendChild(wrap);
		body.scrollTop = body.scrollHeight;

		try {
			await ensureChartJs();
			const chartType = ['bar', 'line', 'pie', 'doughnut'].includes(spec.type) ? spec.type : 'bar';
			const isSliceChart = chartType === 'pie' || chartType === 'doughnut';
			const datasets = spec.datasets.map((ds, idx) => ({
				label: String(ds.label || `Series ${idx + 1}`),
				data: Array.isArray(ds.data) ? ds.data.map((v) => Number(v) || 0) : [],
				backgroundColor: isSliceChart ? CHART_COLORS : CHART_COLORS[idx % CHART_COLORS.length],
				borderColor: isSliceChart ? '#fff' : CHART_COLORS[idx % CHART_COLORS.length],
				borderWidth: isSliceChart ? 2 : 1,
				fill: chartType === 'line' ? false : true,
			}));
			const canvas = document.getElementById(canvasId);
			// eslint-disable-next-line no-new
			new window.Chart(canvas, {
				type: chartType,
				data: { labels: spec.labels.map(String), datasets },
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: { legend: { display: datasets.length > 1 || isSliceChart, labels: { boxWidth: 10, font: { size: 10 } } } },
					scales: isSliceChart ? {} : { y: { beginAtZero: true } },
				},
			});

			const actions = document.createElement('div');
			actions.className = 'ww-a-msg-actions';
			actions.style.marginTop = '8px';
			const dlBtn = document.createElement('button');
			dlBtn.type = 'button';
			dlBtn.className = 'ww-a-msg-action-btn';
			dlBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download chart (PNG)';
			dlBtn.addEventListener('click', () => downloadCanvasAsPng(canvas, `assistant-chart-${timestampSlug()}.png`));
			actions.appendChild(dlBtn);
			wrap.appendChild(actions);
		} catch (_e) {
			wrap.querySelector('.ww-a-chart-canvas-wrap').innerHTML = '<p class="ww-a-chart-error">Could not load the charting library to render this. You can still ask for the numbers in words.</p>';
		}
	}

	async function appendAssistantReply(rawText, imageInfo) {
		const match = CHART_BLOCK_RE.exec(rawText || '');
		const proseText = (match ? rawText.replace(match[0], '') : rawText || '').trim();

		if (proseText) appendTextMessage('assistant', proseText, true);
		else if (!match && !imageInfo) appendTextMessage('assistant', 'I don\u2019t have a response for that right now.', false);

		if (imageInfo) appendImageMessage(imageInfo);

		if (!match) return;
		let spec = null;
		try { spec = JSON.parse(match[1]); } catch (_e) { spec = null; }
		await renderChartBlock(spec);
	}

	function showTyping() {
		const body = root.querySelector('.ww-a-body');
		const el = document.createElement('div');
		el.className = 'ww-a-typing';
		el.id = 'ww-a-typing-indicator';
		el.innerHTML = '<span></span><span></span><span></span>';
		body.appendChild(el);
		body.scrollTop = body.scrollHeight;
	}

	function hideTyping() {
		const el = document.getElementById('ww-a-typing-indicator');
		if (el) el.remove();
	}

	/* ─────────────────────────────────────────────────────────────
	   Sidebar: History (grouped by recency) + Projects
	   ───────────────────────────────────────────────────────────── */

	function closeAllHistoryPopovers() {
		root.querySelectorAll('.ww-a-history-popover.ww-a-open').forEach((el) => el.classList.remove('ww-a-open'));
	}

	function recencyGroupFor(iso) {
		const ts = Date.parse(String(iso || ''));
		if (!Number.isFinite(ts)) return 'Older';
		const now = new Date();
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const dayMs = 24 * 60 * 60 * 1000;
		if (ts >= startOfToday) return 'Today';
		if (ts >= startOfToday - dayMs) return 'Yesterday';
		if (ts >= startOfToday - 7 * dayMs) return 'Previous 7 Days';
		if (ts >= startOfToday - 30 * dayMs) return 'Previous 30 Days';
		return 'Older';
	}

	function renderProjectsList() {
		const host = root.querySelector('.ww-a-projects-list');
		if (!host) return;
		const allChip = `<div class="ww-a-project-chip${activeProjectFilter === null ? ' ww-a-active' : ''}" data-project="__all__"><span class="ww-a-project-name"><i class="fa-solid fa-inbox"></i> All conversations</span></div>`;
		const projectChips = sidebarProjects.map((p) => `
			<div class="ww-a-project-chip${activeProjectFilter === p.id ? ' ww-a-active' : ''}" data-project="${escapeHtml(p.id)}">
				<span class="ww-a-project-name"><i class="fa-regular fa-folder"></i> ${escapeHtml(p.name)}</span>
				<button type="button" class="ww-a-project-del" data-project-del="${escapeHtml(p.id)}" title="Delete project"><i class="fa-solid fa-xmark"></i></button>
			</div>
		`).join('');
		host.innerHTML = allChip + projectChips;

		host.querySelectorAll('.ww-a-project-chip').forEach((chip) => {
			chip.addEventListener('click', (e) => {
				if (e.target.closest('.ww-a-project-del')) return;
				const projectId = chip.getAttribute('data-project');
				activeProjectFilter = projectId === '__all__' ? null : projectId;
				renderProjectsList();
				renderHistoryList();
			});
		});
		host.querySelectorAll('.ww-a-project-del').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				e.stopPropagation();
				const projectId = btn.getAttribute('data-project-del');
				if (!window.confirm('Delete this project? Its conversations will move back to General.')) return;
				const result = await fetchJson(API_BASE + '/api/assistant/projects/' + encodeURIComponent(projectId), { method: 'DELETE' });
				if (result.ok) {
					if (activeProjectFilter === projectId) activeProjectFilter = null;
					await refreshSidebar();
				}
			});
		});
	}

	function renderHistoryList() {
		const host = root.querySelector('.ww-a-history-list');
		if (!host) return;

		const filtered = activeProjectFilter === null
			? sidebarConversations
			: sidebarConversations.filter((c) => c.projectId === activeProjectFilter);

		if (!filtered.length) {
			host.innerHTML = '<div class="ww-a-history-empty">No conversations yet.</div>';
			return;
		}

		const groups = { Today: [], Yesterday: [], 'Previous 7 Days': [], 'Previous 30 Days': [], Older: [] };
		filtered.forEach((c) => { groups[recencyGroupFor(c.updatedAt)].push(c); });

		let html = '';
		Object.keys(groups).forEach((label) => {
			if (!groups[label].length) return;
			html += `<div class="ww-a-history-group-label">${escapeHtml(label)}</div>`;
			groups[label].forEach((c) => {
				html += `
					<div class="ww-a-history-row${c.id === currentConversationId ? ' ww-a-active' : ''}" data-conv-id="${escapeHtml(c.id)}">
						<span class="ww-a-history-title">${escapeHtml(c.title || 'New conversation')}</span>
						<button type="button" class="ww-a-history-menu-btn" data-conv-menu="${escapeHtml(c.id)}" title="Options"><i class="fa-solid fa-ellipsis-vertical"></i></button>
						<div class="ww-a-history-popover" data-conv-popover="${escapeHtml(c.id)}">
							<button type="button" data-conv-rename="${escapeHtml(c.id)}"><i class="fa-solid fa-pen"></i> Rename</button>
							<select data-conv-move="${escapeHtml(c.id)}">
								<option value="">Move to project\u2026</option>
								<option value="__none__">General</option>
								${sidebarProjects.map((p) => `<option value="${escapeHtml(p.id)}"${c.projectId === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
							</select>
							<button type="button" class="ww-a-danger" data-conv-delete="${escapeHtml(c.id)}"><i class="fa-solid fa-trash"></i> Delete</button>
						</div>
					</div>
				`;
			});
		});
		host.innerHTML = html;

		host.querySelectorAll('.ww-a-history-row').forEach((row) => {
			row.addEventListener('click', (e) => {
				if (e.target.closest('.ww-a-history-menu-btn') || e.target.closest('.ww-a-history-popover')) return;
				loadConversation(row.getAttribute('data-conv-id'));
			});
		});
		host.querySelectorAll('[data-conv-menu]').forEach((btn) => {
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				const id = btn.getAttribute('data-conv-menu');
				const pop = host.querySelector(`.ww-a-history-popover[data-conv-popover="${CSS.escape(id)}"]`);
				const wasOpen = pop && pop.classList.contains('ww-a-open');
				closeAllHistoryPopovers();
				if (pop && !wasOpen) pop.classList.add('ww-a-open');
			});
		});
		host.querySelectorAll('[data-conv-rename]').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				e.stopPropagation();
				closeAllHistoryPopovers();
				const id = btn.getAttribute('data-conv-rename');
				const existing = sidebarConversations.find((c) => c.id === id);
				const nextTitle = window.prompt('Rename conversation', existing ? existing.title : '');
				if (!nextTitle || !nextTitle.trim()) return;
				const result = await fetchJson(API_BASE + '/api/assistant/conversations/' + encodeURIComponent(id), {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ title: nextTitle.trim() }),
				});
				if (result.ok) await refreshSidebar();
			});
		});
		host.querySelectorAll('[data-conv-move]').forEach((select) => {
			select.addEventListener('click', (e) => e.stopPropagation());
			select.addEventListener('change', async () => {
				const id = select.getAttribute('data-conv-move');
				const value = select.value;
				if (!value) return;
				closeAllHistoryPopovers();
				const projectId = value === '__none__' ? null : value;
				const result = await fetchJson(API_BASE + '/api/assistant/conversations/' + encodeURIComponent(id), {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ projectId }),
				});
				if (result.ok) await refreshSidebar();
			});
		});
		host.querySelectorAll('[data-conv-delete]').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				e.stopPropagation();
				closeAllHistoryPopovers();
				const id = btn.getAttribute('data-conv-delete');
				if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
				const result = await fetchJson(API_BASE + '/api/assistant/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
				if (result.ok) {
					if (id === currentConversationId) startNewChat(false);
					await refreshSidebar();
				}
			});
		});
	}

	async function refreshSidebar() {
		const result = await fetchJson(API_BASE + '/api/assistant/conversations', { method: 'GET' });
		if (!result.ok) return;
		sidebarConversations = Array.isArray(result.data.conversations) ? result.data.conversations : [];
		sidebarProjects = Array.isArray(result.data.projects) ? result.data.projects : [];
		renderProjectsList();
		renderHistoryList();
	}

	async function loadConversation(id) {
		if (!id || id === currentConversationId) return;
		const result = await fetchJson(API_BASE + '/api/assistant/conversations/' + encodeURIComponent(id), { method: 'GET' });
		if (!result.ok || !result.data || !result.data.conversation) {
			appendTextMessage('error', friendlyErrorMessage(result.status, result.data), false);
			return;
		}
		const conv = result.data.conversation;
		currentConversationId = conv.id;
		transcript.length = 0;
		const body = root.querySelector('.ww-a-body');
		body.innerHTML = '';
		(conv.messages || []).forEach((m) => {
			if (m.role === 'user') {
				appendTextMessage('user', m.content, false);
			} else {
				appendAssistantReply(m.content || '', m.image || null);
			}
		});
		renderHistoryList();
	}

	function startNewChat(refreshList) {
		currentConversationId = null;
		transcript.length = 0;
		root.querySelector('.ww-a-body').innerHTML = '';
		renderWelcome();
		if (refreshList !== false) renderHistoryList();
	}

	async function createProject() {
		const name = window.prompt('New project name');
		if (!name || !name.trim()) return;
		const result = await fetchJson(API_BASE + '/api/assistant/projects', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: name.trim() }),
		});
		if (result.ok) await refreshSidebar();
	}

	/* ─────────────────────────────────────────────────────────────
	   Sending a message
	   ───────────────────────────────────────────────────────────── */

	async function sendMessage(text) {
		const trimmed = String(text || '').trim();
		if (!trimmed || sending || budgetExceeded) return;
		sending = true;
		const input = root.querySelector('.ww-a-input');
		const sendBtn = root.querySelector('.ww-a-send');
		if (sendBtn) sendBtn.disabled = true;

		appendTextMessage('user', trimmed, false);
		if (input) { input.value = ''; input.style.height = 'auto'; }
		showTyping();

		const result = await fetchJson(API_BASE + '/api/assistant/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: trimmed,
				page: pageContextLabel(),
				conversationId: currentConversationId || undefined,
			}),
		});

		hideTyping();

		if (!result.ok) {
			appendTextMessage('error', friendlyErrorMessage(result.status, result.data), false);
			if (result.data && result.data.usage) applyUsage(result.data.usage);
		} else {
			currentConversationId = result.data.conversationId || currentConversationId;
			await appendAssistantReply(result.data.reply || '', result.data.image || null);
			if (result.data.usage) applyUsage(result.data.usage);
			refreshSidebar();
		}

		sending = false;
		if (sendBtn) sendBtn.disabled = budgetExceeded;
		if (input && !budgetExceeded) input.focus();
	}

	/* ─────────────────────────────────────────────────────────────
	   Panel lifecycle
	   ───────────────────────────────────────────────────────────── */

	function togglePanel(forceOpen) {
		panelOpen = typeof forceOpen === 'boolean' ? forceOpen : !panelOpen;
		const panel = document.getElementById('ww-assistant-panel');
		if (panel) panel.classList.toggle('ww-a-visible', panelOpen);
		try { sessionStorage.setItem(STORAGE_OPEN_KEY, panelOpen ? '1' : '0'); } catch (_e) { /* ignore */ }
		if (panelOpen) {
			startUsagePolling();
			refreshSidebar();
			const input = panel && panel.querySelector('.ww-a-input');
			if (input && !budgetExceeded) setTimeout(() => input.focus(), 80);
		}
	}

	function toggleExpanded(forceValue) {
		expanded = typeof forceValue === 'boolean' ? forceValue : !expanded;
		const panel = document.getElementById('ww-assistant-panel');
		if (panel) panel.classList.toggle('ww-a-expanded', expanded);
		const btn = root && root.querySelector('#ww-a-expand-btn');
		if (btn) {
			btn.classList.toggle('ww-a-active', expanded);
			btn.innerHTML = expanded ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
			btn.title = expanded ? 'Collapse workspace' : 'Expand workspace';
		}
		try { sessionStorage.setItem(STORAGE_EXPANDED_KEY, expanded ? '1' : '0'); } catch (_e) { /* ignore */ }
		if (expanded) refreshSidebar();
	}

	function renderWelcome() {
		appendTextMessage('assistant', 'Hi! I can answer questions across the whole system \u2014 sales, inventory, accounting, production, equipment \u2014 build charts, and generate images on request. What would you like to know?', false);
	}

	function renderSuggestions() {
		const wrap = root.querySelector('.ww-a-suggestions');
		const chips = suggestionsForPage(pageContextLabel());
		wrap.innerHTML = chips.map((c) => `<button type="button" class="ww-a-chip">${escapeHtml(c)}</button>`).join('');
		wrap.querySelectorAll('.ww-a-chip').forEach((btn) => {
			btn.addEventListener('click', () => sendMessage(btn.textContent));
		});
	}

	function exportConversation() {
		if (!transcript.length) return;
		const lines = transcript.map((m) => `${m.role === 'user' ? 'You' : m.role === 'error' ? 'Error' : 'Assistant'}: ${m.text}`);
		downloadTextFile(`assistant-conversation-${timestampSlug()}.txt`, lines.join('\n\n'));
	}

	function buildWidget() {
		injectStyles();

		const launcher = document.createElement('button');
		launcher.id = 'ww-assistant-launcher';
		launcher.type = 'button';
		launcher.title = 'Ask the assistant';
		launcher.innerHTML = '<i class="fa-solid fa-robot"></i>';
		launcher.addEventListener('click', () => togglePanel());
		document.body.appendChild(launcher);

		const panel = document.createElement('div');
		panel.id = 'ww-assistant-panel';
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', 'AI Assistant');
		panel.innerHTML = `
			<aside class="ww-a-sidebar">
				<div class="ww-a-sidebar-head">
					<button type="button" class="ww-a-new-chat-btn" id="ww-a-new-chat-btn"><i class="fa-solid fa-plus"></i> New Chat</button>
				</div>
				<div class="ww-a-sidebar-scroll">
					<div class="ww-a-sidebar-section">
						<div class="ww-a-sidebar-section-head">
							<span>Projects</span>
							<button type="button" class="ww-a-sidebar-add-btn" id="ww-a-add-project-btn" title="New project"><i class="fa-solid fa-plus"></i></button>
						</div>
						<div class="ww-a-projects-list"></div>
					</div>
					<div class="ww-a-sidebar-section">
						<div class="ww-a-sidebar-section-head"><span>History</span></div>
						<div class="ww-a-history-list"></div>
					</div>
				</div>
			</aside>
			<div class="ww-a-main">
				<div class="ww-a-head">
					<div>
						<div class="ww-a-head-title"><i class="fa-solid fa-robot"></i> Ops Assistant</div>
						<div class="ww-a-head-sub">CEO/Manager \u00b7 grounded in your live data</div>
					</div>
					<div class="ww-a-head-actions">
						<button type="button" class="ww-a-head-btn" id="ww-a-expand-btn" title="Expand workspace"><i class="fa-solid fa-expand"></i></button>
						<button type="button" class="ww-a-head-btn" id="ww-a-export-btn" title="Download this conversation"><i class="fa-solid fa-file-arrow-down"></i></button>
						<button type="button" class="ww-a-head-btn" id="ww-a-close-btn" title="Close"><i class="fa-solid fa-xmark"></i></button>
					</div>
				</div>
				<div class="ww-a-usage-banner"></div>
				<div class="ww-a-body"></div>
				<div class="ww-a-suggestions"></div>
				<div class="ww-a-inputbar">
					<textarea class="ww-a-input" rows="1" placeholder="Ask about sales, stock, accounting, charts, or ask for an image..."></textarea>
					<button type="button" class="ww-a-send" title="Send"><i class="fa-solid fa-paper-plane"></i></button>
				</div>
			</div>
		`;
		document.body.appendChild(panel);
		root = panel;

		panel.querySelector('#ww-a-close-btn').addEventListener('click', () => togglePanel(false));
		panel.querySelector('#ww-a-export-btn').addEventListener('click', exportConversation);
		panel.querySelector('#ww-a-expand-btn').addEventListener('click', () => toggleExpanded());
		panel.querySelector('#ww-a-new-chat-btn').addEventListener('click', () => startNewChat());
		panel.querySelector('#ww-a-add-project-btn').addEventListener('click', createProject);

		document.addEventListener('click', (e) => {
			if (!e.target.closest('.ww-a-history-menu-btn') && !e.target.closest('.ww-a-history-popover')) {
				closeAllHistoryPopovers();
			}
		});

		const input = panel.querySelector('.ww-a-input');
		input.addEventListener('input', () => {
			input.style.height = 'auto';
			input.style.height = Math.min(84, input.scrollHeight) + 'px';
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input.value); }
		});
		panel.querySelector('.ww-a-send').addEventListener('click', () => sendMessage(input.value));

		renderSuggestions();
		renderWelcome();

		try {
			if (sessionStorage.getItem(STORAGE_EXPANDED_KEY) === '1') toggleExpanded(true);
		} catch (_e) { /* ignore */ }
		try {
			if (sessionStorage.getItem(STORAGE_OPEN_KEY) === '1') togglePanel(true);
		} catch (_e) { /* ignore */ }
	}

	function init() {
		if (document.getElementById('ww-assistant-launcher')) return;
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', buildWidget);
		} else {
			buildWidget();
		}
	}

	init();
})();