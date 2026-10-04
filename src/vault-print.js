/* ═══════════════════════════════════════════════════════════════════
   RECORD VAULT: PRINT & DOWNLOAD REPORTS
   ───────────────────────────────────────────────────────────────────
   Adds printing and bulk download to the Financial Reports tab of the
   Record Vault. "Download selected" / "Download all" bundle the reports
   into one ZIP (JSZip, loaded on demand); if it cannot load, the files
   download one after another instead. Printing:

     - a checkbox on every card to pick reports,
     - "Print selected" and "Print all" in a toolbar above the files.

   "Print all" means every report currently shown, so it respects the
   search box, category, year and date filters (filter to 2026 and it
   prints the 2026 reports).

   When more than one report is printed, the PDFs are merged in the
   browser into ONE document so there is a single print dialog rather
   than one per report. The merge uses pdf-lib, loaded on demand. If it
   cannot load, the reports print one after another instead.

   HOW IT WORKS WITHOUT TOUCHING script.js
   ───────────────────────────────────────
   It reads the report cards script.js already draws (each card carries
   data-rv-file-id) and re-decorates them whenever the list re-renders.
   Files are fetched from the same download endpoint the Open button
   uses. Nothing here changes vault data.

   INTEGRATION
   ───────────
   In pages/vault.html add, after script.js and conn-status.js:
       <script src="../src/vault-print.js?v=1"></script>
   ═══════════════════════════════════════════════════════════════════ */

(function () {
	'use strict';

	if (!document.body || document.body.getAttribute('data-page') !== 'vault') return;

	const SECTION = 'financialReports';
	const PDF_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
	const MAX_FILES_WARN = 40;
	const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

	const container = document.getElementById('rv-file-container');
	if (!container) return;

	const selected = new Set();
	let busy = false;
	let bar = null;

	const apiBase = () => (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : '';
	const downloadUrl = (fileId) => `${apiBase()}/api/record-vault/${SECTION}/${encodeURIComponent(fileId)}/download`;

	function currentSection() {
		const active = document.querySelector('.rv-tab.tab-active[data-rv-section]');
		return active ? active.getAttribute('data-rv-section') : 'companyDocuments';
	}

	function visibleCards() {
		return Array.from(container.querySelectorAll('.rv-card[data-rv-file-id]'));
	}

	function cardInfo(card) {
		const titleEl = card.querySelector('.rv-card-title');
		return {
			id: String(card.getAttribute('data-rv-file-id') || ''),
			name: titleEl ? titleEl.textContent.trim() : 'Report',
		};
	}

	/* ── Styles ─────────────────────────────────────────────────── */

	function injectStyles() {
		if (document.getElementById('rvp-styles')) return;
		const style = document.createElement('style');
		style.id = 'rvp-styles';
		style.textContent = `
			.rvp-bar { display: none; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; margin: 0 0 12px; background: linear-gradient(135deg, #f8fbff 0%, #eef6ff 100%); border: 1px solid #cfe3f5; border-radius: 12px; }
			.rvp-bar.rvp-visible { display: flex; }
			.rvp-title { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 0.9rem; color: #0a3858; margin-right: 4px; }
			.rvp-title i { color: #0077b6; }
			.rvp-spacer { flex: 1 1 auto; }
			.rvp-count { font-size: 0.82rem; font-weight: 600; color: #587289; min-width: 84px; }
			.rvp-btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 8px; border: 1px solid #0077b6; background: #fff; color: #0077b6; font: inherit; font-size: 0.84rem; font-weight: 600; cursor: pointer; transition: background .15s, color .15s, opacity .15s; }
			.rvp-btn:hover:not(:disabled) { background: #eff6ff; }
			.rvp-btn:disabled { opacity: .5; cursor: not-allowed; }
			.rvp-btn-primary { background: #0077b6; color: #fff; }
			.rvp-btn-primary:hover:not(:disabled) { background: #005f92; }
			.rvp-btn-quiet { border-color: #cbd5e1; color: #475569; }
			.rvp-status { flex-basis: 100%; font-size: 0.82rem; color: #587289; display: none; align-items: center; gap: 8px; }
			.rvp-status.rvp-show { display: flex; }
			.rvp-status.rvp-ok { color: #15803d; }
			.rvp-status.rvp-warn { color: #b45309; }
			.rvp-status.rvp-err { color: #b91c1c; }
			.rvp-status a { color: inherit; font-weight: 700; text-decoration: underline; }
			.rvp-check { position: absolute; top: 8px; left: 8px; z-index: 2; width: 22px; height: 22px; margin: 0; border-radius: 6px; cursor: pointer; accent-color: #0077b6; box-shadow: 0 1px 4px rgba(15,23,42,.25); background: #fff; }
			.rv-card.rvp-selected { outline: 2px solid #0077b6; outline-offset: -2px; }
			.rvp-card-btn { display: inline-flex; align-items: center; gap: 6px; }
			@keyframes rvp-spin { to { transform: rotate(360deg); } }
			.rvp-spin { animation: rvp-spin 0.9s linear infinite; }
		`;
		document.head.appendChild(style);
	}

	/* ── Toolbar ────────────────────────────────────────────────── */

	function buildBar() {
		bar = document.createElement('div');
		bar.className = 'rvp-bar';
		bar.id = 'rvp-bar';
		bar.setAttribute('role', 'toolbar');
		bar.setAttribute('aria-label', 'Print and download financial reports');
		bar.innerHTML = `
			<span class="rvp-title"><i class="fa-solid fa-print"></i> Print &amp; download reports</span>
			<button type="button" class="rvp-btn rvp-btn-quiet" data-rvp="select-all"><i class="fa-regular fa-square-check"></i> Select all</button>
			<button type="button" class="rvp-btn rvp-btn-quiet" data-rvp="clear"><i class="fa-regular fa-square"></i> Clear</button>
			<span class="rvp-count" data-rvp="count" aria-live="polite">0 selected</span>
			<span class="rvp-spacer"></span>
			<button type="button" class="rvp-btn" data-rvp="download-selected"><i class="fa-solid fa-download"></i> Download selected</button>
			<button type="button" class="rvp-btn rvp-btn-primary" data-rvp="download-all"><i class="fa-solid fa-download"></i> Download all</button>
			<button type="button" class="rvp-btn" data-rvp="print-selected"><i class="fa-solid fa-print"></i> Print selected</button>
			<button type="button" class="rvp-btn rvp-btn-primary" data-rvp="print-all"><i class="fa-solid fa-print"></i> Print all</button>
			<div class="rvp-status" data-rvp="status" role="status"></div>
		`;
		container.parentNode.insertBefore(bar, container);
		bar.addEventListener('click', onBarClick);
	}

	function setStatus(html, tone) {
		const el = bar && bar.querySelector('[data-rvp="status"]');
		if (!el) return;
		el.className = 'rvp-status' + (html ? ' rvp-show' : '') + (tone ? ` rvp-${tone}` : '');
		el.innerHTML = html || '';
	}

	function escapeText(text) {
		return String(text == null ? '' : text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
	}

	function refreshBar() {
		if (!bar) return;
		const active = currentSection() === SECTION;
		bar.classList.toggle('rvp-visible', active);
		if (!active) return;
		const cards = visibleCards();
		const count = selected.size;
		bar.querySelector('[data-rvp="count"]').textContent = `${count} selected`;
		bar.querySelector('[data-rvp="print-selected"]').disabled = busy || count === 0;
		bar.querySelector('[data-rvp="download-selected"]').disabled = busy || count === 0;
		const downloadAll = bar.querySelector('[data-rvp="download-all"]');
		downloadAll.disabled = busy || cards.length === 0;
		downloadAll.innerHTML = `<i class="fa-solid fa-download"></i> Download all${cards.length ? ` (${cards.length})` : ''}`;
		const printAll = bar.querySelector('[data-rvp="print-all"]');
		printAll.disabled = busy || cards.length === 0;
		printAll.innerHTML = `<i class="fa-solid fa-print"></i> Print all${cards.length ? ` (${cards.length})` : ''}`;
		bar.querySelector('[data-rvp="select-all"]').disabled = busy || cards.length === 0;
		bar.querySelector('[data-rvp="clear"]').disabled = busy || count === 0;
	}

	/* ── Card decoration ────────────────────────────────────────── */

	function decorate() {
		const active = currentSection() === SECTION;
		if (!active) {
			selected.clear();
			refreshBar();
			return;
		}
		const cards = visibleCards();
		const visibleIds = new Set(cards.map((c) => cardInfo(c).id));
		// Drop selections that are no longer on screen (filter or tab changed),
		// so "N selected" always matches what the person can see.
		Array.from(selected).forEach((id) => { if (!visibleIds.has(id)) selected.delete(id); });

		cards.forEach((card) => {
			const { id, name } = cardInfo(card);
			const thumb = card.querySelector('.rv-thumb');
			if (thumb && !thumb.querySelector('.rvp-check')) {
				const box = document.createElement('input');
				box.type = 'checkbox';
				box.className = 'rvp-check';
				box.setAttribute('data-rvp-check', id);
				box.setAttribute('aria-label', `Select ${name} for printing`);
				thumb.appendChild(box);
			}
			const box = card.querySelector('.rvp-check');
			if (box) box.checked = selected.has(id);
			card.classList.toggle('rvp-selected', selected.has(id));

			// Per-card Download button is not needed here: use the toolbar's
			// "Download selected" / "Download all" instead.
			const actions = card.querySelector('.rv-card-actions');
			if (actions) {
				Array.from(actions.querySelectorAll('button, a')).forEach((el) => {
					if (el.textContent.trim().toLowerCase() === 'download') el.remove();
				});
			}
		});
		refreshBar();
	}

	let decorateQueued = false;
	function queueDecorate() {
		if (decorateQueued) return;
		decorateQueued = true;
		const run = () => { decorateQueued = false; decorate(); };
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 0);
	}

	/* ── Printing ───────────────────────────────────────────────── */

	function loadPdfLib() {
		if (window.PDFLib && window.PDFLib.PDFDocument) return Promise.resolve(window.PDFLib);
		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = PDF_LIB_URL;
			script.async = true;
			script.onload = () => (window.PDFLib && window.PDFLib.PDFDocument ? resolve(window.PDFLib) : reject(new Error('pdf-lib unavailable')));
			script.onerror = () => reject(new Error('Could not load pdf-lib'));
			document.head.appendChild(script);
		});
	}

	async function fetchPdf(item) {
		const res = await fetch(downloadUrl(item.id), { credentials: 'include', cache: 'no-store' });
		if (!res.ok) throw new Error(`${item.name}: the server returned ${res.status}`);
		const buffer = await res.arrayBuffer();
		const head = new Uint8Array(buffer.slice(0, 5));
		const isPdf = head.length === 5 && String.fromCharCode(...head) === '%PDF-';
		if (!isPdf) throw new Error(`${item.name}: this file is not a PDF`);
		return buffer;
	}

	async function mergePdfs(buffers) {
		const PDFLib = await loadPdfLib();
		const merged = await PDFLib.PDFDocument.create();
		for (const buffer of buffers) {
			const source = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
			const pages = await merged.copyPages(source, source.getPageIndices());
			pages.forEach((page) => merged.addPage(page));
		}
		const bytes = await merged.save();
		return new Blob([bytes], { type: 'application/pdf' });
	}

	// Sends a PDF blob to the browser's print dialog through a hidden frame.
	// Returns the blob URL so a fallback "open it instead" link can be offered
	// (some browsers, notably iOS Safari, will not print from a hidden frame).
	function printBlob(blob) {
		const url = URL.createObjectURL(blob);
		const frame = document.createElement('iframe');
		frame.setAttribute('aria-hidden', 'true');
		frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
		frame.src = url;
		frame.addEventListener('load', () => {
			setTimeout(() => {
				try {
					frame.contentWindow.focus();
					frame.contentWindow.print();
				} catch (_e) {
					window.open(url, '_blank');
				}
			}, 350);
		});
		document.body.appendChild(frame);
		setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 10 * 60 * 1000);
		return url;
	}

	function waitForNextFrame(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

	async function printItems(items, label) {
		if (busy) return;
		if (!items.length) {
			setStatus('There are no reports to print. Adjust the filters or select at least one report.', 'warn');
			return;
		}
		if (items.length > MAX_FILES_WARN && !window.confirm(`You are about to prepare ${items.length} reports for printing. This may take a moment and produce a very long document. Continue?`)) return;

		busy = true;
		refreshBar();
		setStatus(`<i class="fa-solid fa-spinner rvp-spin"></i> Preparing ${items.length === 1 ? '1 report' : items.length + ' reports'} for printing…`);

		const buffers = [];
		const failed = [];
		for (let i = 0; i < items.length; i += 1) {
			try {
				buffers.push({ item: items[i], buffer: await fetchPdf(items[i]) });
			} catch (error) {
				failed.push(error && error.message ? error.message : items[i].name);
			}
		}

		try {
			if (!buffers.length) {
				setStatus(`<i class="fa-solid fa-circle-exclamation"></i> None of the reports could be loaded. ${escapeText(failed[0] || 'Please check your connection and try again.')}`, 'err');
				return;
			}

			let openUrl = '';
			let mode = 'single';
			if (buffers.length === 1) {
				openUrl = printBlob(new Blob([buffers[0].buffer], { type: 'application/pdf' }));
			} else {
				try {
					const merged = await mergePdfs(buffers.map((b) => b.buffer));
					openUrl = printBlob(merged);
					mode = 'merged';
				} catch (_mergeError) {
					// Merge unavailable: print one after another instead.
					mode = 'sequential';
					if (!window.confirm(`The reports can't be combined into one document right now, so ${buffers.length} print dialogs will open one after another. Continue?`)) return;
					for (const entry of buffers) {
						printBlob(new Blob([entry.buffer], { type: 'application/pdf' }));
						await waitForNextFrame(1500);
					}
				}
			}

			const printed = buffers.length;
			let message = mode === 'merged'
				? `<i class="fa-solid fa-circle-check"></i> ${printed} reports were combined into one document and sent to your printer dialog.`
				: mode === 'sequential'
					? `<i class="fa-solid fa-circle-check"></i> ${printed} reports were sent to your printer dialog.`
					: `<i class="fa-solid fa-circle-check"></i> ${escapeText(buffers[0].item.name)} was sent to your printer dialog.`;
			if (openUrl) message += ` Nothing appeared? <a href="${openUrl}" target="_blank" rel="noopener">Open the PDF</a> and print it from there.`;
			if (failed.length) message += ` <br><i class="fa-solid fa-triangle-exclamation"></i> ${failed.length} could not be loaded and ${failed.length === 1 ? 'was' : 'were'} skipped: ${escapeText(failed.join('; '))}`;
			setStatus(message, failed.length ? 'warn' : 'ok');
		} catch (error) {
			setStatus(`<i class="fa-solid fa-circle-exclamation"></i> Printing failed. ${escapeText(error && error.message ? error.message : 'Please try again.')}`, 'err');
		} finally {
			busy = false;
			refreshBar();
		}
	}

	/* ── Downloading ────────────────────────────────────────────── */

	function loadJsZip() {
		if (window.JSZip) return Promise.resolve(window.JSZip);
		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = JSZIP_URL;
			script.async = true;
			script.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip unavailable')));
			script.onerror = () => reject(new Error('Could not load JSZip'));
			document.head.appendChild(script);
		});
	}

	async function fetchFile(item) {
		const res = await fetch(downloadUrl(item.id), { credentials: 'include', cache: 'no-store' });
		if (!res.ok) throw new Error(`${item.name}: the server returned ${res.status}`);
		return res.blob();
	}

	function safeFileName(name, fallback) {
		const clean = String(name || '').replace(/[\\/:*?"<>|]+/g, '-').trim();
		return clean || fallback;
	}

	function saveBlob(blob, fileName) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
	}

	// Gives each file a unique name inside the ZIP (adds " (2)" etc. to duplicates).
	function uniqueName(name, used) {
		if (!used.has(name)) { used.add(name); return name; }
		const dot = name.lastIndexOf('.');
		const base = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : '';
		let n = 2;
		while (used.has(`${base} (${n})${ext}`)) n += 1;
		const next = `${base} (${n})${ext}`;
		used.add(next);
		return next;
	}

	async function downloadItems(items) {
		if (busy) return;
		if (!items.length) {
			setStatus('There are no reports to download. Adjust the filters or select at least one report.', 'warn');
			return;
		}
		if (items.length > MAX_FILES_WARN && !window.confirm(`You are about to download ${items.length} reports. This may take a moment. Continue?`)) return;

		busy = true;
		refreshBar();
		setStatus(`<i class="fa-solid fa-spinner rvp-spin"></i> Preparing ${items.length === 1 ? '1 report' : items.length + ' reports'} for download…`);

		const files = [];
		const failed = [];
		for (let i = 0; i < items.length; i += 1) {
			try {
				files.push({ item: items[i], blob: await fetchFile(items[i]) });
			} catch (error) {
				failed.push(error && error.message ? error.message : items[i].name);
			}
		}

		try {
			if (!files.length) {
				setStatus(`<i class="fa-solid fa-circle-exclamation"></i> None of the reports could be downloaded. ${escapeText(failed[0] || 'Please check your connection and try again.')}`, 'err');
				return;
			}

			let message;
			if (files.length === 1) {
				saveBlob(files[0].blob, safeFileName(files[0].item.name, 'report.pdf'));
				message = `<i class="fa-solid fa-circle-check"></i> ${escapeText(files[0].item.name)} was downloaded.`;
			} else {
				try {
					const JSZip = await loadJsZip();
					const zip = new JSZip();
					const used = new Set();
					files.forEach((f, i) => zip.file(uniqueName(safeFileName(f.item.name, `report-${i + 1}.pdf`), used), f.blob));
					const zipBlob = await zip.generateAsync({ type: 'blob' });
					const stamp = new Date().toISOString().slice(0, 10);
					saveBlob(zipBlob, `Financial-Reports-${stamp}.zip`);
					message = `<i class="fa-solid fa-circle-check"></i> ${files.length} reports were downloaded as one ZIP file.`;
				} catch (_zipError) {
					// ZIP unavailable: download the files one after another instead.
					for (let i = 0; i < files.length; i += 1) {
						saveBlob(files[i].blob, safeFileName(files[i].item.name, `report-${i + 1}.pdf`));
						await waitForNextFrame(700);
					}
					message = `<i class="fa-solid fa-circle-check"></i> ${files.length} reports were downloaded one by one. If your browser asks to allow multiple downloads, choose Allow.`;
				}
			}
			if (failed.length) message += ` <br><i class="fa-solid fa-triangle-exclamation"></i> ${failed.length} could not be loaded and ${failed.length === 1 ? 'was' : 'were'} skipped: ${escapeText(failed.join('; '))}`;
			setStatus(message, failed.length ? 'warn' : 'ok');
		} catch (error) {
			setStatus(`<i class="fa-solid fa-circle-exclamation"></i> Download failed. ${escapeText(error && error.message ? error.message : 'Please try again.')}`, 'err');
		} finally {
			busy = false;
			refreshBar();
		}
	}

	/* ── Events ─────────────────────────────────────────────────── */

	function onBarClick(event) {
		const btn = event.target.closest('[data-rvp]');
		if (!btn || btn.disabled) return;
		const action = btn.getAttribute('data-rvp');
		const cards = visibleCards().map(cardInfo);
		if (action === 'select-all') {
			cards.forEach((c) => selected.add(c.id));
			decorate();
		} else if (action === 'clear') {
			selected.clear();
			decorate();
		} else if (action === 'print-selected') {
			printItems(cards.filter((c) => selected.has(c.id)), 'selected');
		} else if (action === 'print-all') {
			printItems(cards, 'all');
		} else if (action === 'download-selected') {
			downloadItems(cards.filter((c) => selected.has(c.id)));
		} else if (action === 'download-all') {
			downloadItems(cards);
		}
	}

	container.addEventListener('change', (event) => {
		const box = event.target.closest('.rvp-check');
		if (!box) return;
		const id = box.getAttribute('data-rvp-check');
		if (box.checked) selected.add(id); else selected.delete(id);
		const card = box.closest('.rv-card');
		if (card) card.classList.toggle('rvp-selected', box.checked);
		refreshBar();
	});

	document.addEventListener('click', (event) => {
		if (event.target.closest('.rv-tab')) {
			// script.js swaps the section in its own click handler; wait for it.
			selected.clear();
			setStatus('');
			setTimeout(queueDecorate, 0);
		}
	});

	/* ── Init ───────────────────────────────────────────────────── */

	injectStyles();
	buildBar();
	new MutationObserver(queueDecorate).observe(container, { childList: true });
	decorate();
})();