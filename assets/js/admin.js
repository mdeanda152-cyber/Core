/* Guiltless — order desk. No dependencies.
   The admin token lives in sessionStorage only, so it dies with the tab and
   never persists to disk the way localStorage would. */
(function () {
  'use strict';

  var root = document.querySelector('[data-admin]');
  if (!root) return;

  var API = (root.getAttribute('data-api') || '').replace(/\/+$/, '');
  var TOKEN_KEY = 'guiltless-admin-token';

  var gate     = document.querySelector('[data-gate]');
  var gateMsg  = document.querySelector('[data-gate-msg]');
  var unconfig = document.querySelector('[data-unconfigured]');
  var desk     = document.querySelector('[data-desk]');
  var list     = document.querySelector('[data-orders]');
  var msg      = document.querySelector('[data-msg]');

  var filter = 'new';
  var open = {};   // key -> full order, for rows the user has expanded

  if (!API) { unconfig.hidden = false; return; }

  function token() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(v) {
    try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); }
    catch (e) { /* private mode — the session simply will not persist */ }
  }

  function say(el, text, state) {
    if (!el) return;
    el.textContent = text || '';
    if (state) el.setAttribute('data-state', state); else el.removeAttribute('data-state');
  }

  function money(cents) {
    return typeof cents === 'number' ? '$' + (cents / 100).toFixed(2) : '—';
  }
  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  /* Order data is customer-supplied; never interpolate it as markup. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, options) {
    var opts = options || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { 'Authorization': 'Bearer ' + token() },
        opts.body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 401) { lock('That token was not accepted.'); throw new Error('unauthorised'); }
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
        return data;
      });
    });
  }

  function showGate(message) {
    gate.hidden = false;
    desk.hidden = true;
    say(gateMsg, message || '', message ? 'err' : null);
  }
  function showDesk() {
    gate.hidden = true;
    desk.hidden = false;
  }
  function lock(message) {
    setToken('');
    open = {};
    showGate(message);
  }

  /* ---- Rendering -------------------------------------------------------- */

  var NEXT = {
    new:     [['packed', 'Mark packed'], ['cancelled', 'Cancel']],
    packed:  [['shipped', 'Mark shipped'], ['new', 'Back to new'], ['cancelled', 'Cancel']],
    shipped: [],
    cancelled: []
  };

  function renderRow(o) {
    var status = o.status || 'new';
    var actions = (NEXT[status] || []).map(function (pair) {
      return '<button class="btn btn--mini" type="button" data-set="' + esc(pair[0]) +
             '" data-key="' + esc(o.key) + '">' + esc(pair[1]) + '</button>';
    }).join('');

    var detail = '';
    var full = open[o.key];
    if (full) {
      var s = full.shipping || {};
      var addr = [s.name, s.line1, s.line2,
                  [s.city, s.state, s.postal_code].filter(Boolean).join(' '),
                  s.country].filter(Boolean).map(esc).join('\n');
      detail =
        '<div class="order__detail">' +
          '<address>' + (addr || 'No shipping address on file') + '</address>' +
          '<p style="margin-top:.7em">' +
            esc(full.pints || '—') + ' pints · ' + esc(full.discount || 'no discount') +
            ' · ' + esc(full.phone || 'no phone') +
          '</p>' +
          '<p style="margin-top:.5em;font-family:var(--mono);font-size:.76rem;color:var(--ink-3)">' +
            esc(full.id) +
          '</p>' +
        '</div>';
    }

    return '<div class="order">' +
      '<div>' +
        '<div class="order__who">' + esc(o.name || o.email || 'Unknown') + '</div>' +
        '<div class="order__meta">' + when(o.created) + ' · ' + esc(o.email || '—') +
          (o.state ? ' · ' + esc(o.state) : '') + '</div>' +
      '</div>' +
      '<div>' +
        '<div class="order__total">' + money(o.total_cents) + '</div>' +
        '<div style="text-align:right;margin-top:5px"><span class="chip chip--' + esc(status) + '">' + esc(status) + '</span></div>' +
      '</div>' +
      '<div class="order__actions">' +
        '<button class="btn btn--mini" type="button" data-detail="' + esc(o.key) + '">' +
          (full ? 'Hide detail' : 'Address') + '</button>' +
        actions +
      '</div>' +
      detail +
    '</div>';
  }

  function load() {
    say(msg, 'Loading…');
    return api('/admin/orders?status=' + encodeURIComponent(filter))
      .then(function (data) {
        var orders = data.orders || [];
        list.innerHTML = orders.length
          ? orders.map(renderRow).join('')
          : '<p class="admin-empty">No ' + (filter === 'all' ? '' : filter + ' ') + 'orders.</p>';
        say(msg, orders.length + ' order' + (orders.length === 1 ? '' : 's') +
                 (data.cursor ? ' (first page)' : ''));
      })
      .catch(function (err) {
        if (err.message !== 'unauthorised') say(msg, err.message, 'err');
      });
  }

  /* ---- Events ----------------------------------------------------------- */

  gate.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('tok');
    var value = (input.value || '').trim();
    if (!value) { say(gateMsg, 'Paste the token first.', 'err'); return; }
    setToken(value);
    input.value = '';
    say(gateMsg, 'Checking…');
    api('/admin/orders?status=new')
      .then(function () { showDesk(); load(); })
      .catch(function () { /* lock() already reported it */ });
  });

  document.querySelectorAll('[data-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      filter = btn.getAttribute('data-filter');
      document.querySelectorAll('[data-filter]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      open = {};
      load();
    });
  });

  document.querySelector('[data-refresh]').addEventListener('click', load);
  document.querySelector('[data-lock]').addEventListener('click', function () { lock(); });

  list.addEventListener('click', function (e) {
    var detailBtn = e.target.closest('[data-detail]');
    var setBtn = e.target.closest('[data-set]');

    if (detailBtn) {
      var key = detailBtn.getAttribute('data-detail');
      if (open[key]) { delete open[key]; load(); return; }
      api('/admin/order?key=' + encodeURIComponent(key))
        .then(function (data) { open[key] = data.order; load(); })
        .catch(function (err) { say(msg, err.message, 'err'); });
      return;
    }

    if (setBtn) {
      var k = setBtn.getAttribute('data-key');
      var to = setBtn.getAttribute('data-set');
      setBtn.disabled = true;
      say(msg, 'Updating…');
      api('/admin/order/status', { method: 'POST', body: { key: k, status: to } })
        .then(function () {
          delete open[k];
          // Confirm *after* the reload, otherwise load() overwrites the
          // message with its own count and the confirmation never shows.
          return load().then(function () { say(msg, 'Moved to ' + to + '.', 'ok'); });
        })
        .catch(function (err) { say(msg, err.message, 'err'); setBtn.disabled = false; });
    }
  });

  /* ---- Boot ------------------------------------------------------------- */

  if (token()) {
    api('/admin/orders?status=new')
      .then(function () { showDesk(); load(); })
      .catch(function () { /* lock() shows the gate */ });
  } else {
    showGate();
  }
})();
