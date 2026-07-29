/* Guiltless — site behaviour. No dependencies. */
(function () {
  'use strict';

  /* ---- Theme toggle (persisted) ---------------------------------------- */
  var root = document.documentElement;
  var KEY = 'guiltless-theme';

  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) { /* storage blocked — fall back to OS preference */ }

  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
    navBtn.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      navBtn.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        navBtn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        nav.classList.remove('is-open');
        navBtn.setAttribute('aria-expanded', 'false');
        navBtn.focus();
      }
    });
  }

  /* ---- Sticky header hairline ------------------------------------------ */
  var head = document.querySelector('.site-head');
  if (head) {
    var onScroll = function () {
      head.classList.toggle('is-stuck', window.scrollY > 8);
    };
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

  /* ---- Waitlist form ---------------------------------------------------- */
  /* No backend is wired up yet. Rather than silently dropping the address,
     hand off to the mail client and tell the visitor exactly what happened. */
  document.querySelectorAll('[data-waitlist]').forEach(function (form) {
    var msg = form.parentNode.querySelector('.form__msg');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('input[type="email"]');
      var email = (input.value || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (msg) { msg.textContent = 'That address does not look right — check it and try again.'; msg.setAttribute('data-state', 'err'); }
        input.focus();
        return;
      }
      var to = form.getAttribute('data-waitlist') || 'hello@guiltless.example';
      var subject = encodeURIComponent('Guiltless waitlist');
      var body = encodeURIComponent('Add me to the Guiltless waitlist: ' + email);
      window.location.href = 'mailto:' + to + '?subject=' + subject + '&body=' + body;
      if (msg) {
        msg.textContent = 'Opening your email app to confirm — send the draft and you are on the list.';
        msg.setAttribute('data-state', 'ok');
      }
      form.reset();
    });
  });

  /* ---- Footer year ------------------------------------------------------ */
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
})();
