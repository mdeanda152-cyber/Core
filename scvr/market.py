"""Market sizing and growth scenarios.

Answers four questions about a move into a metro: what is actually there, what
the trajectory looks like month by month, when it breaks even, and whether it
is a good decision.

Two layers, kept strictly apart:

  MEASURED   Establishment and employment counts per metro, from BLS QCEW.
             Loaded from data/metro-markets.json, never computed here.

  MODELLED   Everything that turns those counts into prospects: how many sites
             are enterprise scale, how many run a planning platform, how many
             are far enough past go-live to be underperforming. Nobody
             publishes these, so they are explicit assumptions with defaults,
             every one of them editable and reported alongside the answer.

The split matters because the whole product is a firm that can be believed
about numbers. A market estimate that silently blends census data with guesses
is worth less than one that shows the seam.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "metro-markets.json"

# --- modelled assumptions ---------------------------------------------------


@dataclass
class MarketAssumptions:
    """Every number here is a prior, not a measurement. Defaults are stated in
    the output so a reader can disagree with them specifically."""

    # Headcount of a site big enough to run an enterprise planning platform.
    # Industry employment divided by this estimates enterprise-scale sites.
    enterprise_site_employment: float = 250.0
    # Share of enterprise-scale sites running Blue Yonder, o9, Kinaxis, SAP IBP
    # or Oracle SCM rather than ERP-native or spreadsheet planning.
    platform_penetration: float = 0.18
    # Share of those far enough past go-live to be judged on value, and not
    # getting it. The plan's own wedge: 85% invested, 6% saw ROI inside a year.
    underperformance_rate: float = 0.55
    # Share of a metro one practice can actually cover -- travel, relationships,
    # incumbent advisors already embedded.
    reachable_share: float = 0.35
    # Share of the three platforms this practice is certified on.
    platform_focus_share: float = 0.40

    def label(self) -> dict[str, str]:
        return {
            "enterprise_site_employment":
                f"a site running an enterprise planning platform averages "
                f"{self.enterprise_site_employment:,.0f} employees",
            "platform_penetration":
                f"{self.platform_penetration:.0%} of enterprise-scale sites run one of the "
                "major planning platforms",
            "underperformance_rate":
                f"{self.underperformance_rate:.0%} of those are past go-live and not getting "
                "the value in the business case",
            "reachable_share":
                f"one practice can realistically reach {self.reachable_share:.0%} of a metro",
            "platform_focus_share":
                f"the practice is certified on platforms covering "
                f"{self.platform_focus_share:.0%} of installed accounts",
        }


@dataclass
class GrowthAssumptions:
    """How an engagement turns into the next one."""

    sprint_conversion: float = 0.40      # audits that become a Tier 2 sprint
    retainer_conversion: float = 0.50    # sprints that become a Tier 3 retainer
    audit_lead_months: float = 3.0       # first contact to signed audit
    sprint_lag_months: int = 1           # audit close to sprint start
    retainer_lag_months: int = 3         # sprint close to retainer start
    ramp_months: int = 6                 # months to reach full sales productivity
    audits_per_seller_month: float = 0.9 # signed audits per business developer at full ramp
    referral_rate: float = 0.25          # extra audits generated per delivered engagement


# --- metro market -----------------------------------------------------------


@dataclass
class Metro:
    id: str
    name: str
    states: str
    full_title: str
    establishments: int
    employment: int | None
    industries: dict[str, dict]

    @property
    def display(self) -> str:
        return f"{self.name}, {self.states}" if self.states else self.name


@dataclass
class MarketSizing:
    metro: Metro
    assumptions: MarketAssumptions
    enterprise_sites: float
    platform_accounts: float
    underperforming: float
    addressable: float
    disclosed_employment: bool

    @property
    def annual_audit_capacity(self) -> float:
        """A metro is not an annuity: each account is auditable roughly once."""
        return self.addressable


def load_markets(path: str | Path = DATA_PATH) -> tuple[list[Metro], dict[str, Any]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    metros = [
        Metro(
            id=m["id"], name=m["name"], states=m["states"], full_title=m["full_title"],
            establishments=m["establishments"], employment=m["employment"],
            industries=m["industries"],
        )
        for m in payload["metros"]
    ]
    return metros, payload["source"]


def find_metro(metros: list[Metro], query: str) -> Metro | None:
    """Match on a city name the way someone would type it."""
    needle = query.strip().lower()
    if not needle:
        return None
    for metro in metros:
        if metro.id.lower() == needle:
            return metro
    for metro in metros:
        if metro.name.lower() == needle or metro.display.lower() == needle:
            return metro
    scored = []
    for metro in metros:
        haystack = metro.full_title.lower()
        if needle in haystack:
            # Prefer the metro where the query is the lead city.
            lead = haystack.startswith(needle)
            scored.append((0 if lead else 1, -metro.establishments, metro))
    if scored:
        scored.sort(key=lambda item: (item[0], item[1]))
        return scored[0][2]
    return None


def size_market(
    metro: Metro,
    assumptions: MarketAssumptions | None = None,
    sub_vertical: str | None = None,
    industries: list[dict] | None = None,
) -> MarketSizing:
    assumptions = assumptions or MarketAssumptions()

    keys = list(metro.industries)
    if sub_vertical and industries:
        matching = [
            i["key"] for i in industries if sub_vertical in i.get("sub_verticals", [])
        ]
        if matching:
            keys = [k for k in keys if k in matching] or keys

    employment = sum(
        metro.industries[k]["employment"] or 0
        for k in keys
        if k in metro.industries
    )
    disclosed = employment > 0
    if not disclosed:
        # Employment withheld: fall back to establishments so the metro still
        # ranks, and say so rather than reporting a market of zero.
        establishments = sum(metro.industries[k]["establishments"] for k in keys)
        employment = establishments * 25.0

    enterprise_sites = employment / assumptions.enterprise_site_employment
    platform_accounts = enterprise_sites * assumptions.platform_penetration
    underperforming = platform_accounts * assumptions.underperformance_rate
    addressable = (
        underperforming
        * assumptions.reachable_share
        * assumptions.platform_focus_share
    )

    return MarketSizing(
        metro=metro,
        assumptions=assumptions,
        enterprise_sites=enterprise_sites,
        platform_accounts=platform_accounts,
        underperforming=underperforming,
        addressable=addressable,
        disclosed_employment=disclosed,
    )


def rank_markets(
    metros: list[Metro],
    assumptions: MarketAssumptions | None = None,
    sub_vertical: str | None = None,
    industries: list[dict] | None = None,
    limit: int = 10,
) -> list[MarketSizing]:
    sized = [size_market(m, assumptions, sub_vertical, industries) for m in metros]
    sized.sort(key=lambda s: -s.addressable)
    return sized[:limit]


# --- growth scenario --------------------------------------------------------


@dataclass
class ScenarioInputs:
    markets: list[str] = field(default_factory=list)   # metro ids
    horizon_months: int = 36
    starting_consultants: float = 2.0
    # Fraction of a full-time business developer. At 0.5 this is the founder
    # splitting time, which is what year one actually looks like.
    sellers: float = 0.5
    max_consultants: float = 8.0
    hire_at_utilization: float = 0.85
    hiring_lag_months: int = 2
    sub_vertical: str | None = None


@dataclass
class ScenarioMonth:
    month: int
    audits_signed: float
    sprints_running: float
    retainers_active: float
    revenue: float
    delivery_cost: float
    fixed_cost: float
    profit: float
    cumulative_profit: float
    cash: float
    consultants: float
    utilization: float
    accounts_remaining: float


@dataclass
class Scenario:
    inputs: ScenarioInputs
    market: MarketAssumptions
    growth: GrowthAssumptions
    months: list[ScenarioMonth]
    sizings: list[MarketSizing]
    verdict: str
    reasons: list[str]
    breakeven_month: int | None
    cash_trough: float
    cash_trough_month: int
    peak_consultants: float
    year_three_revenue: float
    market_exhausted_month: int | None

    @property
    def addressable(self) -> float:
        return sum(s.addressable for s in self.sizings)

    @property
    def total_revenue(self) -> float:
        return sum(m.revenue for m in self.months)


GO, MARGINAL, NO = "GO", "MARGINAL", "NO"


def _money(value: float) -> str:
    """Sign outside the currency mark: -$12,000, not $-12,000."""
    sign = "-" if value < 0 else ""
    return f"{sign}${abs(value):,.0f}"


def run_scenario(
    metros: list[Metro],
    firm: Any,
    inputs: ScenarioInputs | None = None,
    market: MarketAssumptions | None = None,
    growth: GrowthAssumptions | None = None,
    industries: list[dict] | None = None,
) -> Scenario:
    """Month-by-month trajectory for entering one or more metros.

    `firm` is an economics.FirmModel -- fees, costs and payment terms come from
    the practice you have already modelled, not from fresh guesses.
    """
    inputs = inputs or ScenarioInputs()
    market = market or MarketAssumptions()
    growth = growth or GrowthAssumptions()

    by_id = {m.id: m for m in metros}
    chosen = [by_id[mid] for mid in inputs.markets if mid in by_id]
    sizings = [size_market(m, market, inputs.sub_vertical, industries) for m in chosen]
    accounts_remaining = sum(s.addressable for s in sizings)

    week_cost = firm.loaded_cost / 47.0
    audit_weeks, sprint_weeks, retainer_weeks = 5.5, 20.0, 3.0
    audits_per_head_month = (47.0 / 12.0) / audit_weeks
    terms_months = max(1, round(firm.payment_terms_days / 30.0))

    consultants = inputs.starting_consultants
    pending_hires: list[int] = []
    signed: list[float] = []          # audits signed, by month index
    collections = [0.0] * (inputs.horizon_months + terms_months + 12)
    cash = firm.starting_cash
    cumulative = 0.0
    months: list[ScenarioMonth] = []
    breakeven: int | None = None
    exhausted: int | None = None
    trough, trough_month = cash, 0

    def bill(month: int, amount: float) -> None:
        index = month + terms_months
        if index < len(collections):
            collections[index] += amount

    for m in range(inputs.horizon_months):
        # Sales capacity ramps; referrals compound off delivered work.
        ramp = min(1.0, (m + 1) / max(growth.ramp_months, 1))
        lead_delay = 1.0 if m >= growth.audit_lead_months else 0.0
        delivered = sum(signed[: max(0, m - 2)]) if signed else 0.0
        demand = (
            inputs.sellers * growth.audits_per_seller_month * ramp * lead_delay
            + delivered * growth.referral_rate / 12.0
        )

        # Delivery capacity: audits compete with sprints and retainers already
        # running, and you cannot sell what you cannot deliver.
        capacity_weeks = consultants * 47.0 / 12.0
        sprints_running = sum(
            signed[i] * growth.sprint_conversion
            for i in range(len(signed))
            if 0 <= m - i - growth.sprint_lag_months < 3
        )
        retainers_active = sum(
            signed[i] * growth.sprint_conversion * growth.retainer_conversion
            for i in range(len(signed))
            if m - i >= growth.sprint_lag_months + 3 + growth.retainer_lag_months
        )
        committed = (
            sprints_running * sprint_weeks / 3.0
            + retainers_active * retainer_weeks
        )
        free_weeks = max(0.0, capacity_weeks - committed)
        deliverable = free_weeks / audit_weeks

        audits = max(0.0, min(demand, deliverable, accounts_remaining))
        accounts_remaining -= audits
        if accounts_remaining <= 0.5 and exhausted is None and m > 0:
            exhausted = m + 1
        signed.append(audits)

        revenue = (
            audits * firm.audit_fee
            + sprints_running / 3.0 * firm.sprint_fee
            + retainers_active * firm.retainer_monthly
        )
        bill(m, audits * firm.audit_fee * firm.deposit_rate)
        bill(m + 1, audits * firm.audit_fee * (1 - firm.deposit_rate))
        bill(m, sprints_running / 3.0 * firm.sprint_fee * firm.deposit_rate)
        bill(m + 2, sprints_running / 3.0 * firm.sprint_fee * (1 - firm.deposit_rate))
        bill(m, retainers_active * firm.retainer_monthly)

        used_weeks = committed + audits * audit_weeks
        delivery_cost = used_weeks * week_cost
        fixed = (consultants * firm.loaded_cost + firm.overhead_annual) / 12.0
        # Sellers carry their own cost; treat as loaded overhead per head.
        fixed += inputs.sellers * firm.loaded_cost * 0.7 / 12.0

        profit = revenue - fixed
        cumulative += profit

        cash += collections[m] - fixed
        if cash < trough:
            trough, trough_month = cash, m + 1

        utilization = used_weeks / capacity_weeks if capacity_weeks else 0.0

        # Hire only when three things are true at once: the team is genuinely
        # full, there is market left to sell into, and recent months paid for
        # themselves. Hiring on utilisation alone is how a practice staffs up
        # into a market that has already run dry.
        trailing = [mo.profit for mo in months[-3:]]
        affordable = (sum(trailing) / len(trailing) > 0) if trailing else False
        work_left = accounts_remaining > audits_per_head_month * 6
        if (
            utilization > inputs.hire_at_utilization
            and consultants < inputs.max_consultants
            and not pending_hires
            and work_left
            and affordable
        ):
            pending_hires.append(m + inputs.hiring_lag_months)
        if pending_hires and pending_hires[0] <= m:
            pending_hires.pop(0)
            consultants = min(inputs.max_consultants, consultants + 1)

        months.append(ScenarioMonth(
            month=m + 1, audits_signed=audits, sprints_running=sprints_running,
            retainers_active=retainers_active, revenue=revenue,
            delivery_cost=delivery_cost, fixed_cost=fixed, profit=profit,
            cumulative_profit=cumulative, cash=cash, consultants=consultants,
            utilization=utilization, accounts_remaining=max(0.0, accounts_remaining),
        ))

    # First month cumulative profit turns positive *and stays there*. A
    # crossing that later reverses is not a break-even, it is a good quarter.
    breakeven = None
    for index in range(len(months) - 1, -1, -1):
        if months[index].cumulative_profit <= 0:
            breakeven = index + 2 if index + 1 < len(months) else None
            break
        if index == 0:
            breakeven = 1
    if breakeven is not None and breakeven > len(months):
        breakeven = None

    year_three = sum(mo.revenue for mo in months[-12:]) if len(months) >= 12 else 0.0
    verdict, reasons = judge(
        months, sizings, breakeven, trough, inputs, firm, growth, exhausted
    )

    return Scenario(
        inputs=inputs, market=market, growth=growth, months=months, sizings=sizings,
        verdict=verdict, reasons=reasons, breakeven_month=breakeven,
        cash_trough=trough, cash_trough_month=trough_month,
        peak_consultants=max(mo.consultants for mo in months) if months else 0.0,
        year_three_revenue=year_three, market_exhausted_month=exhausted,
    )


def judge(
    months: list[ScenarioMonth],
    sizings: list[MarketSizing],
    breakeven: int | None,
    trough: float,
    inputs: ScenarioInputs,
    firm: Any,
    growth: GrowthAssumptions,
    exhausted: int | None,
) -> tuple[str, list[str]]:
    """Is this a good decision? Say why, in the terms that would kill it."""
    reasons: list[str] = []
    fatal = False
    marginal = False

    if not sizings:
        return NO, ["No market selected."]

    addressable = sum(s.addressable for s in sizings)
    audits_needed = sum(mo.audits_signed for mo in months)

    if breakeven is None:
        fatal = True
        reasons.append(
            "Never breaks even inside the horizon. The mix does not cover fixed cost "
            "at any point, so this is a plan to lose money slowly."
        )
    elif breakeven > 24:
        marginal = True
        reasons.append(
            f"Breaks even in month {breakeven}. Past two years is a long time to fund "
            "a bet on one metro."
        )
    else:
        reasons.append(f"Breaks even in month {breakeven} on cumulative profit.")

    if addressable < audits_needed * 1.5:
        marginal = True
        reasons.append(
            f"The market holds about {addressable:.0f} addressable accounts and the plan "
            f"consumes {audits_needed:.0f} of them. Thin: you would be re-selling the same "
            "logos by year three."
        )
    else:
        reasons.append(
            f"About {addressable:.0f} addressable accounts against {audits_needed:.0f} "
            "consumed, so the metro does not run dry inside the horizon."
        )

    if exhausted:
        marginal = True
        reasons.append(f"Market runs out in month {exhausted}; add a second metro before then.")

    if trough < 0:
        need = math.ceil(abs(trough) / 25_000) * 25_000
        if need > firm.starting_cash:
            marginal = True
        reasons.append(
            f"Cash troughs at {_money(trough)}. Arrange a {_money(need)} line before you need it, "
            "not when the first invoice ages past sixty days."
        )
    else:
        reasons.append(f"Cash never goes negative; low point is {_money(trough)}.")

    trailing_profit = sum(mo.profit for mo in months[-6:])
    if trailing_profit < 0:
        marginal = True
        reasons.append(
            f"The last six months run at a {_money(trailing_profit / 6)}/month loss -- the cost "
            "base outgrew what this market can feed. Cut the hiring plan or add a metro."
        )

    peak_utilization = max((mo.utilization for mo in months), default=0.0)
    if peak_utilization > 0.95:
        marginal = True
        reasons.append(
            f"Utilization peaks at {peak_utilization:.0%}. Above 95% there is no slack for "
            "an engagement running long, and fixed-scope work always does."
        )

    if any(mo.consultants >= inputs.max_consultants for mo in months):
        reasons.append(
            f"Hits the {inputs.max_consultants:.0f}-consultant ceiling, so growth after that "
            "is a hiring decision, not a market one."
        )

    verdict = NO if fatal else (MARGINAL if marginal else GO)
    return verdict, reasons


def scenario_to_dict(scenario: Scenario) -> dict[str, Any]:
    return {
        "verdict": scenario.verdict,
        "reasons": scenario.reasons,
        "breakeven_month": scenario.breakeven_month,
        "cash_trough": round(scenario.cash_trough, 2),
        "cash_trough_month": scenario.cash_trough_month,
        "peak_consultants": scenario.peak_consultants,
        "year_three_revenue": round(scenario.year_three_revenue, 2),
        "total_revenue": round(scenario.total_revenue, 2),
        "addressable": round(scenario.addressable, 2),
        "market_exhausted_month": scenario.market_exhausted_month,
        "assumptions": {"market": asdict(scenario.market), "growth": asdict(scenario.growth)},
        "markets": [
            {
                "id": s.metro.id,
                "name": s.metro.display,
                "establishments": s.metro.establishments,
                "employment": s.metro.employment,
                "disclosed_employment": s.disclosed_employment,
                "enterprise_sites": round(s.enterprise_sites, 1),
                "platform_accounts": round(s.platform_accounts, 1),
                "addressable": round(s.addressable, 1),
            }
            for s in scenario.sizings
        ],
        "months": [
            {
                "month": mo.month,
                "audits_signed": round(mo.audits_signed, 3),
                "revenue": round(mo.revenue, 2),
                "profit": round(mo.profit, 2),
                "cumulative_profit": round(mo.cumulative_profit, 2),
                "cash": round(mo.cash, 2),
                "consultants": mo.consultants,
                "utilization": round(mo.utilization, 4),
            }
            for mo in scenario.months
        ],
    }
