/* ═══════════════════════════════════════════════════════════════════
   FULL-SCREEN "EXPAND" BUTTON  (src/fullscreen-toggle.js)
   ───────────────────────────────────────────────────────────────────
   Adds an Expand / Exit full screen button to a reading window.

   - Desktop and tablet: uses the browser's real full-screen mode, so the
     address bar, taskbar and everything else disappear.
   - iPhone and any browser that blocks real full screen: the window
     simply fills the whole screen instead.
   - Esc (or the button again) exits full screen first. A second Esc then
     closes the window as usual.
   - If the window is closed while expanded, full screen is switched off.

   It installs itself on the Record Vault viewer automatically. For other
   windows (e.g. the quarterly report reader) call:

       WWFullscreen.attach(overlayElement, containerForButton, insertBeforeElement)

   where overlayElement is the element that should fill the screen.
   Load this file AFTER script.js:
       <script src="../src/fullscreen-toggle.js?v=1"></script>
   ═══════════════════════════════════════════════════════════════════ */
(function () {
	'use strict';
	if (window.WWFullscreen) return;

	var ON = 'ww-fs-on';
	var registry = []; // { el, btn }

	function injectStyle() {
		if (document.getElementById('ww-fs-style')) return;
		var css = [
			'.ww-fs-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:44px;padding:0 14px;border:1px solid #bfdbfe;border-radius:8px;background:#eff6ff;color:#1d4ed8;font:inherit;font-size:.85rem;font-weight:700;cursor:pointer;flex-shrink:0;line-height:1}',
			'.ww-fs-btn:hover{background:#dbeafe}',
			'.ww-fs-btn:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}',
			'@media (max-width:640px){.ww-fs-word{display:none}.ww-fs-btn{padding:0 12px}}',
			/* Record Vault viewer: fill the whole screen when expanded */
			'.rv-viewer-overlay.' + ON + '{padding:0!important;background:#0f172a;z-index:2147483000}',
			'.rv-viewer-overlay.' + ON + ' .rv-viewer-modal{width:100vw!important;height:100%!important;max-height:none!important;border-radius:0!important}',
			'@supports (height:100dvh){.rv-viewer-overlay.' + ON + ' .rv-viewer-modal{height:100dvh!important}}'
		].join('\n');
		var style = document.createElement('style');
		style.id = 'ww-fs-style';
		style.textContent = css;
		document.head.appendChild(style);
	}

	function nativeEl() {
		return document.fullscreenElement || document.webkitFullscreenElement || null;
	}

	function nativeSupported() {
		return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
	}

	function isOn(el) {
		return !!el && (el.classList.contains(ON) || nativeEl() === el);
	}

	function refresh() {
		registry.forEach(function (r) {
			var on = r.el.classList.contains(ON);
			r.btn.innerHTML = on
				? '<i class="fa-solid fa-compress"></i><span class="ww-fs-word">Exit full screen</span>'
				: '<i class="fa-solid fa-expand"></i><span class="ww-fs-word">Expand</span>';
			r.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
			r.btn.title = on ? 'Exit full screen' : 'Expand to full screen';
			r.btn.setAttribute('aria-label', r.btn.title);
		});
	}

	function nudgeLayout() {
		// Lets pages (e.g. the PDF viewer) re-fit themselves to the new size.
		setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (_e) { /* ignore */ } }, 80);
	}

	function enter(el) {
		el.classList.add(ON);
		var req = el.requestFullscreen || el.webkitRequestFullscreen;
		if (req && nativeSupported()) {
			try {
				var p = req.call(el);
				if (p && typeof p.catch === 'function') p.catch(function () { /* class fallback still fills the screen */ });
			} catch (_e) { /* class fallback still fills the screen */ }
		}
		refresh();
		nudgeLayout();
	}

	function exit(el) {
		el.classList.remove(ON);
		if (nativeEl() === el) {
			var ex = document.exitFullscreen || document.webkitExitFullscreen;
			if (ex) {
				try {
					var p = ex.call(document);
					if (p && typeof p.catch === 'function') p.catch(function () { /* ignore */ });
				} catch (_e) { /* ignore */ }
			}
		}
		refresh();
		nudgeLayout();
	}

	function toggle(el) {
		if (el.classList.contains(ON)) exit(el); else enter(el);
	}

	// The reader pressed Esc in real full screen: the browser leaves full screen
	// by itself, so switch our class off too.
	function onNativeChange() {
		if (!nativeEl()) {
			registry.forEach(function (r) { r.el.classList.remove(ON); });
		}
		refresh();
		nudgeLayout();
	}
	document.addEventListener('fullscreenchange', onNativeChange);
	document.addEventListener('webkitfullscreenchange', onNativeChange);

	// In the "fills the screen" fallback the browser does not handle Esc for us,
	// so the first Esc leaves full screen and does NOT close the window.
	document.addEventListener('keydown', function (event) {
		if (event.key !== 'Escape' || nativeEl()) return;
		var open = registry.filter(function (r) { return r.el.classList.contains(ON); });
		if (!open.length) return;
		event.stopImmediatePropagation();
		event.preventDefault();
		open.forEach(function (r) { exit(r.el); });
	}, true);

	// Closing the window while expanded must also switch full screen off.
	function watchHidden(el) {
		if (typeof MutationObserver !== 'function') return;
		new MutationObserver(function () {
			if (el.classList.contains(ON) && window.getComputedStyle(el).display === 'none') exit(el);
		}).observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
	}

	function attach(overlayEl, hostEl, beforeEl) {
		if (!overlayEl || !hostEl) return null;
		for (var i = 0; i < registry.length; i += 1) {
			if (registry[i].el === overlayEl) return registry[i].btn;
		}
		injectStyle();
		var btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'ww-fs-btn';
		btn.addEventListener('click', function () { toggle(overlayEl); });
		if (beforeEl && beforeEl.parentNode === hostEl) hostEl.insertBefore(btn, beforeEl);
		else hostEl.appendChild(btn);
		registry.push({ el: overlayEl, btn: btn });
		watchHidden(overlayEl);
		refresh();
		return btn;
	}

	window.WWFullscreen = { attach: attach, toggle: toggle, isOn: isOn };

	// Auto-install on the Record Vault viewer.
	function installVault() {
		var overlay = document.getElementById('rv-viewer-modal');
		if (!overlay) return;
		var headRight = overlay.querySelector('.rv-viewer-head-right');
		if (!headRight) return;
		attach(overlay, headRight, document.getElementById('rv-viewer-close'));
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installVault);
	else installVault();
})();