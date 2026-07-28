/*
 * Capture -- market sizing and growth scenarios.
 *
 * Port of scvr/market.py, held to it by tests/test_web_parity.js. Measured
 * data (BLS QCEW establishment and employment counts) arrives via
 * market.data.js and is never computed here; everything this file derives is
 * modelled and reported as such.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  else { root.CaptureMarket = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MARKET_DEFAULTS = {
    enterprise_site_employment: 250.0,
    platform_penetration: 0.18,
    underperformance_rate: 0.55,
    reachable_share: 0.35,
    platform_focus_share: 0.40
  };

  var GROWTH_DEFAULTS = {
    sprint_conversion: 0.40,
    retainer_conversion: 0.50,
    audit_lead_months: 3.0,
    sprint_lag_months: 1,
    retainer_lag_months: 3,
    ramp_months: 6,
    audits_per_seller_month: 0.9,
    referral_rate: 0.25
  };

  var SCENARIO_DEFAULTS = {
    horizon_months: 36,
    starting_consultants: 2.0,
    sellers: 0.5,
    max_consultants: 8.0,
    hire_at_utilization: 0.85,
    hiring_lag_months: 2
  };

  var GO = "GO", MARGINAL = "MARGINAL", NO = "NO";

  var ASSUMPTION_LABELS = {
    enterprise_site_employment: function (v) {
      return "a site running an enterprise planning platform averages " +
        Math.round(v).toLocaleString("en-US") + " employees";
    },
    platform_penetration: function (v) {
      return pct(v) + " of enterprise-scale sites run one of the major planning platforms";
    },
    underperformance_rate: function (v) {
      return pct(v) + " of those are past go-live and not getting the value in the business case";
    },
    reachable_share: function (v) {
      return "one practice can realistically reach " + pct(v) + " of a metro";
    },
    platform_focus_share: function (v) {
      return "the practice is certified on platforms covering " + pct(v) + " of installed accounts";
    }
  };

  function pct(v) { return Math.round(v * 100) + "%"; }

  function withDefaults(defaults, overrides) {
    var out = {};
    Object.keys(defaults).forEach(function (k) { out[k] = defaults[k]; });
    Object.keys(overrides || {}).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(defaults, k) &&
          overrides[k] !== null && overrides[k] !== undefined && overrides[k] !== "") {
        out[k] = overrides[k];
      }
    });
    return out;
  }

  function bankersRound(value) {
    var floor = Math.floor(value);
    if (Math.abs(value - floor - 0.5) > 1e-9) return Math.round(value);
    return floor % 2 === 0 ? floor : floor + 1;
  }

  // --- metros ---------------------------------------------------------------

  var METROS = [];
  var INDUSTRIES = [];
  var SOURCE = {};

  function load(data) {
    METROS = (data && data.metros) || [];
    INDUSTRIES = (data && data.industries) || [];
    SOURCE = (data && data.source) || {};
  }

  function metros() { return METROS; }
  function source() { return SOURCE; }
  function industries() { return INDUSTRIES; }

  function display(metro) {
    return metro.states ? metro.name + ", " + metro.states : metro.name;
  }

  function findMetro(query) {
    var needle = String(query || "").trim().toLowerCase();
    if (!needle) return null;
    var i;
    for (i = 0; i < METROS.length; i++) {
      if (METROS[i].id.toLowerCase() === needle) return METROS[i];
    }
    for (i = 0; i < METROS.length; i++) {
      if (METROS[i].name.toLowerCase() === needle || display(METROS[i]).toLowerCase() === needle) {
        return METROS[i];
      }
    }
    var scored = [];
    METROS.forEach(function (metro) {
      var haystack = metro.full_title.toLowerCase();
      if (haystack.indexOf(needle) !== -1) {
        scored.push({ lead: haystack.indexOf(needle) === 0 ? 0 : 1, metro: metro });
      }
    });
    if (!scored.length) return null;
    scored.sort(function (a, b) {
      return (a.lead - b.lead) || (b.metro.establishments - a.metro.establishments);
    });
    return scored[0].metro;
  }

  function sizeMarket(metro, assumptions, subVertical) {
    var a = withDefaults(MARKET_DEFAULTS, assumptions);
    var keys = Object.keys(metro.industries);

    if (subVertical && INDUSTRIES.length) {
      var matching = INDUSTRIES
        .filter(function (i) { return (i.sub_verticals || []).indexOf(subVertical) !== -1; })
        .map(function (i) { return i.key; });
      if (matching.length) {
        var filtered = keys.filter(function (k) { return matching.indexOf(k) !== -1; });
        if (filtered.length) keys = filtered;
      }
    }

    var employment = 0;
    keys.forEach(function (k) {
      if (metro.industries[k]) employment += metro.industries[k].employment || 0;
    });
    var disclosed = employment > 0;
    if (!disclosed) {
      var establishments = 0;
      keys.forEach(function (k) {
        if (metro.industries[k]) establishments += metro.industries[k].establishments;
      });
      employment = establishments * 25.0;
    }

    var enterpriseSites = employment / a.enterprise_site_employment;
    var platformAccounts = enterpriseSites * a.platform_penetration;
    var underperforming = platformAccounts * a.underperformance_rate;
    var addressable = underperforming * a.reachable_share * a.platform_focus_share;

    return {
      metro: metro,
      assumptions: a,
      enterprise_sites: enterpriseSites,
      platform_accounts: platformAccounts,
      underperforming: underperforming,
      addressable: addressable,
      disclosed_employment: disclosed
    };
  }

  function rankMarkets(assumptions, subVertical, limit) {
    var sized = METROS.map(function (m) { return sizeMarket(m, assumptions, subVertical); });
    sized.sort(function (a, b) { return b.addressable - a.addressable; });
    return sized.slice(0, limit || 10);
  }

  // --- scenario -------------------------------------------------------------

  function runScenario(firm, inputs, assumptions, growthOverrides) {
    var s = withDefaults(SCENARIO_DEFAULTS, inputs);
    var marketAssumptions = withDefaults(MARKET_DEFAULTS, assumptions);
    var g = withDefaults(GROWTH_DEFAULTS, growthOverrides);
    var chosenIds = (inputs && inputs.markets) || [];
    var subVertical = (inputs && inputs.sub_vertical) || null;

    var byId = {};
    METROS.forEach(function (m) { byId[m.id] = m; });
    var sizings = chosenIds
      .filter(function (id) { return byId[id]; })
      .map(function (id) { return sizeMarket(byId[id], marketAssumptions, subVertical); });

    var accountsRemaining = sizings.reduce(function (t, x) { return t + x.addressable; }, 0);

    var weekCost = firm.loaded_cost / 47.0;
    var auditWeeks = 5.5, sprintWeeks = 20.0, retainerWeeks = 3.0;
    var auditsPerHeadMonth = (47.0 / 12.0) / auditWeeks;
    var termsMonths = Math.max(1, bankersRound(firm.payment_terms_days / 30.0));

    var consultants = s.starting_consultants;
    var pendingHires = [];
    var signed = [];
    var collections = new Array(s.horizon_months + termsMonths + 12).fill(0);
    var cash = firm.starting_cash;
    var cumulative = 0;
    var months = [];
    var exhausted = null;
    var trough = cash, troughMonth = 0;

    function bill(month, amount) {
      var index = month + termsMonths;
      if (index < collections.length) collections[index] += amount;
    }

    for (var m = 0; m < s.horizon_months; m++) {
      var ramp = Math.min(1.0, (m + 1) / Math.max(g.ramp_months, 1));
      var leadDelay = m >= g.audit_lead_months ? 1.0 : 0.0;
      var delivered = 0;
      for (var d = 0; d < Math.max(0, m - 2); d++) delivered += signed[d];
      var demand = s.sellers * g.audits_per_seller_month * ramp * leadDelay +
                   delivered * g.referral_rate / 12.0;

      var capacityWeeks = consultants * 47.0 / 12.0;
      var sprintsRunning = 0, retainersActive = 0;
      for (var i = 0; i < signed.length; i++) {
        var age = m - i;
        if (age - g.sprint_lag_months >= 0 && age - g.sprint_lag_months < 3) {
          sprintsRunning += signed[i] * g.sprint_conversion;
        }
        if (age >= g.sprint_lag_months + 3 + g.retainer_lag_months) {
          retainersActive += signed[i] * g.sprint_conversion * g.retainer_conversion;
        }
      }
      var committed = sprintsRunning * sprintWeeks / 3.0 + retainersActive * retainerWeeks;
      var freeWeeks = Math.max(0, capacityWeeks - committed);
      var deliverable = freeWeeks / auditWeeks;

      var audits = Math.max(0, Math.min(demand, deliverable, accountsRemaining));
      accountsRemaining -= audits;
      if (accountsRemaining <= 0.5 && exhausted === null && m > 0) exhausted = m + 1;
      signed.push(audits);

      var revenue = audits * firm.audit_fee +
                    sprintsRunning / 3.0 * firm.sprint_fee +
                    retainersActive * firm.retainer_monthly;
      bill(m, audits * firm.audit_fee * firm.deposit_rate);
      bill(m + 1, audits * firm.audit_fee * (1 - firm.deposit_rate));
      bill(m, sprintsRunning / 3.0 * firm.sprint_fee * firm.deposit_rate);
      bill(m + 2, sprintsRunning / 3.0 * firm.sprint_fee * (1 - firm.deposit_rate));
      bill(m, retainersActive * firm.retainer_monthly);

      var usedWeeks = committed + audits * auditWeeks;
      var deliveryCost = usedWeeks * weekCost;
      var fixed = (consultants * firm.loaded_cost + firm.overhead_annual) / 12.0;
      fixed += s.sellers * firm.loaded_cost * 0.7 / 12.0;

      var profit = revenue - fixed;
      cumulative += profit;

      cash += collections[m] - fixed;
      if (cash < trough) { trough = cash; troughMonth = m + 1; }

      var utilization = capacityWeeks ? usedWeeks / capacityWeeks : 0;

      var trailing = months.slice(-3).map(function (mo) { return mo.profit; });
      var affordable = trailing.length
        ? trailing.reduce(function (t, v) { return t + v; }, 0) / trailing.length > 0
        : false;
      var workLeft = accountsRemaining > auditsPerHeadMonth * 6;
      if (utilization > s.hire_at_utilization && consultants < s.max_consultants &&
          !pendingHires.length && workLeft && affordable) {
        pendingHires.push(m + s.hiring_lag_months);
      }
      if (pendingHires.length && pendingHires[0] <= m) {
        pendingHires.shift();
        consultants = Math.min(s.max_consultants, consultants + 1);
      }

      months.push({
        month: m + 1, audits_signed: audits, sprints_running: sprintsRunning,
        retainers_active: retainersActive, revenue: revenue, delivery_cost: deliveryCost,
        fixed_cost: fixed, profit: profit, cumulative_profit: cumulative, cash: cash,
        consultants: consultants, utilization: utilization,
        accounts_remaining: Math.max(0, accountsRemaining)
      });
    }

    var breakeven = null;
    for (var k = months.length - 1; k >= 0; k--) {
      if (months[k].cumulative_profit <= 0) {
        breakeven = (k + 1 < months.length) ? k + 2 : null;
        break;
      }
      if (k === 0) breakeven = 1;
    }
    if (breakeven !== null && breakeven > months.length) breakeven = null;

    var yearThree = months.length >= 12
      ? months.slice(-12).reduce(function (t, mo) { return t + mo.revenue; }, 0) : 0;

    var judged = judge(months, sizings, breakeven, trough, s, firm, exhausted);

    return {
      inputs: s, market: marketAssumptions, growth: g, months: months, sizings: sizings,
      verdict: judged.verdict, reasons: judged.reasons, breakeven_month: breakeven,
      cash_trough: trough, cash_trough_month: troughMonth,
      peak_consultants: months.length
        ? Math.max.apply(null, months.map(function (mo) { return mo.consultants; })) : 0,
      year_three_revenue: yearThree,
      total_revenue: months.reduce(function (t, mo) { return t + mo.revenue; }, 0),
      addressable: sizings.reduce(function (t, x) { return t + x.addressable; }, 0),
      market_exhausted_month: exhausted
    };
  }

  function money(v) {
    var abs = Math.abs(v), sign = v < 0 ? "-" : "";
    return sign + "$" + Math.round(abs).toLocaleString("en-US");
  }

  function judge(months, sizings, breakeven, trough, inputs, firm, exhausted) {
    var reasons = [];
    var fatal = false, marginal = false;

    if (!sizings.length) return { verdict: NO, reasons: ["No market selected."] };

    var addressable = sizings.reduce(function (t, x) { return t + x.addressable; }, 0);
    var auditsNeeded = months.reduce(function (t, mo) { return t + mo.audits_signed; }, 0);

    if (breakeven === null) {
      fatal = true;
      reasons.push("Never breaks even inside the horizon. The mix does not cover fixed cost " +
        "at any point, so this is a plan to lose money slowly.");
    } else if (breakeven > 24) {
      marginal = true;
      reasons.push("Breaks even in month " + breakeven + ". Past two years is a long time to " +
        "fund a bet on one metro.");
    } else {
      reasons.push("Breaks even in month " + breakeven + " on cumulative profit.");
    }

    if (addressable < auditsNeeded * 1.5) {
      marginal = true;
      reasons.push("The market holds about " + addressable.toFixed(0) + " addressable accounts " +
        "and the plan consumes " + auditsNeeded.toFixed(0) + " of them. Thin: you would be " +
        "re-selling the same logos by year three.");
    } else {
      reasons.push("About " + addressable.toFixed(0) + " addressable accounts against " +
        auditsNeeded.toFixed(0) + " consumed, so the metro does not run dry inside the horizon.");
    }

    if (exhausted) {
      marginal = true;
      reasons.push("Market runs out in month " + exhausted + "; add a second metro before then.");
    }

    if (trough < 0) {
      var need = Math.ceil(Math.abs(trough) / 25000) * 25000;
      if (need > firm.starting_cash) marginal = true;
      reasons.push("Cash troughs at " + money(trough) + ". Arrange a " + money(need) +
        " line before you need it, not when the first invoice ages past sixty days.");
    } else {
      reasons.push("Cash never goes negative; low point is " + money(trough) + ".");
    }

    var trailingProfit = months.slice(-6).reduce(function (t, mo) { return t + mo.profit; }, 0);
    if (trailingProfit < 0) {
      marginal = true;
      reasons.push("The last six months run at a " + money(trailingProfit / 6) + "/month loss -- " +
        "the cost base outgrew what this market can feed. Cut the hiring plan or add a metro.");
    }

    var peakUtilization = months.length
      ? Math.max.apply(null, months.map(function (mo) { return mo.utilization; })) : 0;
    if (peakUtilization > 0.95) {
      marginal = true;
      reasons.push("Utilization peaks at " + pct(peakUtilization) + ". Above 95% there is no " +
        "slack for an engagement running long, and fixed-scope work always does.");
    }

    if (months.some(function (mo) { return mo.consultants >= inputs.max_consultants; })) {
      reasons.push("Hits the " + inputs.max_consultants.toFixed(0) + "-consultant ceiling, so " +
        "growth after that is a hiring decision, not a market one.");
    }

    return { verdict: fatal ? NO : (marginal ? MARGINAL : GO), reasons: reasons };
  }

  function assumptionNotes(assumptions) {
    var a = withDefaults(MARKET_DEFAULTS, assumptions);
    return Object.keys(ASSUMPTION_LABELS).map(function (key) {
      return { key: key, value: a[key], text: ASSUMPTION_LABELS[key](a[key]) };
    });
  }

  return {
    MARKET_DEFAULTS: MARKET_DEFAULTS,
    GROWTH_DEFAULTS: GROWTH_DEFAULTS,
    SCENARIO_DEFAULTS: SCENARIO_DEFAULTS,
    GO: GO, MARGINAL: MARGINAL, NO: NO,
    load: load, metros: metros, source: source, industries: industries,
    display: display, findMetro: findMetro, sizeMarket: sizeMarket, rankMarkets: rankMarkets,
    runScenario: runScenario, assumptionNotes: assumptionNotes
  };
});
