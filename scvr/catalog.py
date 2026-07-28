"""Platform capability catalogs.

One catalog per supported platform. Each entry is a capability a client may
have licensed, and carries the four things the audit needs to reason about it:

  value_weight            how much of the platform's value sits behind it (1-5)
  value_driver            which P&L line it moves
  typical_capture         share of comparable deployments that get real use out
                          of it, used as a fallback benchmark until the pattern
                          library has enough engagements of its own (see
                          scvr.library)
  activation_effort_weeks consultant-weeks to take it from dormant to used

`typical_capture` figures are the firm's own priors, not vendor numbers. They
are starting values to be replaced by observed cohort medians as engagements
accumulate -- that replacement is the whole point of the pattern library.
"""

from __future__ import annotations

from dataclasses import dataclass

# Value drivers, in the language the VP of Supply Chain uses.
VALUE_DRIVERS = (
    "inventory",
    "service",
    "freight",
    "labor",
    "margin",
    "cycle_time",
    "data",
)


@dataclass(frozen=True)
class Capability:
    """A single licensable/usable capability within a platform."""

    id: str
    name: str
    module: str
    platform: str
    value_weight: int
    value_driver: str
    typical_capture: float
    activation_effort_weeks: float
    prerequisites: tuple[str, ...] = ()
    data_requirements: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not 1 <= self.value_weight <= 5:
            raise ValueError(f"{self.id}: value_weight must be 1-5")
        if self.value_driver not in VALUE_DRIVERS:
            raise ValueError(f"{self.id}: unknown value_driver {self.value_driver!r}")
        if not 0.0 <= self.typical_capture <= 1.0:
            raise ValueError(f"{self.id}: typical_capture must be 0-1")


def _c(*args, **kwargs) -> Capability:
    return Capability(*args, **kwargs)


BLUE_YONDER: tuple[Capability, ...] = (
    _c("by.dp.stat_forecast", "Statistical forecasting", "Demand Planning", "blue_yonder",
       5, "inventory", 0.82, 2.0, (), ("shipment history", "product hierarchy")),
    _c("by.dp.demand_sensing", "ML demand sensing (short horizon)", "Demand Planning", "blue_yonder",
       4, "inventory", 0.31, 5.0, ("by.dp.stat_forecast",), ("POS or DC withdrawal feed", "open orders")),
    _c("by.dp.npi", "New product introduction / like-modeling", "Demand Planning", "blue_yonder",
       3, "inventory", 0.24, 3.0, ("by.dp.stat_forecast",), ("attribute master", "launch calendar")),
    _c("by.dp.promo", "Promotion & event modeling", "Demand Planning", "blue_yonder",
       3, "margin", 0.29, 4.0, ("by.dp.stat_forecast",), ("promo calendar", "lift history")),
    _c("by.dp.segmentation", "Demand segmentation & model selection", "Demand Planning", "blue_yonder",
       3, "inventory", 0.35, 2.0, ("by.dp.stat_forecast",), ("volume/variability classification",)),
    _c("by.io.meio", "Multi-echelon inventory optimization", "Inventory Optimization", "blue_yonder",
       5, "inventory", 0.27, 8.0, ("by.dp.stat_forecast", "by.sp.master_planning"),
       ("network model", "lead time variability", "service targets by segment")),
    _c("by.io.safety_stock", "Dynamic safety stock policy", "Inventory Optimization", "blue_yonder",
       4, "inventory", 0.44, 3.0, ("by.dp.stat_forecast",), ("lead time by item/site", "service targets")),
    _c("by.sp.master_planning", "Master supply planning", "Supply Planning", "blue_yonder",
       5, "service", 0.71, 4.0, (), ("BOM/routing or sourcing rules", "capacity calendars")),
    _c("by.sp.capacity", "Constrained capacity planning", "Supply Planning", "blue_yonder",
       4, "service", 0.38, 5.0, ("by.sp.master_planning",), ("resource capacity", "run rates")),
    _c("by.sp.sop", "S&OP / integrated business planning cycle", "Supply Planning", "blue_yonder",
       4, "cycle_time", 0.41, 6.0, ("by.dp.stat_forecast", "by.sp.master_planning"),
       ("financial plan alignment", "scenario definitions")),
    _c("by.ct.exception_mgmt", "Control tower exception management", "Luminate Control Tower", "blue_yonder",
       5, "labor", 0.22, 4.0, ("by.sp.master_planning",), ("alert thresholds", "ownership matrix")),
    _c("by.ct.playbooks", "Resolution playbooks / automated disposition", "Luminate Control Tower", "blue_yonder",
       4, "labor", 0.11, 6.0, ("by.ct.exception_mgmt",), ("documented resolution paths",)),
    _c("by.ct.visibility", "Multi-party shipment visibility", "Luminate Control Tower", "blue_yonder",
       3, "service", 0.33, 4.0, (), ("carrier EDI 214 / API feeds",)),
    _c("by.tms.load_build", "Load building & consolidation", "Transportation Management", "blue_yonder",
       4, "freight", 0.48, 4.0, (), ("order profile", "equipment master")),
    _c("by.tms.routing", "Route optimization", "Transportation Management", "blue_yonder",
       4, "freight", 0.42, 5.0, ("by.tms.load_build",), ("stop geocoding", "service windows")),
    _c("by.tms.rate_engine", "Freight rate engine & least-cost carrier select", "Transportation Management", "blue_yonder",
       4, "freight", 0.39, 5.0, (), ("carrier contract rates", "accessorial schedules")),
    _c("by.tms.tendering", "Automated tendering (EDI 204/990)", "Transportation Management", "blue_yonder",
       3, "freight", 0.36, 3.0, ("by.tms.rate_engine",), ("carrier EDI trading partner setup",)),
    _c("by.wms.labor_mgmt", "Labor management & engineered standards", "Warehouse Management", "blue_yonder",
       4, "labor", 0.26, 6.0, (), ("engineered standards", "task-level scan data")),
    _c("by.wms.slotting", "Slotting optimization", "Warehouse Management", "blue_yonder",
       3, "labor", 0.19, 4.0, (), ("velocity data", "slot dimensions")),
    _c("by.oms.atp", "Available-to-promise / order sourcing", "Order Management", "blue_yonder",
       4, "service", 0.34, 5.0, ("by.sp.master_planning",), ("real-time inventory positions",)),
)

O9: tuple[Capability, ...] = (
    _c("o9.dp.stat_forecast", "Statistical forecasting engine", "Demand Planning", "o9",
       5, "inventory", 0.80, 2.0, (), ("shipment history", "product hierarchy")),
    _c("o9.dp.demand_sensing", "Demand sensing", "Demand Planning", "o9",
       4, "inventory", 0.28, 5.0, ("o9.dp.stat_forecast",), ("POS/channel feed", "open orders")),
    _c("o9.dp.attribute_forecast", "Attribute-based / NPI forecasting", "Demand Planning", "o9",
       3, "inventory", 0.22, 4.0, ("o9.dp.stat_forecast",), ("attribute master",)),
    _c("o9.dp.consensus", "Consensus demand workflow", "Demand Planning", "o9",
       4, "cycle_time", 0.46, 3.0, ("o9.dp.stat_forecast",), ("sales input cadence", "override capture")),
    _c("o9.sp.constrained", "Constrained supply planning", "Supply Planning", "o9",
       5, "service", 0.63, 5.0, (), ("sourcing rules", "capacity model")),
    _c("o9.sp.capacity", "Capacity & resource planning", "Supply Planning", "o9",
       4, "service", 0.37, 5.0, ("o9.sp.constrained",), ("resource master", "run rates")),
    _c("o9.sp.allocation", "Supply allocation / fair share", "Supply Planning", "o9",
       3, "service", 0.29, 4.0, ("o9.sp.constrained",), ("customer priority tiers",)),
    _c("o9.io.meio", "Multi-echelon inventory optimization", "Inventory Optimization", "o9",
       5, "inventory", 0.25, 8.0, ("o9.dp.stat_forecast", "o9.sp.constrained"),
       ("network model", "lead time variability", "service targets")),
    _c("o9.ibp.scenario", "Scenario planning / what-if simulation", "IBP", "o9",
       5, "cycle_time", 0.33, 4.0, ("o9.sp.constrained",), ("scenario library", "baseline snapshots")),
    _c("o9.ibp.pnl_sim", "P&L simulation of supply scenarios", "IBP", "o9",
       4, "margin", 0.18, 6.0, ("o9.ibp.scenario",), ("cost model", "price/margin by SKU")),
    _c("o9.ibp.sop_cycle", "Executive S&OP cycle orchestration", "IBP", "o9",
       4, "cycle_time", 0.44, 6.0, ("o9.dp.consensus", "o9.sp.constrained"), ("cycle calendar", "decision rights")),
    _c("o9.kg.knowledge_graph", "Enterprise knowledge graph modeling", "Digital Brain", "o9",
       5, "data", 0.36, 8.0, (), ("master data governance", "integration contracts")),
    _c("o9.ct.exception_mgmt", "Control tower exceptions & alerts", "Control Tower", "o9",
       5, "labor", 0.24, 4.0, ("o9.sp.constrained",), ("alert thresholds", "ownership matrix")),
    _c("o9.ct.playbooks", "Automated resolution playbooks", "Control Tower", "o9",
       4, "labor", 0.10, 6.0, ("o9.ct.exception_mgmt",), ("documented resolution paths",)),
    _c("o9.rev.pricing", "Revenue / price-volume planning", "Revenue Management", "o9",
       3, "margin", 0.16, 6.0, ("o9.dp.stat_forecast",), ("price elasticity history",)),
    _c("o9.an.analytics", "Planner analytics & KPI cockpit", "Analytics", "o9",
       3, "cycle_time", 0.52, 2.0, (), ("KPI definitions", "baseline period")),
)

KINAXIS: tuple[Capability, ...] = (
    _c("kx.dp.stat_forecast", "Statistical forecasting", "Demand Planning", "kinaxis",
       5, "inventory", 0.78, 2.0, (), ("shipment history", "product hierarchy")),
    _c("kx.dp.consensus", "Consensus demand & override capture", "Demand Planning", "kinaxis",
       4, "cycle_time", 0.48, 3.0, ("kx.dp.stat_forecast",), ("sales input cadence",)),
    _c("kx.sp.constrained", "Constrained supply planning", "Supply Planning", "kinaxis",
       5, "service", 0.69, 4.0, (), ("BOM/routing", "capacity calendars")),
    _c("kx.sp.aggregate", "Aggregate / rough-cut capacity planning", "Supply Planning", "kinaxis",
       4, "service", 0.41, 4.0, ("kx.sp.constrained",), ("resource capacity",)),
    _c("kx.sp.clear_to_build", "Clear-to-build / shortage analysis", "Supply Planning", "kinaxis",
       4, "service", 0.35, 4.0, ("kx.sp.constrained",), ("component pegging", "on-hand accuracy")),
    _c("kx.io.meio", "Multi-echelon inventory optimization", "Inventory Optimization", "kinaxis",
       5, "inventory", 0.23, 8.0, ("kx.dp.stat_forecast", "kx.sp.constrained"),
       ("network model", "lead time variability", "service targets")),
    _c("kx.io.safety_stock", "Safety stock policy management", "Inventory Optimization", "kinaxis",
       4, "inventory", 0.45, 3.0, ("kx.dp.stat_forecast",), ("lead time by item/site",)),
    _c("kx.sim.scenario", "Scenario simulation (what-if)", "Simulation", "kinaxis",
       5, "cycle_time", 0.39, 3.0, ("kx.sp.constrained",), ("scenario library", "baseline snapshots")),
    _c("kx.sim.compare", "Scenario comparison & decision logging", "Simulation", "kinaxis",
       3, "cycle_time", 0.21, 3.0, ("kx.sim.scenario",), ("decision rights", "audit trail policy")),
    _c("kx.sop.cycle", "S&OP cycle orchestration", "S&OP", "kinaxis",
       4, "cycle_time", 0.43, 6.0, ("kx.dp.consensus", "kx.sp.constrained"), ("cycle calendar",)),
    _c("kx.ct.alerts", "Alert-based exception management", "Control Tower", "kinaxis",
       5, "labor", 0.26, 4.0, ("kx.sp.constrained",), ("alert thresholds", "ownership matrix")),
    _c("kx.ct.playbooks", "Automated exception disposition", "Control Tower", "kinaxis",
       4, "labor", 0.12, 6.0, ("kx.ct.alerts",), ("documented resolution paths",)),
    _c("kx.of.atp", "Order fulfillment / ATP", "Order Fulfillment", "kinaxis",
       4, "service", 0.32, 5.0, ("kx.sp.constrained",), ("real-time inventory positions",)),
    _c("kx.an.analytics", "Planner analytics & KPI dashboards", "Analytics", "kinaxis",
       3, "cycle_time", 0.55, 2.0, (), ("KPI definitions", "baseline period")),
    _c("kx.dm.data_quality", "Data quality monitoring & exception feeds", "Data Management", "kinaxis",
       4, "data", 0.30, 4.0, (), ("master data ownership", "error thresholds")),
)

CATALOGS: dict[str, tuple[Capability, ...]] = {
    "blue_yonder": BLUE_YONDER,
    "o9": O9,
    "kinaxis": KINAXIS,
}

PLATFORM_NAMES = {
    "blue_yonder": "Blue Yonder Luminate",
    "o9": "o9 Digital Brain",
    "kinaxis": "Kinaxis Maestro / RapidResponse",
}


def platforms() -> list[str]:
    return sorted(CATALOGS)


def get_catalog(platform: str) -> tuple[Capability, ...]:
    try:
        return CATALOGS[platform]
    except KeyError:
        raise KeyError(
            f"unknown platform {platform!r}; supported: {', '.join(platforms())}"
        ) from None


def get_capability(platform: str, capability_id: str) -> Capability:
    for cap in get_catalog(platform):
        if cap.id == capability_id:
            return cap
    raise KeyError(f"{platform}: unknown capability {capability_id!r}")


def modules(platform: str) -> list[str]:
    seen: list[str] = []
    for cap in get_catalog(platform):
        if cap.module not in seen:
            seen.append(cap.module)
    return seen


def validate_catalogs() -> None:
    """Fail loudly on a malformed catalog: duplicate ids or dangling prereqs."""
    for platform, caps in CATALOGS.items():
        ids = [c.id for c in caps]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"{platform}: duplicate capability ids {sorted(dupes)}")
        known = set(ids)
        for cap in caps:
            missing = [p for p in cap.prerequisites if p not in known]
            if missing:
                raise ValueError(f"{cap.id}: prerequisites not in catalog: {missing}")
            if cap.platform != platform:
                raise ValueError(f"{cap.id}: platform field {cap.platform!r} != {platform!r}")
