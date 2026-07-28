"""Tests for market sizing and growth scenarios."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from scvr import economics, market

ROOT = Path(__file__).resolve().parent.parent
INDUSTRIES = json.loads((ROOT / "data" / "metro-markets.json").read_text())["industries"]


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.metros, self.source = market.load_markets()

    def test_dataset_is_real_and_attributed(self):
        self.assertIn("Bureau of Labor Statistics", self.source["name"])
        self.assertEqual(self.source["licence"], "public domain (US Government work)")
        self.assertTrue(self.source["year"].isdigit())

    def test_every_metro_has_counted_establishments(self):
        self.assertGreater(len(self.metros), 300)
        for metro in self.metros:
            self.assertGreater(metro.establishments, 0, metro.full_title)
            self.assertTrue(metro.industries, metro.full_title)

    def test_lookup_by_common_name_and_code(self):
        self.assertEqual(market.find_metro(self.metros, "Dallas").id, "C1910")
        self.assertEqual(market.find_metro(self.metros, "C1910").id, "C1910")
        self.assertEqual(market.find_metro(self.metros, "dallas-fort worth").id, "C1910")
        self.assertIsNone(market.find_metro(self.metros, "atlantis"))
        self.assertIsNone(market.find_metro(self.metros, ""))

    def test_lookup_prefers_the_lead_city(self):
        # "Riverside" leads its own metro and also appears in others.
        found = market.find_metro(self.metros, "Riverside")
        self.assertTrue(found.full_title.lower().startswith("riverside"))


class SizingTests(unittest.TestCase):
    def setUp(self):
        self.metros, _ = market.load_markets()
        self.dallas = market.find_metro(self.metros, "Dallas")

    def test_funnel_narrows_at_every_stage(self):
        sized = market.size_market(self.dallas, industries=INDUSTRIES)
        self.assertGreater(sized.enterprise_sites, sized.platform_accounts)
        self.assertGreater(sized.platform_accounts, sized.underperforming)
        self.assertGreater(sized.underperforming, sized.addressable)
        self.assertGreater(sized.addressable, 0)

    def test_arithmetic_matches_the_stated_assumptions(self):
        a = market.MarketAssumptions()
        sized = market.size_market(self.dallas, a, industries=INDUSTRIES)
        employment = sum(
            i["employment"] or 0 for i in self.dallas.industries.values()
        )
        self.assertAlmostEqual(sized.enterprise_sites, employment / a.enterprise_site_employment)
        self.assertAlmostEqual(
            sized.addressable,
            sized.enterprise_sites * a.platform_penetration * a.underperformance_rate
            * a.reachable_share * a.platform_focus_share,
        )

    def test_assumptions_are_stated_in_words(self):
        a = market.MarketAssumptions()
        labels = a.label()
        # Every modelled assumption must be explainable in a sentence, and the
        # sentence must carry the number so a reader can disagree with it.
        self.assertEqual(set(labels), set(vars(a)))
        for key, text in labels.items():
            with self.subTest(key=key):
                self.assertGreater(len(text), 25)
                self.assertNotIn("{", text)
                self.assertRegex(text, r"\d")

    def test_sub_vertical_narrows_the_market(self):
        everything = market.size_market(self.dallas, industries=INDUSTRIES)
        cold = market.size_market(self.dallas, sub_vertical="cold_chain", industries=INDUSTRIES)
        self.assertLess(cold.addressable, everything.addressable)

    def test_tighter_assumptions_shrink_the_market(self):
        pessimistic = market.MarketAssumptions(platform_penetration=0.05, reachable_share=0.1)
        base = market.size_market(self.dallas, industries=INDUSTRIES)
        tight = market.size_market(self.dallas, pessimistic, industries=INDUSTRIES)
        self.assertLess(tight.addressable, base.addressable)

    def test_ranking_is_ordered_and_bounded(self):
        ranked = market.rank_markets(self.metros, industries=INDUSTRIES, limit=5)
        self.assertEqual(len(ranked), 5)
        values = [r.addressable for r in ranked]
        self.assertEqual(values, sorted(values, reverse=True))

    def test_withheld_employment_is_flagged_not_zeroed(self):
        withheld = [
            m for m in self.metros
            if all(i["employment"] is None for i in m.industries.values())
        ]
        if not withheld:
            self.skipTest("no fully withheld metro in this vintage")
        sized = market.size_market(withheld[0], industries=INDUSTRIES)
        self.assertFalse(sized.disclosed_employment)
        self.assertGreater(sized.addressable, 0)


class ScenarioTests(unittest.TestCase):
    def setUp(self):
        self.metros, _ = market.load_markets()
        self.firm = economics.FirmModel(consultants=2)

    def run_for(self, cities, **kwargs):
        ids = [market.find_metro(self.metros, c).id for c in cities]
        return market.run_scenario(
            self.metros, self.firm,
            market.ScenarioInputs(markets=ids, **kwargs),
            industries=INDUSTRIES,
        )

    def test_horizon_and_shape(self):
        scenario = self.run_for(["Dallas"], horizon_months=24)
        self.assertEqual(len(scenario.months), 24)
        self.assertEqual([m.month for m in scenario.months], list(range(1, 25)))

    def test_no_market_is_a_no(self):
        scenario = market.run_scenario(
            self.metros, self.firm, market.ScenarioInputs(markets=[]), industries=INDUSTRIES
        )
        self.assertEqual(scenario.verdict, market.NO)
        self.assertIn("No market selected.", scenario.reasons)

    def test_sales_lead_time_delays_the_first_audit(self):
        scenario = self.run_for(["Dallas"])
        self.assertEqual(scenario.months[0].audits_signed, 0.0)
        self.assertGreater(sum(m.audits_signed for m in scenario.months), 0)

    def test_a_thin_metro_is_rejected(self):
        scenario = self.run_for(["Toledo"])
        self.assertEqual(scenario.verdict, market.NO)
        self.assertTrue(any("addressable accounts" in r for r in scenario.reasons))

    def test_more_markets_beat_one(self):
        one = self.run_for(["Dallas"])
        two = self.run_for(["Dallas", "Atlanta"])
        self.assertGreater(two.addressable, one.addressable)
        self.assertGreaterEqual(two.total_revenue, one.total_revenue)

    def test_breakeven_must_be_sustained(self):
        scenario = self.run_for(["Dallas", "Atlanta"])
        if scenario.breakeven_month is None:
            self.skipTest("no break-even in this configuration")
        tail = scenario.months[scenario.breakeven_month - 1:]
        for month in tail:
            self.assertGreater(month.cumulative_profit, 0, f"month {month.month} fell back")

    def test_hiring_stops_when_the_market_is_exhausted(self):
        scenario = self.run_for(["Toledo"])
        self.assertLessEqual(scenario.peak_consultants, 2.0)

    def test_market_never_oversold(self):
        scenario = self.run_for(["Dallas"])
        consumed = sum(m.audits_signed for m in scenario.months)
        self.assertLessEqual(round(consumed, 6), round(scenario.addressable, 6))
        self.assertGreaterEqual(scenario.months[-1].accounts_remaining, 0)

    def test_longer_payment_terms_deepen_the_trough(self):
        fast = market.run_scenario(
            self.metros, economics.FirmModel(consultants=2, payment_terms_days=30),
            market.ScenarioInputs(markets=[market.find_metro(self.metros, "Dallas").id]),
            industries=INDUSTRIES,
        )
        slow = market.run_scenario(
            self.metros, economics.FirmModel(consultants=2, payment_terms_days=90),
            market.ScenarioInputs(markets=[market.find_metro(self.metros, "Dallas").id]),
            industries=INDUSTRIES,
        )
        self.assertLess(slow.cash_trough, fast.cash_trough)

    def test_verdict_reasons_are_always_given(self):
        for cities in (["Dallas"], ["Dallas", "Atlanta"], ["Toledo"]):
            scenario = self.run_for(cities)
            with self.subTest(cities=cities):
                self.assertIn(scenario.verdict, (market.GO, market.MARGINAL, market.NO))
                self.assertTrue(scenario.reasons)
                self.assertTrue(all(r.strip() for r in scenario.reasons))

    def test_negative_money_reads_as_minus_dollar(self):
        scenario = self.run_for(["Toledo"])
        cash_reason = [r for r in scenario.reasons if "troughs" in r]
        if cash_reason:
            self.assertNotIn("$-", cash_reason[0])
            self.assertIn("-$", cash_reason[0])

    def test_serializes_for_the_browser(self):
        payload = market.scenario_to_dict(self.run_for(["Dallas"]))
        self.assertEqual(json.loads(json.dumps(payload))["verdict"], payload["verdict"])
        self.assertIn("assumptions", payload)
        self.assertEqual(len(payload["months"]), 36)


if __name__ == "__main__":
    unittest.main()
