"""Engagement input schema.

An audit engagement is one JSON file: who the client is, what they licensed,
what they actually use, and the operating metrics needed to dollarize the gap.

Everything in `Operations` is optional on purpose. Clients never have all of
it, and the audit is worth more if it says "not assessed -- data not provided"
than if it invents a number. Leakage models that lack their inputs are skipped
and reported as data gaps.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

from . import catalog

# --- capability usage states ------------------------------------------------
#
# Ordered from "we never bought it" to "planners run the business on it".
NOT_ASSESSED = "not_assessed"
NOT_LICENSED = "not_licensed"
LICENSED_UNUSED = "licensed_unused"
DEPLOYED_UNUSED = "deployed_unused"
PARTIAL = "partial"
FULL = "full"

USAGE_STATES = (
    NOT_ASSESSED,
    NOT_LICENSED,
    LICENSED_UNUSED,
    DEPLOYED_UNUSED,
    PARTIAL,
    FULL,
)

# How much of a capability's value a client is actually collecting in each
# state. `deployed_unused` scores above zero because a configured-but-idle
# capability still occasionally gets used, and because it is cheap to revive.
USAGE_SCORE: dict[str, float] = {
    NOT_LICENSED: 0.0,
    LICENSED_UNUSED: 0.0,
    DEPLOYED_UNUSED: 0.10,
    PARTIAL: 0.50,
    FULL: 1.0,
}

# States that count as "the client is paying for this".
LICENSED_STATES = (LICENSED_UNUSED, DEPLOYED_UNUSED, PARTIAL, FULL)

EVIDENCE_LEVELS = ("measured", "estimated", "anecdotal")

REVENUE_BANDS = (
    (250e6, "under_250m"),
    (1e9, "250m_1b"),
    (5e9, "1b_5b"),
    (float("inf"), "over_5b"),
)


def revenue_band(annual_revenue: float) -> str:
    for ceiling, label in REVENUE_BANDS:
        if annual_revenue < ceiling:
            return label
    return REVENUE_BANDS[-1][1]


class EngagementError(ValueError):
    """Raised when an engagement file is malformed."""


@dataclass
class ClientProfile:
    name: str
    platform: str
    sub_vertical: str
    annual_revenue: float
    live_months: int = 0
    sites: int = 1
    erp_systems: int = 1
    skus: int = 0
    planners_fte: float = 0.0
    annual_license_fee: float | None = None
    implementation_spend: float | None = None
    business_case_annual_benefit: float | None = None

    @property
    def band(self) -> str:
        return revenue_band(self.annual_revenue)


@dataclass
class Operations:
    """Operating metrics. All optional -- absence is a reported data gap."""

    # P&L shape
    annual_cogs: float | None = None
    gross_margin_pct: float | None = None

    # Inventory
    inventory_value: float | None = None
    carrying_cost_rate: float | None = None
    excess_obsolete_writeoff: float | None = None

    # Forecasting
    forecast_mape: float | None = None
    attainable_mape: float | None = None
    avg_lead_time_weeks: float | None = None
    service_level_target: float | None = None

    # Planner behaviour
    exceptions_per_week: float | None = None
    minutes_per_exception: float | None = None
    exception_automation_rate: float | None = None
    planner_loaded_cost: float | None = None
    planner_override_rate: float | None = None
    override_value_add_rate: float | None = None

    # Service / freight
    annual_freight_spend: float | None = None
    expedite_share: float | None = None
    expedite_premium_pct: float | None = None
    stockout_rate: float | None = None
    otif_pct: float | None = None

    # Data health
    master_data_accuracy: float | None = None
    data_rework_hours_per_week: float | None = None
    interface_failure_rate: float | None = None

    def provided(self) -> list[str]:
        return [f.name for f in fields(self) if getattr(self, f.name) is not None]

    def missing(self) -> list[str]:
        return [f.name for f in fields(self) if getattr(self, f.name) is None]


@dataclass
class Governance:
    """Qualification inputs -- the 'should we take this job' signals."""

    executive_sponsor: str | None = None  # e.g. "VP Supply Chain"
    documented_baseline: bool = False
    baseline_period_months: int = 0
    dedicated_client_resource: bool = False
    prior_remediation_attempts: int = 0
    vendor_relationship: str | None = None  # "healthy" | "strained" | "renewal_risk"


@dataclass
class Engagement:
    client: ClientProfile
    capabilities: dict[str, str] = field(default_factory=dict)
    operations: Operations = field(default_factory=Operations)
    governance: Governance = field(default_factory=Governance)
    evidence: dict[str, str] = field(default_factory=dict)
    notes: str = ""
    engagement_id: str = ""

    # -- construction --------------------------------------------------------

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Engagement":
        if not isinstance(raw, dict):
            raise EngagementError("engagement file must contain a JSON object")

        client_raw = raw.get("client")
        if not isinstance(client_raw, dict):
            raise EngagementError("missing 'client' object")
        try:
            client = ClientProfile(**client_raw)
        except TypeError as exc:
            raise EngagementError(f"client: {exc}") from None

        if client.platform not in catalog.CATALOGS:
            raise EngagementError(
                f"client.platform {client.platform!r} unknown; "
                f"supported: {', '.join(catalog.platforms())}"
            )

        try:
            operations = Operations(**raw.get("operations", {}))
            governance = Governance(**raw.get("governance", {}))
        except TypeError as exc:
            raise EngagementError(str(exc)) from None

        capabilities = raw.get("capabilities", {}) or {}
        if not isinstance(capabilities, dict):
            raise EngagementError("'capabilities' must be an object of id -> state")

        known = {c.id for c in catalog.get_catalog(client.platform)}
        unknown = sorted(set(capabilities) - known)
        if unknown:
            raise EngagementError(
                f"unknown capability ids for {client.platform}: {', '.join(unknown)}"
            )
        bad_states = sorted(
            {s for s in capabilities.values() if s not in USAGE_STATES}
        )
        if bad_states:
            raise EngagementError(
                f"invalid usage states {bad_states}; valid: {', '.join(USAGE_STATES)}"
            )

        evidence = raw.get("evidence", {}) or {}
        bad_evidence = sorted(
            {e for e in evidence.values() if e not in EVIDENCE_LEVELS}
        )
        if bad_evidence:
            raise EngagementError(
                f"invalid evidence levels {bad_evidence}; valid: {', '.join(EVIDENCE_LEVELS)}"
            )

        return cls(
            client=client,
            capabilities=dict(capabilities),
            operations=operations,
            governance=governance,
            evidence=dict(evidence),
            notes=raw.get("notes", ""),
            engagement_id=raw.get("engagement_id", ""),
        )

    @classmethod
    def load(cls, path: str | Path) -> "Engagement":
        path = Path(path)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise EngagementError(f"{path}: invalid JSON ({exc})") from None
        engagement = cls.from_dict(raw)
        if not engagement.engagement_id:
            engagement.engagement_id = path.stem
        return engagement

    # -- accessors -----------------------------------------------------------

    def state_of(self, capability_id: str) -> str:
        return self.capabilities.get(capability_id, NOT_ASSESSED)

    def evidence_for(self, model_id: str) -> str:
        return self.evidence.get(model_id, self.evidence.get("default", "estimated"))

    def catalog(self) -> tuple[catalog.Capability, ...]:
        return catalog.get_catalog(self.client.platform)


def template(platform: str = "blue_yonder") -> dict[str, Any]:
    """A blank engagement file, pre-populated with the platform's capabilities."""
    caps = catalog.get_catalog(platform)
    return {
        "engagement_id": "client-name-2026-q1",
        "client": {
            "name": "Client Name",
            "platform": platform,
            "sub_vertical": "3pl",
            "annual_revenue": 0,
            "live_months": 0,
            "sites": 1,
            "erp_systems": 1,
            "skus": 0,
            "planners_fte": 0,
            "annual_license_fee": None,
            "implementation_spend": None,
            "business_case_annual_benefit": None,
        },
        "capabilities": {c.id: NOT_ASSESSED for c in caps},
        "operations": {f.name: None for f in fields(Operations)},
        "governance": {
            "executive_sponsor": None,
            "documented_baseline": False,
            "baseline_period_months": 0,
            "dedicated_client_resource": False,
            "prior_remediation_attempts": 0,
            "vendor_relationship": None,
        },
        "evidence": {"default": "estimated"},
        "notes": "",
    }
