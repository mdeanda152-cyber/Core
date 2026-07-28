"""Prioritized remediation roadmap and Tier 2 sprint packing.

The audit's third deliverable. Rules encoded here:

* Rank by recoverable value per consultant-week, discounted by confidence --
  not by size of prize. A $2M finding at 15% confidence behind a nine-month
  data programme loses to a $300K finding that lands in six weeks.
* A sprint carries at most three items. Fixed scope is the product.
* Sequence prerequisites. Activating optimization on top of a forecast nobody
  trusts produces a confident wrong answer.
* Items with no dollar model are carried, but separately and unpriced.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from . import catalog
from .adoption import AdoptionProfile
from .leakage import LeakageEstimate, LeakageResult
from .model import (
    DEPLOYED_UNUSED,
    FULL,
    LICENSED_UNUSED,
    NOT_LICENSED,
    PARTIAL,
    Engagement,
)

# Effort to move a capability from its current state to productive use, as a
# multiple of the catalog's activation estimate.
STATE_EFFORT_MULTIPLIER = {
    LICENSED_UNUSED: 1.0,
    DEPLOYED_UNUSED: 0.6,
    PARTIAL: 0.4,
    FULL: 0.3,  # already used; the work is tuning, not activation
}

SPRINT_MAX_ITEMS = 3
# A finding with no licensed capability behind it is fixed with process work,
# not configuration. It is never a one-week job, and pricing it as one would
# make it out-rank real capability work on value density.
PROCESS_FIX_WEEKS = 4.0
SPRINT_MIN_WEEKS = 8
SPRINT_MAX_WEEKS = 12
SPRINT_MAX_TEAM = 3
MATERIALITY_FLOOR = 25_000.0  # below this a finding is a footnote, not a work package

CAP_REASON = "sprint is capped at three outcomes"

KPI_BY_DRIVER = {
    "labor": "planner hours spent on exception disposition per week",
    "inventory": "on-hand inventory value at constant service level",
    "service": "OTIF / line fill rate",
    "freight": "expedite spend as a share of total freight",
    "margin": "gross margin on the affected portfolio",
    "cycle_time": "planning cycle days and system-plan acceptance rate",
    "data": "master data error rate at point of entry",
}


@dataclass
class RemediationItem:
    id: str
    title: str
    thesis: str
    driver: str
    target_capabilities: tuple[str, ...]
    effort_weeks: float
    quantified: bool
    recoverable_annual: float = 0.0
    low: float = 0.0
    high: float = 0.0
    confidence: float = 0.0
    blocked_by: tuple[str, ...] = ()
    measure: str = ""
    assumptions: list[str] = field(default_factory=list)

    @property
    def score(self) -> float:
        """Confidence-weighted recoverable value per consultant-week."""
        if not self.quantified or self.effort_weeks <= 0:
            return 0.0
        return self.recoverable_annual * self.confidence / self.effort_weeks


@dataclass
class SprintPlan:
    items: list[RemediationItem]
    team_size: int
    duration_weeks: int
    effort_weeks: float
    excluded: list[tuple[RemediationItem, str]] = field(default_factory=list)

    @property
    def recoverable_annual(self) -> float:
        return sum(i.recoverable_annual for i in self.items)

    @property
    def low(self) -> float:
        return sum(i.low for i in self.items)

    @property
    def high(self) -> float:
        return sum(i.high for i in self.items)


@dataclass
class Roadmap:
    items: list[RemediationItem]
    sprint: SprintPlan
    deferred: list[RemediationItem]
    unquantified: list[RemediationItem]

    @property
    def quantified_total(self) -> float:
        return sum(i.recoverable_annual for i in self.items if i.quantified)


def _complexity_multiplier(engagement: Engagement) -> float:
    """Multi-site, multi-ERP estates cost more per capability. Modest, capped."""
    client = engagement.client
    mult = 1.0 + 0.05 * max(client.erp_systems - 1, 0) + 0.02 * max(client.sites - 1, 0)
    return min(mult, 1.6)


def _effort_for(
    engagement: Engagement, capability_ids: tuple[str, ...]
) -> tuple[float, tuple[str, ...]]:
    """Consultant-weeks to make the target capabilities productive.

    Returns (effort, unmet_prerequisites). Capability the client never licensed
    is excluded from effort -- we cannot activate what they did not buy.
    """
    platform = engagement.client.platform
    effort = 0.0
    unmet: list[str] = []
    for cap_id in capability_ids:
        try:
            cap = catalog.get_capability(platform, cap_id)
        except KeyError:
            continue
        state = engagement.state_of(cap_id)
        if state == NOT_LICENSED:
            continue
        multiplier = STATE_EFFORT_MULTIPLIER.get(state)
        if multiplier is None:  # not_assessed
            multiplier = 0.8
        effort += cap.activation_effort_weeks * multiplier
        for prereq in cap.prerequisites:
            prereq_state = engagement.state_of(prereq)
            if prereq_state in (LICENSED_UNUSED, DEPLOYED_UNUSED) and prereq not in capability_ids:
                unmet.append(prereq)

    if effort == 0.0:
        effort = PROCESS_FIX_WEEKS
    effort *= _complexity_multiplier(engagement)
    return max(effort, 1.0), tuple(dict.fromkeys(unmet))


def _item_from_estimate(
    engagement: Engagement, estimate: LeakageEstimate
) -> RemediationItem:
    effort, unmet = _effort_for(engagement, estimate.linked_capabilities)
    targets = ", ".join(
        catalog.get_capability(engagement.client.platform, c).name
        for c in estimate.linked_capabilities
        if _known(engagement.client.platform, c)
    )
    thesis = (
        f"{estimate.basis}. Remediation works through: {targets}."
        if targets
        else f"{estimate.basis}. No licensed capability on this platform addresses it "
        "directly -- process or third-party fix."
    )
    return RemediationItem(
        id=estimate.model_id,
        title=estimate.name,
        thesis=thesis,
        driver=estimate.driver,
        target_capabilities=estimate.linked_capabilities,
        effort_weeks=round(effort, 1),
        quantified=True,
        recoverable_annual=estimate.recoverable_annual,
        low=estimate.low,
        high=estimate.high,
        confidence=estimate.confidence,
        blocked_by=unmet,
        measure=KPI_BY_DRIVER.get(estimate.driver, ""),
        assumptions=list(estimate.assumptions),
    )


def _known(platform: str, capability_id: str) -> bool:
    try:
        catalog.get_capability(platform, capability_id)
    except KeyError:
        return False
    return True


def _unquantified_items(
    engagement: Engagement, adoption: AdoptionProfile, covered: set[str]
) -> list[RemediationItem]:
    """Dormant, high-value capability that no leakage model touched.

    Carried without a dollar figure. The honest position is 'we can see this is
    idle and we cannot yet size it', not a manufactured number.
    """
    items: list[RemediationItem] = []
    for line in adoption.dormant():
        cap = line.capability
        if cap.id in covered or cap.value_weight < 4:
            continue
        effort, unmet = _effort_for(engagement, (cap.id,))
        items.append(
            RemediationItem(
                id=f"activate.{cap.id}",
                title=f"Activate {cap.name}",
                thesis=(
                    f"{cap.module}: licensed and {line.state.replace('_', ' ')}. "
                    f"Comparable deployments get real use from this in "
                    f"{cap.typical_capture:.0%} of cases. Value driver: {cap.value_driver}. "
                    "Not sized -- no operating metric was supplied to quantify it."
                ),
                driver=cap.value_driver,
                target_capabilities=(cap.id,),
                effort_weeks=round(effort, 1),
                quantified=False,
                blocked_by=unmet,
                measure=KPI_BY_DRIVER.get(cap.value_driver, ""),
            )
        )
    return sorted(items, key=lambda i: (-_weight(engagement, i), i.effort_weeks))


def _weight(engagement: Engagement, item: RemediationItem) -> int:
    total = 0
    for cap_id in item.target_capabilities:
        try:
            total += catalog.get_capability(engagement.client.platform, cap_id).value_weight
        except KeyError:
            continue
    return total


def pack_sprint(
    items: list[RemediationItem],
    max_items: int = SPRINT_MAX_ITEMS,
    max_weeks: int = SPRINT_MAX_WEEKS,
) -> SprintPlan:
    """Greedy pack by value density, subject to fixed-scope constraints."""
    chosen: list[RemediationItem] = []
    excluded: list[tuple[RemediationItem, str]] = []
    capacity = max_weeks * SPRINT_MAX_TEAM
    used = 0.0

    for item in sorted(items, key=lambda i: -i.score):
        if len(chosen) >= max_items:
            excluded.append((item, CAP_REASON))
            continue
        if item.recoverable_annual < MATERIALITY_FLOOR:
            excluded.append((item, "below materiality floor for a fixed-fee sprint"))
            continue
        if item.blocked_by:
            excluded.append(
                (item, f"prerequisite capability dormant: {', '.join(item.blocked_by)}")
            )
            continue
        if used + item.effort_weeks > capacity:
            excluded.append((item, "does not fit the sprint envelope"))
            continue
        chosen.append(item)
        used += item.effort_weeks

    team_size = max(1, min(SPRINT_MAX_TEAM, math.ceil(used / max_weeks))) if used else 1
    duration = math.ceil(used / team_size) if used else 0
    duration = max(SPRINT_MIN_WEEKS, min(max_weeks, duration)) if used else 0

    return SprintPlan(
        items=chosen,
        team_size=team_size,
        duration_weeks=duration,
        effort_weeks=round(used, 1),
        excluded=excluded,
    )


def build(
    engagement: Engagement, adoption: AdoptionProfile, leakage: LeakageResult
) -> Roadmap:
    quantified = [
        _item_from_estimate(engagement, est)
        for est in leakage.ranked()
        if est.recoverable_annual > 0
    ]
    covered = {c for item in quantified for c in item.target_capabilities}
    unquantified = _unquantified_items(engagement, adoption, covered)

    ranked = sorted(quantified, key=lambda i: -i.score)
    sprint = pack_sprint(ranked)
    in_sprint = {i.id for i in sprint.items}
    deferred = [i for i in ranked if i.id not in in_sprint]

    return Roadmap(
        items=ranked,
        sprint=sprint,
        deferred=deferred,
        unquantified=unquantified,
    )
