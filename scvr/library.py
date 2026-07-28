"""The pattern library -- the accumulating asset.

Every audit writes one anonymizable record. After enough of them the firm can
say the thing nobody else can say:

    "Firms your size on this platform capture a median 41% of licensed
     capability. You are at 22%. Here is the gap in dollars."

Stored as JSON Lines so it appends safely, diffs readably, and never needs a
database. Cohort statistics are suppressed below MIN_COHORT engagements --
quoting a benchmark drawn from two clients is how a young firm loses the
credibility it is trying to build.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable

DEFAULT_PATH = Path("library/patterns.jsonl")
MIN_COHORT = 3


def _percentile(values: list[float], q: float) -> float:
    """Linear-interpolation percentile; q in [0, 1]."""
    if not values:
        raise ValueError("no values")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = q * (len(ordered) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    frac = pos - lo
    return ordered[lo] * (1 - frac) + ordered[hi] * frac


def median(values: list[float]) -> float:
    return _percentile(values, 0.5)


@dataclass
class CohortStats:
    n: int
    platform: str | None
    revenue_band: str | None
    sub_vertical: str | None
    median_capture: float | None = None
    p25_capture: float | None = None
    p75_capture: float | None = None
    median_license_waste: float | None = None

    @property
    def reportable(self) -> bool:
        return self.n >= MIN_COHORT

    def percentile_of(self, capture_rate: float, records: list[dict]) -> float | None:
        if not self.reportable:
            return None
        rates = [r["capture_rate"] for r in records]
        below = sum(1 for r in rates if r < capture_rate)
        return below / len(rates)

    def describe(self, capture_rate: float) -> str:
        scope = " / ".join(
            p for p in (self.platform, self.revenue_band, self.sub_vertical) if p
        )
        if not self.reportable:
            return (
                f"Cohort ({scope or 'all'}) has only {self.n} prior engagement(s) -- "
                f"below the {MIN_COHORT}-engagement floor, so no benchmark is quoted. "
                "Catalog priors are used instead and are labelled as such."
            )
        return (
            f"Comparable deployments ({scope}, n={self.n}) capture a median "
            f"{self.median_capture:.0%} of licensed capability "
            f"(p25 {self.p25_capture:.0%} / p75 {self.p75_capture:.0%}). "
            f"This client is at {capture_rate:.0%}."
        )


def record_from_audit(audit: Any, engagement_date: str | None = None) -> dict:
    """Build the library record from a completed audit."""
    eng = audit.engagement
    return {
        "engagement_id": eng.engagement_id,
        "date": engagement_date or date.today().isoformat(),
        "platform": eng.client.platform,
        "sub_vertical": eng.client.sub_vertical,
        "revenue_band": eng.client.band,
        "live_months": eng.client.live_months,
        "capture_rate": round(audit.adoption.capture_rate, 4),
        "license_waste_share": round(audit.adoption.license_waste_share(), 4),
        "assessment_coverage": round(audit.adoption.assessment_coverage, 4),
        "qualification": audit.qualification.verdict,
        "recoverable_annual": round(audit.leakage.recoverable_total, 2),
        "leakage": {
            e.model_id: round(e.recoverable_annual, 2)
            for e in audit.leakage.operational
        },
        "evidence": {e.model_id: e.evidence for e in audit.leakage.operational},
        "skipped_models": [s.model_id for s in audit.leakage.skipped],
        "dormant_capabilities": [
            line.capability.id for line in audit.adoption.dormant()
        ],
        "sprint_items": [i.id for i in audit.roadmap.sprint.items],
    }


def add(record: dict, path: str | Path = DEFAULT_PATH) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = {r.get("engagement_id") for r in load(path)}
    if record.get("engagement_id") in existing:
        raise ValueError(
            f"{record['engagement_id']} is already in the library; "
            "re-run with a distinct engagement_id (e.g. a period suffix) to record a re-audit"
        )
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
    return path


def load(path: str | Path = DEFAULT_PATH) -> list[dict]:
    path = Path(path)
    if not path.exists():
        return []
    records = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: malformed library record ({exc})") from None
    return records


def cohort(
    records: Iterable[dict],
    platform: str | None = None,
    revenue_band: str | None = None,
    sub_vertical: str | None = None,
) -> list[dict]:
    out = []
    for r in records:
        if platform and r.get("platform") != platform:
            continue
        if revenue_band and r.get("revenue_band") != revenue_band:
            continue
        if sub_vertical and r.get("sub_vertical") != sub_vertical:
            continue
        out.append(r)
    return out


def stats(
    records: list[dict],
    platform: str | None = None,
    revenue_band: str | None = None,
    sub_vertical: str | None = None,
) -> CohortStats:
    rates = [r["capture_rate"] for r in records if "capture_rate" in r]
    waste = [r["license_waste_share"] for r in records if "license_waste_share" in r]
    cs = CohortStats(
        n=len(records),
        platform=platform,
        revenue_band=revenue_band,
        sub_vertical=sub_vertical,
    )
    if rates:
        cs.median_capture = median(rates)
        cs.p25_capture = _percentile(rates, 0.25)
        cs.p75_capture = _percentile(rates, 0.75)
    if waste:
        cs.median_license_waste = median(waste)
    return cs


def benchmark_for(
    engagement: Any, path: str | Path = DEFAULT_PATH
) -> tuple[CohortStats, list[dict]]:
    """Cohort for this client, widening the filter until it is reportable.

    Tightest first (platform + band + sub-vertical), then drop sub-vertical,
    then band. What we never do is drop the platform: capture rates are not
    comparable across platforms.
    """
    records = load(path)
    client = engagement.client
    filters = [
        (client.platform, client.band, client.sub_vertical),
        (client.platform, client.band, None),
        (client.platform, None, None),
    ]
    fallback: tuple[CohortStats, list[dict]] | None = None
    for platform, band, vertical in filters:
        subset = [
            r
            for r in cohort(records, platform, band, vertical)
            if r.get("engagement_id") != engagement.engagement_id
        ]
        cs = stats(subset, platform, band, vertical)
        if fallback is None:
            fallback = (cs, subset)
        if cs.reportable:
            return cs, subset
    return fallback if fallback else (stats([], client.platform), [])


def pattern_frequency(records: list[dict]) -> list[dict]:
    """How often each leakage pattern shows up, and how big it is when it does."""
    n = len(records)
    if not n:
        return []
    buckets: dict[str, list[float]] = {}
    for r in records:
        for model_id, value in (r.get("leakage") or {}).items():
            if value > 0:
                buckets.setdefault(model_id, []).append(float(value))
    rows = [
        {
            "model_id": model_id,
            "engagements": len(values),
            "frequency": len(values) / n,
            "median_recoverable": median(values),
        }
        for model_id, values in buckets.items()
    ]
    return sorted(rows, key=lambda row: (-row["engagements"], -row["median_recoverable"]))


def dormancy_frequency(records: list[dict], platform: str | None = None) -> list[dict]:
    """Which capabilities are dormant most often -- the diagnosis shortcut."""
    subset = [r for r in records if not platform or r.get("platform") == platform]
    if not subset:
        return []
    counts: dict[str, int] = {}
    for r in subset:
        for cap_id in r.get("dormant_capabilities") or []:
            counts[cap_id] = counts.get(cap_id, 0) + 1
    rows = [
        {
            "capability_id": cap_id,
            "engagements": count,
            "frequency": count / len(subset),
        }
        for cap_id, count in counts.items()
    ]
    return sorted(rows, key=lambda row: -row["engagements"])
