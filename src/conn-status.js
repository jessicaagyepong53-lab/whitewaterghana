/* ═══════════════════════════════════════════════════════════════════
   CONNECTION STATUS BANNER
   ───────────────────────────────────────────────────────────────────
   Surfaces a small, unobtrusive banner when the app hasn't actually
   pulled fresh data from the server recently, so staff understand why
   a change from another device hasn't shown up yet instead of assuming
   the app is broken or their entry was lost.

   WHY THIS CHECKS SYNC FRESHNESS, NOT TRANSPORT STATE
   ────────────────────────────────────────────────────
   script.js wires up Socket.IO and SSE for instant cross-device push,
   falling back to a periodic poll. On serverless hosting (this app is
   deployed on Vercel) neither push channel can be trusted as a signal
   of health:
     - Socket.IO never actually connects there — the serverless
       entrypoint invokes the plain Express app, not the http.Server
       instance Socket.IO is attached to.
     - An SSE connection genuinely opens (readyState reports OPEN) but
       the list of "who's listening" lives in that one serverless
       instance's memory. A write handled by a different instance has
       no way to reach it, so the connection can look perfectly healthy
       while silently delivering nothing.
   Checking window.__wwLastSyncMs — a timestamp script.js updates every
   time it actually finishes pulling fresh data (via poll, tab refocus,
   or a lucky same-instance push) — reports what actually matters: is
   the data on screen current, not whether a particular transport
   object exists.

   INTEGRATION
   ───────────
   1. Save this file as: src/conn-status.js
   2. Add it to every ops page AFTER script.js, e.g. in dashboard.html
      (and any other pages/*.html you want it on):

        <script src="../src/script.js?v=20260704u"></script>
        <script src="../src/conn-status.js?v=1"></script>

   3. The CSS for this banner lives in src/script.css (already appended).
   ═══════════════════════════════════════════════════════════════════ */

(function () {
	'use strict';

	// Only run on internal ops pages (guarded by the same body class script.js uses).
	if (!document.body || !document.body.classList.contains('ops-page')) return;

	const CHECK_INTERVAL_MS = 4000;
	// The realtime poller in script.js runs every 8s. Anything within ~2.5x
	// that window is "on schedule"; past that, something is actually stuck
	// (tab was hidden, a request failed repeatedly, etc.) and worth surfacing.
	const STALE_THRESHOLD_MS = 20000;
	const DEGRADED_GRACE_MS = 6000; // avoid flashing the banner during normal reconnect blips
	const STATE = { ok: 'ok', degraded: 'degraded', offline: 'offline' };

	let banner = null;
	let currentState = STATE.ok;
	let degradedSinceMs = null;

	function ensureBanner() {
		if (banner) return banner;
		banner = document.createElement('div');
		banner.id = 'ww-conn-banner';
		banner.setAttribute('role', 'status');
		banner.setAttribute('aria-live', 'polite');
		banner.innerHTML = `
			<span class="ww-conn-dot"></span>
			<span class="ww-conn-text"></span>
			<button type="button" class="ww-conn-retry" title="Retry connection now">
				<i class="fa-solid fa-arrows-rotate"></i>
			</button>
		`;
		banner.querySelector('.ww-conn-retry').addEventListener('click', () => {
			retryNow();
		});
		document.body.appendChild(banner);
		return banner;
	}

	function setBannerState(state, text) {
		const el = ensureBanner();
		el.classList.remove('ww-conn-ok', 'ww-conn-degraded', 'ww-conn-offline', 'ww-conn-visible');
		if (state === STATE.ok) {
			// Hide entirely when healthy — no need to remind people things are fine.
			return;
		}
		el.classList.add('ww-conn-visible');
		el.classList.add(state === STATE.offline ? 'ww-conn-offline' : 'ww-conn-degraded');
		el.querySelector('.ww-conn-text').textContent = text;
	}

	function detectSyncState() {
		if (!navigator.onLine) return STATE.offline;

		const lastSyncMs = Number(window.__wwLastSyncMs || 0);
		if (!lastSyncMs) {
			// Page just loaded and hasn't completed its first sync yet — that's
			// normal for the first couple of seconds, not a fault.
			return STATE.ok;
		}

		const ageMs = Date.now() - lastSyncMs;
		if (ageMs <= STALE_THRESHOLD_MS) return STATE.ok;
		return STATE.degraded;
	}

	function retryNow() {
		const text = document.querySelector('#ww-conn-banner .ww-conn-text');
		if (text) text.textContent = 'Reconnecting…';
		try {
			if (window.__wwSocket && typeof window.__wwSocket.connect === 'function') {
				window.__wwSocket.connect();
			}
		} catch (_e) { /* ignore */ }
		// A full data pull mirrors what script.js already does on focus/visibility change.
		try {
			if (typeof window.pullRemoteDataAndRefreshUi === 'function') {
				window.pullRemoteDataAndRefreshUi().then(() => {
					if (typeof document !== 'undefined') document.dispatchEvent(new Event('ww-refresh-page'));
				}).catch(() => {});
			}
		} catch (_e) { /* ignore */ }
		// Re-evaluate shortly after to update the banner text.
		setTimeout(evaluate, 1500);
	}

	function evaluate() {
		const detected = detectSyncState();
		const now = Date.now();

		if (detected === STATE.ok) {
			degradedSinceMs = null;
			if (currentState !== STATE.ok) {
				currentState = STATE.ok;
				setBannerState(STATE.ok, '');
			}
			return;
		}

		if (degradedSinceMs === null) degradedSinceMs = now;

		// Don't flash the banner for brief reconnect blips — only surface it
		// once the degraded/offline state has persisted past the grace window.
		if (now - degradedSinceMs < DEGRADED_GRACE_MS) return;

		currentState = detected;
		if (detected === STATE.offline) {
			setBannerState(STATE.offline, 'No internet connection. Your changes are saved locally and will sync once you\u2019re back online.');
		} else {
			setBannerState(STATE.degraded, 'Sync is behind — tap to refresh now. Changes from other devices may take a moment to appear.');
		}
	}

	window.addEventListener('online', evaluate);
	window.addEventListener('offline', evaluate);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) evaluate();
	});

	evaluate();
	setInterval(evaluate, CHECK_INTERVAL_MS);
})();

/* CSS for this banner lives in src/script.css (already appended). */