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
