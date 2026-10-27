/* month-manager.js
 * Loads AFTER script.js on pages that show months.
 *  - Keeps every device's month list in step with the server (the server
 *    adds the new month automatically when a new month starts).
 *  - Adds a "Delete Month" button (CEO / Manager only) with a confirmation pop-up.
 */
(function () {
  'use strict';
  if (window.__wwMonthManagerLoaded) return;
  window.__wwMonthManagerLoaded = true;

  var page = document.body ? (document.body.getAttribute('data-page') || '') : '';
  var MONTH_PAGES = ['inventory', 'invoices', 'sales'];
  var LS_SALES = 'ww_sales_months';
  var LS_INV = 'ww_inventory_months';
  var RELOAD_GUARD = 'ww_month_reconcile_reload_at';
  var MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var state = { current: '', canManage: false };

  function apiUrl(path) {
    return (typeof API_BASE === 'string' ? API_BASE : '') + path;
  }

  function label(month) {
    var parts = String(month).split('-');
    return (MONTH_NAMES[parseInt(parts[1], 10)] || parts[1]) + ' ' + parts[0];
  }

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type || 'info', undefined, 6000);
    } else {
      window.alert(message);
    }
  }

  async function request(path, options) {
    var res = await fetch(apiUrl(path), Object.assign({ credentials: 'include', cache: 'no-store' }, options || {}));
    var body = {};
    try { body = await res.json(); } catch (_e) { /* no JSON body */ }
    if (!res.ok) {
      var err = new Error(body.message || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /* ── local month storage helpers ── */
  function readList(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v.map(String) : [];
    } catch (_e) { return []; }
  }

  function writeList(key, list) {
    try {
      var unique = Array.from(new Set(list)).sort();
      localStorage.setItem(key, JSON.stringify(unique));
    } catch (_e) { /* storage full or blocked */ }
  }

  function purgeLocalMonth(month) {
    var doomed = [];
    for (var i = 0; i < localStorage.length; i += 1) {
      var k = localStorage.key(i);
      if (!k || k.indexOf('ww_') !== 0 || !/(sales|inventory)/.test(k)) continue;
      if (k.slice(-month.length) === month) doomed.push(k);
    }
    doomed.forEach(function (k) { localStorage.removeItem(k); });
    return doomed.length;
  }

  /* Pull the server's month lists into this device. Returns { changed }. */
  async function reconcile() {
    var data = await request('/api/months');
    state.current = data.current || '';
    state.canManage = !!data.canManage;
    var changed = false;

    var sales = readList(LS_SALES);
    var inventory = readList(LS_INV);
    (data.deleted || []).forEach(function (m) {
      if (purgeLocalMonth(m) > 0) changed = true;
      if (sales.indexOf(m) !== -1) { sales = sales.filter(function (x) { return x !== m; }); changed = true; }
      if (inventory.indexOf(m) !== -1) { inventory = inventory.filter(function (x) { return x !== m; }); changed = true; }
    });
    (data.sales || []).forEach(function (m) { if (sales.indexOf(m) === -1) { sales.push(m); changed = true; } });
    (data.inventory || []).forEach(function (m) { if (inventory.indexOf(m) === -1) { inventory.push(m); changed = true; } });
    if (changed) {
      writeList(LS_SALES, sales);
      writeList(LS_INV, inventory);
    }
    return { changed: changed };
  }

  /* ── refreshing the page when months changed ── */
  function overlayOpen() {
    var overlays = document.querySelectorAll('.inv-modal-overlay, .ww-mm-overlay');
    for (var i = 0; i < overlays.length; i += 1) {
      if (overlays[i].style.display !== 'none' && overlays[i].offsetParent !== null) return true;
    }
    return false;
  }

  function userIsTyping() {
    var el = document.activeElement;
    return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  function showRefreshBar() {
    if (document.getElementById('ww-mm-refresh-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'ww-mm-refresh-bar';
    bar.className = 'ww-mm-refresh-bar';
    bar.innerHTML = '<span>The list of months was updated.</span><button type="button">Refresh</button>';
    bar.querySelector('button').addEventListener('click', function () { window.location.reload(); });
    document.body.appendChild(bar);
  }

  function reloadAllowed() {
    var last = Number(sessionStorage.getItem(RELOAD_GUARD) || 0);
    return Date.now() - last > 20000;
  }

  function reloadNow() {
    sessionStorage.setItem(RELOAD_GUARD, String(Date.now()));
    window.location.reload();
  }

  async function checkMonths(isFirstCheck) {
    try {
      var result = await reconcile();
      if (!result.changed) return;
      if (isFirstCheck && reloadAllowed()) { reloadNow(); return; }
      if (!overlayOpen() && !userIsTyping() && reloadAllowed()) { reloadNow(); return; }
      showRefreshBar();
    } catch (_e) { /* offline or not signed in: try again next time */ }
  }

  /* ── styles ── */
  function injectStyles() {
    if (document.getElementById('ww-mm-styles')) return;
    var style = document.createElement('style');
    style.id = 'ww-mm-styles';
    style.textContent = [
      '.ww-del-month-btn{display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:7px 14px;border:1.5px solid #dc2626;border-radius:8px;background:#fff;color:#dc2626;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;transition:background .15s,color .15s}',
      '.ww-del-month-btn:hover,.ww-del-month-btn:focus-visible{background:#dc2626;color:#fff;outline:none}',
      '.ww-mm-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.55)}',
      '.ww-mm-modal{width:100%;max-width:440px;background:#fff;border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.3);overflow:hidden}',
      '.ww-mm-head{display:flex;align-items:center;gap:10px;padding:14px 18px;background:#fef2f2;border-bottom:1px solid #fecaca;color:#b91c1c}',
      '.ww-mm-head h3{margin:0;font-size:1.05rem}',
      '.ww-mm-body{padding:16px 18px;color:#374151;font-size:.93rem;line-height:1.5}',
      '.ww-mm-body p{margin:0 0 10px}',
      '.ww-mm-counts{margin:8px 0 12px;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font-weight:600}',
      '.ww-mm-body input{width:100%;padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;box-sizing:border-box}',
      '.ww-mm-msg{min-height:1.2em;margin-top:8px;font-size:.85rem;color:#b91c1c}',
      '.ww-mm-foot{display:flex;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid #e5e7eb;background:#f9fafb}',
      '.ww-mm-foot button{padding:8px 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}',
      '.ww-mm-cancel{border:1px solid #cbd5e1;background:#fff;color:#334155}',
      '.ww-mm-confirm{border:none;background:#dc2626;color:#fff}',
      '.ww-mm-confirm:disabled{opacity:.45;cursor:not-allowed}',
      '.ww-mm-refresh-bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:10001;display:flex;gap:12px;align-items:center;padding:10px 16px;border-radius:10px;background:#0f172a;color:#fff;font-size:.9rem;box-shadow:0 8px 24px rgba(0,0,0,.3)}',
      '.ww-mm-refresh-bar button{padding:5px 12px;border:none;border-radius:6px;background:#38bdf8;color:#0f172a;font-weight:700;cursor:pointer}',
      '@media (max-width:600px){.ww-del-month-btn{margin-left:0;margin-top:8px}}'
    ].join('');
    document.head.appendChild(style);
  }

  /* ── delete month ── */
  function selectedMonth() {
    var sel = document.getElementById('inv-month-select') || document.getElementById('sales-month-select');
    return sel ? String(sel.value || '').trim() : '';
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function describeCounts(c) {
    var parts = [];
    if (c.invoices) parts.push(plural(c.invoices, 'invoice'));
    if (c.salesOrders) parts.push(plural(c.salesOrders, 'sales order'));
    if (c.rawMaterials) parts.push(plural(c.rawMaterials, 'raw material entry').replace('entrys', 'entries'));
    if (c.finishedProducts) parts.push(plural(c.finishedProducts, 'finished product record'));
    if (c.equipment) parts.push(plural(c.equipment, 'equipment record'));
    if (c.customers) parts.push(plural(c.customers, 'customer record'));
    return parts.join(', ');
  }

  function openDeleteModal(month) {
    var overlay = document.createElement('div');
    overlay.className = 'ww-mm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="ww-mm-modal">' +
        '<div class="ww-mm-head"><i class="fa-solid fa-triangle-exclamation"></i><h3>Delete ' + label(month) + '?</h3></div>' +
        '<div class="ww-mm-body"><p>Checking what is in this month…</p></div>' +
        '<div class="ww-mm-foot">' +
          '<button type="button" class="ww-mm-cancel">Cancel</button>' +
          '<button type="button" class="ww-mm-confirm" disabled>Yes, delete month</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var body = overlay.querySelector('.ww-mm-body');
    var confirmBtn = overlay.querySelector('.ww-mm-confirm');
    var cancelBtn = overlay.querySelector('.ww-mm-cancel');
    var needTyped = false;

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    request('/api/months/' + encodeURIComponent(month) + '/summary').then(function (info) {
      if (info.isCurrent) {
        body.innerHTML = '<p>' + label(month) + ' is the current month and cannot be deleted. A new month is added automatically, so it would just come back.</p>';
        confirmBtn.style.display = 'none';
        return;
      }
      if (info.hasData) {
        needTyped = true;
        body.innerHTML =
          '<p>This month contains data:</p>' +
          '<div class="ww-mm-counts">' + describeCounts(info.counts) + '</div>' +
          '<p>Deleting it permanently removes this data from every page and every device. Are you sure?</p>' +
          '<p>Type <strong>' + month + '</strong> to confirm:</p>' +
          '<input type="text" autocomplete="off" placeholder="' + month + '" aria-label="Type the month to confirm">' +
          '<div class="ww-mm-msg"></div>';
        var input = body.querySelector('input');
        input.addEventListener('input', function () { confirmBtn.disabled = input.value.trim() !== month; });
        input.focus();
      } else {
        body.innerHTML = '<p>This month has no data. Delete it?</p><div class="ww-mm-msg"></div>';
        confirmBtn.disabled = false;
      }
    }).catch(function (err) {
      body.innerHTML = '<p>Could not check this month: ' + (err.message || 'unknown error') + '</p>';
      confirmBtn.style.display = 'none';
    });

    confirmBtn.addEventListener('click', async function () {
      var msg = body.querySelector('.ww-mm-msg');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Deleting…';
      try {
        await request('/api/months/' + encodeURIComponent(month), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmMonth: needTyped ? month : '' })
        });
        purgeLocalMonth(month);
        writeList(LS_SALES, readList(LS_SALES).filter(function (m) { return m !== month; }));
        writeList(LS_INV, readList(LS_INV).filter(function (m) { return m !== month; }));
        close();
        toast(label(month) + ' deleted.', 'success');
        setTimeout(reloadNow, 900);
      } catch (err) {
        if (msg) msg.textContent = err.message || 'Delete failed. Please try again.';
        confirmBtn.textContent = 'Yes, delete month';
        confirmBtn.disabled = needTyped;
      }
    });
  }

  function mountDeleteButton() {
    var anchor = document.getElementById('inv-new-month-btn') || document.getElementById('new-month-btn');
    if (!anchor || document.getElementById('ww-delete-month-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'ww-delete-month-btn';
    btn.className = 'ww-del-month-btn';
    btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Delete Month';
    btn.addEventListener('click', function () {
      var month = selectedMonth();
      if (!/^\d{4}-\d{2}$/.test(month)) { toast('Pick a month first.', 'warning'); return; }
      openDeleteModal(month);
    });
    anchor.insertAdjacentElement('afterend', btn);
  }

  /* Called by the New Month buttons so a deleted month can be added again. */
  window.wwMonthManager = {
    reopenMonth: function (month) {
      return request('/api/months/' + encodeURIComponent(month) + '/reopen', { method: 'POST' }).catch(function () {});
    }
  };

  async function init() {
    injectStyles();
    await checkMonths(true);
    if (MONTH_PAGES.indexOf(page) !== -1 && state.canManage) mountDeleteButton();

    // Pages left open: pick up a new month / another device's changes.
    setInterval(function () { if (!document.hidden) checkMonths(false); }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkMonths(false); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
