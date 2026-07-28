"""The Tier 1 Adoption Audit -- orchestration.

Runs the whole methodology over one engagement file and returns a single
result object the report renderers and the pattern library both consume:

    qualify -> score adoption -> dollarize leakage -> benchmark -> roadmap -> price
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import adoption as adoption_mod
from . import commercial, leakage as leakage_mod, library, qualify, roadmap as roadmap_mod
from .adoption import AdoptionProfile
from .commercial import Commercials
from .leakage import LeakageResult
from .library import CohortStats
from .model import Engagement
from .qualify import Qualification
from .roadmap import Roadmap


@dataclass
class Audit:
    engagement: Engagement
    adoption: AdoptionProfile
    leakage: LeakageResult
    qualification: Qualification
    roadmap: Roadmap
    commercials: Commercials
    benchmark: CohortStats
    cohort_records: list[dict]

    # -- headline numbers ----------------------------------------------------

    @property
    def capture_rate(self) -> float:
        return self.adoption.capture_rate

    @property
    def benchmark_gap(self) -> float | None:
        """Capture-rate shortfall against the cohort median, if reportable."""
        if not self.benchmark.reportable or self.benchmark.median_capture is None:
            return None
        return self.benchmark.median_capture - self.capture_rate

    @property
    def percentile(self) -> float | None:
        return self.benchmark.percentile_of(self.capture_rate, self.cohort_records)

    def to_dict(self) -> dict[str, Any]:
        prof = self.adoption
        return {
            "engagement_id": self.engagement.engagement_id,
            "client": {
                "name": self.engagement.client.name,
                "platform": self.engagement.client.platform,
                "sub_vertical": self.engagement.client.sub_vertical,
                "revenue_band": self.engagement.client.band,
                "live_months": self.engagement.client.live_months,
            },
            "qualification": {
                "verdict": self.qualification.verdict,
                "rationale": self.qualification.rationale,
                "checks": [
                    {
                        "id": c.id,
                        "verdict": c.verdict,
                        "finding": c.finding,
                        "remedy": c.remedy,
                    }
                    for c in self.qualification.checks
                ],
            },
            "adoption": {
                "capture_rate": round(prof.capture_rate, 4),
                "catalog_capture_rate": round(prof.catalog_capture_rate, 4),
                "assessment_coverage": round(prof.assessment_coverage, 4),
                "license_waste_share": round(prof.license_waste_share(), 4),
                "licensed_capabilities": len(prof.licensed_lines),
                "dormant_capabilities": [
                    {
                        "id": ln.capability.id,
                        "name": ln.capability.name,
                        "module": ln.capability.module,
                        "state": ln.state,
                        "value_weight": ln.capability.value_weight,
                    }
                    for ln in prof.dormant()
                ],
                "by_module": prof.by_module(),
                "idle_value_by_driver": prof.by_driver(),
            },
            "benchmark": {
                "n": self.benchmark.n,
                "reportable": self.benchmark.reportable,
                "median_capture": self.benchmark.median_capture,
                "p25_capture": self.benchmark.p25_capture,
                "p75_capture": self.benchmark.p75_capture,
                "percentile_of_client": self.percentile,
                "statement": self.benchmark.describe(self.capture_rate),
            },
            "leakage": {
                "gross_annual": round(self.leakage.gross_total, 2),
                "recoverable_annual": round(self.leakage.recoverable_total, 2),
                "recoverable_low": round(self.leakage.recoverable_low, 2),
                "recoverable_high": round(self.leakage.recoverable_high, 2),
                "license_waste_annual": round(self.leakage.license_waste, 2),
                "by_driver": self.leakage.by_driver(),
                "estimates": [
                    {
                        "model_id": e.model_id,
                        "name": e.name,
                        "driver": e.driver,
                        "category": e.category,
                        "gross_annual": round(e.gross_annual, 2),
                        "recoverable_annual": round(e.recoverable_annual, 2),
                        "low": round(e.low, 2),
                        "high": round(e.high, 2),
                        "confidence": e.confidence,
                        "evidence": e.evidence,
                        "basis": e.basis,
                        "assumptions": e.assumptions,
                        "linked_capabilities": list(e.linked_capabilities),
                    }
                    for e in self.leakage.estimates
                ],
                "not_assessed": [
                    {"model_id": s.model_id, "name": s.name, "missing": s.missing}
                    for s in self.leakage.skipped
                ],
            },
            "roadmap": {
                "sprint": {
                    "duration_weeks": self.roadmap.sprint.duration_weeks,
                    "team_size": self.roadmap.sprint.team_size,
                    "effort_weeks": self.roadmap.sprint.effort_weeks,
                    "recoverable_annual": round(self.roadmap.sprint.recoverable_annual, 2),
                    "items": [_item_dict(i) for i in self.roadmap.sprint.items],
                    "excluded": [
                        {"id": i.id, "title": i.title, "reason": reason}
                        for i, reason in self.roadmap.sprint.excluded
                    ],
                },
                "deferred": [_item_dict(i) for i in self.roadmap.deferred],
                "unquantified": [_item_dict(i) for i in self.roadmap.unquantified],
            },
            "commercials": {
                "audit_fee": self.commercials.audit_fee,
                "sprint_fee": self.commercials.sprint_fee,
                "sprint_delivery_cost": round(self.commercials.sprint_cost, 2),
                "sprint_gross_margin": round(self.commercials.sprint_margin, 4),
                "retainer_monthly": self.commercials.retainer_monthly,
                "client_payback_months": (
                    round(self.commercials.payback_months, 1)
                    if self.commercials.payback_months != float("inf")
                    else None
                ),
                "client_year_one_multiple": round(self.commercials.year_one_multiple, 2),
                "client_low_case_multiple": round(self.commercials.low_case_multiple, 2),
                "notes": self.commercials.notes,
            },
            "data_gaps": self.engagement.operations.missing(),
        }


def _item_dict(item: roadmap_mod.RemediationItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "title": item.title,
        "driver": item.driver,
        "thesis": item.thesis,
        "quantified": item.quantified,
        "recoverable_annual": round(item.recoverable_annual, 2),
        "low": round(item.low, 2),
        "high": round(item.high, 2),
        "confidence": item.confidence,
        "effort_weeks": item.effort_weeks,
        "score": round(item.score, 2),
        "blocked_by": list(item.blocked_by),
        "measure": item.measure,
        "target_capabilities": list(item.target_capabilities),
    }


def run(
    engagement: Engagement, library_path: str | Path = library.DEFAULT_PATH
) -> Audit:
    prof = adoption_mod.profile(engagement)
    qualification = qualify.evaluate(engagement, prof)
    leak = leakage_mod.assess(engagement, prof)
    plan = roadmap_mod.build(engagement, prof, leak)
    commercials = commercial.price(engagement, plan)
    benchmark, cohort_records = library.benchmark_for(engagement, library_path)

    return Audit(
        engagement=engagement,
        adoption=prof,
        leakage=leak,
        qualification=qualification,
        roadmap=plan,
        commercials=commercials,
        benchmark=benchmark,
        cohort_records=cohort_records,
    )
