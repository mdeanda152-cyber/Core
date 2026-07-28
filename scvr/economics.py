"""The firm's own unit economics -- including the cash trap.

Two questions this answers, both from the plan's section 4:

1. Does the mix of audits, sprints and retainers actually fit the team, and
   what margin does it throw off?
2. Given enterprise payment terms of net 60-90 against payroll every two weeks,
   how deep does the cash hole get before the model works?

A services firm can be profitable on paper and die of the second question. The
simulator exists to size the line of credit *before* it is needed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

BILLABLE_WEEKS_PER_YEAR = 47.0

# Delivery effort per unit, in consultant-weeks. Tier 1 is a 3-4 week calendar
# engagement carried by roughly one and a half people; Tier 2 is 8-12 weeks
# with a pair; Tier 3 is a standing part-time commitment.
EFFORT = {
    "audit": 5.5,
    "sprint": 20.0,
    "retainer_month": 3.0,
}


@dataclass
class FirmModel:
    consultants: float = 4.0
    loaded_cost: float = 215_000.0
    bill_rate: float = 300.0
    target_utilization: float = 0.70
    overhead_annual: float = 180_000.0

    audits_per_year: int = 5
    sprints_per_year: int = 2
    retainer_clients: int = 2

    audit_fee: float = 45_000.0
    sprint_fee: float = 175_000.0
    retainer_monthly: float = 30_000.0

    deposit_rate: float = 0.45
    payment_terms_days: int = 75
    starting_cash: float = 150_000.0

    @property
    def week_cost(self) -> float:
        return self.loaded_cost / BILLABLE_WEEKS_PER_YEAR

    @property
    def capacity_weeks(self) -> float:
        return self.consultants * BILLABLE_WEEKS_PER_YEAR

    @property
    def fixed_annual_cost(self) -> float:
        return self.consultants * self.loaded_cost + self.overhead_annual


@dataclass
class UnitEconomics:
    revenue_audit: float
    revenue_sprint: float
    revenue_retainer: float
    delivery_cost: float
    overhead: float
    gross_profit: float
    gross_margin: float
    operating_profit: float
    required_weeks: float
    capacity_weeks: float
    implied_utilization: float
    recurring_share: float
    breakeven_audits: float
    warnings: list[str] = field(default_factory=list)

    @property
    def revenue(self) -> float:
        return self.revenue_audit + self.revenue_sprint + self.revenue_retainer


@dataclass
class CashMonth:
    month: int
    collections: float
    costs: float
    net: float
    balance: float


@dataclass
class CashFlow:
    months: list[CashMonth]

    @property
    def min_balance(self) -> float:
        return min(m.balance for m in self.months)

    @property
    def trough_month(self) -> int:
        return min(self.months, key=lambda m: m.balance).month

    @property
    def ending_balance(self) -> float:
        return self.months[-1].balance

    @property
    def months_negative(self) -> int:
        return sum(1 for m in self.months if m.balance < 0)

    @property
    def credit_line_needed(self) -> float:
        """Round the trough up to the next $25K -- ask for more than the model says."""
        deficit = max(0.0, -self.min_balance)
        return math.ceil(deficit / 25_000) * 25_000 if deficit else 0.0


def unit_economics(firm: FirmModel) -> UnitEconomics:
    rev_audit = firm.audits_per_year * firm.audit_fee
    rev_sprint = firm.sprints_per_year * firm.sprint_fee
    rev_retainer = firm.retainer_clients * firm.retainer_monthly * 12

    weeks_audit = firm.audits_per_year * EFFORT["audit"]
    weeks_sprint = firm.sprints_per_year * EFFORT["sprint"]
    weeks_retainer = firm.retainer_clients * EFFORT["retainer_month"] * 12
    required = weeks_audit + weeks_sprint + weeks_retainer

    delivery_cost = required * firm.week_cost
    revenue = rev_audit + rev_sprint + rev_retainer
    gross_profit = revenue - delivery_cost
    gross_margin = gross_profit / revenue if revenue else 0.0

    # Idle consultant time is a real cost even when it bills nothing.
    idle_cost = max(0.0, firm.capacity_weeks - required) * firm.week_cost
    operating_profit = revenue - delivery_cost - idle_cost - firm.overhead_annual

    implied_utilization = required / firm.capacity_weeks if firm.capacity_weeks else 0.0
    recurring_share = rev_retainer / revenue if revenue else 0.0

    audit_contribution = firm.audit_fee - EFFORT["audit"] * firm.week_cost
    breakeven_audits = (
        (firm.fixed_annual_cost - (rev_sprint - weeks_sprint * firm.week_cost)
         - (rev_retainer - weeks_retainer * firm.week_cost)) / audit_contribution
        if audit_contribution > 0
        else float("inf")
    )

    warnings: list[str] = []
    if implied_utilization > firm.target_utilization + 0.05:
        warnings.append(
            f"Mix requires {implied_utilization:.0%} utilization against a "
            f"{firm.target_utilization:.0%} target -- this plan only works with "
            "subcontractors or a hire."
        )
    if implied_utilization < firm.target_utilization - 0.15:
        warnings.append(
            f"Mix only fills {implied_utilization:.0%} of capacity; the team is "
            "carrying idle cost of "
            f"${idle_cost:,.0f}."
        )
    if recurring_share < 0.40:
        warnings.append(
            f"Only {recurring_share:.0%} of revenue is recurring. The plan's year-two "
            "target is 60% -- project-only firms are one lost deal from trouble."
        )
    max_audits = firm.capacity_weeks / EFFORT["audit"]
    if breakeven_audits > max_audits:
        warnings.append(
            f"Break-even needs {breakeven_audits:.0f} audits but the team can only "
            f"deliver {max_audits:.0f} at full capacity. Tier 1 does not pay the bills "
            "on its own -- it buys the Tier 2 and Tier 3 pipeline."
        )
    if gross_margin < 0.40:
        warnings.append(
            f"Gross margin {gross_margin:.0%} is below the 40% floor; either rates are "
            "too low or fixed-scope work is running long."
        )
    return UnitEconomics(
        revenue_audit=rev_audit,
        revenue_sprint=rev_sprint,
        revenue_retainer=rev_retainer,
        delivery_cost=delivery_cost,
        overhead=firm.overhead_annual,
        gross_profit=gross_profit,
        gross_margin=gross_margin,
        operating_profit=operating_profit,
        required_weeks=required,
        capacity_weeks=firm.capacity_weeks,
        implied_utilization=implied_utilization,
        recurring_share=recurring_share,
        breakeven_audits=breakeven_audits,
        warnings=warnings,
    )


def _spread(count: int, horizon: int) -> list[int]:
    """Evenly spaced start months for `count` engagements per 12-month year."""
    if count <= 0:
        return []
    starts = []
    for year_start in range(0, horizon, 12):
        for i in range(count):
            month = year_start + (i * 12) // count
            if month < horizon:
                starts.append(month)
    return starts


def cash_flow(firm: FirmModel, horizon_months: int = 24) -> CashFlow:
    terms_months = max(1, round(firm.payment_terms_days / 30.0))
    collections = [0.0] * (horizon_months + terms_months + 6)

    def collect(month: int, amount: float) -> None:
        idx = month + terms_months
        if idx < len(collections):
            collections[idx] += amount

    # Deposits are invoiced at kickoff; the balance on completion.
    for start in _spread(firm.audits_per_year, horizon_months):
        collect(start, firm.audit_fee * firm.deposit_rate)
        collect(start + 1, firm.audit_fee * (1 - firm.deposit_rate))

    for start in _spread(firm.sprints_per_year, horizon_months):
        collect(start, firm.sprint_fee * firm.deposit_rate)
        collect(start + 3, firm.sprint_fee * (1 - firm.deposit_rate))

    for month in range(horizon_months):
        collect(month, firm.retainer_clients * firm.retainer_monthly)

    monthly_cost = firm.fixed_annual_cost / 12.0
    balance = firm.starting_cash
    months: list[CashMonth] = []
    for month in range(horizon_months):
        received = collections[month]
        net = received - monthly_cost
        balance += net
        months.append(
            CashMonth(
                month=month + 1,
                collections=received,
                costs=monthly_cost,
                net=net,
                balance=balance,
            )
        )
    return CashFlow(months=months)
