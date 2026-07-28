/*
 * Parity: the browser engine must agree with the Python package.
 *
 * Two implementations of the same methodology is a liability unless something
 * checks them against each other. This runs web/src/engine.js over the same
 * engagement files scvr/ was run over, and fails on any divergence beyond
 * floating-point noise.
 *
 *   node tests/test_web_parity.js
 *
 * Regenerate the reference outputs after changing any model:
 *   python3 tools/gen_web_data.py
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const engine = require(path.join(ROOT, "web/src/engine.js"));
const data = require(path.join(ROOT, "web/src/catalog.data.js"));
const marketEngine = require(path.join(ROOT, "web/src/market.js"));
const marketData = require(path.join(ROOT, "web/src/market.data.js"));
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/parity.json"), "utf8"));

engine.loadCatalogs(data.catalogs, data.platformNames);
marketEngine.load(marketData);

// Acklam's inverse-normal approximation is accurate to ~1.15e-9 relative,
// which is the only intentional source of divergence from Python's exact
// NormalDist. Everything else must agree to floating-point noise.
const REL_TOLERANCE = 1e-7;
const ABS_TOLERANCE = 1e-6;

let checks = 0;
const failures = [];

function fail(label, expected, actual) {
  failures.push(`${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
}

function closeTo(label, expected, actual) {
  checks++;
  if (typeof actual !== "number" || Number.isNaN(actual)) return fail(label, expected, actual);
  if (!Number.isFinite(expected)) {
    if (expected !== actual) fail(label, expected, actual);
    return;
  }
  const diff = Math.abs(expected - actual);
  if (diff <= ABS_TOLERANCE) return;
  if (diff / Math.max(Math.abs(expected), 1e-12) <= REL_TOLERANCE) return;
  fail(label, expected, actual);
}

function equal(label, expected, actual) {
  checks++;
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(label, expected, actual);
}

// --- audits ------------------------------------------------------------------

fixtures.audits.forEach((fixture) => {
  const tag = fixture.source;
  const expected = fixture.expected;
  const audit = engine.runAudit(fixture.engagement, []);

  closeTo(`${tag} capture_rate`, expected.capture_rate, audit.adoption.captureRate);
  closeTo(`${tag} catalog_capture_rate`, expected.catalog_capture_rate, audit.adoption.catalogCaptureRate);
  closeTo(`${tag} assessment_coverage`, expected.assessment_coverage, audit.adoption.assessmentCoverage);
  closeTo(`${tag} license_waste_share`, expected.license_waste_share, audit.adoption.licenseWasteShare);
  equal(`${tag} dormant order`, expected.dormant, audit.adoption.dormant.map((l) => l.capability.id));

  Object.keys(expected.by_module).forEach((module) => {
    const row = audit.adoption.byModule.find((r) => r.module === module);
    closeTo(`${tag} module ${module}`, expected.by_module[module], row ? row.capture_rate : NaN);
  });

  equal(`${tag} qualification verdict`, expected.qualification.verdict, audit.qualification.verdict);
  const actualChecks = {};
  audit.qualification.checks.forEach((c) => { actualChecks[c.id] = c.verdict; });
  equal(`${tag} qualification checks`, expected.qualification.checks, actualChecks);

  closeTo(`${tag} leakage gross_total`, expected.leakage.gross_total, audit.leakage.grossTotal);
  closeTo(`${tag} leakage recoverable_total`, expected.leakage.recoverable_total, audit.leakage.recoverableTotal);
  closeTo(`${tag} leakage recoverable_low`, expected.leakage.recoverable_low, audit.leakage.recoverableLow);
  closeTo(`${tag} leakage recoverable_high`, expected.leakage.recoverable_high, audit.leakage.recoverableHigh);
  closeTo(`${tag} license waste`, expected.leakage.license_waste, audit.leakage.licenseWaste);
  equal(`${tag} skipped models`, expected.leakage.skipped, audit.leakage.skipped.map((s) => s.model_id).sort());

  Object.keys(expected.leakage.estimates).forEach((id) => {
    const want = expected.leakage.estimates[id];
    const got = audit.leakage.estimates.find((e) => e.model_id === id);
    if (!got) return fail(`${tag} missing estimate ${id}`, want, null);
    closeTo(`${tag} ${id} gross`, want.gross, got.gross_annual);
    closeTo(`${tag} ${id} recoverable`, want.recoverable, got.recoverable_annual);
    closeTo(`${tag} ${id} low`, want.low, got.low);
    closeTo(`${tag} ${id} high`, want.high, got.high);
    closeTo(`${tag} ${id} confidence`, want.confidence, got.confidence);
    equal(`${tag} ${id} evidence`, want.evidence, got.evidence);
  });

  const sprint = audit.roadmap.sprint;
  equal(`${tag} sprint items`, expected.roadmap.sprint_items, sprint.items.map((i) => i.id));
  equal(`${tag} sprint duration`, expected.roadmap.duration_weeks, sprint.duration_weeks);
  equal(`${tag} sprint team`, expected.roadmap.team_size, sprint.team_size);
  closeTo(`${tag} sprint effort`, expected.roadmap.effort_weeks, sprint.effort_weeks);
  closeTo(`${tag} sprint recoverable`, expected.roadmap.sprint_recoverable, sprint.recoverable_annual);
  equal(`${tag} unquantified`, expected.roadmap.unquantified, audit.roadmap.unquantified.map((i) => i.id));

  Object.keys(expected.roadmap.item_effort).forEach((id) => {
    const item = audit.roadmap.items.find((i) => i.id === id);
    if (!item) return fail(`${tag} missing roadmap item ${id}`, id, null);
    closeTo(`${tag} ${id} effort`, expected.roadmap.item_effort[id], item.effort_weeks);
    closeTo(`${tag} ${id} score`, expected.roadmap.item_score[id], item.score);
  });

  equal(`${tag} audit fee`, expected.commercials.audit_fee, audit.commercials.audit_fee);
  equal(`${tag} sprint fee`, expected.commercials.sprint_fee, audit.commercials.sprint_fee);
  equal(`${tag} retainer`, expected.commercials.retainer_monthly, audit.commercials.retainer_monthly);
  closeTo(`${tag} sprint margin`, expected.commercials.sprint_margin, audit.commercials.sprint_margin);
  closeTo(`${tag} year one multiple`, expected.commercials.year_one_multiple, audit.commercials.year_one_multiple);
});

// --- firm economics ----------------------------------------------------------

fixtures.firms.forEach((fixture, index) => {
  const tag = `firm[${index}]`;
  const firm = engine.firmModel(fixture.overrides);
  const econ = engine.unitEconomics(firm);
  const cash = engine.cashFlow(firm, 24);
  const want = fixture.expected;

  closeTo(`${tag} revenue`, want.revenue, econ.revenue);
  closeTo(`${tag} delivery cost`, want.delivery_cost, econ.delivery_cost);
  closeTo(`${tag} gross margin`, want.gross_margin, econ.gross_margin);
  closeTo(`${tag} operating profit`, want.operating_profit, econ.operating_profit);
  closeTo(`${tag} required weeks`, want.required_weeks, econ.required_weeks);
  closeTo(`${tag} implied utilization`, want.implied_utilization, econ.implied_utilization);
  closeTo(`${tag} recurring share`, want.recurring_share, econ.recurring_share);
  closeTo(`${tag} breakeven audits`, want.breakeven_audits, econ.breakeven_audits);
  equal(`${tag} warning count`, want.warnings, econ.warnings.length);
  closeTo(`${tag} min balance`, want.min_balance, cash.min_balance);
  equal(`${tag} trough month`, want.trough_month, cash.trough_month);
  closeTo(`${tag} ending balance`, want.ending_balance, cash.ending_balance);
  equal(`${tag} months negative`, want.months_negative, cash.months_negative);
  closeTo(`${tag} credit line`, want.credit_line_needed, cash.credit_line_needed);
});

// --- library helpers ---------------------------------------------------------

(function libraryChecks() {
  closeTo("percentile p25", 0.3, engine.percentile([0.2, 0.4, 0.6], 0.25));
  closeTo("median", 0.4, engine.median([0.2, 0.4, 0.6]));

  const records = [0.2, 0.4, 0.6].map((rate, i) => ({
    engagement_id: `e${i}`, platform: "blue_yonder", sub_vertical: "3pl",
    revenue_band: "250m_1b", capture_rate: rate, license_waste_share: 0.3,
    leakage: { exception_handling: 100000 }, dormant_capabilities: ["by.ct.playbooks"]
  }));

  const small = engine.cohortStats(records.slice(0, 2), "blue_yonder");
  equal("small cohort suppressed", false, small.reportable);

  const stats = engine.cohortStats(records, "blue_yonder");
  equal("cohort reportable at the floor", true, stats.reportable);
  closeTo("cohort median", 0.4, stats.median_capture);
  closeTo("cohort percentile", 2 / 3, stats.percentileOf(0.5));

  const patterns = engine.patternFrequency(records);
  equal("pattern frequency", 1, patterns[0].frequency);

  const benchmark = engine.benchmarkFor(
    { engagement_id: "e0", client: { platform: "blue_yonder", annual_revenue: 300e6, sub_vertical: "3pl" } },
    records
  );
  equal("client excluded from its own cohort", 2, benchmark.stats.n);
})();

// --- market sizing and scenarios ---------------------------------------------

(function marketChecks() {
  const fixtures_ = fixtures.market;
  if (!fixtures_) return;

  Object.keys(fixtures_.lookups).forEach((query) => {
    const found = marketEngine.findMetro(query);
    equal(`lookup "${query}"`, fixtures_.lookups[query], found ? found.id : null);
  });

  fixtures_.sizings.forEach((fixture) => {
    const metro = marketEngine.findMetro(fixture.metro_id);
    const tag = `size ${fixture.metro_id}/${fixture.sub_vertical || "all"}`;
    if (!metro) return fail(tag, fixture.metro_id, null);
    const sized = marketEngine.sizeMarket(metro, null, fixture.sub_vertical);
    closeTo(`${tag} enterprise_sites`, fixture.expected.enterprise_sites, sized.enterprise_sites);
    closeTo(`${tag} platform_accounts`, fixture.expected.platform_accounts, sized.platform_accounts);
    closeTo(`${tag} addressable`, fixture.expected.addressable, sized.addressable);
    equal(`${tag} disclosed`, fixture.expected.disclosed_employment, sized.disclosed_employment);
  });

  equal("3pl market ranking", fixtures_.ranking_3pl,
    marketEngine.rankMarkets(null, "3pl", 8).map((s) => s.metro.id));

  fixtures_.scenarios.forEach((fixture) => {
    const tag = `scenario ${fixture.label}`;
    const firm = engine.firmModel(fixture.firm_overrides);
    const inputs = Object.assign({ markets: fixture.market_ids, horizon_months: 36 }, fixture.inputs);
    const scenario = marketEngine.runScenario(firm, inputs);
    const want = fixture.expected;

    equal(`${tag} verdict`, want.verdict, scenario.verdict);
    equal(`${tag} reasons`, want.reasons, scenario.reasons);
    equal(`${tag} breakeven`, want.breakeven_month, scenario.breakeven_month);
    closeTo(`${tag} cash trough`, want.cash_trough, scenario.cash_trough);
    equal(`${tag} trough month`, want.cash_trough_month, scenario.cash_trough_month);
    closeTo(`${tag} peak consultants`, want.peak_consultants, scenario.peak_consultants);
    closeTo(`${tag} yr3 revenue`, want.year_three_revenue, scenario.year_three_revenue);
    closeTo(`${tag} total revenue`, want.total_revenue, scenario.total_revenue);
    closeTo(`${tag} addressable`, want.addressable, scenario.addressable);
    equal(`${tag} exhausted`, want.market_exhausted_month, scenario.market_exhausted_month);
    equal(`${tag} month count`, want.months.length, scenario.months.length);

    want.months.forEach((wantMonth, index) => {
      const got = scenario.months[index];
      if (!got) return fail(`${tag} missing month ${wantMonth.month}`, wantMonth.month, null);
      closeTo(`${tag} m${wantMonth.month} revenue`, wantMonth.revenue, got.revenue);
      closeTo(`${tag} m${wantMonth.month} profit`, wantMonth.profit, got.profit);
      closeTo(`${tag} m${wantMonth.month} cumulative`, wantMonth.cumulative_profit, got.cumulative_profit);
      closeTo(`${tag} m${wantMonth.month} cash`, wantMonth.cash, got.cash);
      closeTo(`${tag} m${wantMonth.month} heads`, wantMonth.consultants, got.consultants);
      closeTo(`${tag} m${wantMonth.month} utilization`, wantMonth.utilization, got.utilization);
      closeTo(`${tag} m${wantMonth.month} audits`, wantMonth.audits_signed, got.audits_signed);
    });
  });
})();

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`\nPARITY FAILED -- ${failures.length} of ${checks} checks diverged:\n`);
  failures.slice(0, 25).forEach((f) => console.error("  " + f));
  if (failures.length > 25) console.error(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}

console.log(`parity ok -- ${checks} checks across ${fixtures.audits.length} engagements, ` +
            `${fixtures.firms.length} firm models and ${fixtures.market.scenarios.length} market scenarios`);
