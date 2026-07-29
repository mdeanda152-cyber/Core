/* Guiltless — site behaviour. No dependencies. */
(function () {
  'use strict';

  /* ---- Theme (persisted) ------------------------------------------------ */
  var root = document.documentElement;
  var KEY = 'guiltless-theme';

  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) { /* storage blocked — fall back to OS preference */ }

  function currentTheme() {
    return root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  var themeBtn = document.querySelector('[data-theme-toggle]');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      themeBtn.setAttribute('aria-label', 'Switch to ' + (next === 'dark' ? 'light' : 'dark') + ' theme');
      try { localStorage.setItem(KEY, next); } catch (e) { /* no-op */ }
    });
  }

  /* ---- Mobile nav ------------------------------------------------------- */
  var navBtn = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');
  if (navBtn && nav) {
    var closeNav = function () {
      nav.classList.remove('is-open');
      navBtn.setAttribute('aria-expanded', 'false');
    };
    navBtn.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      navBtn.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', function (e) { if (e.target.tagName === 'A') closeNav(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) { closeNav(); navBtn.focus(); }
    });
  }

  /* ---- Sticky header hairline ------------------------------------------ */
  var head = document.querySelector('.site-head');
  if (head) {
    var onScroll = function () { head.classList.toggle('is-stuck', window.scrollY > 8); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---- Reveal on scroll ------------------------------------------------- */
  var targets = document.querySelectorAll('.reveal');
  if (targets.length) {
    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('is-in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
      targets.forEach(function (el) { io.observe(el); });
    }
  }

  /* ---- Freezing-point model --------------------------------------------
     Colligative: freezing-point depression scales with molar concentration,
     so each solute is weighted by its relative FPD factor (sucrose = 1.0).
     Fixed solutes contribute 34.2 g sucrose-equivalent:
       milk salts 8.0 · lactose 7.3 · sea salt 6.6 · fibre 6.3 · sucrose 6.0
     ---------------------------------------------------------------------- */
  var model = document.querySelector('[data-model]');
  if (model) {
    var FIXED_SE = 34.2,
        PROTEIN  = 42,
        FIBRE    = 17.9,
        LACTOSE  = 7.3,
        SUCROSE  = 6,
        ASH      = 3.1,
        STAB     = 1.6,
        PINT     = 359,
        LO = 15, HI = 45;          // gauge scale, g sucrose-eq / 100 g water

    var $ = function (id) { return model.querySelector('#' + id); };
    var allu = $('m-allu'), fat = $('m-fat'),
        alluOut = $('m-alluOut'), fatOut = $('m-fatOut'),
        se = $('m-se'), kcal = $('m-kcal'), ppk = $('m-ppk'), solids = $('m-solids'),
        pin = $('m-pin'), win = $('m-win'), verdict = $('m-verdict'), diag = $('m-diag');

    // premium scoopability window: 26–30 g sucrose-eq per 100 g water
    win.style.left  = ((26 - LO) / (HI - LO) * 100) + '%';
    win.style.width = ((30 - 26) / (HI - LO) * 100) + '%';

    var render = function () {
      var a = +allu.value, f = +fat.value;
      var solidsG = PROTEIN + f + a + FIBRE + LACTOSE + SUCROSE + ASH + STAB;
      var water = PINT - solidsG;
      var ratio = (FIXED_SE + a * 1.9) / water * 100;
      var cal = PROTEIN * 4 + f * 9 + SUCROSE * 4 + LACTOSE * 4 + a * 0.4 + FIBRE * 1;

      alluOut.textContent = a + ' g';
      fatOut.textContent  = f + ' g';
      se.textContent      = ratio.toFixed(1);
      kcal.textContent    = Math.round(cal);
      ppk.textContent     = (PROTEIN / cal * 100).toFixed(1) + ' g';
      solids.textContent  = (solidsG / PINT * 100).toFixed(1) + ' %';

      pin.style.left = Math.max(0, Math.min(100, (ratio - LO) / (HI - LO) * 100)) + '%';

      var label, colour, text;
      if (ratio < 22) {
        label = 'freezes to a brick'; colour = 'var(--bad)';
        text = 'Too little freezing-point depression. Most of the water is ice at −18 °C — this is the pint you have to microwave, and it is exactly the original Halo Top complaint.';
      } else if (ratio < 26) {
        label = 'firm, scoops hard'; colour = 'var(--warm)';
        text = 'Scoopable but stiff straight from the freezer. Fine behind a counter at −13 °C, punishing in a home freezer.';
      } else if (ratio <= 30) {
        label = 'premium window'; colour = 'var(--good)';
        text = 'The target. Scoopable straight from a home freezer, still firm enough to hold a shape on a cone. Premium full-fat ice cream lives in this band.';
      } else if (ratio <= 36) {
        label = 'soft, fast melt'; colour = 'var(--warm)';
        text = 'Yields easily but slumps. The scoop loses definition on the plate and melts to liquid faster than it should.';
      } else {
        label = 'gummy, no structure'; colour = 'var(--bad)';
        text = 'Far too much depression — too little of the water ever freezes. This is our rejected v0.9: gummy, slumping, and it will not hold a scoop shape at all.';
      }

      verdict.textContent = label;
      verdict.style.color = colour;
      pin.style.background = colour;

      if (f <= 4) {
        text += ' At this fat level there is no partial-coalescence network — expect a wet, fast-collapsing body regardless of the freezing point.';
      } else if (f >= 16) {
        text += ' Fat this high builds excellent structure and flavour carry, but the calorie budget is blown well past target.';
      }
      diag.textContent = text;
    };

    allu.addEventListener('input', render);
    fat.addEventListener('input', render);
    render();
  }

  /* ---- Waitlist ---------------------------------------------------------
     Set data-endpoint on the form to POST JSON {email} to a real list
     provider (Formspree, Buttondown, a Worker, anything that accepts JSON).
     With no endpoint configured it degrades to the visitor's mail client
     and says so, rather than silently swallowing the address.
     ---------------------------------------------------------------------- */
  document.querySelectorAll('[data-waitlist]').forEach(function (form) {
    var msg = form.parentNode.querySelector('.form__msg');
    var set = function (text, state) {
      if (!msg) return;
      msg.textContent = text;
      if (state) msg.setAttribute('data-state', state);
      else msg.removeAttribute('data-state');
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('input[type="email"]');
      var btn = form.querySelector('button');
      var email = (input.value || '').trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        set('That address does not look right — check it and try again.', 'err');
        input.focus();
        return;
      }

      var endpoint = form.getAttribute('data-endpoint');
      if (!endpoint) {
        var to = form.getAttribute('data-waitlist') || 'hello@guiltless.example';
        window.location.href = 'mailto:' + to +
          '?subject=' + encodeURIComponent('Guiltless waitlist') +
          '&body=' + encodeURIComponent('Add me to the Guiltless waitlist: ' + email);
        set('Opening your email app — send the draft and you are on the list.', 'ok');
        form.reset();
        return;
      }

      btn.disabled = true;
      set('Adding you…', 'busy');
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email: email, source: window.location.pathname })
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        set('You are on the list. We will be in touch.', 'ok');
        form.reset();
      }).catch(function () {
        set('That did not go through. Try again, or email us directly.', 'err');
      }).then(function () {
        btn.disabled = false;
      });
    });
  });

  /* ---- Footer year ------------------------------------------------------ */
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
})();

/* ==========================================================================
   Shop cart
   Persisted to localStorage. Volume pricing applies at cart level, so the
   per-pint price drops as the pack grows — no separate bundle SKUs.
   ========================================================================== */
(function () {
  'use strict';

  var shopRoot = document.querySelector('[data-shop]') || document.querySelector('[data-cart-drawer]');
  if (!shopRoot) return;

  var KEY = 'guiltless-cart-v1';
  var UNIT = 9.50;          // list price per pint, USD
  var SHIP = 12.99;         // flat dry-ice shipping
  var FREE_AT = 75;         // free shipping threshold on merchandise subtotal
  var MIN_PINTS = 4;        // dry-ice packs do not ship below this

  // qty threshold -> discount rate
  var TIERS = [
    { min: 12, rate: 0.20 },
    { min: 8,  rate: 0.14 },
    { min: 4,  rate: 0.08 },
    { min: 0,  rate: 0    }
  ];

  var cart = {};
  try { cart = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { cart = {}; }

  var drawer  = document.querySelector('[data-cart-drawer]');
  var scrim   = document.querySelector('[data-cart-scrim]');
  var openBtn = document.querySelector('[data-cart-open]');
  var closeBtn= document.querySelector('[data-cart-close]');
  var bodyEl  = document.querySelector('[data-cart-body]');
  var footEl  = document.querySelector('[data-cart-foot]');
  var countEl = document.querySelector('[data-cart-count]');

  var money = function (n) { return '$' + n.toFixed(2); };
  var totalQty = function () {
    return Object.keys(cart).reduce(function (n, k) { return n + cart[k].qty; }, 0);
  };
  var tierFor = function (q) {
    for (var i = 0; i < TIERS.length; i++) if (q >= TIERS[i].min) return TIERS[i];
    return TIERS[TIERS.length - 1];
  };

  var save = function () {
    try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) { /* no-op */ }
  };

  /* ---- Drawer open/close (with focus restore) ---- */
  var lastFocus = null;
  function openCart() {
    lastFocus = document.activeElement;
    drawer.classList.add('is-open');
    scrim.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    if (openBtn) openBtn.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    if (closeBtn) closeBtn.focus();
  }
  function closeCart() {
    drawer.classList.remove('is-open');
    scrim.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    if (openBtn) openBtn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  if (openBtn)  openBtn.addEventListener('click', openCart);
  if (closeBtn) closeBtn.addEventListener('click', closeCart);
  if (scrim)    scrim.addEventListener('click', closeCart);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) closeCart();
  });

  /* ---- Mutations ---- */
  function addItem(id, name, swatch) {
    if (!cart[id]) cart[id] = { name: name, swatch: swatch, qty: 0 };
    cart[id].qty++;
    save(); render();
  }
  function setQty(id, q) {
    if (!cart[id]) return;
    cart[id].qty = q;
    if (cart[id].qty <= 0) delete cart[id];
    save(); render();
  }

  document.querySelectorAll('[data-add]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      addItem(btn.getAttribute('data-add'), btn.getAttribute('data-name'), btn.getAttribute('data-swatch'));
      btn.classList.add('is-added');
      var original = btn.textContent;
      btn.textContent = 'Added';
      setTimeout(function () { btn.classList.remove('is-added'); btn.textContent = original; }, 1100);
    });
  });

  /* ---- Render ---- */
  function render() {
    var q = totalQty();

    if (countEl) {
      countEl.textContent = String(q);
      countEl.hidden = q === 0;
    }

    // active pricing tier highlight
    var tier = tierFor(q);
    document.querySelectorAll('[data-tier]').forEach(function (el) {
      el.classList.toggle('is-active', Number(el.getAttribute('data-tier')) === tier.min && q > 0);
    });

    // per-pint price shown on product cards
    var unitNow = UNIT * (1 - tier.rate);
    document.querySelectorAll('[data-unit-price]').forEach(function (el) {
      el.innerHTML = tier.rate
        ? '<s>' + money(UNIT) + '</s>' + money(unitNow)
        : money(UNIT);
    });

    if (!bodyEl) return;

    if (q === 0) {
      bodyEl.innerHTML = '<p class="cart__empty">Your cart is empty.<br>Packs start at ' + MIN_PINTS + ' pints.</p>';
      footEl.innerHTML = '';
      return;
    }

    var rows = '';
    Object.keys(cart).forEach(function (id) {
      var it = cart[id];
      rows += '<div class="citem">' +
        '<div class="citem__sw" style="background:' + it.swatch + '"></div>' +
        '<div><h4>' + it.name + '</h4>' +
        '<div class="citem__unit">' + money(unitNow) + ' each</div>' +
        '<div class="qty">' +
          '<button type="button" data-dec="' + id + '" aria-label="Decrease quantity of ' + it.name + '">−</button>' +
          '<span>' + it.qty + '</span>' +
          '<button type="button" data-inc="' + id + '" aria-label="Increase quantity of ' + it.name + '">+</button>' +
        '</div></div>' +
        '<div class="citem__line">' + money(unitNow * it.qty) + '</div>' +
      '</div>';
    });
    bodyEl.innerHTML = rows;

    var list = UNIT * q;
    var sub = unitNow * q;
    var saved = list - sub;
    var ship = sub >= FREE_AT ? 0 : SHIP;
    var total = sub + ship;
    var under = q < MIN_PINTS;
    var toFree = Math.max(0, FREE_AT - sub);

    var foot = '';
    foot += '<div class="cart__row"><span>Subtotal (' + q + ' pint' + (q === 1 ? '' : 's') + ')</span><span>' + money(list) + '</span></div>';
    if (saved > 0.005) {
      foot += '<div class="cart__row cart__row--save"><span>Volume pricing (−' + Math.round(tier.rate * 100) + '%)</span><span>−' + money(saved) + '</span></div>';
    }
    foot += '<div class="cart__row"><span>Shipping (dry ice, 2-day)</span><span>' + (ship ? money(ship) : 'Free') + '</span></div>';
    foot += '<div class="cart__row cart__row--total"><span>Total</span><span>' + money(total) + '</span></div>';

    if (toFree > 0) {
      foot += '<div class="ship-bar"><i style="width:' + Math.min(100, sub / FREE_AT * 100) + '%"></i></div>';
      foot += '<p class="cart__note">' + money(toFree) + ' more for free shipping.</p>';
    }
    if (under) {
      foot += '<p class="cart__note">Add ' + (MIN_PINTS - q) + ' more pint' + (MIN_PINTS - q === 1 ? '' : 's') +
              ' — dry-ice packs do not ship below ' + MIN_PINTS + '.</p>';
    }
    foot += '<button class="btn btn--primary" type="button" data-checkout' + (under ? ' disabled' : '') + '>Checkout</button>';
    foot += '<p class="cart__msg" role="status" aria-live="polite"></p>';
    footEl.innerHTML = foot;
  }

  /* ---- Delegated cart controls ---- */
  document.addEventListener('click', function (e) {
    var dec = e.target.closest && e.target.closest('[data-dec]');
    var inc = e.target.closest && e.target.closest('[data-inc]');
    var out = e.target.closest && e.target.closest('[data-checkout]');
    if (dec) { var i = dec.getAttribute('data-dec'); setQty(i, cart[i].qty - 1); }
    if (inc) { var j = inc.getAttribute('data-inc'); setQty(j, cart[j].qty + 1); }
    if (out) checkout(out);
  });

  /* ---- Checkout ---------------------------------------------------------
     Card details are never collected here — that belongs to a PCI-compliant
     processor. Set data-checkout-endpoint on [data-cart-drawer] to a backend
     that creates a Stripe Checkout session and returns {url}; we redirect.
     ---------------------------------------------------------------------- */
  function checkout(btn) {
    var msg = footEl.querySelector('.cart__msg');
    var endpoint = drawer.getAttribute('data-checkout-endpoint');
    var items = Object.keys(cart).map(function (id) {
      return { id: id, name: cart[id].name, qty: cart[id].qty };
    });

    if (!endpoint) {
      msg.textContent = 'Checkout is not connected yet — no payment processor is wired to this store.';
      msg.setAttribute('data-state', 'err');
      return;
    }

    btn.disabled = true;
    msg.textContent = 'Redirecting to secure checkout…';
    msg.setAttribute('data-state', 'ok');

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ items: items, qty: totalQty() })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      if (!data || !data.url) throw new Error('no session url');
      window.location.href = data.url;
    }).catch(function () {
      msg.textContent = 'Could not reach checkout. Try again in a moment.';
      msg.setAttribute('data-state', 'err');
      btn.disabled = false;
    });
  }

  render();
})();
