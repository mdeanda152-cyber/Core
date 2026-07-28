"""Licensed capability vs. actually-used capability.

The headline number of a Tier 1 audit: of the capability the client is paying
for, what share are they actually collecting? Weighted by value, not by module
count -- ten dormant reports do not equal one dormant MEIO engine.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import catalog
from .model import (
    DEPLOYED_UNUSED,
    LICENSED_STATES,
    NOT_ASSESSED,
    NOT_LICENSED,
    USAGE_SCORE,
    Engagement,
)


@dataclass
class CapabilityLine:
    capability: catalog.Capability
    state: str

    @property
    def licensed(self) -> bool:
        return self.state in LICENSED_STATES

    @property
    def assessed(self) -> bool:
        return self.state != NOT_ASSESSED

    @property
    def usage_score(self) -> float:
        return USAGE_SCORE.get(self.state, 0.0)

    @property
    def captured_value(self) -> float:
        return self.capability.value_weight * self.usage_score

    @property
    def gap_value(self) -> float:
        """Value weight sitting idle in a capability they already pay for."""
        if not self.licensed:
            return 0.0
        return self.capability.value_weight * (1.0 - self.usage_score)


@dataclass
class AdoptionProfile:
    lines: list[CapabilityLine]

    # -- coverage ------------------------------------------------------------

    @property
    def assessed_lines(self) -> list[CapabilityLine]:
        return [ln for ln in self.lines if ln.assessed]

    @property
    def licensed_lines(self) -> list[CapabilityLine]:
        return [ln for ln in self.lines if ln.licensed]

    @property
    def assessment_coverage(self) -> float:
        if not self.lines:
            return 0.0
        return len(self.assessed_lines) / len(self.lines)

    # -- the headline --------------------------------------------------------

    @property
    def licensed_weight(self) -> float:
        return sum(ln.capability.value_weight for ln in self.licensed_lines)

    @property
    def captured_weight(self) -> float:
        return sum(ln.captured_value for ln in self.licensed_lines)

    @property
    def capture_rate(self) -> float:
        """Share of licensed, value-weighted capability actually in use."""
        if self.licensed_weight == 0:
            return 0.0
        return self.captured_weight / self.licensed_weight

    @property
    def catalog_capture_rate(self) -> float:
        """Capture against the full catalog, including what they never bought.

        Useful for an upsell conversation with the vendor partner; never the
        headline number, because clients are not accountable for capability
        they did not license.
        """
        total = sum(ln.capability.value_weight for ln in self.assessed_lines)
        if total == 0:
            return 0.0
        return sum(ln.captured_value for ln in self.assessed_lines) / total

    # -- breakdowns ----------------------------------------------------------

    def by_module(self) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for ln in self.licensed_lines:
            row = out.setdefault(
                ln.capability.module,
                {"licensed_weight": 0.0, "captured_weight": 0.0, "capabilities": 0},
            )
            row["licensed_weight"] += ln.capability.value_weight
            row["captured_weight"] += ln.captured_value
            row["capabilities"] += 1
        for row in out.values():
            row["capture_rate"] = (
                row["captured_weight"] / row["licensed_weight"]
                if row["licensed_weight"]
                else 0.0
            )
        return out

    def by_driver(self) -> dict[str, float]:
        """Idle value weight per P&L driver -- points at which leakage to chase."""
        out: dict[str, float] = {}
        for ln in self.licensed_lines:
            if ln.gap_value:
                out[ln.capability.value_driver] = (
                    out.get(ln.capability.value_driver, 0.0) + ln.gap_value
                )
        return dict(sorted(out.items(), key=lambda kv: -kv[1]))

    def dormant(self) -> list[CapabilityLine]:
        """Licensed capability delivering little or nothing, worst first."""
        idle = [ln for ln in self.licensed_lines if ln.usage_score < 0.5]
        return sorted(idle, key=lambda ln: (-ln.gap_value, ln.capability.activation_effort_weeks))

    def underperforming_vs_benchmark(self) -> list[tuple[CapabilityLine, float]]:
        """Licensed capabilities used less than comparable deployments manage.

        Returns (line, shortfall) where shortfall is the catalog prior minus
        this client's usage score.
        """
        out = []
        for ln in self.licensed_lines:
            shortfall = ln.capability.typical_capture - ln.usage_score
            if shortfall > 0.05:
                out.append((ln, shortfall))
        return sorted(out, key=lambda pair: -pair[1] * pair[0].capability.value_weight)

    def blocked_by_prerequisite(self) -> list[tuple[CapabilityLine, list[str]]]:
        """Dormant capability whose prerequisites are themselves dormant.

        Sequencing matters: activating MEIO before the forecast is trustworthy
        produces a confident wrong answer, which is worse than no answer.
        """
        score = {ln.capability.id: ln.usage_score for ln in self.lines}
        out = []
        for ln in self.dormant():
            unmet = [
                p for p in ln.capability.prerequisites if score.get(p, 0.0) < 0.5
            ]
            if unmet:
                out.append((ln, unmet))
        return out

    def license_waste_share(self) -> float:
        """Fraction of licensed value weight producing nothing at all."""
        if self.licensed_weight == 0:
            return 0.0
        dead = sum(
            ln.capability.value_weight
            for ln in self.licensed_lines
            if ln.usage_score <= USAGE_SCORE[DEPLOYED_UNUSED]
        )
        return dead / self.licensed_weight


def profile(engagement: Engagement) -> AdoptionProfile:
    lines = [
        CapabilityLine(capability=cap, state=engagement.state_of(cap.id))
        for cap in engagement.catalog()
    ]
    return AdoptionProfile(lines=lines)


def state_counts(prof: AdoptionProfile) -> dict[str, int]:
    counts = {
        NOT_ASSESSED: 0,
        NOT_LICENSED: 0,
    }
    for ln in prof.lines:
        counts[ln.state] = counts.get(ln.state, 0) + 1
    return counts
