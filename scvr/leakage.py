"""Value leakage models -- turning adoption gaps into dollars.

Every model here is a documented formula over metrics the client can produce,
with the assumptions stated in the output. Two rules the audit lives by:

1. A model whose inputs are missing is *skipped and reported*, never guessed.
2. Every estimate carries a band. Evidence quality widens the band; it does not
   change the point estimate. A single confident-looking number from a firm
   with no track record is worth nothing.

Gross vs. recoverable: gross is the size of the problem, recoverable is the
part a remediation sprint can actually take back inside a year. Selling gross
is how consultancies get fired in month nine.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import NormalDist
from typing import Callable

from .adoption import AdoptionProfile
from .model import ClientProfile, Engagement, Operations

HOURS_PER_FTE_YEAR = 1880.0

# Evidence quality -> (confidence, band half-width as a fraction of the point).
EVIDENCE_BANDS: dict[str, tuple[float, float]] = {
    "measured": (0.85, 0.20),
    "estimated": (0.60, 0.40),
    "anecdotal": (0.35, 0.65),
}

# Defaults used only when the client cannot supply the metric. Each one is
# announced in the estimate's `assumptions` so nothing is silently invented.
DEFAULTS = {
    "carrying_cost_rate": 0.22,
    "service_level_target": 0.95,
    "gross_margin_pct": 0.25,
    "expedite_premium_pct": 0.35,
    "exception_automation_rate": 0.0,
    "override_value_add_rate": 0.25,
    "attainable_mape_ratio": 0.75,
    "attainable_mape_floor": 0.10,
}

# Share of the gross problem a Tier 2 sprint can realistically take back in
# year one. These are the numbers the pattern library should sharpen first.
RECOVERY = {
    "exception_handling": 0.55,
    "forecast_inventory": 0.70,
    "planner_override": 0.50,
    "expedite_freight": 0.40,
    "stockout_margin": 0.35,
    "excess_obsolete": 0.30,
    "data_quality_tax": 0.50,
}


class MissingInputs(Exception):
    def __init__(self, names: list[str]):
        super().__init__(", ".join(names))
        self.names = names


@dataclass
class Context:
    client: ClientProfile
    ops: Operations
    adoption: AdoptionProfile


@dataclass
class LeakageEstimate:
    model_id: str
    name: str
    driver: str
    category: str  # "operational" | "license"
    gross_annual: float
    recoverable_annual: float
    low: float
    high: float
    confidence: float
    evidence: str
    basis: str
    assumptions: list[str] = field(default_factory=list)
    linked_capabilities: tuple[str, ...] = ()

    @property
    def band(self) -> tuple[float, float]:
        return (self.low, self.high)


@dataclass
class SkippedModel:
    model_id: str
    name: str
    missing: list[str]

    @property
    def note(self) -> str:
        return f"not assessed -- requires {', '.join(self.missing)}"


@dataclass
class LeakageResult:
    estimates: list[LeakageEstimate]
    skipped: list[SkippedModel]

    @property
    def operational(self) -> list[LeakageEstimate]:
        return [e for e in self.estimates if e.category == "operational"]

    @property
    def gross_total(self) -> float:
        return sum(e.gross_annual for e in self.operational)

    @property
    def recoverable_total(self) -> float:
        return sum(e.recoverable_annual for e in self.operational)

    @property
    def recoverable_low(self) -> float:
        return sum(e.low for e in self.operational)

    @property
    def recoverable_high(self) -> float:
        return sum(e.high for e in self.operational)

    @property
    def license_waste(self) -> float:
        return sum(e.gross_annual for e in self.estimates if e.category == "license")

    def by_driver(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for e in self.operational:
            out[e.driver] = out.get(e.driver, 0.0) + e.recoverable_annual
        return dict(sorted(out.items(), key=lambda kv: -kv[1]))

    def ranked(self) -> list[LeakageEstimate]:
        return sorted(self.operational, key=lambda e: -e.recoverable_annual)


# --- capability roles -------------------------------------------------------
#
# Leakage models are platform-neutral; the capabilities that fix them are not.
# This maps a model's remediation target onto each platform's catalog ids.

CAPABILITY_ROLES: dict[str, dict[str, tuple[str, ...]]] = {
    "exception_automation": {
        "blue_yonder": ("by.ct.exception_mgmt", "by.ct.playbooks"),
        "o9": ("o9.ct.exception_mgmt", "o9.ct.playbooks"),
        "kinaxis": ("kx.ct.alerts", "kx.ct.playbooks"),
    },
    "forecast_quality": {
        "blue_yonder": ("by.dp.stat_forecast", "by.dp.segmentation", "by.dp.demand_sensing"),
        "o9": ("o9.dp.stat_forecast", "o9.dp.demand_sensing", "o9.dp.consensus"),
        "kinaxis": ("kx.dp.stat_forecast", "kx.dp.consensus"),
    },
    "inventory_policy": {
        "blue_yonder": ("by.io.safety_stock", "by.io.meio"),
        "o9": ("o9.io.meio",),
        "kinaxis": ("kx.io.safety_stock", "kx.io.meio"),
    },
    "plan_trust": {
        "blue_yonder": ("by.sp.master_planning", "by.sp.sop"),
        "o9": ("o9.ibp.scenario", "o9.dp.consensus"),
        "kinaxis": ("kx.sim.scenario", "kx.dp.consensus"),
    },
    "freight_optimization": {
        "blue_yonder": ("by.tms.load_build", "by.tms.routing", "by.tms.rate_engine"),
        "o9": (),
        "kinaxis": (),
    },
    "service_reliability": {
        "blue_yonder": ("by.sp.master_planning", "by.oms.atp", "by.io.meio"),
        "o9": ("o9.sp.constrained", "o9.sp.allocation"),
        "kinaxis": ("kx.sp.constrained", "kx.of.atp", "kx.sp.clear_to_build"),
    },
    "inventory_health": {
        "blue_yonder": ("by.io.meio", "by.dp.segmentation"),
        "o9": ("o9.io.meio", "o9.dp.attribute_forecast"),
        "kinaxis": ("kx.io.meio", "kx.sp.clear_to_build"),
    },
    "data_foundation": {
        "blue_yonder": (),
        "o9": ("o9.kg.knowledge_graph",),
        "kinaxis": ("kx.dm.data_quality",),
    },
}


def capabilities_for_role(platform: str, role: str) -> tuple[str, ...]:
    return CAPABILITY_ROLES.get(role, {}).get(platform, ())


# --- model definitions ------------------------------------------------------


@dataclass(frozen=True)
class LeakageModel:
    id: str
    name: str
    driver: str
    role: str
    compute: Callable[[Context], "RawEstimate"]
    category: str = "operational"


@dataclass
class RawEstimate:
    gross: float
    recoverable: float
    basis: str
    assumptions: list[str] = field(default_factory=list)


def _need(ops: Operations, *names: str) -> tuple[float, ...]:
    missing = [n for n in names if getattr(ops, n, None) is None]
    if missing:
        raise MissingInputs(missing)
    return tuple(float(getattr(ops, n)) for n in names)


def _money(x: float) -> str:
    return f"${x:,.0f}"


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def _hourly(ops: Operations) -> float:
    (loaded,) = _need(ops, "planner_loaded_cost")
    return loaded / HOURS_PER_FTE_YEAR


# 1. Manual exception handling ------------------------------------------------


def _exception_handling(ctx: Context) -> RawEstimate:
    ops = ctx.ops
    exceptions, minutes = _need(ops, "exceptions_per_week", "minutes_per_exception")
    hourly = _hourly(ops)
    automation = ops.exception_automation_rate
    assumptions = []
    if automation is None:
        automation = DEFAULTS["exception_automation_rate"]
        assumptions.append("no measured automation rate; assumed 0% auto-dispositioned")

    annual_hours = exceptions * (minutes / 60.0) * 52.0 * (1.0 - automation)
    gross = annual_hours * hourly
    recoverable = gross * RECOVERY["exception_handling"]
    assumptions.append(
        f"{_pct(RECOVERY['exception_handling'])} of exception volume is rules-dispositionable "
        "based on prior engagements"
    )
    assumptions.append(
        "recovered hours are planner capacity redeployed, not headcount removed, "
        "unless the client commits to the reduction"
    )
    basis = (
        f"{exceptions:,.0f} exceptions/wk x {minutes:,.0f} min x 52 wk "
        f"x (1 - {_pct(automation)} automated) = {annual_hours:,.0f} planner-hours/yr "
        f"at {_money(hourly)}/hr"
    )
    return RawEstimate(gross, recoverable, basis, assumptions)


# 2. Forecast error carried as inventory --------------------------------------


def _forecast_inventory(ctx: Context) -> RawEstimate:
    ops = ctx.ops
    cogs, mape, lead_time = _need(ops, "annual_cogs", "forecast_mape", "avg_lead_time_weeks")
    assumptions = []

    attainable = ops.attainable_mape
    if attainable is None:
        attainable = max(
            mape * DEFAULTS["attainable_mape_ratio"], DEFAULTS["attainable_mape_floor"]
        )
        assumptions.append(
            f"attainable MAPE not established; assumed {_pct(attainable)} "
            f"({DEFAULTS['attainable_mape_ratio']:.0%} of current, floored at "
            f"{_pct(DEFAULTS['attainable_mape_floor'])})"
        )
    attainable = min(attainable, mape)

    service = ops.service_level_target
    if service is None:
        service = DEFAULTS["service_level_target"]
        assumptions.append(f"service level target assumed {_pct(service)}")
    carrying = ops.carrying_cost_rate
    if carrying is None:
        carrying = DEFAULTS["carrying_cost_rate"]
        assumptions.append(f"carrying cost rate assumed {_pct(carrying)}")

    z = NormalDist().inv_cdf(min(max(service, 0.5), 0.9999))
    weekly_cogs = cogs / 52.0
    factor = z * math.sqrt(lead_time) * weekly_cogs
    excess_inventory = factor * (mape - attainable)

    if ops.inventory_value is not None:
        cap = 0.5 * ops.inventory_value
        if excess_inventory > cap:
            assumptions.append(
                f"raw estimate capped at 50% of on-hand inventory ({_money(cap)}) "
                "to keep the claim defensible"
            )
            excess_inventory = cap

    gross = excess_inventory * carrying
    recoverable = gross * RECOVERY["forecast_inventory"]
    assumptions.append(
        "MAPE used as a proxy for the coefficient of variation of forecast error; "
        "confirm against actual error distribution before quoting externally"
    )
    basis = (
        f"safety stock delta = z({service:.2f})={z:.2f} x sqrt({lead_time:.1f} wk) "
        f"x {_money(weekly_cogs)}/wk COGS x ({_pct(mape)} - {_pct(attainable)}) "
        f"= {_money(excess_inventory)} excess inventory, carried at {_pct(carrying)}"
    )
    return RawEstimate(gross, recoverable, basis, assumptions)


# 3. Planner override erosion --------------------------------------------------


def _planner_override(ctx: Context) -> RawEstimate:
    ops = ctx.ops
    (override_rate,) = _need(ops, "planner_override_rate")
    benefit = ctx.client.business_case_annual_benefit
    if benefit is None:
        raise MissingInputs(["client.business_case_annual_benefit"])

    assumptions = []
    value_add = ops.override_value_add_rate
    if value_add is None:
        value_add = DEFAULTS["override_value_add_rate"]
        assumptions.append(
            f"assumed {_pct(value_add)} of overrides improve on the system plan "
            "(planners do know things the model does not)"
        )

    gross = benefit * override_rate * (1.0 - value_add)
    recoverable = gross * RECOVERY["planner_override"]
    assumptions.append(
        "erosion is measured against the original business case, so it inherits "
        "whatever optimism was in that case -- restate the case if it was never validated"
    )
    basis = (
        f"{_money(benefit)} business-case benefit x {_pct(override_rate)} override rate "
        f"x (1 - {_pct(value_add)} value-adding overrides)"
    )
    return RawEstimate(gross, recoverable, basis, assumptions)


# 4. Expedite freight premium --------------------------------------------------


def _expedite_freight(ctx: Context) -> RawEstimate:
    ops = ctx.ops
    spend, share = _need(ops, "annual_freight_spend", "expedite_share")
    assumptions = []
    premium = ops.expedite_premium_pct
    if premium is None:
        premium = DEFAULTS["expedite_premium_pct"]
        assumptions.append(f"expedite premium assumed {_pct(premium)} over contract rate")

    gross = spend * share * premium
    recoverable = gross * RECOVERY["expedite_freight"]
    assumptions.append(
        "only the planning-driven share of expedites is addressable; "
        "supplier failures and demand spikes are not"
    )
    basis = (
        f"{_money(spend)} freight x {_pct(share)} expedited x {_pct(premium)} premium"
    )
    return RawEstimate(gross, recoverable, basis, assumptions)


# 5. Stockout lost margin ------------------------------------------------------


def _stockout_margin(ctx: Context) -> RawEstimate:
    ops = ctx.ops
    (stockout,) = _need(ops, "stockout_rate")
    revenue = ctx.client.annual_revenue
    assumptions = []
    margin = ops.gross_margin_pct
    if margin is None:
        margin = DEFAULTS["gross_margin_pct"]
        assumptions.append(f"gross margin assumed {_pct(margin)}")

    gross = revenue * stockout * margin
    recoverable = gross * RECOVERY["stockout_margin"]
    assumptions.append(
        "assumes lost lines are truly lost, not deferred; substitution within the "
        "catalogue reduces this materially"
    )
    basis = (
        f"{_money(revenue)} revenue x {_pct(stockout)} lost-sale rate x {_pct(margin)} margin"
    )
    return RawEstimate(gross, recoverable, basis, assumptions)


# 6. Excess & obsolete ---------------------------------------------------------


def _excess_obsolete(ctx: Context) -> RawEstimate:
    (writeoff,) = _need(ctx.ops, "excess_obsolete_writeoff")
    gross = writeoff
    recoverable = gross * RECOVERY["excess_obsolete"]
    assumptions = [
        "only the share of write-off attributable to planning latency is addressable; "
        "product end-of-life and quality holds are not",
    ]
    basis = f"{_money(writeoff)} annual E&O write-off"
    return RawEstimate(gross, recoverable, basis, assumptions)


# 7. Data quality tax ----------------------------------------------------------


def _data_quality_tax(ctx: Context) -> RawEstimate:
    ops = ctx.ops
    (hours,) = _need(ops, "data_rework_hours_per_week")
    hourly = _hourly(ops)
    gross = hours * 52.0 * hourly
    recoverable = gross * RECOVERY["data_quality_tax"]
    assumptions = [
        "assumes rework is eliminated by validation at source, not moved upstream",
        "if master data accuracy is below the qualification threshold this is a "
        "data programme, not a remediation sprint -- see the qualification gate",
    ]
    basis = f"{hours:,.1f} rework hrs/wk x 52 at {_money(hourly)}/hr"
    return RawEstimate(gross, recoverable, basis, assumptions)


# 8. License waste (reported separately, never counted as recovery) -------------


def _license_waste(ctx: Context) -> RawEstimate:
    fee = ctx.client.annual_license_fee
    if fee is None:
        raise MissingInputs(["client.annual_license_fee"])
    dead_share = ctx.adoption.license_waste_share()
    gross = fee * dead_share
    assumptions = [
        "subscription cost attached to capability producing nothing; it is not cash "
        "recoverable without a renewal renegotiation, so it is excluded from the "
        "recovery total and shown as sunk spend",
    ]
    basis = (
        f"{_money(fee)} annual subscription x {_pct(dead_share)} of value-weighted "
        "licensed capability sitting idle"
    )
    return RawEstimate(gross, 0.0, basis, assumptions)


MODELS: tuple[LeakageModel, ...] = (
    LeakageModel("exception_handling", "Manual exception handling", "labor",
                 "exception_automation", _exception_handling),
    LeakageModel("forecast_inventory", "Forecast error carried as inventory", "inventory",
                 "forecast_quality", _forecast_inventory),
    LeakageModel("planner_override", "Planner override erosion", "cycle_time",
                 "plan_trust", _planner_override),
    LeakageModel("expedite_freight", "Expedite freight premium", "freight",
                 "freight_optimization", _expedite_freight),
    LeakageModel("stockout_margin", "Stockout lost margin", "service",
                 "service_reliability", _stockout_margin),
    LeakageModel("excess_obsolete", "Excess & obsolete write-off", "inventory",
                 "inventory_health", _excess_obsolete),
    LeakageModel("data_quality_tax", "Master data rework tax", "data",
                 "data_foundation", _data_quality_tax),
    LeakageModel("license_waste", "Idle subscription cost", "margin",
                 "data_foundation", _license_waste, category="license"),
)


def assess(engagement: Engagement, adoption: AdoptionProfile) -> LeakageResult:
    ctx = Context(client=engagement.client, ops=engagement.operations, adoption=adoption)
    estimates: list[LeakageEstimate] = []
    skipped: list[SkippedModel] = []

    for model in MODELS:
        try:
            raw = model.compute(ctx)
        except MissingInputs as exc:
            skipped.append(SkippedModel(model.id, model.name, exc.names))
            continue

        evidence = engagement.evidence_for(model.id)
        confidence, half_width = EVIDENCE_BANDS[evidence]
        low = raw.recoverable * (1.0 - half_width)
        high = raw.recoverable * (1.0 + half_width)

        estimates.append(
            LeakageEstimate(
                model_id=model.id,
                name=model.name,
                driver=model.driver,
                category=model.category,
                gross_annual=raw.gross,
                recoverable_annual=raw.recoverable,
                low=low,
                high=high,
                confidence=confidence,
                evidence=evidence,
                basis=raw.basis,
                assumptions=raw.assumptions,
                linked_capabilities=capabilities_for_role(
                    engagement.client.platform, model.role
                ),
            )
        )

    return LeakageResult(estimates=estimates, skipped=skipped)
