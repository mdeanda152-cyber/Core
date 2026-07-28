"""The qualification gate -- deciding whether to take the job at all.

From the plan's risk section: some of the ROI shortfall is fixable underuse
(the market) and some is bad master data or fantasy expectations set during the
original sale (not the market). An early unwinnable engagement costs more than
the fee it earns, because the firm has no reputation to absorb it.

Each check returns PASS, WARN, or BLOCK. Any BLOCK means walk away; two or more
WARNs means the engagement is conditional on fixing the condition first.
"""

from __future__ import annotations

from dataclasses import dataclass

from .adoption import AdoptionProfile
from .model import Engagement

PASS, WARN, BLOCK = "pass", "warn", "block"

GO, CONDITIONAL, WALK_AWAY = "GO", "CONDITIONAL", "WALK_AWAY"

# Thresholds. These are the firm's underwriting standards -- tighten them as the
# pattern library shows which engagements actually went badly.
MASTER_DATA_BLOCK = 0.75
MASTER_DATA_WARN = 0.90
MIN_LIVE_MONTHS = 9
INTERFACE_FAILURE_BLOCK = 0.10
MIN_DATA_COVERAGE = 0.35
MIN_ASSESSMENT_COVERAGE = 0.60


@dataclass
class Check:
    id: str
    verdict: str
    finding: str
    remedy: str = ""


@dataclass
class Qualification:
    checks: list[Check]

    @property
    def blocks(self) -> list[Check]:
        return [c for c in self.checks if c.verdict == BLOCK]

    @property
    def warnings(self) -> list[Check]:
        return [c for c in self.checks if c.verdict == WARN]

    @property
    def verdict(self) -> str:
        if self.blocks:
            return WALK_AWAY
        if len(self.warnings) >= 2:
            return CONDITIONAL
        return GO

    @property
    def rationale(self) -> str:
        if self.verdict == WALK_AWAY:
            return (
                "Decline or rescope. "
                + "; ".join(c.finding for c in self.blocks)
            )
        if self.verdict == CONDITIONAL:
            return (
                "Proceed only with the pre-conditions below written into the SOW. "
                + "; ".join(c.remedy or c.finding for c in self.warnings)
            )
        return "No disqualifying conditions found."


def _master_data(engagement: Engagement) -> Check:
    accuracy = engagement.operations.master_data_accuracy
    if accuracy is None:
        return Check(
            "master_data",
            WARN,
            "Master data accuracy has never been measured.",
            "Include a two-week data profiling step before committing to sprint scope.",
        )
    if accuracy < MASTER_DATA_BLOCK:
        return Check(
            "master_data",
            BLOCK,
            f"Master data accuracy {accuracy:.0%} is below the {MASTER_DATA_BLOCK:.0%} "
            "floor -- no planning remediation survives this",
            "Refer to a data remediation programme; revisit in 6-12 months.",
        )
    if accuracy < MASTER_DATA_WARN:
        return Check(
            "master_data",
            WARN,
            f"Master data accuracy {accuracy:.0%} is workable but will limit results.",
            "Scope a data clean-up work package inside the sprint and baseline it separately.",
        )
    return Check("master_data", PASS, f"Master data accuracy {accuracy:.0%}.")


def _maturity(engagement: Engagement) -> Check:
    months = engagement.client.live_months
    if months < MIN_LIVE_MONTHS:
        return Check(
            "maturity",
            BLOCK,
            f"Platform has been live {months} months -- this is still implementation, "
            "not value realization",
            "Revisit after two full planning cycles post go-live.",
        )
    return Check("maturity", PASS, f"Live {months} months; past the stabilisation window.")


def _sponsor(engagement: Engagement) -> Check:
    sponsor = (engagement.governance.executive_sponsor or "").strip()
    if not sponsor:
        return Check(
            "sponsor",
            BLOCK,
            "No named executive sponsor -- findings will have nowhere to land",
            "Do not start without a named VP Supply Chain or COO owner.",
        )
    operational = any(
        token in sponsor.lower()
        for token in ("supply chain", "operations", "coo", "logistics", "fulfil", "planning")
    )
    if not operational:
        return Check(
            "sponsor",
            WARN,
            f"Sponsor is {sponsor}; the buyer who signed the original contract has ego "
            "invested in calling it a success.",
            "Secure a co-sponsor who lives with the platform daily.",
        )
    return Check("sponsor", PASS, f"Sponsor: {sponsor}.")


def _baseline(engagement: Engagement) -> Check:
    gov = engagement.governance
    if not gov.documented_baseline:
        return Check(
            "baseline",
            WARN,
            "No documented performance baseline -- outcomes cannot be proven, "
            "which is the entire product.",
            "Establish and sign off a baseline as engagement step one.",
        )
    if gov.baseline_period_months < 3:
        return Check(
            "baseline",
            WARN,
            f"Baseline covers only {gov.baseline_period_months} months; seasonality "
            "will swamp the measured delta.",
            "Extend the baseline to at least 3 months, ideally 6.",
        )
    return Check("baseline", PASS, f"Baseline documented over {gov.baseline_period_months} months.")


def _integration(engagement: Engagement) -> Check:
    rate = engagement.operations.interface_failure_rate
    if rate is None:
        return Check("integration", PASS, "Interface failure rate not reported; no signal either way.")
    if rate > INTERFACE_FAILURE_BLOCK:
        return Check(
            "integration",
            BLOCK,
            f"Interface failure rate {rate:.0%} -- the platform is not receiving "
            "reliable data and no tuning will fix that",
            "Integration stabilisation first, by whoever owns the middleware.",
        )
    return Check("integration", PASS, f"Interface failure rate {rate:.0%}.")


def _data_coverage(engagement: Engagement) -> Check:
    provided = len(engagement.operations.provided())
    total = provided + len(engagement.operations.missing())
    coverage = provided / total if total else 0.0
    if coverage < MIN_DATA_COVERAGE:
        return Check(
            "data_coverage",
            WARN,
            f"Only {coverage:.0%} of operating metrics supplied; most leakage models "
            "will be unquantifiable.",
            "Get the metric pack completed before the fee is fixed.",
        )
    return Check("data_coverage", PASS, f"{coverage:.0%} of operating metrics supplied.")


def _assessment_coverage(adoption: AdoptionProfile) -> Check:
    coverage = adoption.assessment_coverage
    if coverage < MIN_ASSESSMENT_COVERAGE:
        return Check(
            "assessment_coverage",
            WARN,
            f"Only {coverage:.0%} of the platform catalog has been assessed; "
            "the capture rate is provisional.",
            "Complete the capability walkthrough with the platform owner.",
        )
    return Check("assessment_coverage", PASS, f"{coverage:.0%} of the catalog assessed.")


def _prior_attempts(engagement: Engagement) -> Check:
    attempts = engagement.governance.prior_remediation_attempts
    if attempts >= 2:
        return Check(
            "prior_attempts",
            WARN,
            f"{attempts} previous remediation attempts have failed; the blocker is "
            "probably organisational, not technical.",
            "Diagnose why the last attempt failed before scoping this one.",
        )
    plural = "" if attempts == 1 else "s"
    return Check("prior_attempts", PASS, f"{attempts} prior remediation attempt{plural}.")


def evaluate(engagement: Engagement, adoption: AdoptionProfile) -> Qualification:
    return Qualification(
        checks=[
            _master_data(engagement),
            _maturity(engagement),
            _sponsor(engagement),
            _baseline(engagement),
            _integration(engagement),
            _data_coverage(engagement),
            _assessment_coverage(adoption),
            _prior_attempts(engagement),
        ]
    )
