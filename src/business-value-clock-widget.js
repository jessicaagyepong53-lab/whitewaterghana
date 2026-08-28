/* ═══════════════════════════════════════════════════════════════════
   BUSINESS VALUE CLOCK — drop-in widget
   ───────────────────────────────────────────────────────────────────
   Renders a small clickable clock card that matches the rest of the
   app's look (white cards, blue accent, same fonts). Clicking it opens
   the full interactive Business Value Clock — built from real sales
   and accounting data — in a modal with Close and Print controls.

   USAGE — on any page inside /pages/:
     1) Add a mount point near the top of the page:
          <div id="bvc-widget"></div>
     2) Include this script after script.js:
          <script src="../src/business-value-clock-widget.js"></script>

   The widget auto-initializes on DOMContentLoaded if #bvc-widget exists.
   To mount into a different element id, call:
          initBvcWidget('my-custom-id');
   ═══════════════════════════════════════════════════════════════════ */
(function () {
	'use strict';

	var STYLE_ID = 'bvc-widget-styles';
	var TARGET_PAGE = 'business-value-clock.html';

	function ensureStyles() {
		if (document.getElementById(STYLE_ID)) return;
		var style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = [
			'.bvc-widget-btn{display:flex;align-items:center;gap:12px;width:100%;',
			'background:#fff;border:1px solid #cde3f3;border-radius:14px;',
			'padding:13px 16px;cursor:pointer;color:#13324a;font-family:inherit;',
			'text-align:left;box-shadow:0 6px 18px rgba(8,54,84,0.07);',
			'transition:transform .15s ease, box-shadow .15s ease;}',
			'.bvc-widget-btn:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(8,54,84,0.13);}',
			'.bvc-widget-btn:focus-visible{outline:2px solid #0077b6;outline-offset:2px;}',
			'.bvc-mini-dial{width:42px;height:42px;flex-shrink:0;}',
			'.bvc-widget-text{min-width:0;flex:1;}',
			'.bvc-widget-label{display:block;font-weight:700;font-size:0.92rem;color:#0a3858;}',
			'.bvc-widget-sub{display:block;font-size:0.78rem;color:#587289;margin-top:2px;}',
			'.bvc-widget-arrow{margin-left:8px;color:#0077b6;flex-shrink:0;font-size:0.85rem;}',
			'.bvc-modal-overlay{position:fixed;inset:0;background:rgba(10,30,45,0.55);z-index:5000;',
			'display:flex;align-items:center;justify-content:center;padding:20px;',
			'opacity:0;pointer-events:none;transition:opacity .18s ease;}',
			'.bvc-modal-overlay.open{opacity:1;pointer-events:auto;}',
			'.bvc-modal{background:#f4f9fd;border-radius:18px;width:min(1200px,96vw);',
			'height:min(92vh,900px);position:relative;overflow:hidden;',
			'box-shadow:0 30px 80px rgba(0,0,0,0.35);transform:translateY(12px);',
			'transition:transform .18s ease;display:flex;flex-direction:column;}',
			'.bvc-modal-overlay.open .bvc-modal{transform:translateY(0);}',
			'.bvc-modal-bar{display:flex;align-items:center;justify-content:flex-end;gap:8px;',
			'padding:10px 12px;background:#fff;border-bottom:1px solid #cde3f3;flex-shrink:0;}',
			'.bvc-modal-bar-btn{display:inline-flex;align-items:center;gap:6px;',
			'border:1px solid #cde3f3;background:#fff;color:#0a3858;font:inherit;',
			'font-size:0.82rem;font-weight:600;padding:7px 13px;border-radius:8px;cursor:pointer;}',
			'.bvc-modal-bar-btn:hover{background:#f0f7ff;}',
			'.bvc-modal-bar-btn.primary{background:#0077b6;border-color:#0077b6;color:#fff;}',
			'.bvc-modal-bar-btn.primary:hover{background:#005f92;}',
			'.bvc-modal-close{width:34px;height:34px;border-radius:50%;border:1px solid #cde3f3;',
			'background:#fff;color:#0a3858;font-size:1.2rem;line-height:1;cursor:pointer;',
			'display:inline-flex;align-items:center;justify-content:center;}',
			'.bvc-modal-close:hover{background:#fee2e2;border-color:#fca5a5;color:#b91c1c;}',
			'.bvc-modal-body{position:relative;flex:1;min-height:0;}',
			'.bvc-modal-body iframe{width:100%;height:100%;border:none;display:block;}',
			'.bvc-modal-loading{position:absolute;inset:0;display:flex;align-items:center;',
			'justify-content:center;color:#587289;font-family:inherit;font-size:0.85rem;',
			'background:#f4f9fd;}',
			'@media (max-width:640px){.bvc-modal-bar-btn span{display:none;}}',
		].join('');
		document.head.appendChild(style);
	}

	function miniDialSvg() {
		return '<svg viewBox="0 0 100 100" class="bvc-mini-dial" aria-hidden="true">' +
			'<circle cx="50" cy="50" r="46" fill="#f0f7ff" stroke="#0077b6" stroke-width="2"/>' +
			'<circle cx="50" cy="50" r="34" fill="none" stroke="#cde3f3" stroke-width="1" stroke-dasharray="2 5"/>' +
			'<line x1="50" y1="50" x2="50" y2="20" stroke="#0a3858" stroke-width="2.5" stroke-linecap="round"/>' +
			'<line x1="50" y1="50" x2="68" y2="58" stroke="#16a34a" stroke-width="2" stroke-linecap="round"/>' +
			'<circle cx="50" cy="50" r="3" fill="#0077b6"/>' +
			'</svg>';
	}

	function openBvcModal() {
		closeBvcModal(); // guard against double-open
		var overlay = document.createElement('div');
		overlay.className = 'bvc-modal-overlay';
		overlay.id = 'bvc-modal-overlay';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-label', 'Business Value Clock');
		overlay.innerHTML =
			'<div class="bvc-modal">' +
			'<div class="bvc-modal-bar">' +
			'<button type="button" class="bvc-modal-bar-btn primary" id="bvc-modal-print" title="Print this view">' +
			'<i class="fa-solid fa-print" aria-hidden="true"></i><span>Print</span></button>' +
			'<button type="button" class="bvc-modal-close" id="bvc-modal-close" aria-label="Close">&times;</button>' +
			'</div>' +
			'<div class="bvc-modal-body">' +
			'<div class="bvc-modal-loading" id="bvc-modal-loading">Loading the clock…</div>' +
			'<iframe src="' + TARGET_PAGE + '" title="Business Value Clock" id="bvc-modal-iframe"></iframe>' +
			'</div>' +
			'</div>';
		document.body.appendChild(overlay);
		requestAnimationFrame(function () { overlay.classList.add('open'); });

		var iframe = document.getElementById('bvc-modal-iframe');
		var loading = document.getElementById('bvc-modal-loading');
		if (iframe && loading) {
			iframe.addEventListener('load', function () { loading.style.display = 'none'; }, { once: true });
		}

		overlay.addEventListener('click', function (e) {
			if (e.target === overlay) closeBvcModal();
		});
		document.getElementById('bvc-modal-close').addEventListener('click', closeBvcModal);
		document.getElementById('bvc-modal-print').addEventListener('click', function () {
			try {
				var win = document.getElementById('bvc-modal-iframe').contentWindow;
				win.focus();
				win.print();
			} catch (_e) {
				window.open(TARGET_PAGE, '_blank');
			}
		});
		document.addEventListener('keydown', onEscClose);
	}

	function onEscClose(e) {
		if (e.key === 'Escape') closeBvcModal();
	}

	function closeBvcModal() {
		var overlay = document.getElementById('bvc-modal-overlay');
		if (!overlay) return;
		overlay.classList.remove('open');
		document.removeEventListener('keydown', onEscClose);
		setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 180);
	}

	function initBvcWidget(containerId) {
		var container = document.getElementById(containerId || 'bvc-widget');
		if (!container) return;
		ensureStyles();
		container.innerHTML =
			'<button type="button" class="bvc-widget-btn" id="bvc-widget-btn" aria-haspopup="dialog">' +
			miniDialSvg() +
			'<span class="bvc-widget-text">' +
			'<span class="bvc-widget-label">Business Value Clock</span>' +
			'<span class="bvc-widget-sub">Tap to see growth projections &amp; seasonal demand, from your own numbers</span>' +
			'</span>' +
			'<i class="fa-solid fa-arrow-up-right-from-square bvc-widget-arrow" aria-hidden="true"></i>' +
			'</button>';
		var btn = document.getElementById('bvc-widget-btn');
		if (btn) btn.addEventListener('click', openBvcModal);
	}

	window.initBvcWidget = initBvcWidget;
	window.openBusinessValueClock = openBvcModal;

	document.addEventListener('DOMContentLoaded', function () {
		if (document.getElementById('bvc-widget')) initBvcWidget('bvc-widget');
	});
})();