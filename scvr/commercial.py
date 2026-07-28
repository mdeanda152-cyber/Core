"""Pricing the three tiers for a specific engagement.

Price to value, floored by cost, clamped to the published band. The bands come
from the plan: audit $35-60K, sprint $100-250K, retainer $20-40K/month. Staying
inside them is what keeps the offer productized -- the moment pricing becomes
bespoke, so does scope.

The ratio that matters is the client's: if year-one recoverable value at the
*low* end of the band is not comfortably above the fee, the deal is not worth
signing for either side.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .model import Engagement
from .roadmap import Roadmap

AUDIT_BASE = 35_000
AUDIT_MIN, AUDIT_MAX = 35_000, 60_000
SPRINT_MIN, SPRINT_MAX = 100_000, 250_000
RETAINER_MIN, RETAINER_MAX = 20_000, 40_000

PRICE_TO_VALUE = 0.22        # sprint fee as a share of year-one recoverable
RETAINER_VALUE_SHARE = 0.10  # annual retainer as a share of recoverable value
TARGET_GROSS_MARGIN = 0.45
CONSULTANT_WEEK_COST = 4_700.0  # fully loaded, ~$220K/yr over 47 billable weeks
COMFORT_RATIO = 3.0          # low-end recoverable must be >= 3x the sprint fee


@dataclass
class Commercials:
    audit_fee: int
    sprint_fee: int
    sprint_cost: float
    sprint_margin: float
    retainer_monthly: int
    payback_months: float
    year_one_multiple: float
    low_case_multiple: float
    notes: list[str] = field(default_factory=list)


def _round_to(value: float, step: int) -> int:
    return int(round(value / step) * step)


def audit_fee(engagement: Engagement) -> int:
    client = engagement.client
    fee = AUDIT_BASE
    fee += 4_000 * max(client.erp_systems - 1, 0)
    fee += 2_500 * min(max(client.sites - 1, 0), 6)
    if client.skus > 50_000:
        fee += 5_000
    if client.annual_revenue >= 1e9:
        fee += 5_000
    return _round_to(min(max(fee, AUDIT_MIN), AUDIT_MAX), 1_000)


def price(engagement: Engagement, roadmap: Roadmap) -> Commercials:
    notes: list[str] = []
    sprint = roadmap.sprint

    cost = sprint.team_size * sprint.duration_weeks * CONSULTANT_WEEK_COST
    cost_floor = cost / (1.0 - TARGET_GROSS_MARGIN) if cost else SPRINT_MIN
    value_price = sprint.recoverable_annual * PRICE_TO_VALUE

    fee = max(cost_floor, value_price)
    if fee > SPRINT_MAX:
        notes.append(
            f"Value-based price would be ${fee:,.0f}, above the ${SPRINT_MAX:,} Tier 2 "
            "ceiling. Hold the ceiling -- the client keeps the surplus and the fixed-scope "
            "promise stays intact. Widen scope only through Tier 3."
        )
    if fee < SPRINT_MIN and sprint.items:
        notes.append(
            f"Scope prices below the ${SPRINT_MIN:,} Tier 2 floor; either fold it into "
            "the audit as a quick win or add the next roadmap item."
        )
    fee = min(max(fee, SPRINT_MIN), SPRINT_MAX)
    fee_int = _round_to(fee, 5_000)

    margin = 1.0 - (cost / fee_int) if fee_int else 0.0
    if margin < TARGET_GROSS_MARGIN and sprint.items:
        notes.append(
            f"Gross margin {margin:.0%} is below the {TARGET_GROSS_MARGIN:.0%} target -- "
            "delivery is over-staffed for the value at stake."
        )

    recoverable = sprint.recoverable_annual
    payback = (fee_int / (recoverable / 12.0)) if recoverable > 0 else float("inf")
    multiple = (recoverable / fee_int) if fee_int else 0.0
    low_multiple = (sprint.low / fee_int) if fee_int else 0.0

    if low_multiple and low_multiple < COMFORT_RATIO:
        notes.append(
            f"At the low end of the estimate band the client sees only {low_multiple:.1f}x "
            f"the fee. Below {COMFORT_RATIO:.0f}x, walk the scope back or widen it -- "
            "a marginal ROI case is how a fixed-fee sprint turns into a dispute."
        )

    retainer_raw = roadmap.quantified_total * RETAINER_VALUE_SHARE / 12.0
    retainer = _round_to(min(max(retainer_raw, RETAINER_MIN), RETAINER_MAX), 1_000)
    if roadmap.deferred:
        notes.append(
            f"{len(roadmap.deferred)} quantified items were deferred out of the sprint -- "
            "that is the Tier 3 retainer conversation, not a bigger sprint."
        )

    return Commercials(
        audit_fee=audit_fee(engagement),
        sprint_fee=fee_int,
        sprint_cost=cost,
        sprint_margin=margin,
        retainer_monthly=retainer,
        payback_months=payback,
        year_one_multiple=multiple,
        low_case_multiple=low_multiple,
        notes=notes,
    )
