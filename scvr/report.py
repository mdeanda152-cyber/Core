"""Deliverable rendering -- the document the client actually receives.

Markdown is the source of truth; the HTML renderer converts the same text so
the two can never drift. The structure mirrors the Tier 1 promise: what you
licensed vs. what you use, where value is leaking in dollars, and what to do
about it in priority order -- plus, because the firm's credibility depends on
it, exactly what could not be assessed and why.
"""

from __future__ import annotations

import html
import re
from datetime import date

from . import catalog
from . import roadmap as roadmap_mod
from .audit import Audit
from .economics import CashFlow, FirmModel, UnitEconomics
from .model import Engagement

# --- helpers ----------------------------------------------------------------


def money(value: float | None) -> str:
    if value is None:
        return "n/a"
    if abs(value) >= 1_000_000:
        return f"${value / 1_000_000:,.2f}M"
    if abs(value) >= 1_000:
        return f"${value / 1_000:,.0f}K"
    return f"${value:,.0f}"


def pct(value: float | None, digits: int = 0) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.{digits}f}%"


def _table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "_None._\n"
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out) + "\n"


VERDICT_LABEL = {
    "GO": "GO",
    "CONDITIONAL": "CONDITIONAL -- pre-conditions required",
    "WALK_AWAY": "DO NOT PROCEED",
}

CHECK_LABEL = {"pass": "pass", "warn": "warn", "block": "BLOCK"}


def _article(number: int) -> str:
    """'an 11-week sprint', 'a 12-week sprint'."""
    text = str(number)
    return "an" if text.startswith(("8", "11", "18")) else "a"


# --- audit report -----------------------------------------------------------


def render_markdown(audit: Audit, report_date: str | None = None) -> str:
    eng = audit.engagement
    client = eng.client
    prof = audit.adoption
    leak = audit.leakage
    plan = audit.roadmap
    comm = audit.commercials
    when = report_date or date.today().isoformat()

    out: list[str] = []
    add = out.append

    platform_name = catalog.PLATFORM_NAMES.get(client.platform, client.platform)
    add(f"# Adoption Audit -- {client.name}")
    add(f"### {platform_name} | {client.sub_vertical} | {when}\n")
    add(
        f"Engagement `{eng.engagement_id}` | live {client.live_months} months | "
        f"revenue band `{client.band}`\n"
    )
    add("---\n")

    # 1. Executive summary
    add("## 1. Executive summary\n")
    add(
        f"**You are capturing {pct(prof.capture_rate)} of the capability you are "
        f"licensed for.** {audit.benchmark.describe(prof.capture_rate)}\n"
    )
    if audit.benchmark_gap is not None and audit.benchmark_gap > 0:
        add(
            f"The gap to the cohort median is {pct(audit.benchmark_gap)} of licensed "
            "capability, weighted by value.\n"
        )

    summary_rows = [
        ["Licensed capability captured (value-weighted)", pct(prof.capture_rate)],
        ["Licensed capability producing nothing", pct(prof.license_waste_share())],
        ["Annual value leakage (gross)", money(leak.gross_total)],
        [
            "**Recoverable in year one**",
            f"**{money(leak.recoverable_total)}** ({money(leak.recoverable_low)} -- "
            f"{money(leak.recoverable_high)})",
        ],
        ["Idle subscription cost (sunk, not recoverable)", money(leak.license_waste)],
        ["Catalog assessed", pct(prof.assessment_coverage)],
    ]
    add(_table(["Measure", "Value"], summary_rows))

    if plan.sprint.items:
        titles = "; ".join(i.title for i in plan.sprint.items)
        add(
            f"**Recommended next step:** {_article(plan.sprint.duration_weeks)} "
            f"{plan.sprint.duration_weeks}-week fixed-scope "
            f"remediation sprint on {len(plan.sprint.items)} outcome(s) -- {titles} -- "
            f"targeting {money(plan.sprint.recoverable_annual)} of annualised recovery "
            f"at a fee of {money(comm.sprint_fee)} "
            f"({comm.year_one_multiple:.1f}x in year one, payback "
            f"{comm.payback_months:.1f} months).\n"
        )
    else:
        add(
            "**Recommended next step:** no fixed-scope sprint is proposed. Nothing in "
            "the assessed scope clears the materiality floor with the evidence "
            "currently available -- see section 5.\n"
        )

    # 2. Qualification
    add("---\n")
    add("## 2. Engagement qualification\n")
    add(f"**Verdict: {VERDICT_LABEL[audit.qualification.verdict]}**\n")
    add(audit.qualification.rationale + "\n")
    add(
        _table(
            ["Check", "Result", "Finding", "Required action"],
            [
                [c.id, CHECK_LABEL[c.verdict], c.finding, c.remedy or "--"]
                for c in audit.qualification.checks
            ],
        )
    )

    # 3. Licensed vs used
    add("---\n")
    add("## 3. Licensed capability vs. capability in use\n")
    module_rows = [
        [
            module,
            f"{int(row['capabilities'])}",
            f"{row['licensed_weight']:.0f}",
            pct(row["capture_rate"]),
        ]
        for module, row in sorted(
            prof.by_module().items(), key=lambda kv: kv[1]["capture_rate"]
        )
    ]
    add(_table(["Module", "Licensed capabilities", "Value weight", "Capture"], module_rows))

    dormant = prof.dormant()
    add(f"\n### Dormant capability ({len(dormant)} licensed, little or no use)\n")
    add(
        _table(
            ["Capability", "Module", "State", "Weight", "Cohort prior", "Activation"],
            [
                [
                    ln.capability.name,
                    ln.capability.module,
                    ln.state.replace("_", " "),
                    str(ln.capability.value_weight),
                    pct(ln.capability.typical_capture),
                    f"{ln.capability.activation_effort_weeks:.0f} wk",
                ]
                for ln in dormant
            ],
        )
    )

    blocked = prof.blocked_by_prerequisite()
    if blocked:
        add("\n### Sequencing constraints\n")
        add(
            "These cannot be activated first. Optimization layered on a plan nobody "
            "trusts produces a confident wrong answer.\n"
        )
        add(
            _table(
                ["Capability", "Waiting on"],
                [
                    [
                        ln.capability.name,
                        ", ".join(
                            catalog.get_capability(client.platform, p).name for p in unmet
                        ),
                    ]
                    for ln, unmet in blocked
                ],
            )
        )

    idle_by_driver = prof.by_driver()
    if idle_by_driver:
        add("\n### Idle value weight by P&L driver\n")
        add(
            _table(
                ["Driver", "Idle weight"],
                [[d, f"{w:.0f}"] for d, w in idle_by_driver.items()],
            )
        )

    # 4. Leakage
    add("---\n")
    add("## 4. Where value is leaking\n")
    add(
        "Gross is the size of the problem. Recoverable is the part a fixed-scope "
        "sprint can take back within twelve months. Only recoverable is ever quoted "
        "as a commitment.\n"
    )
    add(
        _table(
            ["Finding", "Driver", "Gross/yr", "Recoverable/yr", "Range", "Evidence"],
            [
                [
                    e.name,
                    e.driver,
                    money(e.gross_annual),
                    money(e.recoverable_annual),
                    f"{money(e.low)} -- {money(e.high)}",
                    e.evidence,
                ]
                for e in leak.ranked()
            ],
        )
    )
    if leak.license_waste:
        add(
            f"\nSeparately, **{money(leak.license_waste)}/yr of subscription cost is "
            "attached to capability producing nothing**. That is sunk spend, not "
            "recoverable cash -- it converts to value only through adoption, or to cash "
            "only at renewal.\n"
        )

    add("\n### Basis of estimate\n")
    for e in leak.estimates:
        add(f"\n**{e.name}** ({e.category}, confidence {pct(e.confidence)})\n")
        add(f"- Calculation: {e.basis}")
        add(f"- Recoverable: {money(e.recoverable_annual)} of {money(e.gross_annual)} gross")
        for assumption in e.assumptions:
            add(f"- Assumption: {assumption}")
        if e.linked_capabilities:
            names = ", ".join(
                catalog.get_capability(client.platform, c).name
                for c in e.linked_capabilities
            )
            add(f"- Remediated through: {names}")
        add("")

    if leak.skipped:
        add("\n### Not assessed\n")
        add(
            "These are not zero. They are unmeasured, and quoting a number we cannot "
            "support would devalue the ones we can.\n"
        )
        add(
            _table(
                ["Finding", "Missing input"],
                [[s.name, ", ".join(s.missing)] for s in leak.skipped],
            )
        )

    # 5. Roadmap
    add("---\n")
    add("## 5. Remediation roadmap\n")
    if plan.sprint.items:
        add(
            f"### Proposed Tier 2 sprint -- {plan.sprint.duration_weeks} weeks, "
            f"{plan.sprint.team_size} consultant(s), {plan.sprint.effort_weeks:.0f} "
            "consultant-weeks\n"
        )
        for n, item in enumerate(plan.sprint.items, 1):
            add(f"\n**{n}. {item.title}** -- {money(item.recoverable_annual)}/yr "
                f"({money(item.low)} -- {money(item.high)}), {item.effort_weeks:.0f} wk\n")
            add(f"- Thesis: {item.thesis}")
            add(f"- Measured by: {item.measure}")
            add(f"- Value per consultant-week (confidence-weighted): {money(item.score)}")
            add("")
    else:
        add("No sprint scope is proposed from this audit.\n")

    # Items excluded purely by the three-outcome cap appear in the deferred
    # backlog below; only structural exclusions are called out here.
    structural = [
        (i, reason)
        for i, reason in plan.sprint.excluded
        if reason != roadmap_mod.CAP_REASON
    ]
    if structural:
        add("\n### Cannot be taken into a sprint yet\n")
        add(
            _table(
                ["Item", "Value/yr", "Why not"],
                [[i.title, money(i.recoverable_annual), reason] for i, reason in structural],
            )
        )

    if plan.deferred:
        add("\n### Deferred -- the Tier 3 backlog\n")
        add(
            _table(
                ["Item", "Recoverable/yr", "Effort", "Blocked by"],
                [
                    [
                        i.title,
                        money(i.recoverable_annual),
                        f"{i.effort_weeks:.0f} wk",
                        ", ".join(i.blocked_by) or "--",
                    ]
                    for i in plan.deferred
                ],
            )
        )

    if plan.unquantified:
        add("\n### Idle capability we could not size\n")
        add(
            "High-value capability confirmed dormant, with no operating metric supplied "
            "to put a number on it. Carried unpriced rather than guessed.\n"
        )
        add(
            _table(
                ["Capability", "Driver", "Effort", "Note"],
                [
                    [i.title, i.driver, f"{i.effort_weeks:.0f} wk", i.thesis]
                    for i in plan.unquantified
                ],
            )
        )

    # 6. Commercials
    add("---\n")
    add("## 6. Commercials\n")
    add(
        _table(
            ["Item", "Price", "Basis"],
            [
                ["Tier 1 audit (this engagement)", money(comm.audit_fee), "fixed fee"],
                [
                    "Tier 2 remediation sprint",
                    money(comm.sprint_fee),
                    f"fixed scope, {plan.sprint.duration_weeks} weeks, "
                    f"{pct(comm.sprint_margin)} delivery margin",
                ],
                [
                    "Tier 3 managed optimization",
                    f"{money(comm.retainer_monthly)}/month",
                    "ongoing tuning, adoption monitoring, quarterly review against baseline",
                ],
            ],
        )
    )
    add(
        f"\nClient return on the sprint: **{comm.year_one_multiple:.1f}x in year one** "
        f"({comm.low_case_multiple:.1f}x at the low end of the estimate band), payback in "
        f"{comm.payback_months:.1f} months.\n"
    )
    for note in comm.notes:
        add(f"- Note: {note}")
    if comm.notes:
        add("")

    # 7. Caveats
    add("---\n")
    add("## 7. What would change this answer\n")
    gaps = eng.operations.missing()
    if gaps:
        add(
            "The following operating metrics were not supplied. Each one either "
            "unlocks a leakage model or narrows a band:\n"
        )
        add("".join(f"\n- `{g}`" for g in gaps) + "\n")
    else:
        add("All operating metrics were supplied.\n")
    add(
        "\nEstimate bands reflect evidence quality, not modelling precision. A "
        "`measured` finding carries a +/-20% band; `estimated` +/-40%; `anecdotal` "
        "+/-65%. Moving a finding from estimated to measured is usually a two-day "
        "exercise and is worth doing before the sprint is scoped.\n"
    )
    if eng.notes:
        add(f"\n**Engagement notes:** {eng.notes}\n")

    return "\n".join(out).rstrip() + "\n"


# --- economics report -------------------------------------------------------


def render_economics_markdown(
    firm: FirmModel, econ: UnitEconomics, cash: CashFlow
) -> str:
    out: list[str] = []
    add = out.append
    add("# Firm economics\n")
    add(
        f"{firm.consultants:g} consultant(s) at {money(firm.loaded_cost)} loaded, "
        f"{money(firm.bill_rate)}/hr rate, {pct(firm.target_utilization)} target "
        "utilization.\n"
    )

    add("## Annual P&L\n")
    add(
        _table(
            ["Line", "Amount"],
            [
                [f"Tier 1 audits ({firm.audits_per_year} x {money(firm.audit_fee)})",
                 money(econ.revenue_audit)],
                [f"Tier 2 sprints ({firm.sprints_per_year} x {money(firm.sprint_fee)})",
                 money(econ.revenue_sprint)],
                [f"Tier 3 retainers ({firm.retainer_clients} x "
                 f"{money(firm.retainer_monthly)}/mo)", money(econ.revenue_retainer)],
                ["**Revenue**", f"**{money(econ.revenue)}**"],
                ["Delivery cost", money(-econ.delivery_cost)],
                ["Gross profit", f"{money(econ.gross_profit)} ({pct(econ.gross_margin)})"],
                ["Overhead", money(-econ.overhead)],
                ["**Operating profit**", f"**{money(econ.operating_profit)}**"],
            ],
        )
    )

    add("\n## Capacity and mix\n")
    add(
        _table(
            ["Measure", "Value"],
            [
                ["Consultant-weeks required", f"{econ.required_weeks:.0f}"],
                ["Consultant-weeks available", f"{econ.capacity_weeks:.0f}"],
                ["Implied utilization", pct(econ.implied_utilization)],
                ["Recurring revenue share", pct(econ.recurring_share)],
                [
                    "Audits needed to break even (at this sprint/retainer mix)",
                    f"{max(econ.breakeven_audits, 0):.1f}",
                ],
            ],
        )
    )

    add("\n## Cash flow\n")
    add(
        f"Payment terms net {firm.payment_terms_days} against a {pct(firm.deposit_rate)} "
        f"deposit, starting cash {money(firm.starting_cash)}.\n"
    )
    add(
        _table(
            ["Measure", "Value"],
            [
                ["Cash trough", f"{money(cash.min_balance)} (month {cash.trough_month})"],
                ["Months below zero", str(cash.months_negative)],
                ["Ending balance", money(cash.ending_balance)],
                [
                    "**Credit line to arrange before it is needed**",
                    f"**{money(cash.credit_line_needed)}**",
                ],
            ],
        )
    )
    add(
        _table(
            ["Month", "Collections", "Costs", "Net", "Balance"],
            [
                [
                    str(m.month),
                    money(m.collections),
                    money(-m.costs),
                    money(m.net),
                    money(m.balance),
                ]
                for m in cash.months
            ],
        )
    )

    if econ.warnings:
        add("\n## Warnings\n")
        for w in econ.warnings:
            add(f"- {w}")
        add("")
    return "\n".join(out).rstrip() + "\n"


# --- markdown -> html -------------------------------------------------------

_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC = re.compile(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)")
_CODE = re.compile(r"`([^`]+)`")


def _inline(text: str) -> str:
    text = html.escape(text)
    text = _CODE.sub(r"<code>\1</code>", text)
    text = _BOLD.sub(r"<strong>\1</strong>", text)
    text = _ITALIC.sub(r"<em>\1</em>", text)
    return text


def _is_separator(line: str) -> bool:
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return bool(cells) and all(set(c) <= {"-", ":"} and c for c in cells)


def markdown_to_html(md: str) -> str:
    """Converter for the markdown this module emits -- not a general one."""
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    in_list = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            close_list()
            i += 1
            continue

        if stripped.startswith("|") and i + 1 < len(lines) and _is_separator(lines[i + 1]):
            close_list()
            headers = [c.strip() for c in stripped.strip("|").split("|")]
            out.append("<table><thead><tr>")
            out += [f"<th>{_inline(h)}</th>" for h in headers]
            out.append("</tr></thead><tbody>")
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                out.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in cells) + "</tr>")
                i += 1
            out.append("</tbody></table>")
            continue

        if stripped.startswith("#"):
            close_list()
            level = len(stripped) - len(stripped.lstrip("#"))
            level = min(level, 6)
            out.append(f"<h{level}>{_inline(stripped[level:].strip())}</h{level}>")
            i += 1
            continue

        if stripped in ("---", "***", "___"):
            close_list()
            out.append("<hr>")
            i += 1
            continue

        if stripped.startswith("> "):
            close_list()
            out.append(f"<blockquote>{_inline(stripped[2:])}</blockquote>")
            i += 1
            continue

        if stripped.startswith("- "):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{_inline(stripped[2:])}</li>")
            i += 1
            continue

        close_list()
        out.append(f"<p>{_inline(stripped)}</p>")
        i += 1

    close_list()
    return "\n".join(out)


_CSS = """
:root { color-scheme: light dark; --bg:#ffffff; --fg:#16191d; --muted:#5b6470;
        --line:#e3e6ea; --accent:#8a5a2b; --head:#f6f7f9; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#14161a; --fg:#e8eaed; --muted:#9aa3ad; --line:#2b2f36;
          --accent:#d9a066; --head:#1c1f25; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2.5rem 1.25rem 5rem; background:var(--bg); color:var(--fg);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size:2rem; letter-spacing:-0.02em; margin:0 0 .25rem; }
h2 { font-size:1.35rem; margin:2.5rem 0 .75rem; padding-bottom:.3rem;
     border-bottom:1px solid var(--line); }
h3 { font-size:1.05rem; margin:1.75rem 0 .5rem; color:var(--muted);
     font-weight:600; letter-spacing:.01em; }
h4 { font-size:1rem; margin:1.25rem 0 .4rem; }
p { margin:.6rem 0; }
hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
ul { margin:.5rem 0 1rem; padding-left:1.15rem; }
li { margin:.2rem 0; }
code { background:var(--head); border:1px solid var(--line); border-radius:4px;
       padding:.05rem .3rem; font-size:.85em; }
strong { color:var(--fg); }
blockquote { margin:1rem 0; padding:.5rem 1rem; border-left:3px solid var(--accent);
             color:var(--muted); }
.table-wrap { overflow-x:auto; margin:1rem 0; }
table { border-collapse:collapse; width:100%; font-size:.9rem; }
th, td { text-align:left; padding:.5rem .7rem; border-bottom:1px solid var(--line);
         vertical-align:top; }
th { background:var(--head); font-weight:600; white-space:nowrap; }
tbody tr:hover { background:var(--head); }
"""


def render_html(markdown: str, title: str) -> str:
    body = markdown_to_html(markdown)
    body = body.replace("<table>", '<div class="table-wrap"><table>').replace(
        "</table>", "</table></div>"
    )
    return (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{html.escape(title)}</title>\n"
        f"<style>{_CSS}</style>\n</head>\n<body>\n<main>\n{body}\n</main>\n</body>\n</html>\n"
    )


def audit_title(engagement: Engagement) -> str:
    return f"Adoption Audit -- {engagement.client.name}"
