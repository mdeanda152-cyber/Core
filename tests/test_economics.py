"""Tests for the firm's unit economics and the cash trap simulation."""

from __future__ import annotations

import unittest

from scvr.economics import EFFORT, FirmModel, cash_flow, unit_economics


class UnitEconomicsTests(unittest.TestCase):
    def test_revenue_cost_and_margin_arithmetic(self):
        firm = FirmModel(
            consultants=1,
            loaded_cost=94_000,  # $2,000 per billable week over 47 weeks
            overhead_annual=0,
            audits_per_year=0,
            sprints_per_year=0,
            retainer_clients=1,
            retainer_monthly=10_000,
        )
        econ = unit_economics(firm)
        self.assertAlmostEqual(econ.revenue, 120_000.0)
        self.assertAlmostEqual(econ.required_weeks, 36.0)  # 3 weeks x 12 months
        self.assertAlmostEqual(econ.delivery_cost, 72_000.0)
        self.assertAlmostEqual(econ.gross_margin, 0.40)
        self.assertAlmostEqual(econ.recurring_share, 1.0)

    def test_idle_capacity_is_charged_to_operating_profit(self):
        firm = FirmModel(
            consultants=2,
            loaded_cost=94_000,
            overhead_annual=0,
            audits_per_year=0,
            sprints_per_year=0,
            retainer_clients=1,
            retainer_monthly=10_000,
        )
        econ = unit_economics(firm)
        idle_weeks = econ.capacity_weeks - econ.required_weeks
        self.assertAlmostEqual(
            econ.operating_profit,
            econ.revenue - econ.delivery_cost - idle_weeks * firm.week_cost,
        )
        self.assertLess(econ.operating_profit, econ.gross_profit)

    def test_overbooked_mix_is_flagged(self):
        firm = FirmModel(consultants=1, audits_per_year=4, sprints_per_year=2, retainer_clients=2)
        econ = unit_economics(firm)
        self.assertGreater(econ.implied_utilization, 1.0)
        self.assertTrue(any("utilization" in w for w in econ.warnings))

    def test_project_only_mix_is_flagged_against_the_recurring_target(self):
        firm = FirmModel(retainer_clients=0)
        econ = unit_economics(firm)
        self.assertEqual(econ.recurring_share, 0.0)
        self.assertTrue(any("recurring" in w for w in econ.warnings))

    def test_tier_one_alone_cannot_cover_fixed_cost(self):
        firm = FirmModel(consultants=4, sprints_per_year=0, retainer_clients=0)
        econ = unit_economics(firm)
        max_audits = econ.capacity_weeks / EFFORT["audit"]
        self.assertGreater(econ.breakeven_audits, max_audits)
        self.assertTrue(any("Break-even" in w for w in econ.warnings))

    def test_default_mix_matches_the_plans_targets(self):
        econ = unit_economics(FirmModel())
        self.assertGreaterEqual(econ.gross_margin, 0.40)
        self.assertLessEqual(econ.gross_margin, 0.55)
        self.assertLessEqual(econ.implied_utilization, 0.80)


class CashFlowTests(unittest.TestCase):
    def _startup(self, **overrides) -> FirmModel:
        base = dict(
            consultants=1,
            loaded_cost=120_000,
            overhead_annual=0,
            audits_per_year=1,
            sprints_per_year=0,
            retainer_clients=0,
            audit_fee=100_000,
            deposit_rate=0.5,
            payment_terms_days=60,
            starting_cash=0,
        )
        base.update(overrides)
        return FirmModel(**base)

    def test_collections_land_after_the_payment_terms(self):
        cash = cash_flow(self._startup(), horizon_months=6)
        balances = [m.balance for m in cash.months]
        # $10K/month of cost, nothing collected until net-60 elapses.
        self.assertAlmostEqual(balances[0], -10_000)
        self.assertAlmostEqual(balances[1], -20_000)
        self.assertAlmostEqual(balances[2], 20_000)   # 50% deposit lands
        self.assertAlmostEqual(balances[3], 60_000)   # balance lands

    def test_credit_line_is_sized_from_the_trough_and_rounded_up(self):
        cash = cash_flow(self._startup(), horizon_months=6)
        self.assertAlmostEqual(cash.min_balance, -20_000)
        self.assertEqual(cash.months_negative, 2)
        self.assertEqual(cash.credit_line_needed, 25_000)

    def test_bigger_deposit_pulls_cash_forward(self):
        # The trough itself is the pre-collection window, which no deposit can
        # avoid; what a deposit buys is a faster climb out of it.
        small = cash_flow(self._startup(deposit_rate=0.1), horizon_months=12)
        large = cash_flow(self._startup(deposit_rate=0.5), horizon_months=12)
        self.assertLess(small.months[2].balance, large.months[2].balance)
        self.assertLessEqual(small.months_negative, 12)
        self.assertGreater(large.months[2].collections, small.months[2].collections)

    def test_longer_terms_deepen_the_hole(self):
        fast = cash_flow(self._startup(payment_terms_days=30), horizon_months=12)
        slow = cash_flow(self._startup(payment_terms_days=90), horizon_months=12)
        self.assertLess(slow.min_balance, fast.min_balance)

    def test_no_credit_line_needed_when_the_firm_is_capitalised(self):
        cash = cash_flow(self._startup(starting_cash=500_000), horizon_months=12)
        self.assertEqual(cash.credit_line_needed, 0.0)

    def test_engagements_repeat_each_year(self):
        cash = cash_flow(self._startup(audits_per_year=2), horizon_months=24)
        collected = sum(m.collections for m in cash.months)
        self.assertGreater(collected, 300_000)  # two years of two audits, less lag


if __name__ == "__main__":
    unittest.main()
