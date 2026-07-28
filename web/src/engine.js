/*
 * Capture -- audit engine.
 *
 * A faithful port of the Python package in `scvr/`. The two implementations
 * are held together by tests/test_web_parity.js, which runs both over the same
 * engagement files and fails on any divergence beyond floating-point noise.
 * Constant names are kept identical to the Python so the files can be read
 * side by side.
 *
 * Runs in the browser (attaches to window.CaptureEngine) and in node (exports
 * via module.exports), with no dependencies in either.
 */
(function (root, factory) {
  var engine = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = engine;
  } else {
    root.CaptureEngine = engine;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // --- constants shared with scvr/model.py ---------------------------------

  var NOT_ASSESSED = "not_assessed";
  var NOT_LICENSED = "not_licensed";
  var LICENSED_UNUSED = "licensed_unused";
  var DEPLOYED_UNUSED = "deployed_unused";
  var PARTIAL = "partial";
  var FULL = "full";

  var USAGE_STATES = [
    NOT_ASSESSED, NOT_LICENSED, LICENSED_UNUSED, DEPLOYED_UNUSED, PARTIAL, FULL
  ];

  var USAGE_SCORE = {};
  USAGE_SCORE[NOT_LICENSED] = 0.0;
  USAGE_SCORE[LICENSED_UNUSED] = 0.0;
  USAGE_SCORE[DEPLOYED_UNUSED] = 0.10;
  USAGE_SCORE[PARTIAL] = 0.50;
  USAGE_SCORE[FULL] = 1.0;

  var LICENSED_STATES = [LICENSED_UNUSED, DEPLOYED_UNUSED, PARTIAL, FULL];

  var STATE_LABEL = {
    not_assessed: "Not assessed",
    not_licensed: "Not licensed",
    licensed_unused: "Licensed, unused",
    deployed_unused: "Configured, idle",
    partial: "Partly used",
    full: "Fully used"
  };

  var REVENUE_BANDS = [
    [250e6, "under_250m"],
    [1e9, "250m_1b"],
    [5e9, "1b_5b"],
    [Infinity, "over_5b"]
  ];

  var BAND_LABEL = {
    under_250m: "under $250M",
    "250m_1b": "$250M-$1B",
    "1b_5b": "$1B-$5B",
    over_5b: "over $5B"
  };

  function revenueBand(annualRevenue) {
    for (var i = 0; i < REVENUE_BANDS.length; i++) {
      if (annualRevenue < REVENUE_BANDS[i][0]) return REVENUE_BANDS[i][1];
    }
    return "over_5b";
  }

  // --- math ----------------------------------------------------------------

  // Acklam's inverse normal CDF. Relative error < 1.15e-9, which keeps the
  // safety-stock model inside parity tolerance of Python's NormalDist.
  function invNorm(p) {
    if (p <= 0 || p >= 1) throw new Error("invNorm expects 0 < p < 1");
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
    var pLow = 0.02425, pHigh = 1 - pLow, q, r;
    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > pHigh) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
              ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  function percentile(values, q) {
    if (!values.length) throw new Error("no values");
    var ordered = values.slice().sort(function (x, y) { return x - y; });
    if (ordered.length === 1) return ordered[0];
    var pos = q * (ordered.length - 1);
    var lo = Math.floor(pos);
    var hi = Math.min(lo + 1, ordered.length - 1);
    var frac = pos - lo;
    return ordered[lo] * (1 - frac) + ordered[hi] * frac;
  }

  function median(values) { return percentile(values, 0.5); }

  function round(value, places) {
    var factor = Math.pow(10, places || 0);
    return Math.round(value * factor) / factor;
  }

  function clamp(value, low, high) { return Math.min(Math.max(value, low), high); }

  // Python's round() breaks ties to even; Math.round() breaks them upward. Fee
  // rounding lands on an exact .5 often enough that the difference is visible,
  // so match the reference implementation.
  function bankersRound(value) {
    var floor = Math.floor(value);
    var diff = value - floor;
    if (Math.abs(diff - 0.5) > 1e-9) return Math.round(value);
    return floor % 2 === 0 ? floor : floor + 1;
  }

  function roundTo(value, step) { return bankersRound(value / step) * step; }

  // --- catalog access ------------------------------------------------------

  var CATALOGS = {};       // populated by loadCatalogs()
  var PLATFORM_NAMES = {};

  function loadCatalogs(data, names) {
    CATALOGS = data;
    PLATFORM_NAMES = names || {};
  }

  function getCatalog(platform) {
    var caps = CATALOGS[platform];
    if (!caps) throw new Error("unknown platform " + platform);
    return caps;
  }

  function getCapability(platform, id) {
    var caps = getCatalog(platform);
    for (var i = 0; i < caps.length; i++) if (caps[i].id === id) return caps[i];
    return null;
  }

  function platforms() { return Object.keys(CATALOGS).sort(); }

  // --- adoption (scvr/adoption.py) -----------------------------------------

  function stateOf(engagement, id) {
    var caps = engagement.capabilities || {};
    return Object.prototype.hasOwnProperty.call(caps, id) ? caps[id] : NOT_ASSESSED;
  }

  function profileAdoption(engagement) {
    var platform = engagement.client.platform;
    var lines = getCatalog(platform).map(function (cap) {
      var state = stateOf(engagement, cap.id);
      var usage = Object.prototype.hasOwnProperty.call(USAGE_SCORE, state) ? USAGE_SCORE[state] : 0;
      return {
        capability: cap,
        state: state,
        licensed: LICENSED_STATES.indexOf(state) !== -1,
        assessed: state !== NOT_ASSESSED,
        usageScore: usage,
        capturedValue: cap.value_weight * usage,
        gapValue: LICENSED_STATES.indexOf(state) !== -1 ? cap.value_weight * (1 - usage) : 0
      };
    });

    var licensedLines = lines.filter(function (l) { return l.licensed; });
    var assessedLines = lines.filter(function (l) { return l.assessed; });
    var licensedWeight = licensedLines.reduce(function (t, l) { return t + l.capability.value_weight; }, 0);
    var capturedWeight = licensedLines.reduce(function (t, l) { return t + l.capturedValue; }, 0);
    var assessedWeight = assessedLines.reduce(function (t, l) { return t + l.capability.value_weight; }, 0);

    var deadWeight = licensedLines.reduce(function (t, l) {
      return t + (l.usageScore <= USAGE_SCORE[DEPLOYED_UNUSED] ? l.capability.value_weight : 0);
    }, 0);

    var byModule = {};
    licensedLines.forEach(function (l) {
      var row = byModule[l.capability.module] ||
        (byModule[l.capability.module] = { licensed_weight: 0, captured_weight: 0, capabilities: 0 });
      row.licensed_weight += l.capability.value_weight;
      row.captured_weight += l.capturedValue;
      row.capabilities += 1;
    });
    Object.keys(byModule).forEach(function (module) {
      var row = byModule[module];
      row.capture_rate = row.licensed_weight ? row.captured_weight / row.licensed_weight : 0;
      row.module = module;
    });

    var byDriver = {};
    licensedLines.forEach(function (l) {
      if (l.gapValue) byDriver[l.capability.value_driver] = (byDriver[l.capability.value_driver] || 0) + l.gapValue;
    });

    var dormant = licensedLines
      .filter(function (l) { return l.usageScore < 0.5; })
      .sort(function (a, b) {
        return (b.gapValue - a.gapValue) ||
               (a.capability.activation_effort_weeks - b.capability.activation_effort_weeks);
      });

    var scoreById = {};
    lines.forEach(function (l) { scoreById[l.capability.id] = l.usageScore; });

    var blocked = [];
    dormant.forEach(function (l) {
      var unmet = (l.capability.prerequisites || []).filter(function (p) {
        return (scoreById[p] || 0) < 0.5;
      });
      if (unmet.length) blocked.push({ line: l, unmet: unmet });
    });

    return {
      lines: lines,
      licensedLines: licensedLines,
      assessedLines: assessedLines,
      licensedWeight: licensedWeight,
      capturedWeight: capturedWeight,
      captureRate: licensedWeight ? capturedWeight / licensedWeight : 0,
      catalogCaptureRate: assessedWeight
        ? assessedLines.reduce(function (t, l) { return t + l.capturedValue; }, 0) / assessedWeight
        : 0,
      assessmentCoverage: lines.length ? assessedLines.length / lines.length : 0,
      licenseWasteShare: licensedWeight ? deadWeight / licensedWeight : 0,
      byModule: Object.keys(byModule).map(function (m) { return byModule[m]; }),
      byDriver: byDriver,
      dormant: dormant,
      blocked: blocked
    };
  }

  // --- leakage (scvr/leakage.py) -------------------------------------------

  var HOURS_PER_FTE_YEAR = 1880.0;

  var EVIDENCE_BANDS = {
    measured: [0.85, 0.20],
    estimated: [0.60, 0.40],
    anecdotal: [0.35, 0.65]
  };

  var DEFAULTS = {
    carrying_cost_rate: 0.22,
    service_level_target: 0.95,
    gross_margin_pct: 0.25,
    expedite_premium_pct: 0.35,
    exception_automation_rate: 0.0,
    override_value_add_rate: 0.25,
    attainable_mape_ratio: 0.75,
    attainable_mape_floor: 0.10
  };

  var RECOVERY = {
    exception_handling: 0.55,
    forecast_inventory: 0.70,
    planner_override: 0.50,
    expedite_freight: 0.40,
    stockout_margin: 0.35,
    excess_obsolete: 0.30,
    data_quality_tax: 0.50
  };

  var CAPABILITY_ROLES = {
    exception_automation: {
      blue_yonder: ["by.ct.exception_mgmt", "by.ct.playbooks"],
      o9: ["o9.ct.exception_mgmt", "o9.ct.playbooks"],
      kinaxis: ["kx.ct.alerts", "kx.ct.playbooks"]
    },
    forecast_quality: {
      blue_yonder: ["by.dp.stat_forecast", "by.dp.segmentation", "by.dp.demand_sensing"],
      o9: ["o9.dp.stat_forecast", "o9.dp.demand_sensing", "o9.dp.consensus"],
      kinaxis: ["kx.dp.stat_forecast", "kx.dp.consensus"]
    },
    inventory_policy: {
      blue_yonder: ["by.io.safety_stock", "by.io.meio"],
      o9: ["o9.io.meio"],
      kinaxis: ["kx.io.safety_stock", "kx.io.meio"]
    },
    plan_trust: {
      blue_yonder: ["by.sp.master_planning", "by.sp.sop"],
      o9: ["o9.ibp.scenario", "o9.dp.consensus"],
      kinaxis: ["kx.sim.scenario", "kx.dp.consensus"]
    },
    freight_optimization: {
      blue_yonder: ["by.tms.load_build", "by.tms.routing", "by.tms.rate_engine"],
      o9: [],
      kinaxis: []
    },
    service_reliability: {
      blue_yonder: ["by.sp.master_planning", "by.oms.atp", "by.io.meio"],
      o9: ["o9.sp.constrained", "o9.sp.allocation"],
      kinaxis: ["kx.sp.constrained", "kx.of.atp", "kx.sp.clear_to_build"]
    },
    inventory_health: {
      blue_yonder: ["by.io.meio", "by.dp.segmentation"],
      o9: ["o9.io.meio", "o9.dp.attribute_forecast"],
      kinaxis: ["kx.io.meio", "kx.sp.clear_to_build"]
    },
    data_foundation: {
      blue_yonder: [],
      o9: ["o9.kg.knowledge_graph"],
      kinaxis: ["kx.dm.data_quality"]
    }
  };

  function capabilitiesForRole(platform, role) {
    var byPlatform = CAPABILITY_ROLES[role] || {};
    return byPlatform[platform] || [];
  }

  function MissingInputs(names) { this.names = names; }

  function need(ops, names) {
    var missing = names.filter(function (n) {
      return ops[n] === undefined || ops[n] === null || ops[n] === "";
    });
    if (missing.length) throw new MissingInputs(missing);
    return names.map(function (n) { return Number(ops[n]); });
  }

  function optional(ops, name) {
    var value = ops[name];
    return (value === undefined || value === null || value === "") ? null : Number(value);
  }

  function money(x) {
    return "$" + Math.round(x).toLocaleString("en-US");
  }

  function pct(x, digits) {
    return (x * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  function hourly(ops) {
    return need(ops, ["planner_loaded_cost"])[0] / HOURS_PER_FTE_YEAR;
  }

  var MODELS = [
    {
      id: "exception_handling",
      name: "Manual exception handling",
      plain: "Planners clearing alerts by hand that the system could clear for them.",
      driver: "labor",
      role: "exception_automation",
      category: "operational",
      compute: function (ctx) {
        var ops = ctx.ops;
        var v = need(ops, ["exceptions_per_week", "minutes_per_exception"]);
        var rate = hourly(ops);
        var assumptions = [];
        var automation = optional(ops, "exception_automation_rate");
        if (automation === null) {
          automation = DEFAULTS.exception_automation_rate;
          assumptions.push("no measured automation rate; assumed 0% auto-dispositioned");
        }
        var annualHours = v[0] * (v[1] / 60) * 52 * (1 - automation);
        var gross = annualHours * rate;
        assumptions.push(pct(RECOVERY.exception_handling) +
          " of exception volume is rules-dispositionable based on prior engagements");
        assumptions.push("recovered hours are planner capacity redeployed, not headcount removed, " +
          "unless the client commits to the reduction");
        return {
          gross: gross,
          recoverable: gross * RECOVERY.exception_handling,
          basis: v[0].toLocaleString("en-US") + " exceptions/wk x " + v[1] + " min x 52 wk x (1 - " +
            pct(automation) + " automated) = " + Math.round(annualHours).toLocaleString("en-US") +
            " planner-hours/yr at " + money(rate) + "/hr",
          assumptions: assumptions
        };
      }
    },
    {
      id: "forecast_inventory",
      name: "Forecast error carried as inventory",
      plain: "Extra stock held purely to absorb a forecast that misses more than it needs to.",
      driver: "inventory",
      role: "forecast_quality",
      category: "operational",
      compute: function (ctx) {
        var ops = ctx.ops;
        var v = need(ops, ["annual_cogs", "forecast_mape", "avg_lead_time_weeks"]);
        var cogs = v[0], mape = v[1], leadTime = v[2];
        var assumptions = [];

        var attainable = optional(ops, "attainable_mape");
        if (attainable === null) {
          attainable = Math.max(mape * DEFAULTS.attainable_mape_ratio, DEFAULTS.attainable_mape_floor);
          assumptions.push("attainable MAPE not established; assumed " + pct(attainable) +
            " (75% of current, floored at " + pct(DEFAULTS.attainable_mape_floor) + ")");
        }
        attainable = Math.min(attainable, mape);

        var service = optional(ops, "service_level_target");
        if (service === null) {
          service = DEFAULTS.service_level_target;
          assumptions.push("service level target assumed " + pct(service));
        }
        var carrying = optional(ops, "carrying_cost_rate");
        if (carrying === null) {
          carrying = DEFAULTS.carrying_cost_rate;
          assumptions.push("carrying cost rate assumed " + pct(carrying));
        }

        var z = invNorm(clamp(service, 0.5, 0.9999));
        var weeklyCogs = cogs / 52;
        var excess = z * Math.sqrt(leadTime) * weeklyCogs * (mape - attainable);

        var onHand = optional(ops, "inventory_value");
        if (onHand !== null) {
          var cap = 0.5 * onHand;
          if (excess > cap) {
            assumptions.push("raw estimate capped at 50% of on-hand inventory (" + money(cap) +
              ") to keep the claim defensible");
            excess = cap;
          }
        }

        var gross = excess * carrying;
        assumptions.push("MAPE used as a proxy for the coefficient of variation of forecast error; " +
          "confirm against actual error distribution before quoting externally");
        return {
          gross: gross,
          recoverable: gross * RECOVERY.forecast_inventory,
          basis: "safety stock delta = z(" + service.toFixed(2) + ")=" + z.toFixed(2) + " x sqrt(" +
            leadTime.toFixed(1) + " wk) x " + money(weeklyCogs) + "/wk COGS x (" + pct(mape) + " - " +
            pct(attainable) + ") = " + money(excess) + " excess inventory, carried at " + pct(carrying),
          assumptions: assumptions
        };
      }
    },
    {
      id: "planner_override",
      name: "Planner override erosion",
      plain: "The business case evaporating because planners overrule the system's plan.",
      driver: "cycle_time",
      role: "plan_trust",
      category: "operational",
      compute: function (ctx) {
        var ops = ctx.ops;
        var overrideRate = need(ops, ["planner_override_rate"])[0];
        var benefit = ctx.client.business_case_annual_benefit;
        if (benefit === undefined || benefit === null || benefit === "") {
          throw new MissingInputs(["client.business_case_annual_benefit"]);
        }
        benefit = Number(benefit);
        var assumptions = [];
        var valueAdd = optional(ops, "override_value_add_rate");
        if (valueAdd === null) {
          valueAdd = DEFAULTS.override_value_add_rate;
          assumptions.push("assumed " + pct(valueAdd) + " of overrides improve on the system plan " +
            "(planners do know things the model does not)");
        }
        var gross = benefit * overrideRate * (1 - valueAdd);
        assumptions.push("erosion is measured against the original business case, so it inherits " +
          "whatever optimism was in that case -- restate the case if it was never validated");
        return {
          gross: gross,
          recoverable: gross * RECOVERY.planner_override,
          basis: money(benefit) + " business-case benefit x " + pct(overrideRate) +
            " override rate x (1 - " + pct(valueAdd) + " value-adding overrides)",
          assumptions: assumptions
        };
      }
    },
    {
      id: "expedite_freight",
      name: "Expedite freight premium",
      plain: "Premium paid to move freight fast because the plan saw the need too late.",
      driver: "freight",
      role: "freight_optimization",
      category: "operational",
      compute: function (ctx) {
        var ops = ctx.ops;
        var v = need(ops, ["annual_freight_spend", "expedite_share"]);
        var assumptions = [];
        var premium = optional(ops, "expedite_premium_pct");
        if (premium === null) {
          premium = DEFAULTS.expedite_premium_pct;
          assumptions.push("expedite premium assumed " + pct(premium) + " over contract rate");
        }
        var gross = v[0] * v[1] * premium;
        assumptions.push("only the planning-driven share of expedites is addressable; " +
          "supplier failures and demand spikes are not");
        return {
          gross: gross,
          recoverable: gross * RECOVERY.expedite_freight,
          basis: money(v[0]) + " freight x " + pct(v[1]) + " expedited x " + pct(premium) + " premium",
          assumptions: assumptions
        };
      }
    },
    {
      id: "stockout_margin",
      name: "Stockout lost margin",
      plain: "Orders that could not be filled, valued at the margin they would have earned.",
      driver: "service",
      role: "service_reliability",
      category: "operational",
      compute: function (ctx) {
        var ops = ctx.ops;
        var stockout = need(ops, ["stockout_rate"])[0];
        var revenue = Number(ctx.client.annual_revenue);
        var assumptions = [];
        var margin = optional(ops, "gross_margin_pct");
        if (margin === null) {
          margin = DEFAULTS.gross_margin_pct;
          assumptions.push("gross margin assumed " + pct(margin));
        }
        var gross = revenue * stockout * margin;
        assumptions.push("assumes lost lines are truly lost, not deferred; substitution within the " +
          "catalogue reduces this materially");
        return {
          gross: gross,
          recoverable: gross * RECOVERY.stockout_margin,
          basis: money(revenue) + " revenue x " + pct(stockout) + " lost-sale rate x " +
            pct(margin) + " margin",
          assumptions: assumptions
        };
      }
    },
    {
      id: "excess_obsolete",
      name: "Excess & obsolete write-off",
      plain: "Stock written off because the plan reacted to the decline too slowly.",
      driver: "inventory",
      role: "inventory_health",
      category: "operational",
      compute: function (ctx) {
        var writeoff = need(ctx.ops, ["excess_obsolete_writeoff"])[0];
        return {
          gross: writeoff,
          recoverable: writeoff * RECOVERY.excess_obsolete,
          basis: money(writeoff) + " annual E&O write-off",
          assumptions: ["only the share of write-off attributable to planning latency is addressable; " +
            "product end-of-life and quality holds are not"]
        };
      }
    },
    {
      id: "data_quality_tax",
      name: "Master data rework tax",
      plain: "Hours spent fixing data the system should never have accepted.",
      driver: "data",
      role: "data_foundation",
      category: "operational",
      compute: function (ctx) {
        var ops = ctx.ops;
        var hours = need(ops, ["data_rework_hours_per_week"])[0];
        var rate = hourly(ops);
        var gross = hours * 52 * rate;
        return {
          gross: gross,
          recoverable: gross * RECOVERY.data_quality_tax,
          basis: hours.toFixed(1) + " rework hrs/wk x 52 at " + money(rate) + "/hr",
          assumptions: [
            "assumes rework is eliminated by validation at source, not moved upstream",
            "if master data accuracy is below the qualification threshold this is a data programme, " +
            "not a remediation sprint -- see the qualification gate"
          ]
        };
      }
    },
    {
      id: "license_waste",
      name: "Idle subscription cost",
      plain: "Subscription paid every year for capability that produces nothing.",
      driver: "margin",
      role: "data_foundation",
      category: "license",
      compute: function (ctx) {
        var fee = ctx.client.annual_license_fee;
        if (fee === undefined || fee === null || fee === "") {
          throw new MissingInputs(["client.annual_license_fee"]);
        }
        fee = Number(fee);
        var deadShare = ctx.adoption.licenseWasteShare;
        return {
          gross: fee * deadShare,
          recoverable: 0,
          basis: money(fee) + " annual subscription x " + pct(deadShare) +
            " of value-weighted licensed capability sitting idle",
          assumptions: ["subscription cost attached to capability producing nothing; it is not cash " +
            "recoverable without a renewal renegotiation, so it is excluded from the recovery total " +
            "and shown as sunk spend"]
        };
      }
    }
  ];

  function evidenceFor(engagement, modelId) {
    var evidence = engagement.evidence || {};
    return evidence[modelId] || evidence["default"] || "estimated";
  }

  function assessLeakage(engagement, adoption) {
    var ctx = {
      client: engagement.client,
      ops: engagement.operations || {},
      adoption: adoption
    };
    var estimates = [];
    var skipped = [];

    MODELS.forEach(function (model) {
      var raw;
      try {
        raw = model.compute(ctx);
      } catch (err) {
        if (err instanceof MissingInputs) {
          skipped.push({ model_id: model.id, name: model.name, missing: err.names, plain: model.plain });
          return;
        }
        throw err;
      }
      var evidence = evidenceFor(engagement, model.id);
      var band = EVIDENCE_BANDS[evidence] || EVIDENCE_BANDS.estimated;
      estimates.push({
        model_id: model.id,
        name: model.name,
        plain: model.plain,
        driver: model.driver,
        category: model.category,
        gross_annual: raw.gross,
        recoverable_annual: raw.recoverable,
        low: raw.recoverable * (1 - band[1]),
        high: raw.recoverable * (1 + band[1]),
        confidence: band[0],
        evidence: evidence,
        basis: raw.basis,
        assumptions: raw.assumptions,
        linked_capabilities: capabilitiesForRole(engagement.client.platform, model.role)
      });
    });

    var operational = estimates.filter(function (e) { return e.category === "operational"; });
    var sum = function (list, key) {
      return list.reduce(function (t, e) { return t + e[key]; }, 0);
    };
    var byDriver = {};
    operational.forEach(function (e) {
      byDriver[e.driver] = (byDriver[e.driver] || 0) + e.recoverable_annual;
    });

    return {
      estimates: estimates,
      skipped: skipped,
      operational: operational,
      ranked: operational.slice().sort(function (a, b) {
        return b.recoverable_annual - a.recoverable_annual;
      }),
      grossTotal: sum(operational, "gross_annual"),
      recoverableTotal: sum(operational, "recoverable_annual"),
      recoverableLow: sum(operational, "low"),
      recoverableHigh: sum(operational, "high"),
      licenseWaste: sum(estimates.filter(function (e) { return e.category === "license"; }), "gross_annual"),
      byDriver: byDriver
    };
  }

  // --- qualification (scvr/qualify.py) -------------------------------------

  var PASS = "pass", WARN = "warn", BLOCK = "block";
  var GO = "GO", CONDITIONAL = "CONDITIONAL", WALK_AWAY = "WALK_AWAY";

  var MASTER_DATA_BLOCK = 0.75;
  var MASTER_DATA_WARN = 0.90;
  var MIN_LIVE_MONTHS = 9;
  var INTERFACE_FAILURE_BLOCK = 0.10;
  var MIN_DATA_COVERAGE = 0.35;
  var MIN_ASSESSMENT_COVERAGE = 0.60;

  var OPERATIONS_FIELDS = [
    "annual_cogs", "gross_margin_pct", "inventory_value", "carrying_cost_rate",
    "excess_obsolete_writeoff", "forecast_mape", "attainable_mape", "avg_lead_time_weeks",
    "service_level_target", "exceptions_per_week", "minutes_per_exception",
    "exception_automation_rate", "planner_loaded_cost", "planner_override_rate",
    "override_value_add_rate", "annual_freight_spend", "expedite_share",
    "expedite_premium_pct", "stockout_rate", "otif_pct", "master_data_accuracy",
    "data_rework_hours_per_week", "interface_failure_rate"
  ];

  function providedMetrics(engagement) {
    var ops = engagement.operations || {};
    return OPERATIONS_FIELDS.filter(function (f) {
      return ops[f] !== undefined && ops[f] !== null && ops[f] !== "";
    });
  }

  function missingMetrics(engagement) {
    var provided = providedMetrics(engagement);
    return OPERATIONS_FIELDS.filter(function (f) { return provided.indexOf(f) === -1; });
  }

  function qualify(engagement, adoption) {
    var ops = engagement.operations || {};
    var gov = engagement.governance || {};
    var checks = [];

    var accuracy = optional(ops, "master_data_accuracy");
    if (accuracy === null) {
      checks.push({ id: "master_data", verdict: WARN,
        finding: "Master data accuracy has never been measured.",
        remedy: "Include a two-week data profiling step before committing to sprint scope." });
    } else if (accuracy < MASTER_DATA_BLOCK) {
      checks.push({ id: "master_data", verdict: BLOCK,
        finding: "Master data accuracy " + pct(accuracy, 0) + " is below the " +
          pct(MASTER_DATA_BLOCK, 0) + " floor -- no planning remediation survives this",
        remedy: "Refer to a data remediation programme; revisit in 6-12 months." });
    } else if (accuracy < MASTER_DATA_WARN) {
      checks.push({ id: "master_data", verdict: WARN,
        finding: "Master data accuracy " + pct(accuracy, 0) + " is workable but will limit results.",
        remedy: "Scope a data clean-up work package inside the sprint and baseline it separately." });
    } else {
      checks.push({ id: "master_data", verdict: PASS,
        finding: "Master data accuracy " + pct(accuracy, 0) + ".", remedy: "" });
    }

    var months = Number(engagement.client.live_months || 0);
    if (months < MIN_LIVE_MONTHS) {
      checks.push({ id: "maturity", verdict: BLOCK,
        finding: "Platform has been live " + months +
          " months -- this is still implementation, not value realization",
        remedy: "Revisit after two full planning cycles post go-live." });
    } else {
      checks.push({ id: "maturity", verdict: PASS,
        finding: "Live " + months + " months; past the stabilisation window.", remedy: "" });
    }

    var sponsor = (gov.executive_sponsor || "").trim();
    if (!sponsor) {
      checks.push({ id: "sponsor", verdict: BLOCK,
        finding: "No named executive sponsor -- findings will have nowhere to land",
        remedy: "Do not start without a named VP Supply Chain or COO owner." });
    } else {
      var lowered = sponsor.toLowerCase();
      var operational = ["supply chain", "operations", "coo", "logistics", "fulfil", "planning"]
        .some(function (token) { return lowered.indexOf(token) !== -1; });
      if (!operational) {
        checks.push({ id: "sponsor", verdict: WARN,
          finding: "Sponsor is " + sponsor + "; the buyer who signed the original contract has ego " +
            "invested in calling it a success.",
          remedy: "Secure a co-sponsor who lives with the platform daily." });
      } else {
        checks.push({ id: "sponsor", verdict: PASS, finding: "Sponsor: " + sponsor + ".", remedy: "" });
      }
    }

    var baselineMonths = Number(gov.baseline_period_months || 0);
    if (!gov.documented_baseline) {
      checks.push({ id: "baseline", verdict: WARN,
        finding: "No documented performance baseline -- outcomes cannot be proven, " +
          "which is the entire product.",
        remedy: "Establish and sign off a baseline as engagement step one." });
    } else if (baselineMonths < 3) {
      checks.push({ id: "baseline", verdict: WARN,
        finding: "Baseline covers only " + baselineMonths +
          " months; seasonality will swamp the measured delta.",
        remedy: "Extend the baseline to at least 3 months, ideally 6." });
    } else {
      checks.push({ id: "baseline", verdict: PASS,
        finding: "Baseline documented over " + baselineMonths + " months.", remedy: "" });
    }

    var interfaceRate = optional(ops, "interface_failure_rate");
    if (interfaceRate === null) {
      checks.push({ id: "integration", verdict: PASS,
        finding: "Interface failure rate not reported; no signal either way.", remedy: "" });
    } else if (interfaceRate > INTERFACE_FAILURE_BLOCK) {
      checks.push({ id: "integration", verdict: BLOCK,
        finding: "Interface failure rate " + pct(interfaceRate, 0) +
          " -- the platform is not receiving reliable data and no tuning will fix that",
        remedy: "Integration stabilisation first, by whoever owns the middleware." });
    } else {
      checks.push({ id: "integration", verdict: PASS,
        finding: "Interface failure rate " + pct(interfaceRate, 0) + ".", remedy: "" });
    }

    var provided = providedMetrics(engagement).length;
    var coverage = OPERATIONS_FIELDS.length ? provided / OPERATIONS_FIELDS.length : 0;
    if (coverage < MIN_DATA_COVERAGE) {
      checks.push({ id: "data_coverage", verdict: WARN,
        finding: "Only " + pct(coverage, 0) + " of operating metrics supplied; most leakage models " +
          "will be unquantifiable.",
        remedy: "Get the metric pack completed before the fee is fixed." });
    } else {
      checks.push({ id: "data_coverage", verdict: PASS,
        finding: pct(coverage, 0) + " of operating metrics supplied.", remedy: "" });
    }

    if (adoption.assessmentCoverage < MIN_ASSESSMENT_COVERAGE) {
      checks.push({ id: "assessment_coverage", verdict: WARN,
        finding: "Only " + pct(adoption.assessmentCoverage, 0) + " of the platform catalog has been " +
          "assessed; the capture rate is provisional.",
        remedy: "Complete the capability walkthrough with the platform owner." });
    } else {
      checks.push({ id: "assessment_coverage", verdict: PASS,
        finding: pct(adoption.assessmentCoverage, 0) + " of the catalog assessed.", remedy: "" });
    }

    var attempts = Number(gov.prior_remediation_attempts || 0);
    if (attempts >= 2) {
      checks.push({ id: "prior_attempts", verdict: WARN,
        finding: attempts + " previous remediation attempts have failed; the blocker is probably " +
          "organisational, not technical.",
        remedy: "Diagnose why the last attempt failed before scoping this one." });
    } else {
      checks.push({ id: "prior_attempts", verdict: PASS,
        finding: attempts + " prior remediation attempt" + (attempts === 1 ? "" : "s") + ".",
        remedy: "" });
    }

    var blocks = checks.filter(function (c) { return c.verdict === BLOCK; });
    var warnings = checks.filter(function (c) { return c.verdict === WARN; });
    var verdict = blocks.length ? WALK_AWAY : (warnings.length >= 2 ? CONDITIONAL : GO);
    var rationale;
    if (verdict === WALK_AWAY) {
      rationale = "Decline or rescope. " + blocks.map(function (c) { return c.finding; }).join("; ");
    } else if (verdict === CONDITIONAL) {
      rationale = "Proceed only with the pre-conditions below written into the SOW. " +
        warnings.map(function (c) { return c.remedy || c.finding; }).join("; ");
    } else {
      rationale = "No disqualifying conditions found.";
    }

    return { checks: checks, blocks: blocks, warnings: warnings, verdict: verdict, rationale: rationale };
  }

  // --- roadmap (scvr/roadmap.py) -------------------------------------------

  var STATE_EFFORT_MULTIPLIER = {};
  STATE_EFFORT_MULTIPLIER[LICENSED_UNUSED] = 1.0;
  STATE_EFFORT_MULTIPLIER[DEPLOYED_UNUSED] = 0.6;
  STATE_EFFORT_MULTIPLIER[PARTIAL] = 0.4;
  STATE_EFFORT_MULTIPLIER[FULL] = 0.3;

  var SPRINT_MAX_ITEMS = 3;
  var PROCESS_FIX_WEEKS = 4.0;
  var SPRINT_MIN_WEEKS = 8;
  var SPRINT_MAX_WEEKS = 12;
  var SPRINT_MAX_TEAM = 3;
  var MATERIALITY_FLOOR = 25000.0;
  var CAP_REASON = "sprint is capped at three outcomes";

  var KPI_BY_DRIVER = {
    labor: "planner hours spent on exception disposition per week",
    inventory: "on-hand inventory value at constant service level",
    service: "OTIF / line fill rate",
    freight: "expedite spend as a share of total freight",
    margin: "gross margin on the affected portfolio",
    cycle_time: "planning cycle days and system-plan acceptance rate",
    data: "master data error rate at point of entry"
  };

  function complexityMultiplier(engagement) {
    var client = engagement.client;
    var mult = 1.0 + 0.05 * Math.max((Number(client.erp_systems) || 1) - 1, 0) +
                     0.02 * Math.max((Number(client.sites) || 1) - 1, 0);
    return Math.min(mult, 1.6);
  }

  function effortFor(engagement, capabilityIds) {
    var platform = engagement.client.platform;
    var effort = 0;
    var unmet = [];
    capabilityIds.forEach(function (id) {
      var cap = getCapability(platform, id);
      if (!cap) return;
      var state = stateOf(engagement, id);
      if (state === NOT_LICENSED) return;
      var multiplier = STATE_EFFORT_MULTIPLIER[state];
      if (multiplier === undefined) multiplier = 0.8;  // not_assessed
      effort += cap.activation_effort_weeks * multiplier;
      (cap.prerequisites || []).forEach(function (prereq) {
        var prereqState = stateOf(engagement, prereq);
        if ((prereqState === LICENSED_UNUSED || prereqState === DEPLOYED_UNUSED) &&
            capabilityIds.indexOf(prereq) === -1 && unmet.indexOf(prereq) === -1) {
          unmet.push(prereq);
        }
      });
    });
    if (effort === 0) effort = PROCESS_FIX_WEEKS;
    effort *= complexityMultiplier(engagement);
    return { effort: Math.max(effort, 1.0), unmet: unmet };
  }

  function itemScore(item) {
    if (!item.quantified || item.effort_weeks <= 0) return 0;
    return item.recoverable_annual * item.confidence / item.effort_weeks;
  }

  function buildRoadmap(engagement, adoption, leakage) {
    var platform = engagement.client.platform;

    var quantified = leakage.ranked
      .filter(function (e) { return e.recoverable_annual > 0; })
      .map(function (e) {
        var effort = effortFor(engagement, e.linked_capabilities);
        var names = e.linked_capabilities
          .map(function (id) { var c = getCapability(platform, id); return c ? c.name : null; })
          .filter(Boolean);
        var item = {
          id: e.model_id,
          title: e.name,
          plain: e.plain,
          thesis: names.length
            ? e.basis + ". Remediation works through: " + names.join(", ") + "."
            : e.basis + ". No licensed capability on this platform addresses it directly -- " +
              "process or third-party fix.",
          driver: e.driver,
          target_capabilities: e.linked_capabilities,
          target_names: names,
          effort_weeks: round(effort.effort, 1),
          quantified: true,
          recoverable_annual: e.recoverable_annual,
          low: e.low,
          high: e.high,
          confidence: e.confidence,
          blocked_by: effort.unmet,
          measure: KPI_BY_DRIVER[e.driver] || "",
          assumptions: e.assumptions
        };
        item.score = itemScore(item);
        return item;
      });

    var covered = {};
    quantified.forEach(function (item) {
      item.target_capabilities.forEach(function (id) { covered[id] = true; });
    });

    var unquantified = adoption.dormant
      .filter(function (line) {
        return !covered[line.capability.id] && line.capability.value_weight >= 4;
      })
      .map(function (line) {
        var cap = line.capability;
        var effort = effortFor(engagement, [cap.id]);
        return {
          id: "activate." + cap.id,
          title: "Activate " + cap.name,
          plain: "Licensed capability sitting idle, with nothing supplied to size it.",
          thesis: cap.module + ": licensed and " + STATE_LABEL[line.state].toLowerCase() +
            ". Comparable deployments get real use from this in " + pct(cap.typical_capture, 0) +
            " of cases. Value driver: " + cap.value_driver +
            ". Not sized -- no operating metric was supplied to quantify it.",
          driver: cap.value_driver,
          target_capabilities: [cap.id],
          target_names: [cap.name],
          effort_weeks: round(effort.effort, 1),
          quantified: false,
          recoverable_annual: 0, low: 0, high: 0, confidence: 0, score: 0,
          blocked_by: effort.unmet,
          measure: KPI_BY_DRIVER[cap.value_driver] || "",
          assumptions: []
        };
      })
      .sort(function (a, b) {
        var weightOf = function (item) {
          return item.target_capabilities.reduce(function (t, id) {
            var cap = getCapability(platform, id);
            return t + (cap ? cap.value_weight : 0);
          }, 0);
        };
        return (weightOf(b) - weightOf(a)) || (a.effort_weeks - b.effort_weeks);
      });

    var ranked = quantified.slice().sort(function (a, b) { return b.score - a.score; });

    // Greedy pack by value density under the fixed-scope constraints.
    var chosen = [], excluded = [], used = 0;
    var capacity = SPRINT_MAX_WEEKS * SPRINT_MAX_TEAM;
    ranked.forEach(function (item) {
      if (chosen.length >= SPRINT_MAX_ITEMS) { excluded.push({ item: item, reason: CAP_REASON }); return; }
      if (item.recoverable_annual < MATERIALITY_FLOOR) {
        excluded.push({ item: item, reason: "below materiality floor for a fixed-fee sprint" });
        return;
      }
      if (item.blocked_by.length) {
        excluded.push({ item: item,
          reason: "prerequisite capability dormant: " + item.blocked_by.join(", ") });
        return;
      }
      if (used + item.effort_weeks > capacity) {
        excluded.push({ item: item, reason: "does not fit the sprint envelope" });
        return;
      }
      chosen.push(item);
      used += item.effort_weeks;
    });

    var teamSize = used ? Math.max(1, Math.min(SPRINT_MAX_TEAM, Math.ceil(used / SPRINT_MAX_WEEKS))) : 1;
    var duration = used
      ? Math.max(SPRINT_MIN_WEEKS, Math.min(SPRINT_MAX_WEEKS, Math.ceil(used / teamSize)))
      : 0;

    var sum = function (list, key) { return list.reduce(function (t, i) { return t + i[key]; }, 0); };
    var chosenIds = chosen.map(function (i) { return i.id; });

    return {
      items: ranked,
      sprint: {
        items: chosen,
        team_size: teamSize,
        duration_weeks: duration,
        effort_weeks: round(used, 1),
        excluded: excluded,
        recoverable_annual: sum(chosen, "recoverable_annual"),
        low: sum(chosen, "low"),
        high: sum(chosen, "high")
      },
      deferred: ranked.filter(function (i) { return chosenIds.indexOf(i.id) === -1; }),
      unquantified: unquantified,
      quantifiedTotal: sum(ranked, "recoverable_annual")
    };
  }

  // --- commercials (scvr/commercial.py) ------------------------------------

  var AUDIT_BASE = 35000, AUDIT_MIN = 35000, AUDIT_MAX = 60000;
  var SPRINT_MIN = 100000, SPRINT_MAX = 250000;
  var RETAINER_MIN = 20000, RETAINER_MAX = 40000;
  var PRICE_TO_VALUE = 0.22;
  var RETAINER_VALUE_SHARE = 0.10;
  var TARGET_GROSS_MARGIN = 0.45;
  var CONSULTANT_WEEK_COST = 4700.0;
  var COMFORT_RATIO = 3.0;

  function auditFee(engagement) {
    var client = engagement.client;
    var fee = AUDIT_BASE;
    fee += 4000 * Math.max((Number(client.erp_systems) || 1) - 1, 0);
    fee += 2500 * Math.min(Math.max((Number(client.sites) || 1) - 1, 0), 6);
    if (Number(client.skus) > 50000) fee += 5000;
    if (Number(client.annual_revenue) >= 1e9) fee += 5000;
    return roundTo(clamp(fee, AUDIT_MIN, AUDIT_MAX), 1000);
  }

  function priceEngagement(engagement, roadmap) {
    var notes = [];
    var sprint = roadmap.sprint;

    var cost = sprint.team_size * sprint.duration_weeks * CONSULTANT_WEEK_COST;
    var costFloor = cost ? cost / (1 - TARGET_GROSS_MARGIN) : SPRINT_MIN;
    var valuePrice = sprint.recoverable_annual * PRICE_TO_VALUE;

    var fee = Math.max(costFloor, valuePrice);
    if (fee > SPRINT_MAX) {
      notes.push("Value-based price would be " + money(fee) + ", above the " + money(SPRINT_MAX) +
        " Tier 2 ceiling. Hold the ceiling -- the client keeps the surplus and the fixed-scope " +
        "promise stays intact. Widen scope only through Tier 3.");
    }
    if (fee < SPRINT_MIN && sprint.items.length) {
      notes.push("Scope prices below the " + money(SPRINT_MIN) + " Tier 2 floor; either fold it into " +
        "the audit as a quick win or add the next roadmap item.");
    }
    fee = clamp(fee, SPRINT_MIN, SPRINT_MAX);
    var feeInt = roundTo(fee, 5000);

    var margin = feeInt ? 1 - (cost / feeInt) : 0;
    if (margin < TARGET_GROSS_MARGIN && sprint.items.length) {
      notes.push("Gross margin " + pct(margin, 0) + " is below the " + pct(TARGET_GROSS_MARGIN, 0) +
        " target -- delivery is over-staffed for the value at stake.");
    }

    var recoverable = sprint.recoverable_annual;
    var payback = recoverable > 0 ? feeInt / (recoverable / 12) : Infinity;
    var multiple = feeInt ? recoverable / feeInt : 0;
    var lowMultiple = feeInt ? sprint.low / feeInt : 0;

    if (lowMultiple && lowMultiple < COMFORT_RATIO) {
      notes.push("At the low end of the estimate band the client sees only " + lowMultiple.toFixed(1) +
        "x the fee. Below " + COMFORT_RATIO.toFixed(0) + "x, walk the scope back or widen it -- " +
        "a marginal ROI case is how a fixed-fee sprint turns into a dispute.");
    }

    var retainer = roundTo(clamp(roadmap.quantifiedTotal * RETAINER_VALUE_SHARE / 12,
      RETAINER_MIN, RETAINER_MAX), 1000);
    if (roadmap.deferred.length) {
      notes.push(roadmap.deferred.length + " quantified items were deferred out of the sprint -- " +
        "that is the Tier 3 retainer conversation, not a bigger sprint.");
    }

    return {
      audit_fee: auditFee(engagement),
      sprint_fee: feeInt,
      sprint_cost: cost,
      sprint_margin: margin,
      retainer_monthly: retainer,
      payback_months: payback,
      year_one_multiple: multiple,
      low_case_multiple: lowMultiple,
      notes: notes
    };
  }

  // --- pattern library (scvr/library.py) -----------------------------------

  var MIN_COHORT = 3;

  function cohort(records, platform, band, subVertical) {
    return records.filter(function (r) {
      if (platform && r.platform !== platform) return false;
      if (band && r.revenue_band !== band) return false;
      if (subVertical && r.sub_vertical !== subVertical) return false;
      return true;
    });
  }

  function cohortStats(records, platform, band, subVertical) {
    var rates = records.map(function (r) { return r.capture_rate; })
      .filter(function (v) { return typeof v === "number"; });
    var waste = records.map(function (r) { return r.license_waste_share; })
      .filter(function (v) { return typeof v === "number"; });
    var stats = {
      n: records.length,
      platform: platform || null,
      revenue_band: band || null,
      sub_vertical: subVertical || null,
      reportable: records.length >= MIN_COHORT,
      median_capture: rates.length ? median(rates) : null,
      p25_capture: rates.length ? percentile(rates, 0.25) : null,
      p75_capture: rates.length ? percentile(rates, 0.75) : null,
      median_license_waste: waste.length ? median(waste) : null
    };
    stats.percentileOf = function (captureRate) {
      if (!stats.reportable || !rates.length) return null;
      var below = rates.filter(function (r) { return r < captureRate; }).length;
      return below / rates.length;
    };
    stats.describe = function (captureRate) {
      var scope = [stats.platform, stats.revenue_band, stats.sub_vertical]
        .filter(Boolean).join(" / ");
      if (!stats.reportable) {
        return "Cohort (" + (scope || "all") + ") has only " + stats.n + " prior engagement(s) -- " +
          "below the " + MIN_COHORT + "-engagement floor, so no benchmark is quoted. Catalog priors " +
          "are used instead and are labelled as such.";
      }
      return "Comparable deployments (" + scope + ", n=" + stats.n + ") capture a median " +
        pct(stats.median_capture, 0) + " of licensed capability (p25 " + pct(stats.p25_capture, 0) +
        " / p75 " + pct(stats.p75_capture, 0) + "). This client is at " + pct(captureRate, 0) + ".";
    };
    return stats;
  }

  function benchmarkFor(engagement, records) {
    records = records || [];
    var client = engagement.client;
    var band = revenueBand(Number(client.annual_revenue) || 0);
    var filters = [
      [client.platform, band, client.sub_vertical],
      [client.platform, band, null],
      [client.platform, null, null]
    ];
    var fallback = null;
    for (var i = 0; i < filters.length; i++) {
      var subset = cohort(records, filters[i][0], filters[i][1], filters[i][2])
        .filter(function (r) { return r.engagement_id !== engagement.engagement_id; });
      var stats = cohortStats(subset, filters[i][0], filters[i][1], filters[i][2]);
      if (!fallback) fallback = { stats: stats, records: subset };
      if (stats.reportable) return { stats: stats, records: subset };
    }
    return fallback || { stats: cohortStats([], client.platform), records: [] };
  }

  function recordFromAudit(audit, isoDate) {
    var leakage = {};
    audit.leakage.operational.forEach(function (e) {
      leakage[e.model_id] = round(e.recoverable_annual, 2);
    });
    return {
      engagement_id: audit.engagement.engagement_id,
      date: isoDate || new Date().toISOString().slice(0, 10),
      platform: audit.engagement.client.platform,
      sub_vertical: audit.engagement.client.sub_vertical,
      revenue_band: revenueBand(Number(audit.engagement.client.annual_revenue) || 0),
      live_months: Number(audit.engagement.client.live_months) || 0,
      capture_rate: round(audit.adoption.captureRate, 4),
      license_waste_share: round(audit.adoption.licenseWasteShare, 4),
      assessment_coverage: round(audit.adoption.assessmentCoverage, 4),
      qualification: audit.qualification.verdict,
      recoverable_annual: round(audit.leakage.recoverableTotal, 2),
      leakage: leakage,
      skipped_models: audit.leakage.skipped.map(function (s) { return s.model_id; }),
      dormant_capabilities: audit.adoption.dormant.map(function (l) { return l.capability.id; }),
      sprint_items: audit.roadmap.sprint.items.map(function (i) { return i.id; })
    };
  }

  function patternFrequency(records) {
    if (!records.length) return [];
    var buckets = {};
    records.forEach(function (r) {
      var leakage = r.leakage || {};
      Object.keys(leakage).forEach(function (id) {
        if (leakage[id] > 0) (buckets[id] || (buckets[id] = [])).push(leakage[id]);
      });
    });
    return Object.keys(buckets).map(function (id) {
      return {
        model_id: id,
        engagements: buckets[id].length,
        frequency: buckets[id].length / records.length,
        median_recoverable: median(buckets[id])
      };
    }).sort(function (a, b) {
      return (b.engagements - a.engagements) || (b.median_recoverable - a.median_recoverable);
    });
  }

  function dormancyFrequency(records, platform) {
    var subset = records.filter(function (r) { return !platform || r.platform === platform; });
    if (!subset.length) return [];
    var counts = {};
    subset.forEach(function (r) {
      (r.dormant_capabilities || []).forEach(function (id) {
        counts[id] = (counts[id] || 0) + 1;
      });
    });
    return Object.keys(counts).map(function (id) {
      return { capability_id: id, engagements: counts[id], frequency: counts[id] / subset.length };
    }).sort(function (a, b) { return b.engagements - a.engagements; });
  }

  // --- firm economics (scvr/economics.py) ----------------------------------

  var BILLABLE_WEEKS_PER_YEAR = 47.0;
  var EFFORT = { audit: 5.5, sprint: 20.0, retainer_month: 3.0 };

  var FIRM_DEFAULTS = {
    consultants: 4,
    loaded_cost: 215000,
    bill_rate: 300,
    target_utilization: 0.70,
    overhead_annual: 180000,
    audits_per_year: 5,
    sprints_per_year: 2,
    retainer_clients: 2,
    audit_fee: 45000,
    sprint_fee: 175000,
    retainer_monthly: 30000,
    deposit_rate: 0.45,
    payment_terms_days: 75,
    starting_cash: 150000
  };

  function firmModel(overrides) {
    var firm = {};
    Object.keys(FIRM_DEFAULTS).forEach(function (k) { firm[k] = FIRM_DEFAULTS[k]; });
    Object.keys(overrides || {}).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(FIRM_DEFAULTS, k)) firm[k] = Number(overrides[k]);
    });
    firm.week_cost = firm.loaded_cost / BILLABLE_WEEKS_PER_YEAR;
    firm.capacity_weeks = firm.consultants * BILLABLE_WEEKS_PER_YEAR;
    firm.fixed_annual_cost = firm.consultants * firm.loaded_cost + firm.overhead_annual;
    return firm;
  }

  function unitEconomics(firm) {
    var revAudit = firm.audits_per_year * firm.audit_fee;
    var revSprint = firm.sprints_per_year * firm.sprint_fee;
    var revRetainer = firm.retainer_clients * firm.retainer_monthly * 12;

    var weeksAudit = firm.audits_per_year * EFFORT.audit;
    var weeksSprint = firm.sprints_per_year * EFFORT.sprint;
    var weeksRetainer = firm.retainer_clients * EFFORT.retainer_month * 12;
    var required = weeksAudit + weeksSprint + weeksRetainer;

    var deliveryCost = required * firm.week_cost;
    var revenue = revAudit + revSprint + revRetainer;
    var grossProfit = revenue - deliveryCost;
    var grossMargin = revenue ? grossProfit / revenue : 0;
    var idleCost = Math.max(0, firm.capacity_weeks - required) * firm.week_cost;
    var operatingProfit = revenue - deliveryCost - idleCost - firm.overhead_annual;
    var impliedUtilization = firm.capacity_weeks ? required / firm.capacity_weeks : 0;
    var recurringShare = revenue ? revRetainer / revenue : 0;

    var auditContribution = firm.audit_fee - EFFORT.audit * firm.week_cost;
    var breakevenAudits = auditContribution > 0
      ? (firm.fixed_annual_cost - (revSprint - weeksSprint * firm.week_cost) -
         (revRetainer - weeksRetainer * firm.week_cost)) / auditContribution
      : Infinity;

    var warnings = [];
    if (impliedUtilization > firm.target_utilization + 0.05) {
      warnings.push("Mix requires " + pct(impliedUtilization, 0) + " utilization against a " +
        pct(firm.target_utilization, 0) + " target -- this plan only works with subcontractors or a hire.");
    }
    if (impliedUtilization < firm.target_utilization - 0.15) {
      warnings.push("Mix only fills " + pct(impliedUtilization, 0) + " of capacity; the team is " +
        "carrying idle cost of " + money(idleCost) + ".");
    }
    if (recurringShare < 0.40) {
      warnings.push("Only " + pct(recurringShare, 0) + " of revenue is recurring. The plan's " +
        "year-two target is 60% -- project-only firms are one lost deal from trouble.");
    }
    var maxAudits = firm.capacity_weeks / EFFORT.audit;
    if (breakevenAudits > maxAudits) {
      warnings.push("Break-even needs " + Math.round(breakevenAudits) + " audits but the team can " +
        "only deliver " + Math.round(maxAudits) + " at full capacity. Tier 1 does not pay the bills " +
        "on its own -- it buys the Tier 2 and Tier 3 pipeline.");
    }
    if (grossMargin < 0.40) {
      warnings.push("Gross margin " + pct(grossMargin, 0) + " is below the 40% floor; either rates " +
        "are too low or fixed-scope work is running long.");
    }

    return {
      revenue_audit: revAudit, revenue_sprint: revSprint, revenue_retainer: revRetainer,
      revenue: revenue, delivery_cost: deliveryCost, overhead: firm.overhead_annual,
      gross_profit: grossProfit, gross_margin: grossMargin, operating_profit: operatingProfit,
      required_weeks: required, capacity_weeks: firm.capacity_weeks,
      implied_utilization: impliedUtilization, recurring_share: recurringShare,
      breakeven_audits: breakevenAudits, warnings: warnings
    };
  }

  function spread(count, horizon) {
    if (count <= 0) return [];
    var starts = [];
    for (var yearStart = 0; yearStart < horizon; yearStart += 12) {
      for (var i = 0; i < count; i++) {
        var month = yearStart + Math.floor((i * 12) / count);
        if (month < horizon) starts.push(month);
      }
    }
    return starts;
  }

  function cashFlow(firm, horizonMonths) {
    horizonMonths = horizonMonths || 24;
    var termsMonths = Math.max(1, bankersRound(firm.payment_terms_days / 30));
    var collections = new Array(horizonMonths + termsMonths + 6).fill(0);

    function collect(month, amount) {
      var idx = month + termsMonths;
      if (idx < collections.length) collections[idx] += amount;
    }

    spread(firm.audits_per_year, horizonMonths).forEach(function (start) {
      collect(start, firm.audit_fee * firm.deposit_rate);
      collect(start + 1, firm.audit_fee * (1 - firm.deposit_rate));
    });
    spread(firm.sprints_per_year, horizonMonths).forEach(function (start) {
      collect(start, firm.sprint_fee * firm.deposit_rate);
      collect(start + 3, firm.sprint_fee * (1 - firm.deposit_rate));
    });
    for (var m = 0; m < horizonMonths; m++) {
      collect(m, firm.retainer_clients * firm.retainer_monthly);
    }

    var monthlyCost = firm.fixed_annual_cost / 12;
    var balance = firm.starting_cash;
    var months = [];
    for (var i = 0; i < horizonMonths; i++) {
      var received = collections[i];
      var net = received - monthlyCost;
      balance += net;
      months.push({ month: i + 1, collections: received, costs: monthlyCost, net: net, balance: balance });
    }

    var balances = months.map(function (m) { return m.balance; });
    var minBalance = Math.min.apply(null, balances);
    var trough = months[balances.indexOf(minBalance)].month;
    var deficit = Math.max(0, -minBalance);

    return {
      months: months,
      min_balance: minBalance,
      trough_month: trough,
      ending_balance: months[months.length - 1].balance,
      months_negative: months.filter(function (m) { return m.balance < 0; }).length,
      credit_line_needed: deficit ? Math.ceil(deficit / 25000) * 25000 : 0
    };
  }

  // --- orchestration -------------------------------------------------------

  function runAudit(engagement, records) {
    var adoption = profileAdoption(engagement);
    var qualification = qualify(engagement, adoption);
    var leakage = assessLeakage(engagement, adoption);
    var roadmap = buildRoadmap(engagement, adoption, leakage);
    var commercials = priceEngagement(engagement, roadmap);
    var benchmark = benchmarkFor(engagement, records || []);

    return {
      engagement: engagement,
      adoption: adoption,
      qualification: qualification,
      leakage: leakage,
      roadmap: roadmap,
      commercials: commercials,
      benchmark: benchmark.stats,
      cohortRecords: benchmark.records,
      benchmarkGap: (benchmark.stats.reportable && benchmark.stats.median_capture !== null)
        ? benchmark.stats.median_capture - adoption.captureRate
        : null
    };
  }

  return {
    // constants
    USAGE_STATES: USAGE_STATES, USAGE_SCORE: USAGE_SCORE, STATE_LABEL: STATE_LABEL,
    LICENSED_STATES: LICENSED_STATES, BAND_LABEL: BAND_LABEL, MIN_COHORT: MIN_COHORT,
    MODELS: MODELS, RECOVERY: RECOVERY, EVIDENCE_BANDS: EVIDENCE_BANDS,
    OPERATIONS_FIELDS: OPERATIONS_FIELDS, FIRM_DEFAULTS: FIRM_DEFAULTS,
    SPRINT_MAX_ITEMS: SPRINT_MAX_ITEMS, MATERIALITY_FLOOR: MATERIALITY_FLOOR,
    CAP_REASON: CAP_REASON, EFFORT: EFFORT,
    // catalog
    loadCatalogs: loadCatalogs, getCatalog: getCatalog, getCapability: getCapability,
    platforms: platforms, platformName: function (p) { return PLATFORM_NAMES[p] || p; },
    // pipeline
    profileAdoption: profileAdoption, assessLeakage: assessLeakage, qualify: qualify,
    buildRoadmap: buildRoadmap, priceEngagement: priceEngagement, auditFee: auditFee,
    runAudit: runAudit,
    // library
    cohort: cohort, cohortStats: cohortStats, benchmarkFor: benchmarkFor,
    recordFromAudit: recordFromAudit, patternFrequency: patternFrequency,
    dormancyFrequency: dormancyFrequency,
    // economics
    firmModel: firmModel, unitEconomics: unitEconomics, cashFlow: cashFlow,
    // helpers
    revenueBand: revenueBand, providedMetrics: providedMetrics, missingMetrics: missingMetrics,
    median: median, percentile: percentile, invNorm: invNorm, money: money, pct: pct
  };
});
