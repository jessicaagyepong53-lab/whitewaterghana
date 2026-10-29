/* smart-suggest.js
 * Turns repeating text fields into dropdowns fed by what people have already
 * typed (the server collects the values). Typing a brand-new value still works.
 * Loaded automatically by script.js; does nothing on pages without these fields.
 */
(function () {
  'use strict';
  if (window.__wwSmartSuggest) return;
  window.__wwSmartSuggest = true;

  var page = document.body ? (document.body.getAttribute('data-page') || '') : '';

  // selector -> which server list feeds it. Names, phones, amounts and dates are left out on purpose.
  var RULES = [
    { selector: '#inv-field-location', list: 'locations', placeholder: 'Choose a location or type a new one' },
    { selector: '#inv-field-supplier', list: 'suppliers', placeholder: 'Choose a supplier or type a new one' },
    { selector: '#si-field-carType', list: 'carTypes', placeholder: 'Choose a car type or type a new one' },
    { selector: '#si-field-carNumber', list: 'carNumbers', placeholder: 'Choose a car number or type a new one' },
    { selector: '#pu-field-item', list: 'items', placeholder: 'Choose an item or type a new one' },
    { selector: '#acc-field-desc', list: 'descriptions', placeholder: 'Choose a description or type a new one' },
    { selector: 'input[name="unit"]', list: 'units', pages: ['production'], placeholder: 'Choose a unit or type a new one' }
  ];

  // Values already on this device, so a just-saved entry shows before the server round trip.
  var LOCAL = {
    locations: [['ww_raw_materials', 'location'], ['ww_finished_products', 'location']],
    suppliers: [['ww_raw_materials', 'supplier']]
  };

  var server = {};
  var fetchedAt = 0;
  var inFlight = null;

  function norm(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
  function esc(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function listId(name) { return 'ww-suggest-' + name; }

  function localValues(name) {
    var out = [];
    (LOCAL[name] || []).forEach(function (pair) {
      try {
        var rows = JSON.parse(localStorage.getItem(pair[0]) || '[]');
        if (Array.isArray(rows)) rows.forEach(function (r) { if (r && r[pair[1]]) out.push(r[pair[1]]); });
      } catch (_e) { /* ignore */ }
    });
    return out;
  }

  function values(name) {
    var seen = {};
    var out = [];
    (server[name] || []).concat(localValues(name)).forEach(function (v) {
      var n = norm(v);
      if (!n || /^n\/a$/i.test(n)) return;
      var k = n.toLowerCase();
      if (seen[k]) return;
      seen[k] = n;
      out.push(n);
    });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }

  function fill(name) {
    var dl = document.getElementById(listId(name));
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = listId(name);
      document.body.appendChild(dl);
    }
    dl.innerHTML = values(name).map(function (v) { return '<option value="' + esc(v) + '"></option>'; }).join('');
  }

  function fillAll() {
    RULES.forEach(function (rule) { if (document.getElementById(listId(rule.list))) fill(rule.list); });
  }

  function refresh(force) {
    if (inFlight) return inFlight;
    if (!force && Date.now() - fetchedAt < 15000) { fillAll(); return Promise.resolve(); }
    var base = typeof API_BASE === 'string' ? API_BASE : '';
    inFlight = fetch(base + '/api/suggestions', { credentials: 'include', cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (data && typeof data === 'object') { server = data; fetchedAt = Date.now(); } })
      .catch(function () { /* offline: keep what we have */ })
      .then(function () { inFlight = null; fillAll(); });
    return inFlight;
  }

  function attach(input, rule) {
    if (input.getAttribute('data-ww-suggest')) return;
    input.setAttribute('data-ww-suggest', rule.list);
    input.setAttribute('list', listId(rule.list));
    input.setAttribute('autocomplete', 'off');
    if (rule.placeholder) input.placeholder = rule.placeholder;
    fill(rule.list);
    refresh(true);
  }

  function scan() {
    RULES.forEach(function (rule) {
      if (rule.pages && rule.pages.indexOf(page) === -1) return;
      var found = document.querySelectorAll(rule.selector);
      for (var i = 0; i < found.length; i += 1) attach(found[i], rule);
    });
  }

  // Typing "loading side" when "Loading Side" already exists reuses the existing spelling.
  document.addEventListener('submit', function (e) {
    var inputs = e.target && e.target.querySelectorAll ? e.target.querySelectorAll('input[data-ww-suggest]') : [];
    for (var i = 0; i < inputs.length; i += 1) {
      var el = inputs[i];
      var typed = norm(el.value);
      if (!typed) continue;
      var match = values(el.getAttribute('data-ww-suggest')).filter(function (v) { return v.toLowerCase() === typed.toLowerCase(); })[0];
      el.value = match || typed;
    }
  }, true);

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || setTimeout)(function () { scheduled = false; scan(); });
  }

  function init() {
    scan();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
