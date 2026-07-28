/* Capture -- console UI.
 *
 * All calculation lives in engine.js (the verified port of the Python
 * package). This file is presentation and state: it never does arithmetic on
 * a finding, it only draws what the engine returns.
 */
(function () {
  "use strict";

  var E = window.CaptureEngine;
  var DATA = window.CaptureData;
  var M = window.CaptureMarket;
  var ADVISOR = window.CaptureAdvisor;
  E.loadCatalogs(DATA.catalogs, DATA.platformNames);
  M.load(window.CaptureMarketData);
  ADVISOR.init(M);

  var STORE = {
    engagement: "capture.engagement.v1",
    library: "capture.library.v1",
    firm: "capture.firm.v1",
    chat: "capture.chat.v1",
    theme: "capture.theme.v1"
  };

  // --- small helpers --------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else if (key === "style") node.setAttribute("style", value);
      else node.setAttribute(key, value === true ? "" : value);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function money(value, opts) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    var abs = Math.abs(value);
    var sign = value < 0 ? "-" : "";
    if (opts && opts.exact) return sign + "$" + Math.round(abs).toLocaleString("en-US");
    if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return sign + "$" + Math.round(abs / 1e3).toLocaleString("en-US") + "K";
    return sign + "$" + Math.round(abs).toLocaleString("en-US");
  }

  function pct(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    return (value * 100).toFixed(digits === undefined ? 0 : digits) + "%";
  }

  var SUB_VERTICAL_LABEL = {
    "3pl": "Third-party logistics",
    cold_chain: "Cold chain",
    industrial_distribution: "Industrial distribution",
    retail_dc: "Retail DC operations",
    manufacturing: "Manufacturing"
  };

  function verticalLabel(key) { return SUB_VERTICAL_LABEL[key] || titleCase(key); }

  function titleCase(text) {
    return String(text || "").replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function toast(message) {
    var node = document.getElementById("toast");
    node.textContent = message;
    node.dataset.show = "true";
    clearTimeout(node._timer);
    node._timer = setTimeout(function () { node.dataset.show = "false"; }, 2400);
  }

  // --- state ----------------------------------------------------------------

  function blankEngagement(platform) {
    return {
      engagement_id: "new-engagement",
      client: {
        name: "", platform: platform || "blue_yonder", sub_vertical: "3pl",
        annual_revenue: null, live_months: null, sites: 1, erp_systems: 1, skus: null,
        planners_fte: null, annual_license_fee: null, implementation_spend: null,
        business_case_annual_benefit: null
      },
      capabilities: {}, operations: {}, governance: {
        executive_sponsor: "", documented_baseline: false, baseline_period_months: 0,
        dedicated_client_resource: false, prior_remediation_attempts: 0, vendor_relationship: ""
      },
      evidence: { "default": "estimated" },
      notes: ""
    };
  }

  var state = {
    view: "engagement",
    engagement: load(STORE.engagement) || deepCopy(DATA.samples[0]),
    library: load(STORE.library) || [],
    firm: load(STORE.firm) || {},
    chat: load(STORE.chat) || [],
    chatContext: { lastMetros: [], sub_vertical: null },
    audit: null
  };

  function deepCopy(value) { return JSON.parse(JSON.stringify(value)); }

  function load(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode */ }
  }

  function recompute() {
    try {
      state.audit = E.runAudit(state.engagement, state.library);
    } catch (err) {
      state.audit = null;
      console.error(err);
    }
    save(STORE.engagement, state.engagement);
  }

  // --- field definitions ----------------------------------------------------

  var CLIENT_FIELDS = [
    { key: "name", label: "Client name", kind: "text", placeholder: "Northgate Logistics" },
    { key: "platform", label: "Platform", kind: "select",
      options: E.platforms().map(function (p) { return [p, E.platformName(p)]; }) },
    { key: "sub_vertical", label: "Sub-vertical", kind: "select", options: [
      ["3pl", "Third-party logistics"], ["cold_chain", "Cold chain"],
      ["industrial_distribution", "Industrial distribution"], ["retail_dc", "Retail DC operations"],
      ["manufacturing", "Manufacturing"], ["other", "Other"]] },
    { key: "annual_revenue", label: "Annual revenue", kind: "money" },
    { key: "live_months", label: "Months live on the platform", kind: "number",
      hint: "Under 9 and this is still an implementation" },
    { key: "sites", label: "Sites", kind: "number" },
    { key: "erp_systems", label: "ERP systems in the estate", kind: "number" },
    { key: "skus", label: "Active SKUs", kind: "number" },
    { key: "planners_fte", label: "Planners (FTE)", kind: "number" },
    { key: "annual_license_fee", label: "Annual subscription", kind: "money",
      hint: "Unlocks the idle-licence figure" },
    { key: "implementation_spend", label: "Original implementation spend", kind: "money" },
    { key: "business_case_annual_benefit", label: "Business case annual benefit", kind: "money",
      hint: "Unlocks the override erosion model" }
  ];

  var METRIC_GROUPS = [
    { title: "P&L shape", fields: [
      { key: "annual_cogs", label: "Annual COGS", kind: "money" },
      { key: "gross_margin_pct", label: "Gross margin", kind: "pct" }
    ]},
    { title: "Inventory", fields: [
      { key: "inventory_value", label: "Inventory on hand", kind: "money" },
      { key: "carrying_cost_rate", label: "Carrying cost rate", kind: "pct", hint: "Default 22%" },
      { key: "excess_obsolete_writeoff", label: "Annual E&O write-off", kind: "money" }
    ]},
    { title: "Forecasting", fields: [
      { key: "forecast_mape", label: "Forecast error (MAPE)", kind: "pct" },
      { key: "attainable_mape", label: "Attainable MAPE", kind: "pct", hint: "Default: 75% of current" },
      { key: "avg_lead_time_weeks", label: "Average lead time (weeks)", kind: "number" },
      { key: "service_level_target", label: "Service level target", kind: "pct", hint: "Default 95%" }
    ]},
    { title: "Planners", fields: [
      { key: "exceptions_per_week", label: "Exceptions per week", kind: "number" },
      { key: "minutes_per_exception", label: "Minutes per exception", kind: "number" },
      { key: "exception_automation_rate", label: "Auto-dispositioned today", kind: "pct" },
      { key: "planner_loaded_cost", label: "Planner loaded cost (annual)", kind: "money" },
      { key: "planner_override_rate", label: "Planner override rate", kind: "pct" },
      { key: "override_value_add_rate", label: "Overrides that add value", kind: "pct", hint: "Default 25%" }
    ]},
    { title: "Service and freight", fields: [
      { key: "annual_freight_spend", label: "Annual freight spend", kind: "money" },
      { key: "expedite_share", label: "Expedited share of freight", kind: "pct" },
      { key: "expedite_premium_pct", label: "Expedite premium", kind: "pct", hint: "Default 35%" },
      { key: "stockout_rate", label: "Lost-sale rate", kind: "pct" },
      { key: "otif_pct", label: "OTIF", kind: "pct" }
    ]},
    { title: "Data health", fields: [
      { key: "master_data_accuracy", label: "Master data accuracy", kind: "pct",
        hint: "Below 75% and the audit says walk away" },
      { key: "data_rework_hours_per_week", label: "Data rework hours per week", kind: "number" },
      { key: "interface_failure_rate", label: "Interface failure rate", kind: "pct" }
    ]}
  ];

  var GOVERNANCE_FIELDS = [
    { key: "executive_sponsor", label: "Executive sponsor", kind: "text",
      placeholder: "VP Supply Chain", hint: "An operational owner, not the CIO who signed" },
    { key: "documented_baseline", label: "Documented baseline exists", kind: "bool" },
    { key: "baseline_period_months", label: "Baseline period (months)", kind: "number" },
    { key: "dedicated_client_resource", label: "Dedicated client resource", kind: "bool" },
    { key: "prior_remediation_attempts", label: "Prior remediation attempts", kind: "number" },
    { key: "vendor_relationship", label: "Vendor relationship", kind: "select", options: [
      ["", "Unknown"], ["healthy", "Healthy"], ["strained", "Strained"],
      ["renewal_risk", "Renewal at risk"]] }
  ];

  // --- field rendering ------------------------------------------------------

  function readValue(field, target) {
    var raw = target.value.trim();
    if (field.kind === "text" || field.kind === "select") return raw;
    if (field.kind === "bool") return raw === "true";
    if (raw === "") return null;
    var num = Number(raw.replace(/[, $]/g, ""));
    if (!isFinite(num)) return null;
    return field.kind === "pct" ? num / 100 : num;
  }

  function writeValue(field, value) {
    if (value === null || value === undefined) return "";
    if (field.kind === "pct") return String(Math.round(value * 10000) / 100);
    if (field.kind === "bool") return value ? "true" : "false";
    if (field.kind === "money") return Number(value).toLocaleString("en-US");
    return String(value);
  }

  function renderField(field, bag, onChange) {
    var value = bag[field.key];
    var control;

    if (field.kind === "select" || field.kind === "bool") {
      var options = field.kind === "bool" ? [["false", "No"], ["true", "Yes"]] : field.options;
      control = el("select", {}, options.map(function (opt) {
        return el("option", { value: opt[0], selected: String(writeValue(field, value)) === String(opt[0]) },
          [opt[1]]);
      }));
    } else {
      control = el("input", {
        type: field.kind === "text" ? "text" : "text",
        inputmode: field.kind === "text" ? null : "decimal",
        value: writeValue(field, value),
        placeholder: field.placeholder || (field.kind === "pct" ? "%" : "")
      });
    }

    control.addEventListener("change", function (event) {
      bag[field.key] = readValue(field, event.target);
      onChange();
    });
    var echo = field.kind === "money" ? el("span", { class: "field__hint" }) : null;
    function updateEcho() {
      if (!echo) return;
      var current = bag[field.key];
      echo.textContent = (current === null || current === undefined || current === "")
        ? "" : money(current);
    }
    updateEcho();

    if (field.kind !== "select" && field.kind !== "bool") {
      control.addEventListener("input", function (event) {
        bag[field.key] = readValue(field, event.target);
        updateEcho();
        onChange();
      });
    }
    if (field.kind === "money") {
      control.addEventListener("blur", function (event) {
        event.target.value = writeValue(field, bag[field.key]);
      });
    }

    var isEmpty = value === null || value === undefined || value === "";
    return el("div", { class: "field" + (isEmpty ? " field--empty" : "") }, [
      el("label", { text: field.label + (field.kind === "pct" ? " (%)" : "") }),
      control,
      echo,
      field.hint ? el("span", { class: "field__hint", text: field.hint }) : null
    ]);
  }

  // --- charts ---------------------------------------------------------------

  function meter(captureRate, cohortMedian) {
    var TICKS = 25;
    var filled = Math.round(captureRate * TICKS);
    var markerIndex = cohortMedian === null || cohortMedian === undefined
      ? -1 : Math.min(TICKS - 1, Math.round(cohortMedian * TICKS));

    var scale = el("div", { class: "meter__scale", role: "img",
      "aria-label": "Capture rate " + pct(captureRate) +
        (markerIndex >= 0 ? ", cohort median " + pct(cohortMedian) : "") });

    for (var i = 0; i < TICKS; i++) {
      var classes = "meter__tick" + (i < filled ? " meter__tick--on" : "") +
        (i === markerIndex ? " meter__tick--marker" : "");
      scale.appendChild(el("div", { class: classes },
        i === markerIndex ? [el("span", { class: "meter__needle" })] : []));
    }

    return el("div", { class: "meter" }, [
      scale,
      el("div", { class: "meter__axis" }, [
        el("span", { text: "0%" }), el("span", { text: "50%" }), el("span", { text: "100%" })
      ]),
      markerIndex >= 0
        ? el("div", { class: "meter__legend", html: "Vertical rule marks the cohort median, <b>" +
            pct(cohortMedian) + "</b>." })
        : null
    ]);
  }

  function barRows(rows, options) {
    options = options || {};
    var max = Math.max.apply(null, rows.map(function (r) {
      return Math.max(r.value, r.high || 0);
    }).concat([options.min || 0.0001]));

    return el("div", { class: "bars" }, rows.map(function (row) {
      var track = el("div", { class: "bar-track" });
      var fill = el("div", { class: "bar-fill", style: "width:" + (row.value / max * 100) + "%" });
      track.appendChild(fill);

      if (row.low !== undefined && row.high !== undefined && row.high > row.low) {
        var left = row.low / max * 100;
        var right = row.high / max * 100;
        track.appendChild(el("div", { class: "bar-whisker",
          style: "left:" + left + "%;width:" + (right - left) + "%" }));
        track.appendChild(el("div", { class: "bar-cap", style: "left:" + left + "%" }));
        track.appendChild(el("div", { class: "bar-cap", style: "left:" + right + "%" }));
      }

      return el("div", { class: "bar-row", tabindex: "0",
        title: row.tooltip || (row.label + ": " + row.display) }, [
        el("div", { class: "bar-row__label" }, [
          document.createTextNode(row.label),
          row.sub ? el("small", { text: row.sub }) : null
        ]),
        track,
        el("div", { class: "bar-row__value", text: row.display })
      ]);
    }));
  }

  function cashColumns(months) {
    var peak = Math.max.apply(null, months.map(function (m) { return Math.abs(m.balance); }).concat([1]));
    var wrap = el("div", { class: "columns", role: "img",
      "aria-label": "Monthly cash balance over " + months.length + " months" });
    wrap.appendChild(el("div", { class: "zero-line", style: "top:50%" }));

    months.forEach(function (m) {
      var height = Math.abs(m.balance) / peak * 100;
      var positive = m.balance >= 0;
      wrap.appendChild(el("div", { class: "col",
        title: "Month " + m.month + ": " + money(m.balance) }, [
        el("div", { class: "col__pos", style: "height:50%;align-items:flex-end" },
          positive ? [el("div", { class: "col__bar", style: "height:" + height + "%" })] : []),
        el("div", { class: "col__neg", style: "height:50%;align-items:flex-start" },
          positive ? [] : [el("div", { class: "col__bar col__bar--neg", style: "height:" + height + "%" })])
      ]));
    });

    return el("div", {}, [
      wrap,
      el("div", { class: "meter__axis" }, [
        el("span", { text: "month 1" }),
        el("span", { text: "month " + Math.round(months.length / 2) }),
        el("span", { text: "month " + months.length })
      ])
    ]);
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svg(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (attrs[key] === null || attrs[key] === undefined) return;
      if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  /* Cumulative profit over the horizon: the shape of the bet. Zero rule and
   * break-even marker carry the answer; the endpoint carries the size. */
  function trajectoryChart(scenario) {
    var months = scenario.months;
    if (!months.length) return null;

    var W = 640, H = 190, padL = 8, padR = 58, padT = 14, padB = 22;
    var values = months.map(function (m) { return m.cumulative_profit; });
    var maxV = Math.max.apply(null, values.concat([0]));
    var minV = Math.min.apply(null, values.concat([0]));
    var span = (maxV - minV) || 1;

    function x(i) { return padL + (i / Math.max(months.length - 1, 1)) * (W - padL - padR); }
    function y(v) { return padT + (1 - (v - minV) / span) * (H - padT - padB); }

    var zeroY = y(0);
    var line = months.map(function (m, i) {
      return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(m.cumulative_profit).toFixed(1);
    }).join(" ");
    var area = line + " L" + x(months.length - 1).toFixed(1) + " " + zeroY.toFixed(1) +
               " L" + x(0).toFixed(1) + " " + zeroY.toFixed(1) + " Z";

    var last = months[months.length - 1];
    var kids = [
      svg("path", { d: area, class: "area" }),
      svg("line", { x1: padL, x2: W - padR, y1: zeroY, y2: zeroY, class: "zero" }),
      svg("path", { d: line, class: "line" + (last.cumulative_profit < 0 ? " line--loss" : "") }),
      svg("circle", { cx: x(months.length - 1), cy: y(last.cumulative_profit), r: 3.5,
                      class: "endpoint" }),
      svg("text", { x: W - padR + 6, y: y(last.cumulative_profit) + 4, class: "value",
                    text: money(last.cumulative_profit) }),
      svg("text", { x: padL, y: H - 4, text: "month 1" }),
      svg("text", { x: W - padR, y: H - 4, "text-anchor": "end",
                    text: "month " + months.length })
    ];

    if (scenario.breakeven_month) {
      var bi = scenario.breakeven_month - 1;
      kids.splice(2, 0, svg("line", { x1: x(bi), x2: x(bi), y1: padT, y2: H - padB,
                                      class: "marker" }));
      kids.push(svg("text", { x: x(bi) + 4, y: padT + 9, class: "marker-label",
                              text: "breaks even m" + scenario.breakeven_month }));
    }

    months.forEach(function (m, i) {
      kids.push(svg("rect", {
        x: x(i) - 4, y: padT, width: 8, height: H - padT - padB, fill: "transparent"
      }, [svg("title", { text: "Month " + m.month + ": cumulative " +
          money(m.cumulative_profit) + ", revenue " + money(m.revenue) })]));
    });

    return el("div", { class: "trajectory" }, [
      svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
        "aria-label": "Cumulative profit over " + months.length + " months, ending at " +
          money(last.cumulative_profit) }, kids)
    ]);
  }

  function tile(label, value, foot, accent) {
    return el("div", { class: "tile" }, [
      el("div", { class: "tile__label", text: label }),
      el("div", { class: "tile__value" + (accent ? " tile__value--accent" : ""), text: value }),
      foot ? el("div", { class: "tile__foot", text: foot }) : null
    ]);
  }

  function table(headers, rows, caption) {
    var thead = el("thead", {}, [el("tr", {}, headers.map(function (h) {
      return el("th", { class: h.num ? "num" : null, text: h.label || h });
    }))]);
    var tbody = el("tbody", {}, rows.map(function (cells) {
      return el("tr", {}, cells.map(function (cell) {
        if (cell && cell.node) return el("td", { class: cell.num ? "num" : null }, [cell.node]);
        var isNum = cell && typeof cell === "object" ? cell.num : false;
        var text = cell && typeof cell === "object" ? cell.text : cell;
        return el("td", { class: isNum ? "num" : null, text: text === undefined ? "" : String(text) });
      }));
    }));
    var node = el("table", {}, [thead, tbody]);
    if (caption) node.appendChild(el("caption", { text: caption }));
    return el("div", { class: "table-wrap" }, [node]);
  }

  function panel(title, eyebrow, children) {
    return el("section", { class: "panel" }, [
      el("div", { class: "panel__head" }, [
        el("h2", { text: title }),
        eyebrow ? el("span", { class: "eyebrow", text: eyebrow }) : null
      ])
    ].concat(children.filter(Boolean)));
  }

  var VERDICT_STYLE = { GO: "good", CONDITIONAL: "warn", WALK_AWAY: "crit" };
  var VERDICT_TEXT = {
    GO: "Take the engagement",
    CONDITIONAL: "Conditional — fix these first",
    WALK_AWAY: "Do not proceed"
  };
  var CHECK_STYLE = { pass: "good", warn: "warn", block: "crit" };

  // --- engagement view ------------------------------------------------------

  function renderEngagement() {
    var eng = state.engagement;

    var samples = document.getElementById("sample-buttons");
    clear(samples);
    DATA.samples.forEach(function (sample) {
      samples.appendChild(el("button", { class: "btn", onclick: function () {
        state.engagement = deepCopy(sample);
        recompute();
        renderAll();
        toast("Loaded " + sample.client.name);
      }, text: sample.client.name }));
    });
    samples.appendChild(el("button", { class: "btn btn--ghost", onclick: function () {
      state.engagement = blankEngagement(eng.client.platform);
      recompute();
      renderAll();
      toast("Blank engagement");
    }, text: "Start blank" }));

    var clientFields = document.getElementById("client-fields");
    clear(clientFields);
    CLIENT_FIELDS.forEach(function (field) {
      clientFields.appendChild(renderField(field, eng.client, function () {
        if (field.key === "platform") { eng.capabilities = {}; refresh(); renderEngagement(); }
        else refresh();
      }));
    });

    renderCapabilities();

    var metricFields = document.getElementById("metric-fields");
    clear(metricFields);
    metricFields.removeAttribute("class");
    METRIC_GROUPS.forEach(function (group) {
      metricFields.appendChild(el("div", { style: "margin-bottom:1.1rem" }, [
        el("div", { class: "eyebrow", style: "margin-bottom:.5rem", text: group.title }),
        el("div", { class: "fields" }, group.fields.map(function (field) {
          return renderField(field, eng.operations, refresh);
        }))
      ]));
    });

    var govFields = document.getElementById("governance-fields");
    clear(govFields);
    GOVERNANCE_FIELDS.forEach(function (field) {
      govFields.appendChild(renderField(field, eng.governance, refresh));
    });

    var evidenceFields = document.getElementById("evidence-fields");
    clear(evidenceFields);
    var evidenceOptions = [["measured", "Measured (±20%)"], ["estimated", "Estimated (±40%)"],
      ["anecdotal", "Anecdotal (±65%)"]];
    [{ key: "default", label: "Default for all findings" }].concat(
      E.MODELS.filter(function (m) { return m.category === "operational"; })
        .map(function (m) { return { key: m.id, label: m.name }; })
    ).forEach(function (entry) {
      evidenceFields.appendChild(renderField(
        { key: entry.key, label: entry.label, kind: "select", options: evidenceOptions },
        eng.evidence, refresh));
    });
  }

  function renderCapabilities() {
    var host = document.getElementById("capability-list");
    clear(host);
    var eng = state.engagement;
    var catalog = E.getCatalog(eng.client.platform);
    var states = [
      ["not_assessed", "?"], ["not_licensed", "Not licensed"], ["licensed_unused", "Licensed"],
      ["deployed_unused", "Configured"], ["partial", "Partly"], ["full", "Fully"]
    ];

    var modules = [];
    catalog.forEach(function (cap) { if (modules.indexOf(cap.module) === -1) modules.push(cap.module); });

    modules.forEach(function (module) {
      var caps = catalog.filter(function (c) { return c.module === module; });
      var rows = caps.map(function (cap) {
        var current = eng.capabilities[cap.id] || "not_assessed";
        var seg = el("div", { class: "seg", role: "group", "aria-label": cap.name + " usage" },
          states.map(function (pair) {
            return el("button", {
              type: "button",
              "aria-pressed": current === pair[0] ? "true" : "false",
              title: pair[0] === "not_assessed" ? "Not assessed" : E.STATE_LABEL[pair[0]],
              onclick: function () {
                eng.capabilities[cap.id] = pair[0];
                refresh();
                renderCapabilities();
              },
              text: pair[1]
            });
          }));

        return el("div", { class: "cap-row" }, [
          el("div", {}, [
            el("div", { class: "cap-row__name", text: cap.name }),
            el("div", { class: "cap-row__meta" }, [
              el("span", { html: "weight <b>" + cap.value_weight + "</b>" }),
              el("span", { html: "drives <b>" + titleCase(cap.value_driver) + "</b>" }),
              el("span", { html: "peers <b>" + pct(cap.typical_capture) + "</b>" }),
              el("span", { html: "activation <b>" + cap.activation_effort_weeks + " wk</b>" })
            ])
          ]),
          seg
        ]);
      });

      var assessed = caps.filter(function (c) {
        return eng.capabilities[c.id] && eng.capabilities[c.id] !== "not_assessed";
      }).length;

      host.appendChild(el("div", { class: "cap-module" }, [
        el("div", { class: "cap-module__head" }, [
          el("h3", { text: module }),
          el("span", { text: assessed + "/" + caps.length })
        ])
      ].concat(rows)));
    });
  }

  // --- report view ----------------------------------------------------------

  function renderReport() {
    var host = document.getElementById("view-report");
    clear(host);
    var audit = state.audit;
    if (!audit) {
      host.appendChild(el("p", { class: "empty", text: "Could not run the audit — check the client platform." }));
      return;
    }

    var eng = audit.engagement;
    var adoption = audit.adoption;
    var leakage = audit.leakage;
    var plan = audit.roadmap;
    var comm = audit.commercials;

    host.appendChild(el("header", { class: "view__head" }, [
      el("div", { class: "eyebrow", text: E.platformName(eng.client.platform) + " · " +
        verticalLabel(eng.client.sub_vertical) + " · live " + (eng.client.live_months || 0) + " months" }),
      el("h1", { text: (eng.client.name || "Unnamed client") + " — adoption audit" }),
      el("div", { class: "btn-row no-print" }, [
        el("button", { class: "btn btn--primary", "data-action": "record", text: "Record in library" }),
        el("button", { class: "btn", "data-action": "copy-md", text: "Copy summary" }),
        el("button", { class: "btn", "data-action": "print", text: "Print / PDF" })
      ])
    ]));

    // Headline
    host.appendChild(panel("Where the value stands", "Executive summary", [
      el("div", { class: "hero" }, [
        el("div", {}, [
          el("div", { class: "eyebrow", text: "Licensed capability in use" }),
          el("div", { class: "hero__figure" }, [
            document.createTextNode(pct(adoption.captureRate)),
            el("small", { text: "captured" })
          ]),
          el("div", { class: "hero__caption",
            text: audit.benchmarkGap !== null && audit.benchmarkGap > 0
              ? "That is " + pct(audit.benchmarkGap) + " of value-weighted capability behind the cohort median."
              : "Weighted by value, across everything they are licensed for." })
        ]),
        el("div", {}, [
          meter(adoption.captureRate, audit.benchmark.reportable ? audit.benchmark.median_capture : null),
          el("p", { class: "note", text: audit.benchmark.describe(adoption.captureRate) })
        ])
      ])
    ]));

    var tiles = el("div", { class: "tiles" }, [
      tile("Recoverable in year one", money(leakage.recoverableTotal),
        money(leakage.recoverableLow) + " – " + money(leakage.recoverableHigh), true),
      tile("Gross annual leakage", money(leakage.grossTotal), "size of the problem"),
      tile("Idle subscription cost", money(leakage.licenseWaste), "sunk, not recoverable"),
      tile("Dormant capability", String(adoption.dormant.length),
        pct(adoption.licenseWasteShare) + " of licensed value producing nothing"),
      tile("Catalog assessed", pct(adoption.assessmentCoverage),
        adoption.assessmentCoverage < 0.6 ? "capture rate is provisional" : "walkthrough complete")
    ]);
    host.appendChild(tiles);

    // Qualification
    var verdictStyle = VERDICT_STYLE[audit.qualification.verdict];
    host.appendChild(panel("Should you take this job?", "Qualification gate", [
      el("div", { class: "verdict verdict--" + verdictStyle }, [
        el("strong", { text: VERDICT_TEXT[audit.qualification.verdict] }),
        el("span", { text: audit.qualification.rationale })
      ]),
      table(["Check", "Result", "Finding", "Required action"],
        audit.qualification.checks.map(function (c) {
          return [
            titleCase(c.id),
            { node: el("span", { class: "pill pill--" + CHECK_STYLE[c.verdict],
                text: c.verdict === "block" ? "Blocker" : titleCase(c.verdict) }) },
            c.finding,
            c.remedy || "—"
          ];
        }))
    ]));

    // Capture by module
    var moduleRows = adoption.byModule.slice().sort(function (a, b) {
      return a.capture_rate - b.capture_rate;
    }).map(function (row) {
      return {
        label: row.module,
        sub: row.capabilities + " licensed · weight " + row.licensed_weight,
        value: row.capture_rate, low: undefined, high: undefined,
        display: pct(row.capture_rate),
        tooltip: row.module + ": " + pct(row.capture_rate) + " of licensed value captured"
      };
    });

    host.appendChild(panel("Capture by module", "Worst first", [
      moduleRows.length ? barRows(moduleRows, { min: 1 })
        : el("p", { class: "empty", text: "Nothing licensed yet — run the capability walkthrough." }),
      adoption.blocked.length ? el("div", { style: "margin-top:1.1rem" }, [
        el("div", { class: "eyebrow", style: "margin-bottom:.5rem", text: "Sequencing constraints" }),
        table(["Capability", "Cannot start until"], adoption.blocked.map(function (b) {
          return [b.line.capability.name, b.unmet.map(function (id) {
            var cap = E.getCapability(state.engagement.client.platform, id);
            return cap ? cap.name : id;
          }).join(", ")];
        }))
      ]) : null
    ]));

    // Dormant
    if (adoption.dormant.length) {
      host.appendChild(panel("Dormant capability", "Licensed, doing nothing", [
        table([
          "Capability", "Module", "State", { label: "Weight", num: true },
          { label: "Peers using it", num: true }, { label: "Activation", num: true }
        ], adoption.dormant.map(function (line) {
          return [
            line.capability.name, line.capability.module,
            { node: el("span", { class: "pill pill--mute", text: E.STATE_LABEL[line.state] }) },
            { text: line.capability.value_weight, num: true },
            { text: pct(line.capability.typical_capture), num: true },
            { text: line.capability.activation_effort_weeks + " wk", num: true }
          ];
        }), "Peer figures are catalog priors until the pattern library has three comparable engagements.")
      ]));
    }

    // Findings
    var findingRows = leakage.ranked.map(function (e) {
      return {
        label: e.name, sub: titleCase(e.driver) + " · " + e.evidence,
        value: e.recoverable_annual, low: e.low, high: e.high,
        display: money(e.recoverable_annual),
        tooltip: e.name + ": " + money(e.recoverable_annual) + " recoverable (" +
          money(e.low) + " – " + money(e.high) + "), " + money(e.gross_annual) + " gross"
      };
    });

    host.appendChild(panel("Where value is leaking", "Recoverable per year, with confidence band", [
      findingRows.length ? barRows(findingRows)
        : el("p", { class: "empty", text: "No findings can be quantified yet — add operating metrics." }),
      findingRows.length ? el("p", { class: "note",
        text: "Bars show what a fixed-scope sprint can take back inside twelve months. " +
              "The whisker is the evidence-quality band. Gross exposure is larger and is not quoted." }) : null,
      el("div", { style: "margin-top:1rem" }, leakage.estimates.map(function (e) {
        return el("article", { class: "finding" }, [
          el("div", { class: "finding__head" }, [
            el("div", { class: "finding__title", text: e.name }),
            el("span", { class: "pill pill--" + (e.evidence === "measured" ? "good" :
              e.evidence === "anecdotal" ? "warn" : "mute"), text: e.evidence })
          ]),
          el("p", { class: "finding__plain", text: e.plain }),
          el("div", { class: "finding__figures" }, e.category === "license" ? [
            el("div", {}, [el("b", { text: money(e.gross_annual) }), document.createTextNode("sunk each year")]),
            el("div", {}, [el("b", { text: "not recoverable" }),
              document.createTextNode("converts through adoption, or at renewal")])
          ] : [
            el("div", {}, [el("b", { text: money(e.recoverable_annual) }), document.createTextNode("recoverable / yr")]),
            el("div", {}, [el("b", { text: money(e.low) + " – " + money(e.high) }), document.createTextNode("range")]),
            el("div", {}, [el("b", { text: money(e.gross_annual) }), document.createTextNode("gross exposure")])
          ]),
          el("div", { class: "finding__basis", text: e.basis }),
          e.assumptions.length ? el("ul", { class: "finding__assumptions" }, e.assumptions.map(function (a) {
            return el("li", { text: a });
          })) : null,
          e.linked_capabilities.length ? el("div", { style: "margin-top:.5rem" },
            e.linked_capabilities.map(function (id) {
              var cap = E.getCapability(state.engagement.client.platform, id);
              return el("span", { class: "chip", text: cap ? cap.name : id });
            })) : null
        ]);
      }))
    ]));

    if (leakage.skipped.length) {
      host.appendChild(panel("Not assessed", "Unmeasured, not zero", [
        el("p", { class: "muted", style: "font-size:.9rem",
          text: "These are not worth nothing. They are unmeasured, and quoting a number we cannot " +
                "support would devalue the ones we can." }),
        table(["Finding", "What it needs"], leakage.skipped.map(function (s) {
          return [s.name, s.missing.join(", ")];
        }))
      ]));
    }

    // Roadmap
    var sprint = plan.sprint;
    var structural = sprint.excluded.filter(function (x) { return x.reason !== E.CAP_REASON; });

    host.appendChild(panel(
      sprint.items.length
        ? "Proposed sprint — " + sprint.duration_weeks + " weeks, " + sprint.team_size + " consultant(s)"
        : "Proposed sprint",
      "Tier 2 · fixed scope",
      [
        sprint.items.length ? el("div", {}, sprint.items.map(function (item, index) {
          return el("article", { class: "sprint-item" }, [
            el("div", { class: "sprint-item__rank", text: String(index + 1) }),
            el("div", {}, [
              el("div", { class: "finding__head" }, [
                el("div", { class: "finding__title", text: item.title }),
                el("span", { class: "pill pill--accent",
                  text: money(item.recoverable_annual) + " / yr" })
              ]),
              el("p", { class: "finding__plain", text: item.plain }),
              el("div", { class: "finding__figures" }, [
                el("div", {}, [el("b", { text: item.effort_weeks + " wk" }), document.createTextNode("effort")]),
                el("div", {}, [el("b", { text: money(item.score) }), document.createTextNode("value / consultant-week")]),
                el("div", {}, [el("b", { text: money(item.low) + " – " + money(item.high) }),
                  document.createTextNode("range")])
              ]),
              el("p", { class: "note", text: "Measured by: " + item.measure }),
              item.target_names.length ? el("div", { style: "margin-top:.5rem" },
                item.target_names.map(function (name) { return el("span", { class: "chip", text: name }); })) : null
            ])
          ]);
        })) : el("p", { class: "empty",
          text: "Nothing clears the materiality floor with the evidence available. That is a finding, not a gap." }),

        structural.length ? el("div", { style: "margin-top:1.2rem" }, [
          el("div", { class: "eyebrow", style: "margin-bottom:.5rem", text: "Cannot go in a sprint yet" }),
          table(["Item", { label: "Value / yr", num: true }, "Why not"], structural.map(function (x) {
            return [x.item.title, { text: money(x.item.recoverable_annual), num: true }, x.reason];
          }))
        ]) : null,

        plan.deferred.length ? el("div", { style: "margin-top:1.2rem" }, [
          el("div", { class: "eyebrow", style: "margin-bottom:.5rem", text: "Deferred — the Tier 3 backlog" }),
          table(["Item", { label: "Recoverable / yr", num: true }, { label: "Effort", num: true }],
            plan.deferred.map(function (i) {
              return [i.title, { text: money(i.recoverable_annual), num: true },
                { text: i.effort_weeks + " wk", num: true }];
            }))
        ]) : null,

        plan.unquantified.length ? el("div", { style: "margin-top:1.2rem" }, [
          el("div", { class: "eyebrow", style: "margin-bottom:.5rem", text: "Idle, and we cannot size it" }),
          table(["Capability", "Driver", { label: "Effort", num: true }, "Note"],
            plan.unquantified.map(function (i) {
              return [i.title, titleCase(i.driver), { text: i.effort_weeks + " wk", num: true }, i.thesis];
            }))
        ]) : null
      ]
    ));

    // Commercials
    host.appendChild(panel("Commercials", "Priced inside the published bands", [
      table(["Tier", { label: "Price", num: true }, "Basis"], [
        ["Tier 1 — this audit", { text: money(comm.audit_fee, { exact: true }), num: true }, "fixed fee"],
        ["Tier 2 — remediation sprint", { text: money(comm.sprint_fee, { exact: true }), num: true },
          sprint.duration_weeks + " weeks fixed scope · " + pct(comm.sprint_margin) + " delivery margin"],
        ["Tier 3 — managed optimization",
          { text: money(comm.retainer_monthly, { exact: true }) + " / mo", num: true },
          "ongoing tuning, adoption monitoring, quarterly review against baseline"]
      ]),
      el("div", { class: "tiles", style: "margin-top:1rem" }, [
        tile("Client return, year one", isFinite(comm.year_one_multiple)
          ? comm.year_one_multiple.toFixed(1) + "x" : "—", "on the sprint fee", true),
        tile("At the low end", isFinite(comm.low_case_multiple)
          ? comm.low_case_multiple.toFixed(1) + "x" : "—", "bottom of the estimate band"),
        tile("Payback", isFinite(comm.payback_months)
          ? comm.payback_months.toFixed(1) + " mo" : "—", "fee against monthly recovery")
      ]),
      comm.notes.length ? el("ul", { class: "finding__assumptions", style: "margin-top:1rem" },
        comm.notes.map(function (n) { return el("li", { text: n }); })) : null
    ]));

    // Data gaps
    var gaps = E.missingMetrics(eng);
    host.appendChild(panel("What would change this answer", "Data gaps", [
      gaps.length
        ? el("div", {}, [
            el("p", { class: "muted", style: "font-size:.9rem",
              text: "Each of these either unlocks a model or narrows a band:" }),
            el("div", {}, gaps.map(function (g) { return el("span", { class: "chip", text: g }); }))
          ])
        : el("p", { class: "muted", text: "Every operating metric was supplied." }),
      el("p", { class: "note",
        text: "Bands reflect evidence quality, not modelling precision. Moving a finding from " +
              "estimated to measured is usually a two-day exercise and is worth doing before the " +
              "sprint is scoped." })
    ]));
  }


  // --- growth advisor -------------------------------------------------------

  var VERDICT_STYLE_MARKET = { GO: "good", MARGINAL: "warn", NO: "crit" };
  var VERDICT_TEXT_MARKET = {
    GO: "Worth doing",
    MARGINAL: "Only with eyes open",
    NO: "Don't do this"
  };

  var SUGGESTIONS = [
    "Should I open in Dallas?",
    "What areas would be good?",
    "Dallas vs Atlanta",
    "How big is the Chicago market?",
    "When does it break even with 3 consultants?",
    "Where do these numbers come from?"
  ];

  function currentFirm() {
    var bag = {};
    Object.keys(E.FIRM_DEFAULTS).forEach(function (k) {
      bag[k] = state.firm[k] === undefined ? E.FIRM_DEFAULTS[k] : state.firm[k];
    });
    return E.firmModel(bag);
  }

  function marketTiles(scenario) {
    return el("div", { class: "tiles" }, [
      tile("Breaks even", scenario.breakeven_month ? "month " + scenario.breakeven_month : "never",
        scenario.breakeven_month ? "and stays there" : "inside the horizon", true),
      tile("Revenue, final year", money(scenario.year_three_revenue), "run rate at the end"),
      tile("Addressable accounts", scenario.addressable.toFixed(0), "modelled from real counts"),
      tile("Cash trough", money(scenario.cash_trough), "month " + scenario.cash_trough_month),
      tile("Peak headcount", String(Math.round(scenario.peak_consultants)), "consultants")
    ]);
  }

  function marketBreakdown(sizing) {
    var m = sizing.metro;
    return table(
      ["Layer", { label: "Figure", num: true }, "Where it comes from"],
      [
        ["Establishments in scope", { text: m.establishments.toLocaleString("en-US"), num: true },
          "measured — BLS QCEW"],
        ["People employed", { text: m.employment ? m.employment.toLocaleString("en-US") : "withheld",
          num: true }, sizing.disclosed_employment ? "measured — BLS QCEW" : "BLS withheld; estimated from establishments"],
        ["Enterprise-scale sites", { text: sizing.enterprise_sites.toFixed(0), num: true },
          "modelled — employment ÷ 250 per site"],
        ["Running a planning platform", { text: sizing.platform_accounts.toFixed(0), num: true },
          "modelled — 18% penetration"],
        ["Past go-live, underperforming", { text: sizing.underperforming.toFixed(0), num: true },
          "modelled — 55% of those"],
        ["Addressable by this practice", { text: sizing.addressable.toFixed(0), num: true },
          "modelled — 35% reachable × 40% platform focus"]
      ]
    );
  }

  function verdictBlock(scenario) {
    return el("div", { class: "verdict verdict--" + VERDICT_STYLE_MARKET[scenario.verdict] }, [
      el("strong", { text: VERDICT_TEXT_MARKET[scenario.verdict] }),
      el("span", { text: scenario.reasons[0] || "" })
    ]);
  }

  function reasonList(scenario) {
    return el("ul", { class: "finding__assumptions" },
      scenario.reasons.slice(1).map(function (r) { return el("li", { text: r }); }));
  }

  function contextPrefix(plan) {
    if (!plan.used_context) return "";
    var names = plan.metros.map(M.display).join(" + ");
    if (plan.unknown_places && plan.unknown_places.length) {
      return "I do not know \u201c" + plan.unknown_places[0] + "\u201d as a US metro, so this is " +
        names + " from your last question. ";
    }
    return "Still on " + names + ". ";
  }

  function answerDecision(plan, firm) {
    var ids = plan.metros.map(function (m) { return m.id; });
    var scenario = ADVISOR.scenarioFor(plan, firm, ids);
    var names = plan.metros.map(M.display).join(" + ");
    var heads = plan.consultants || M.SCENARIO_DEFAULTS.starting_consultants;

    var lead = scenario.verdict === "GO"
      ? "Yes — on these numbers " + names + " works."
      : scenario.verdict === "MARGINAL"
        ? "It can work, but not comfortably."
        : "No. Not on these numbers.";

    return {
      text: contextPrefix(plan) + lead + " Starting with " + heads + " consultant" +
        (heads === 1 ? "" : "s") + " over " + scenario.months.length +
        " months, against your own fees and payment terms.",
      blocks: [
        verdictBlock(scenario),
        marketTiles(scenario),
        trajectoryChart(scenario),
        el("p", { class: "note", text: "Line is cumulative profit. Everything below the rule " +
          "is money you are funding out of pocket." }),
        reasonList(scenario)
      ],
      metros: ids
    };
  }

  function answerSize(plan) {
    var metro = plan.metros[0];
    var sizing = M.sizeMarket(metro, null, plan.sub_vertical);
    return {
      text: M.display(metro) + " has " + metro.establishments.toLocaleString("en-US") +
        " establishments in warehousing, trucking, wholesale and food manufacturing" +
        (sizing.disclosed_employment
          ? " employing " + metro.employment.toLocaleString("en-US") + " people. "
          : ". Employment is withheld by BLS for this metro, so the figures below start from " +
            "establishment counts instead. ") +
        "Filtering down to accounts this practice could actually win:",
      blocks: [
        marketBreakdown(sizing),
        el("p", { class: "note", text: "The first two rows are counted. Everything under them " +
          "is modelled from stated assumptions — ask where the numbers come from to see them." })
      ],
      metros: [metro.id]
    };
  }

  function answerRank(plan, firm) {
    var ranked = M.rankMarkets(null, plan.sub_vertical, 8);
    var rows = ranked.map(function (s, i) {
      return [
        String(i + 1),
        M.display(s.metro),
        { text: s.metro.establishments.toLocaleString("en-US"), num: true },
        { text: s.addressable.toFixed(0), num: true }
      ];
    });
    var top = ranked[0];
    return {
      text: (plan.sub_vertical ? "For " + verticalLabel(plan.sub_vertical) + ", the" : "The") +
        " deepest markets in the country, ranked by accounts this practice could realistically " +
        "win. " + M.display(top.metro) + " leads with about " + top.addressable.toFixed(0) +
        ". Ask me about any of them.",
      blocks: [
        table(["#", "Metro", { label: "Establishments", num: true },
               { label: "Addressable", num: true }], rows),
        el("p", { class: "note", text: "Depth is not the whole answer — a market you already " +
          "have relationships in beats a bigger one you do not." })
      ],
      metros: ranked.slice(0, 3).map(function (s) { return s.metro.id; })
    };
  }

  function answerCompare(plan, firm) {
    var results = plan.metros.slice(0, 3).map(function (metro) {
      return { metro: metro, scenario: ADVISOR.scenarioFor(plan, firm, [metro.id]) };
    });
    var best = results.slice().sort(function (a, b) {
      var order = { GO: 0, MARGINAL: 1, NO: 2 };
      return (order[a.scenario.verdict] - order[b.scenario.verdict]) ||
             ((a.scenario.breakeven_month || 999) - (b.scenario.breakeven_month || 999)) ||
             (b.scenario.year_three_revenue - a.scenario.year_three_revenue);
    })[0];

    var rows = results.map(function (r) {
      return [
        M.display(r.metro),
        { node: el("span", { class: "pill pill--" + VERDICT_STYLE_MARKET[r.scenario.verdict],
            text: r.scenario.verdict }) },
        { text: r.scenario.breakeven_month ? "m" + r.scenario.breakeven_month : "never", num: true },
        { text: r.scenario.addressable.toFixed(0), num: true },
        { text: money(r.scenario.year_three_revenue), num: true },
        { text: money(r.scenario.cash_trough), num: true }
      ];
    });

    return {
      text: M.display(best.metro) + " wins" +
        (best.scenario.breakeven_month
          ? ", breaking even in month " + best.scenario.breakeven_month + "."
          : ", though none of them break even inside the horizon.") +
        " Same firm model, same assumptions, one metro at a time:",
      blocks: [
        table(["Metro", "Verdict", { label: "Breaks even", num: true },
               { label: "Accounts", num: true }, { label: "Final-year revenue", num: true },
               { label: "Cash trough", num: true }], rows),
        trajectoryChart(best.scenario),
        reasonList(best.scenario)
      ],
      metros: results.map(function (r) { return r.metro.id; })
    };
  }

  function answerTrajectory(plan, firm) {
    if (!plan.metros.length) return answerRank(plan, firm);
    var ids = plan.metros.map(function (m) { return m.id; });
    var scenario = ADVISOR.scenarioFor(plan, firm, ids);
    var text = contextPrefix(plan) + (scenario.breakeven_month
      ? "Cumulative profit turns positive in month " + scenario.breakeven_month +
        " and stays positive. Before that you are funding it."
      : "It never breaks even inside " + scenario.months.length + " months. " +
        "The cost base is bigger than this market can feed.");
    return {
      text: text,
      blocks: [marketTiles(scenario), trajectoryChart(scenario), reasonList(scenario)],
      metros: ids
    };
  }

  function answerAssumptions() {
    var src = M.source();
    var notes = M.assumptionNotes(null);
    return {
      text: "Two layers, deliberately kept apart. The counts are real: " + src.name +
        ", " + src.year + " " + src.basis + " — a census of employers covering " +
        "about 95% of US jobs, public domain. What is not real is which of those " +
        "companies run Blue Yonder, o9 or Kinaxis. Nobody publishes that, so it is modelled:",
      blocks: [
        table(["Assumption", { label: "Default", num: true }, "Means"],
          notes.map(function (n) {
            return [
              titleCase(n.key),
              { text: n.key === "enterprise_site_employment" ? n.value.toFixed(0)
                  : pct(n.value), num: true },
              n.text
            ];
          })),
        el("p", { class: "note", text: "Disagree with any of these and the answer changes — " +
          "that is the point of showing them rather than folding them into one number." })
      ],
      metros: []
    };
  }

  function answerHelp() {
    return {
      text: "I model moves into a metro against your own firm economics. Ask me things like:",
      blocks: [
        el("ul", { class: "finding__assumptions" }, [
          "\u201cShould I open in Dallas?\u201d — verdict, trajectory and break-even month",
          "\u201cWhat areas would be good?\u201d — the deepest markets, ranked",
          "\u201cDallas vs Atlanta\u201d — same model, side by side",
          "\u201cHow big is Chicago?\u201d — what is actually there, counted and modelled",
          "\u201cBreak even with 4 consultants?\u201d — change the team and re-run",
          "\u201cWhere do these numbers come from?\u201d — sources and assumptions"
        ].map(function (t) { return el("li", { text: t }); })),
        el("p", { class: "note", text: "Fees, payment terms and costs come from the Economics " +
          "screen, so edit those first if they are not yours." })
      ],
      metros: []
    };
  }

  function answerUnknown(plan) {
    return {
      text: "I could not find a US metro in that. I know 375 of them by name — try a city " +
        "like Dallas, Riverside, Columbus or Allentown, or ask what areas would be good.",
      blocks: [],
      metros: []
    };
  }

  function respond(question) {
    var firm = currentFirm();
    var plan = ADVISOR.interpret(question, state.chatContext);

    if (plan.intent === "help") return answerHelp();
    if (plan.intent === "assumptions") return answerAssumptions();
    if (plan.intent === "rank") return answerRank(plan, firm);
    if (!plan.metros.length) return plan.unmatched ? answerUnknown(plan) : answerHelp();
    if (plan.intent === "compare") return answerCompare(plan, firm);
    if (plan.intent === "size") return answerSize(plan);
    if (plan.intent === "trajectory") return answerTrajectory(plan, firm);
    return answerDecision(plan, firm);
  }

  function bubble(entry) {
    var body = el("div", { class: "bubble__body" });
    body.appendChild(el("p", { text: entry.text }));
    (entry.blocks || []).forEach(function (block) { if (block) body.appendChild(block); });
    return el("div", { class: "bubble bubble--" + entry.role }, [
      el("div", { class: "bubble__who", text: entry.role === "user" ? "You" : "Advisor" }),
      body
    ]);
  }

  function pushMessage(role, text, blocksFactory) {
    var log = document.getElementById("chat-log");
    var entry = { role: role, text: text, blocks: blocksFactory ? blocksFactory() : [] };
    log.appendChild(bubble(entry));
    // Blocks are live DOM, so only the text is persisted; replies re-render
    // from scratch on reload against whatever the firm model says then.
    state.chat.push({ role: role, text: text });
    if (state.chat.length > 40) state.chat = state.chat.slice(-40);
    save(STORE.chat, state.chat);
    log.lastChild.scrollIntoView({ block: "nearest" });
  }

  function ask(question) {
    if (!question.trim()) return;
    pushMessage("user", question.trim());
    var answer;
    try {
      answer = respond(question);
    } catch (err) {
      console.error(err);
      answer = { text: "Something went wrong running that scenario.", blocks: [], metros: [] };
    }
    if (answer.metros && answer.metros.length) state.chatContext.lastMetros = answer.metros;
    pushMessage("advisor", answer.text, function () { return answer.blocks; });
  }

  function renderGrowth() {
    var src = M.source();
    var host = document.getElementById("growth-source");
    clear(host);
    host.appendChild(el("div", { class: "panel__head" }, [
      el("h2", { text: "Market data" }),
      el("span", { class: "eyebrow", text: M.metros().length + " US metros" })
    ]));
    host.appendChild(el("p", { class: "muted", style: "font-size:.9rem",
      text: src.name + ", " + src.year + " " + src.basis + ". " + src.coverage + ". " +
        "Counts are measured; anything derived from them is labelled as modelled." }));

    var log = document.getElementById("chat-log");
    clear(log);
    if (!state.chat.length) {
      var intro = answerHelp();
      log.appendChild(bubble({ role: "advisor", text: intro.text, blocks: intro.blocks }));
    } else {
      state.chat.forEach(function (entry) {
        log.appendChild(bubble({ role: entry.role, text: entry.text, blocks: [] }));
      });
    }

    var suggestions = document.getElementById("chat-suggestions");
    clear(suggestions);
    SUGGESTIONS.forEach(function (text) {
      suggestions.appendChild(el("button", { class: "suggestion", type: "button", text: text,
        onclick: function () { ask(text); } }));
    });
  }

  // --- library view ---------------------------------------------------------

  function renderLibrary() {
    var host = document.getElementById("view-library");
    clear(host);

    host.appendChild(el("header", { class: "view__head" }, [
      el("div", { class: "eyebrow", text: "The compounding asset" }),
      el("h1", { text: "Pattern library" }),
      el("p", { text: "One record per completed audit. Cohort figures stay hidden until three " +
        "comparable engagements exist — quoting a benchmark drawn from two clients is how a young " +
        "firm loses the credibility it is trying to build." }),
      el("div", { class: "btn-row no-print" }, [
        el("button", { class: "btn btn--primary", "data-action": "record", text: "Record current engagement" }),
        el("button", { class: "btn", "data-action": "seed", text: "Add the four examples" }),
        el("button", { class: "btn btn--ghost", "data-action": "clear-library", text: "Clear library" })
      ])
    ]));

    if (!state.library.length) {
      host.appendChild(panel("Empty", "No engagements yet", [
        el("p", { class: "empty", text: "Record an audit, or load the four worked examples to see how " +
          "the benchmark behaves once a cohort exists." })
      ]));
      return;
    }

    var platform = state.engagement.client.platform;
    var benchmark = E.benchmarkFor(state.engagement, state.library);

    host.appendChild(el("div", { class: "tiles" }, [
      tile("Engagements recorded", String(state.library.length)),
      tile("Cohort for this client", String(benchmark.stats.n),
        benchmark.stats.reportable ? "reportable" : "below the three-engagement floor"),
      tile("Cohort median capture",
        benchmark.stats.reportable ? pct(benchmark.stats.median_capture) : "—",
        benchmark.stats.reportable
          ? "p25 " + pct(benchmark.stats.p25_capture) + " · p75 " + pct(benchmark.stats.p75_capture)
          : "needs " + (E.MIN_COHORT - benchmark.stats.n) + " more", true),
      tile("This client", pct(state.audit ? state.audit.adoption.captureRate : 0),
        benchmark.stats.reportable && benchmark.stats.percentileOf
          ? "percentile " + pct(benchmark.stats.percentileOf(state.audit.adoption.captureRate))
          : "no percentile yet")
    ]));

    host.appendChild(panel("Recorded engagements", "Newest last", [
      table(["Engagement", "Platform", "Sub-vertical", "Band",
        { label: "Capture", num: true }, { label: "Recoverable", num: true }, "Verdict", ""],
        state.library.map(function (record, index) {
          return [
            record.engagement_id, E.platformName(record.platform), verticalLabel(record.sub_vertical),
            E.BAND_LABEL[record.revenue_band] || record.revenue_band,
            { text: pct(record.capture_rate), num: true },
            { text: money(record.recoverable_annual), num: true },
            { node: el("span", { class: "pill pill--" + VERDICT_STYLE[record.qualification],
                text: record.qualification.replace("_", " ") }) },
            { node: el("button", { class: "btn btn--ghost no-print", text: "Remove",
                onclick: function () {
                  state.library.splice(index, 1);
                  save(STORE.library, state.library);
                  recompute();
                  renderAll();
                  toast("Removed");
                } }) }
          ];
        }))
    ]));

    var patterns = E.patternFrequency(E.cohort(state.library, platform));
    if (patterns.length) {
      host.appendChild(panel("Failure patterns", E.platformName(platform), [
        el("p", { class: "muted", style: "font-size:.9rem",
          text: "After twenty engagements this table is the diagnosis shortcut: what usually breaks, " +
                "and what it is usually worth." }),
        table(["Pattern", { label: "Seen in", num: true }, { label: "Frequency", num: true },
          { label: "Median recoverable", num: true }],
          patterns.map(function (row) {
            var model = E.MODELS.filter(function (m) { return m.id === row.model_id; })[0];
            return [model ? model.name : row.model_id,
              { text: row.engagements, num: true },
              { text: pct(row.frequency), num: true },
              { text: money(row.median_recoverable), num: true }];
          }))
      ]));
    }

    var dormancy = E.dormancyFrequency(state.library, platform);
    if (dormancy.length) {
      host.appendChild(panel("Most often dormant", "Where to look first", [
        table(["Capability", { label: "Seen in", num: true }, { label: "Frequency", num: true }],
          dormancy.slice(0, 12).map(function (row) {
            var cap = E.getCapability(platform, row.capability_id);
            return [cap ? cap.name + " — " + cap.module : row.capability_id,
              { text: row.engagements, num: true }, { text: pct(row.frequency), num: true }];
          }))
      ]));
    }
  }

  // --- firm view ------------------------------------------------------------

  var FIRM_FIELDS = [
    { key: "consultants", label: "Consultants", kind: "number" },
    { key: "loaded_cost", label: "Loaded cost each", kind: "money" },
    { key: "target_utilization", label: "Target utilization", kind: "pct" },
    { key: "overhead_annual", label: "Overhead", kind: "money" },
    { key: "audits_per_year", label: "Tier 1 audits / year", kind: "number" },
    { key: "audit_fee", label: "Audit fee", kind: "money" },
    { key: "sprints_per_year", label: "Tier 2 sprints / year", kind: "number" },
    { key: "sprint_fee", label: "Sprint fee", kind: "money" },
    { key: "retainer_clients", label: "Tier 3 retainer clients", kind: "number" },
    { key: "retainer_monthly", label: "Retainer / month", kind: "money" },
    { key: "deposit_rate", label: "Deposit on signature", kind: "pct" },
    { key: "payment_terms_days", label: "Payment terms (days)", kind: "number" },
    { key: "starting_cash", label: "Starting cash", kind: "money" }
  ];

  function renderFirm() {
    var host = document.getElementById("view-firm");
    clear(host);

    var bag = {};
    Object.keys(E.FIRM_DEFAULTS).forEach(function (k) {
      bag[k] = state.firm[k] === undefined ? E.FIRM_DEFAULTS[k] : state.firm[k];
    });
    var firm = E.firmModel(bag);
    var econ = E.unitEconomics(firm);
    var cash = E.cashFlow(firm, 24);

    host.appendChild(el("header", { class: "view__head" }, [
      el("div", { class: "eyebrow", text: "Your business, not the client's" }),
      el("h1", { text: "Firm economics" }),
      el("p", { text: "Does the mix fit the team, and how deep does the cash hole get between " +
        "enterprise payment terms and fortnightly payroll? A services firm can be profitable on " +
        "paper and still die of the second question." })
    ]));

    host.appendChild(panel("Inputs", "Change anything", [
      el("div", { class: "fields" }, FIRM_FIELDS.map(function (field) {
        return renderField(field, bag, function () {
          state.firm = bag;
          save(STORE.firm, bag);
          renderFirm();
        });
      })),
      el("div", { class: "btn-row no-print", style: "margin-top:1rem" }, [
        el("button", { class: "btn", text: "Reset to defaults", onclick: function () {
          state.firm = {};
          save(STORE.firm, {});
          renderFirm();
        } })
      ])
    ]));

    host.appendChild(el("div", { class: "tiles" }, [
      tile("Revenue", money(econ.revenue), "annual", true),
      tile("Gross margin", pct(econ.gross_margin), money(econ.gross_profit) + " gross profit"),
      tile("Operating profit", money(econ.operating_profit), "after idle time and overhead"),
      tile("Implied utilization", pct(econ.implied_utilization),
        Math.round(econ.required_weeks) + " of " + Math.round(econ.capacity_weeks) + " weeks"),
      tile("Recurring revenue", pct(econ.recurring_share), "plan targets 60% by year two")
    ]));

    if (econ.warnings.length) {
      host.appendChild(panel("What the mix is telling you", "Warnings", [
        el("div", { class: "stack" }, econ.warnings.map(function (w) {
          return el("div", { class: "verdict verdict--warn", style: "margin:0" }, [
            el("strong", { text: "Check" }), el("span", { text: w })
          ]);
        }))
      ]));
    }

    host.appendChild(panel("Annual P&L", "Where the money goes", [
      table(["Line", { label: "Amount", num: true }], [
        ["Tier 1 audits (" + firm.audits_per_year + " × " + money(firm.audit_fee) + ")",
          { text: money(econ.revenue_audit), num: true }],
        ["Tier 2 sprints (" + firm.sprints_per_year + " × " + money(firm.sprint_fee) + ")",
          { text: money(econ.revenue_sprint), num: true }],
        ["Tier 3 retainers (" + firm.retainer_clients + " × " + money(firm.retainer_monthly) + "/mo)",
          { text: money(econ.revenue_retainer), num: true }],
        [{ node: el("b", { text: "Revenue" }) },
          { node: el("b", { class: "num", text: money(econ.revenue) }), num: true }],
        ["Delivery cost", { text: money(-econ.delivery_cost), num: true }],
        ["Overhead", { text: money(-econ.overhead), num: true }],
        [{ node: el("b", { text: "Operating profit" }) },
          { node: el("b", { class: "num", text: money(econ.operating_profit) }), num: true }]
      ])
    ]));

    host.appendChild(panel("The cash trap", "Net " + firm.payment_terms_days + " against payroll", [
      el("div", { class: "tiles", style: "margin:0 0 1rem" }, [
        tile("Cash trough", money(cash.min_balance), "month " + cash.trough_month),
        tile("Months below zero", String(cash.months_negative), "out of 24"),
        tile("Credit line to arrange", money(cash.credit_line_needed), "before you need it", true),
        tile("Ending balance", money(cash.ending_balance), "month 24")
      ]),
      cashColumns(cash.months),
      el("p", { class: "note", text: "Bars are the cash balance each month; anything below the rule " +
        "is borrowed money. Deposits pull collections forward — they cannot remove the opening gap " +
        "before the first invoice clears." })
    ]));
  }

  // --- method view ----------------------------------------------------------

  var FORMULAS = {
    exception_handling: "exceptions/week × minutes ÷ 60 × 52 × (1 − automated) × planner hourly cost\n" +
      "recoverable = 55% of that",
    forecast_inventory: "excess stock = z(service level) × √(lead time weeks) × weekly COGS × (MAPE − attainable MAPE)\n" +
      "cost = excess stock × carrying rate;  recoverable = 70%",
    planner_override: "business case benefit × override rate × (1 − share of overrides that help)\n" +
      "recoverable = 50%",
    expedite_freight: "freight spend × expedited share × premium over contract rate\n" +
      "recoverable = 40%",
    stockout_margin: "revenue × lost-sale rate × gross margin\nrecoverable = 35%",
    excess_obsolete: "annual write-off\nrecoverable = 30% (the planning-latency share)",
    data_quality_tax: "rework hours/week × 52 × planner hourly cost\nrecoverable = 50%",
    license_waste: "annual subscription × share of licensed value producing nothing\nrecoverable = 0"
  };

  function renderMethod() {
    var host = document.getElementById("method-models");
    clear(host);
    E.MODELS.forEach(function (model) {
      host.appendChild(el("article", { class: "method-model" }, [
        el("div", { class: "finding__head" }, [
          el("h3", { text: model.name }),
          el("span", { class: "pill pill--mute", text: titleCase(model.driver) })
        ]),
        el("p", { class: "finding__plain", text: model.plain }),
        el("pre", { class: "formula", text: FORMULAS[model.id] || "" })
      ]));
    });

    var states = document.getElementById("method-states");
    clear(states);
    states.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", { text: "State" }), el("th", { text: "Means" }),
      el("th", { class: "num", text: "Scores" })
    ])]));
    states.appendChild(el("tbody", {}, [
      ["not_licensed", "They never bought it — excluded from the denominator"],
      ["licensed_unused", "Paying for it, never switched on"],
      ["deployed_unused", "Configured during the implementation, nobody opens it"],
      ["partial", "Used by some of the team, some of the time"],
      ["full", "The business genuinely runs on it"]
    ].map(function (row) {
      return el("tr", {}, [
        el("td", {}, [el("b", { text: E.STATE_LABEL[row[0]] })]),
        el("td", { text: row[1] }),
        el("td", { class: "num", text: (E.USAGE_SCORE[row[0]]).toFixed(2) })
      ]);
    })));
  }

  // --- markdown summary -----------------------------------------------------

  function summaryMarkdown() {
    var audit = state.audit;
    if (!audit) return "";
    var eng = audit.engagement;
    var lines = [];
    lines.push("# Adoption audit — " + (eng.client.name || "Unnamed client"));
    lines.push("");
    lines.push("**" + pct(audit.adoption.captureRate) + " of licensed capability in use.** " +
      audit.benchmark.describe(audit.adoption.captureRate));
    lines.push("");
    lines.push("| Measure | Value |");
    lines.push("|---|---|");
    lines.push("| Recoverable in year one | " + money(audit.leakage.recoverableTotal) + " (" +
      money(audit.leakage.recoverableLow) + " – " + money(audit.leakage.recoverableHigh) + ") |");
    lines.push("| Gross annual leakage | " + money(audit.leakage.grossTotal) + " |");
    lines.push("| Idle subscription cost | " + money(audit.leakage.licenseWaste) + " |");
    lines.push("| Qualification | " + audit.qualification.verdict + " |");
    lines.push("");
    lines.push("## Findings");
    lines.push("");
    lines.push("| Finding | Recoverable/yr | Range | Evidence |");
    lines.push("|---|---|---|---|");
    audit.leakage.ranked.forEach(function (e) {
      lines.push("| " + e.name + " | " + money(e.recoverable_annual) + " | " +
        money(e.low) + " – " + money(e.high) + " | " + e.evidence + " |");
    });
    if (audit.leakage.skipped.length) {
      lines.push("");
      lines.push("Not assessed: " + audit.leakage.skipped.map(function (s) {
        return s.name + " (needs " + s.missing.join(", ") + ")";
      }).join("; ") + ".");
    }
    lines.push("");
    lines.push("## Proposed sprint");
    lines.push("");
    if (audit.roadmap.sprint.items.length) {
      lines.push(audit.roadmap.sprint.duration_weeks + " weeks, " +
        audit.roadmap.sprint.team_size + " consultant(s), fee " +
        money(audit.commercials.sprint_fee, { exact: true }) + ".");
      lines.push("");
      audit.roadmap.sprint.items.forEach(function (item, i) {
        lines.push((i + 1) + ". **" + item.title + "** — " + money(item.recoverable_annual) +
          "/yr, " + item.effort_weeks + " wk. Measured by " + item.measure + ".");
      });
    } else {
      lines.push("No scope clears the materiality floor with the evidence available.");
    }
    return lines.join("\n") + "\n";
  }

  // --- actions --------------------------------------------------------------

  function recordEngagement() {
    if (!state.audit) return;
    var record = E.recordFromAudit(state.audit);
    if (!record.engagement_id) { toast("Give the engagement an id first"); return; }
    var exists = state.library.some(function (r) { return r.engagement_id === record.engagement_id; });
    if (exists) { toast(record.engagement_id + " is already recorded"); return; }
    state.library.push(record);
    save(STORE.library, state.library);
    recompute();
    renderAll();
    toast("Recorded " + record.engagement_id);
  }

  function seedLibrary() {
    var added = 0;
    DATA.samples.forEach(function (sample) {
      var audit = E.runAudit(sample, state.library);
      var record = E.recordFromAudit(audit);
      if (state.library.some(function (r) { return r.engagement_id === record.engagement_id; })) return;
      state.library.push(record);
      added++;
    });
    save(STORE.library, state.library);
    recompute();
    renderAll();
    toast(added ? "Added " + added + " engagements" : "Already recorded");
  }

  function exportFile() {
    var blob = new Blob([JSON.stringify(state.engagement, null, 2) + "\n"],
      { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = el("a", { href: url, download: (state.engagement.engagement_id || "engagement") + ".json" });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast("Saved — the CLI reads this same file");
  }

  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed.client || !parsed.client.platform) throw new Error("missing client.platform");
        if (!DATA.catalogs[parsed.client.platform]) {
          throw new Error("unknown platform " + parsed.client.platform);
        }
        state.engagement = parsed;
        recompute();
        renderAll();
        toast("Opened " + (parsed.client.name || parsed.engagement_id || "engagement"));
      } catch (err) {
        toast("Could not open that file: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  function setTheme(theme) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
    save(STORE.theme, theme);
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute("data-theme");
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (!current) setTheme(prefersDark ? "light" : "dark");
    else setTheme(current === "dark" ? "light" : "dark");
  }

  // --- view plumbing --------------------------------------------------------

  function setView(view) {
    state.view = view;
    ["engagement", "report", "growth", "library", "firm", "method"].forEach(function (name) {
      document.getElementById("view-" + name).hidden = name !== view;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      tab.setAttribute("aria-selected", tab.dataset.view === view ? "true" : "false");
    });
    if (view === "report") renderReport();
    if (view === "growth") renderGrowth();
    if (view === "library") renderLibrary();
    if (view === "firm") renderFirm();
    window.scrollTo({ top: 0, behavior: "instant" in document.documentElement.style ? "instant" : "auto" });
  }

  function renderRail() {
    var host = document.getElementById("rail-summary");
    clear(host);
    var audit = state.audit;
    if (!audit) return;

    var idField = el("input", {
      value: state.engagement.engagement_id || "",
      style: "font-family:var(--mono);font-size:.78rem;padding:.3rem .4rem;border:1px solid var(--rule);" +
             "border-radius:4px;background:var(--panel);color:var(--ink);width:100%",
      onchange: function (e) { state.engagement.engagement_id = e.target.value.trim(); recompute(); }
    });

    host.appendChild(idField);
    host.appendChild(el("div", { class: "stack", style: "margin-top:.5rem;font-family:var(--sans);font-size:.75rem" }, [
      el("div", { class: "row-between" }, [
        el("span", { class: "muted", text: "Capture" }),
        el("span", { class: "num", text: pct(audit.adoption.captureRate) })
      ]),
      el("div", { class: "row-between" }, [
        el("span", { class: "muted", text: "Recoverable" }),
        el("span", { class: "num", text: money(audit.leakage.recoverableTotal) })
      ]),
      el("div", { class: "row-between" }, [
        el("span", { class: "muted", text: "Verdict" }),
        el("span", { class: "pill pill--" + VERDICT_STYLE[audit.qualification.verdict],
          text: audit.qualification.verdict.replace("_", " ") })
      ])
    ]));
  }

  function refresh() {
    recompute();
    renderRail();
    updateProgress();
    if (state.view === "report") renderReport();
    if (state.view === "library") renderLibrary();
  }

  function updateProgress() {
    var eng = state.engagement;
    var catalog = E.getCatalog(eng.client.platform);
    var assessed = catalog.filter(function (c) {
      return eng.capabilities[c.id] && eng.capabilities[c.id] !== "not_assessed";
    }).length;
    var walkthrough = document.getElementById("walkthrough-progress");
    if (walkthrough) walkthrough.textContent = assessed + " of " + catalog.length + " assessed";

    var provided = E.providedMetrics(eng).length;
    var metrics = document.getElementById("metrics-progress");
    if (metrics) metrics.textContent = provided + " of " + E.OPERATIONS_FIELDS.length + " supplied";
  }

  function renderAll() {
    renderEngagement();
    renderMethod();
    renderRail();
    updateProgress();
    setView(state.view);
  }

  // --- wiring ---------------------------------------------------------------

  document.addEventListener("click", function (event) {
    var tab = event.target.closest(".tab");
    if (tab) { setView(tab.dataset.view); return; }

    var action = event.target.closest("[data-action]");
    if (!action) return;
    switch (action.dataset.action) {
      case "import": document.getElementById("import-file").click(); break;
      case "export": exportFile(); break;
      case "print": window.print(); break;
      case "theme": toggleTheme(); break;
      case "record": recordEngagement(); break;
      case "seed": seedLibrary(); break;
      case "clear-library":
        state.library = [];
        save(STORE.library, state.library);
        recompute();
        renderAll();
        toast("Library cleared");
        break;
      case "copy-md":
        navigator.clipboard.writeText(summaryMarkdown()).then(
          function () { toast("Summary copied as Markdown"); },
          function () { toast("Clipboard blocked — use Save file instead"); }
        );
        break;
      case "mark-all":
        E.getCatalog(state.engagement.client.platform).forEach(function (cap) {
          state.engagement.capabilities[cap.id] = action.dataset.state;
        });
        refresh();
        renderCapabilities();
        break;
    }
  });

  document.getElementById("chat-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var input = document.getElementById("chat-input");
    ask(input.value);
    input.value = "";
  });

  document.getElementById("import-file").addEventListener("change", function (event) {
    if (event.target.files && event.target.files[0]) importFile(event.target.files[0]);
    event.target.value = "";
  });

  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
    var views = { 1: "engagement", 2: "report", 3: "growth", 4: "library", 5: "firm",
                  6: "method" };
    if (views[event.key]) { setView(views[event.key]); event.preventDefault(); }
  });

  setTheme(load(STORE.theme));
  recompute();
  renderAll();
})();
