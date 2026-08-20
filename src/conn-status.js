/* ═══════════════════════════════════════════════════════════════════
   CONNECTION STATUS BANNER
   ───────────────────────────────────────────────────────────────────
   Watches the real-time sync transport already set up in script.js
   (Socket.IO → SSE → 15s poll) and surfaces a small, unobtrusive
   banner when the app is NOT on the fastest transport, so staff
   understand why a change from another device hasn't shown up yet
   instead of assuming the app is broken or their entry was lost.

   INTEGRATION
   ───────────
   1. Save this file as: src/conn-status.js
   2. Add it to every ops page AFTER script.js, e.g. in dashboard.html
      (and any other pages/*.html you want it on):

        <script src="../src/script.js?v=20260704u"></script>
        <script src="../src/conn-status.js?v=1"></script>

   3. Add the CSS block at the bottom of this file to src/script.css.

   This module does not modify script.js. It reads the same global
   state script.js already maintains (window.__wwSocket,
   window.__wwSocketConnected, window.__wwSseSource) and polls it,
   so it stays in sync with whatever transport is currently active
   without duplicating connection logic.
   ═══════════════════════════════════════════════════════════════════ */

(function () {
	'use strict';

	// Only run on internal ops pages (guarded by the same body class script.js uses).
	if (!document.body || !document.body.classList.contains('ops-page')) return;

	const CHECK_INTERVAL_MS = 4000;
	const DEGRADED_GRACE_MS = 8000; // avoid flashing the banner during normal reconnect blips
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

	function detectTransportState() {
		if (!navigator.onLine) return STATE.offline;

		const socketConnected = !!window.__wwSocketConnected;
		const sseOpen = !!(window.__wwSseSource && window.__wwSseSource.readyState === 1 /* OPEN */);

		if (socketConnected || sseOpen) return STATE.ok;

		// Neither Socket.IO nor SSE is currently connected — the app has
		// fallen back to (or is waiting to fall back to) periodic polling.
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
				window.pullRemoteDataAndRefreshUi().catch(() => {});
			}
		} catch (_e) { /* ignore */ }
		// Re-evaluate shortly after to update the banner text.
		setTimeout(evaluate, 1500);
	}

	function evaluate() {
		const detected = detectTransportState();
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
			setBannerState(STATE.degraded, 'Live sync is running slower than usual (checking every 15s). Your changes are still saved.');
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

/* CSS for this banner now lives in src/script.css (already appended). */