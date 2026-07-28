"""Tests for the audit pipeline: model -> adoption -> leakage -> roadmap -> price."""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path
from statistics import NormalDist

from scvr import adoption, catalog, cli, commercial, leakage, qualify, report, roadmap
from scvr.audit import run
from scvr.model import Engagement, EngagementError, revenue_band

BASE_CLIENT = {
    "name": "Test Co",
    "platform": "blue_yonder",
    "sub_vertical": "3pl",
    "annual_revenue": 300_000_000,
    "live_months": 24,
    "sites": 1,
    "erp_systems": 1,
    "skus": 1_000,
    "planners_fte": 5,
}

HEALTHY_GOVERNANCE = {
    "executive_sponsor": "VP Supply Chain",
    "documented_baseline": True,
    "baseline_period_months": 6,
    "dedicated_client_resource": True,
    "prior_remediation_attempts": 0,
}


def engagement(**overrides) -> Engagement:
    raw = {
        "engagement_id": "test-1",
        "client": dict(BASE_CLIENT, **overrides.pop("client", {})),
        "capabilities": overrides.pop("capabilities", {}),
        "operations": overrides.pop("operations", {}),
        "governance": dict(HEALTHY_GOVERNANCE, **overrides.pop("governance", {})),
        "evidence": overrides.pop("evidence", {}),
    }
    raw.update(overrides)
    return Engagement.from_dict(raw)


class CatalogTests(unittest.TestCase):
    def test_catalogs_are_well_formed(self):
        catalog.validate_catalogs()  # duplicate ids / dangling prerequisites

    def test_every_role_maps_to_real_capabilities(self):
        for role, per_platform in leakage.CAPABILITY_ROLES.items():
            self.assertEqual(
                set(per_platform), set(catalog.platforms()), f"role {role} misses a platform"
            )
            for platform, ids in per_platform.items():
                for cap_id in ids:
                    catalog.get_capability(platform, cap_id)  # raises if unknown

    def test_unknown_platform_is_rejected(self):
        with self.assertRaises(KeyError):
            catalog.get_catalog("manhattan")


class EngagementValidationTests(unittest.TestCase):
    def test_unknown_capability_id_rejected(self):
        with self.assertRaises(EngagementError) as ctx:
            engagement(capabilities={"by.nope.thing": "full"})
        self.assertIn("unknown capability", str(ctx.exception))

    def test_invalid_state_rejected(self):
        with self.assertRaises(EngagementError):
            engagement(capabilities={"by.io.meio": "sort_of"})

    def test_invalid_evidence_rejected(self):
        with self.assertRaises(EngagementError):
            engagement(evidence={"exception_handling": "vibes"})

    def test_unknown_platform_rejected(self):
        with self.assertRaises(EngagementError):
            engagement(client={"platform": "manhattan"})

    def test_revenue_bands(self):
        self.assertEqual(revenue_band(100e6), "under_250m")
        self.assertEqual(revenue_band(300e6), "250m_1b")
        self.assertEqual(revenue_band(2e9), "1b_5b")
        self.assertEqual(revenue_band(9e9), "over_5b")


class AdoptionTests(unittest.TestCase):
    def test_capture_rate_is_value_weighted_over_licensed_only(self):
        # meio (w5) full, playbooks (w4) licensed_unused, slotting (w3) not licensed.
        prof = adoption.profile(
            engagement(
                capabilities={
                    "by.io.meio": "full",
                    "by.ct.playbooks": "licensed_unused",
                    "by.wms.slotting": "not_licensed",
                }
            )
        )
        self.assertAlmostEqual(prof.licensed_weight, 9.0)
        self.assertAlmostEqual(prof.captured_weight, 5.0)
        self.assertAlmostEqual(prof.capture_rate, 5 / 9)

    def test_unassessed_capability_is_excluded_not_assumed(self):
        prof = adoption.profile(engagement(capabilities={"by.io.meio": "full"}))
        self.assertAlmostEqual(prof.capture_rate, 1.0)
        self.assertLess(prof.assessment_coverage, 0.1)

    def test_partial_use_scores_half(self):
        prof = adoption.profile(engagement(capabilities={"by.io.meio": "partial"}))
        self.assertAlmostEqual(prof.capture_rate, 0.5)

    def test_dormant_and_license_waste(self):
        prof = adoption.profile(
            engagement(
                capabilities={
                    "by.io.meio": "licensed_unused",
                    "by.ct.exception_mgmt": "deployed_unused",
                    "by.sp.master_planning": "full",
                }
            )
        )
        dormant_ids = [ln.capability.id for ln in prof.dormant()]
        self.assertEqual(dormant_ids, ["by.io.meio", "by.ct.exception_mgmt"])
        self.assertAlmostEqual(prof.license_waste_share(), 10 / 15)

    def test_prerequisite_blocking_is_detected(self):
        prof = adoption.profile(
            engagement(
                capabilities={
                    "by.ct.exception_mgmt": "licensed_unused",
                    "by.ct.playbooks": "licensed_unused",
                }
            )
        )
        blocked = {ln.capability.id: unmet for ln, unmet in prof.blocked_by_prerequisite()}
        self.assertIn("by.ct.playbooks", blocked)
        self.assertEqual(blocked["by.ct.playbooks"], ["by.ct.exception_mgmt"])


class LeakageTests(unittest.TestCase):
    def _assess(self, **kwargs):
        eng = engagement(**kwargs)
        return leakage.assess(eng, adoption.profile(eng))

    def test_exception_handling_arithmetic(self):
        result = self._assess(
            operations={
                "exceptions_per_week": 100,
                "minutes_per_exception": 12,
                "planner_loaded_cost": 94_000,  # $50.00/hr over 1880 hours
            },
            evidence={"exception_handling": "measured"},
        )
        est = next(e for e in result.estimates if e.model_id == "exception_handling")
        self.assertAlmostEqual(est.gross_annual, 52_000.0, places=2)
        self.assertAlmostEqual(est.recoverable_annual, 52_000.0 * 0.55, places=2)
        self.assertAlmostEqual(est.low, est.recoverable_annual * 0.8, places=2)
        self.assertAlmostEqual(est.high, est.recoverable_annual * 1.2, places=2)

    def test_automation_rate_reduces_manual_volume(self):
        result = self._assess(
            operations={
                "exceptions_per_week": 100,
                "minutes_per_exception": 12,
                "planner_loaded_cost": 94_000,
                "exception_automation_rate": 0.25,
            }
        )
        est = next(e for e in result.estimates if e.model_id == "exception_handling")
        self.assertAlmostEqual(est.gross_annual, 52_000.0 * 0.75, places=2)

    def test_forecast_inventory_safety_stock_formula(self):
        result = self._assess(
            operations={
                "annual_cogs": 52_000_000,  # $1M/week
                "forecast_mape": 0.30,
                "attainable_mape": 0.20,
                "avg_lead_time_weeks": 4.0,
                "service_level_target": 0.95,
                "carrying_cost_rate": 0.25,
            }
        )
        est = next(e for e in result.estimates if e.model_id == "forecast_inventory")
        z = NormalDist().inv_cdf(0.95)
        expected_inventory = z * math.sqrt(4.0) * 1_000_000 * 0.10
        self.assertAlmostEqual(est.gross_annual, expected_inventory * 0.25, places=2)
        self.assertAlmostEqual(est.recoverable_annual, est.gross_annual * 0.70, places=2)

    def test_forecast_inventory_capped_by_on_hand(self):
        result = self._assess(
            operations={
                "annual_cogs": 52_000_000,
                "forecast_mape": 0.60,
                "attainable_mape": 0.20,
                "avg_lead_time_weeks": 9.0,
                "carrying_cost_rate": 0.25,
                "inventory_value": 1_000_000,
            }
        )
        est = next(e for e in result.estimates if e.model_id == "forecast_inventory")
        self.assertAlmostEqual(est.gross_annual, 500_000 * 0.25, places=2)
        self.assertTrue(any("capped" in a for a in est.assumptions))

    def test_missing_inputs_are_reported_not_guessed(self):
        result = self._assess(operations={})
        self.assertEqual(result.estimates, [])
        skipped = {s.model_id: s.missing for s in result.skipped}
        self.assertIn("exception_handling", skipped)
        self.assertIn("exceptions_per_week", skipped["exception_handling"])
        self.assertEqual(result.recoverable_total, 0.0)

    def test_evidence_quality_widens_the_band_only(self):
        ops = {
            "exceptions_per_week": 100,
            "minutes_per_exception": 12,
            "planner_loaded_cost": 94_000,
        }
        measured = self._assess(operations=ops, evidence={"exception_handling": "measured"})
        anecdotal = self._assess(operations=ops, evidence={"exception_handling": "anecdotal"})
        m = measured.estimates[0]
        a = anecdotal.estimates[0]
        self.assertAlmostEqual(m.recoverable_annual, a.recoverable_annual)
        self.assertLess(a.low, m.low)
        self.assertGreater(a.high, m.high)

    def test_license_waste_is_excluded_from_recoverable_total(self):
        eng = engagement(
            client={"annual_license_fee": 1_000_000},
            capabilities={"by.io.meio": "licensed_unused"},
        )
        result = leakage.assess(eng, adoption.profile(eng))
        waste = next(e for e in result.estimates if e.model_id == "license_waste")
        self.assertAlmostEqual(waste.gross_annual, 1_000_000.0)
        self.assertEqual(waste.recoverable_annual, 0.0)
        self.assertEqual(result.recoverable_total, 0.0)
        self.assertAlmostEqual(result.license_waste, 1_000_000.0)

    def test_override_erosion_requires_a_business_case(self):
        result = self._assess(operations={"planner_override_rate": 0.5})
        skipped = {s.model_id: s.missing for s in result.skipped}
        self.assertIn("client.business_case_annual_benefit", skipped["planner_override"])


class QualificationTests(unittest.TestCase):
    def _evaluate(self, **kwargs):
        eng = engagement(**kwargs)
        return qualify.evaluate(eng, adoption.profile(eng))

    def test_bad_master_data_is_a_walk_away(self):
        q = self._evaluate(operations={"master_data_accuracy": 0.6})
        self.assertEqual(q.verdict, qualify.WALK_AWAY)
        self.assertIn("master_data", [c.id for c in q.blocks])

    def test_too_early_is_a_walk_away(self):
        q = self._evaluate(client={"live_months": 4})
        self.assertEqual(q.verdict, qualify.WALK_AWAY)

    def test_missing_sponsor_is_a_walk_away(self):
        q = self._evaluate(governance={"executive_sponsor": None})
        self.assertEqual(q.verdict, qualify.WALK_AWAY)

    def test_cio_only_sponsor_warns(self):
        q = self._evaluate(governance={"executive_sponsor": "CIO"})
        self.assertIn("sponsor", [c.id for c in q.warnings])

    def test_two_warnings_make_it_conditional(self):
        q = self._evaluate(
            governance={"documented_baseline": False},
            operations={"master_data_accuracy": 0.85},
        )
        self.assertEqual(q.verdict, qualify.CONDITIONAL)

    def test_clean_engagement_is_a_go(self):
        eng = engagement(
            capabilities={c.id: "partial" for c in catalog.get_catalog("blue_yonder")},
            operations={
                "master_data_accuracy": 0.95,
                "annual_cogs": 1,
                "forecast_mape": 0.2,
                "avg_lead_time_weeks": 2,
                "exceptions_per_week": 1,
                "minutes_per_exception": 1,
                "planner_loaded_cost": 100_000,
                "interface_failure_rate": 0.01,
                "inventory_value": 1,
                "stockout_rate": 0.01,
            },
        )
        q = qualify.evaluate(eng, adoption.profile(eng))
        self.assertEqual(q.verdict, qualify.GO)


class RoadmapTests(unittest.TestCase):
    def _roadmap(self, **kwargs):
        eng = engagement(**kwargs)
        prof = adoption.profile(eng)
        return eng, roadmap.build(eng, prof, leakage.assess(eng, prof))

    def test_sprint_holds_at_most_three_outcomes(self):
        _, plan = self._roadmap(
            client={"business_case_annual_benefit": 5_000_000},
            capabilities={c.id: "licensed_unused" for c in catalog.get_catalog("blue_yonder")},
            operations={
                "annual_cogs": 52_000_000,
                "forecast_mape": 0.35,
                "avg_lead_time_weeks": 6,
                "exceptions_per_week": 500,
                "minutes_per_exception": 12,
                "planner_loaded_cost": 120_000,
                "planner_override_rate": 0.5,
                "annual_freight_spend": 20_000_000,
                "expedite_share": 0.15,
                "stockout_rate": 0.02,
                "excess_obsolete_writeoff": 2_000_000,
                "data_rework_hours_per_week": 20,
            },
        )
        self.assertLessEqual(len(plan.sprint.items), 3)
        self.assertGreaterEqual(plan.sprint.duration_weeks, roadmap.SPRINT_MIN_WEEKS)
        self.assertLessEqual(plan.sprint.duration_weeks, roadmap.SPRINT_MAX_WEEKS)

    def test_immaterial_findings_stay_out_of_the_sprint(self):
        _, plan = self._roadmap(
            capabilities={"by.ct.exception_mgmt": "licensed_unused"},
            operations={
                "exceptions_per_week": 2,
                "minutes_per_exception": 5,
                "planner_loaded_cost": 100_000,
            },
        )
        self.assertEqual(plan.sprint.items, [])
        reasons = [reason for _, reason in plan.sprint.excluded]
        self.assertTrue(any("materiality" in r for r in reasons))

    def test_findings_with_no_platform_capability_are_not_costed_as_one_week(self):
        eng, plan = self._roadmap(
            operations={"data_rework_hours_per_week": 40, "planner_loaded_cost": 100_000}
        )
        item = next(i for i in plan.items if i.id == "data_quality_tax")
        self.assertEqual(item.target_capabilities, ())
        self.assertGreaterEqual(item.effort_weeks, roadmap.PROCESS_FIX_WEEKS)

    def test_unquantified_dormant_capability_is_carried_without_a_number(self):
        _, plan = self._roadmap(capabilities={"by.wms.labor_mgmt": "licensed_unused"})
        titles = [i.title for i in plan.unquantified]
        self.assertIn("Activate Labor management & engineered standards", titles)
        self.assertTrue(all(i.recoverable_annual == 0 for i in plan.unquantified))

    def test_effort_scales_with_estate_complexity(self):
        simple, _ = self._roadmap(capabilities={"by.io.meio": "licensed_unused"})
        complex_eng = engagement(
            client={"erp_systems": 4, "sites": 10},
            capabilities={"by.io.meio": "licensed_unused"},
        )
        simple_effort, _ = roadmap._effort_for(simple, ("by.io.meio",))
        complex_effort, _ = roadmap._effort_for(complex_eng, ("by.io.meio",))
        self.assertGreater(complex_effort, simple_effort)


class CommercialTests(unittest.TestCase):
    def test_audit_fee_stays_inside_the_published_band(self):
        cheap = commercial.audit_fee(engagement())
        rich = commercial.audit_fee(
            engagement(
                client={
                    "erp_systems": 9,
                    "sites": 40,
                    "skus": 400_000,
                    "annual_revenue": 4e9,
                }
            )
        )
        self.assertEqual(cheap, commercial.AUDIT_MIN)
        self.assertLessEqual(rich, commercial.AUDIT_MAX)

    def test_sprint_fee_is_clamped_and_flagged(self):
        eng = engagement(
            client={"business_case_annual_benefit": 40_000_000},
            capabilities={"by.sp.master_planning": "partial", "by.sp.sop": "partial"},
            operations={"planner_override_rate": 0.7, "planner_loaded_cost": 120_000},
        )
        prof = adoption.profile(eng)
        plan = roadmap.build(eng, prof, leakage.assess(eng, prof))
        priced = commercial.price(eng, plan)
        self.assertEqual(priced.sprint_fee, commercial.SPRINT_MAX)
        self.assertTrue(any("ceiling" in n for n in priced.notes))

    def test_retainer_stays_inside_the_published_band(self):
        eng = engagement(
            client={"business_case_annual_benefit": 40_000_000},
            capabilities={"by.sp.master_planning": "partial"},
            operations={"planner_override_rate": 0.7},
        )
        prof = adoption.profile(eng)
        plan = roadmap.build(eng, prof, leakage.assess(eng, prof))
        priced = commercial.price(eng, plan)
        self.assertGreaterEqual(priced.retainer_monthly, commercial.RETAINER_MIN)
        self.assertLessEqual(priced.retainer_monthly, commercial.RETAINER_MAX)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.library = Path(self.tmp.name) / "patterns.jsonl"
        self.audit = run(
            Engagement.load("examples/client-zero-northgate-3pl.json"),
            library_path=self.library,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_markdown_contains_the_three_tier_one_deliverables(self):
        md = report.render_markdown(self.audit, report_date="2026-01-01")
        self.assertIn("## 1. Executive summary", md)
        self.assertIn("## 3. Licensed capability vs. capability in use", md)
        self.assertIn("## 4. Where value is leaking", md)
        self.assertIn("## 5. Remediation roadmap", md)
        self.assertIn("Northgate Logistics", md)

    def test_no_benchmark_is_quoted_from_an_empty_library(self):
        md = report.render_markdown(self.audit)
        self.assertIn("below the 3-engagement floor", md)

    def test_html_is_self_contained_and_escaped(self):
        md = report.render_markdown(self.audit)
        html_doc = report.render_html(md, "t")
        self.assertIn("<!doctype html>", html_doc)
        self.assertNotIn("http://", html_doc)
        self.assertNotIn("<script", html_doc)
        self.assertIn("<table>", html_doc)
        self.assertIn("prefers-color-scheme", html_doc)

    def test_markdown_table_converts_to_html_table(self):
        html_doc = report.markdown_to_html(
            "| A | B |\n|---|---|\n| 1 | 2 |\n\n- item\n\n# Head\n"
        )
        self.assertEqual(html_doc.count("<tr>"), 2)
        self.assertIn("<th>A</th>", html_doc)
        self.assertIn("<li>item</li>", html_doc)
        self.assertIn("<h1>Head</h1>", html_doc)

    def test_inline_html_is_escaped(self):
        self.assertIn("&lt;script&gt;", report.markdown_to_html("<script>x</script>"))


class CrossPlatformTests(unittest.TestCase):
    """Every platform must run the whole pipeline, not just Blue Yonder."""

    OPS = {
        "annual_cogs": 200_000_000,
        "gross_margin_pct": 0.3,
        "inventory_value": 30_000_000,
        "carrying_cost_rate": 0.22,
        "excess_obsolete_writeoff": 1_000_000,
        "forecast_mape": 0.3,
        "avg_lead_time_weeks": 5,
        "exceptions_per_week": 300,
        "minutes_per_exception": 10,
        "planner_loaded_cost": 110_000,
        "planner_override_rate": 0.4,
        "annual_freight_spend": 10_000_000,
        "expedite_share": 0.1,
        "stockout_rate": 0.02,
        "master_data_accuracy": 0.93,
        "data_rework_hours_per_week": 15,
    }

    def test_pipeline_runs_for_every_platform(self):
        with tempfile.TemporaryDirectory() as tmp:
            for platform in catalog.platforms():
                caps = catalog.get_catalog(platform)
                eng = Engagement.from_dict(
                    {
                        "engagement_id": f"smoke-{platform}",
                        "client": dict(
                            BASE_CLIENT,
                            platform=platform,
                            annual_license_fee=500_000,
                            business_case_annual_benefit=3_000_000,
                        ),
                        "capabilities": {
                            c.id: ("full" if i % 3 == 0 else "licensed_unused")
                            for i, c in enumerate(caps)
                        },
                        "operations": self.OPS,
                        "governance": HEALTHY_GOVERNANCE,
                    }
                )
                result = run(eng, library_path=Path(tmp) / "none.jsonl")
                with self.subTest(platform=platform):
                    self.assertGreater(result.leakage.recoverable_total, 0)
                    self.assertGreater(result.capture_rate, 0)
                    self.assertEqual(result.qualification.verdict, qualify.GO)
                    md = report.render_markdown(result)
                    self.assertIn(catalog.PLATFORM_NAMES[platform], md)
                    json.dumps(result.to_dict())  # serializable

    def test_freight_findings_have_no_target_on_planning_only_platforms(self):
        # o9 and Kinaxis have no TMS module; the finding still surfaces, but as
        # process work rather than a capability activation.
        self.assertEqual(leakage.capabilities_for_role("o9", "freight_optimization"), ())
        self.assertNotEqual(
            leakage.capabilities_for_role("blue_yonder", "freight_optimization"), ()
        )


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_audit_writes_all_formats_and_records(self):
        lib = self.dir / "patterns.jsonl"
        code = cli.main(
            [
                "audit",
                "examples/client-zero-northgate-3pl.json",
                "--out",
                str(self.dir / "out"),
                "--format",
                "all",
                "--library",
                str(lib),
                "--record",
            ]
        )
        self.assertEqual(code, 0)
        for suffix in ("md", "html", "json"):
            self.assertTrue((self.dir / "out" / f"northgate-3pl-2026-q1.{suffix}").exists())
        payload = json.loads((self.dir / "out" / "northgate-3pl-2026-q1.json").read_text())
        self.assertEqual(payload["client"]["platform"], "blue_yonder")
        self.assertGreater(payload["leakage"]["recoverable_annual"], 0)
        self.assertEqual(len(lib.read_text().strip().splitlines()), 1)

    def test_scaffold_then_validate_round_trip(self):
        path = self.dir / "new.json"
        self.assertEqual(cli.main(["scaffold", str(path), "--platform", "kinaxis"]), 0)
        self.assertEqual(cli.main(["validate", str(path)]), 0)
        self.assertEqual(cli.main(["scaffold", str(path)]), 1)  # refuses to overwrite

    def test_walk_away_exits_nonzero(self):
        path = self.dir / "bad.json"
        raw = json.loads(Path("examples/client-zero-northgate-3pl.json").read_text())
        raw["operations"]["master_data_accuracy"] = 0.5
        path.write_text(json.dumps(raw))
        code = cli.main(["audit", str(path), "--out", str(self.dir / "out2")])
        self.assertEqual(code, 2)

    def test_unknown_economics_field_is_rejected(self):
        self.assertEqual(cli.main(["economics", "--set", "nonsense=3"]), 1)


if __name__ == "__main__":
    unittest.main()
