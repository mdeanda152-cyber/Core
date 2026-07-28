# Supply Chain AI Value Realization — audit toolkit

Working code for the methodology described in
[`docs/supply-chain-ai-value-realization.md`](docs/supply-chain-ai-value-realization.md).

The plan's section 5 puts "build the audit methodology" in weeks 4–10 and calls
it the firm's IP; section 7 says the accumulated pattern library is the real
asset. This is both of those, as software: a repeatable Tier 1 Adoption Audit
that scores licensed-vs-used capability, dollarizes the gap with documented
formulas, sequences the fixes, prices the three tiers, and writes one record per
engagement into a benchmark that gets sharper with every client.

Python 3.11+, standard library only. No install step, no dependencies.

```bash
python -m scvr audit examples/client-zero-northgate-3pl.json --out out --format all
```

---

## What it does

| Module | Responsibility |
|---|---|
| `scvr/catalog.py` | Capability catalogs for Blue Yonder, o9 and Kinaxis — value weight, P&L driver, activation effort, prerequisites, cohort prior |
| `scvr/model.py` | The engagement file: client profile, capability states, operating metrics, governance, evidence quality |
| `scvr/qualify.py` | The walk-away gate — master data floor, deployment maturity, sponsor level, measurable baseline, integration health |
| `scvr/adoption.py` | Value-weighted capture rate, dormant capability, sequencing constraints, idle value by driver |
| `scvr/leakage.py` | Eight dollar models, each with its formula, assumptions and confidence band stated in the output |
| `scvr/roadmap.py` | Prioritization by recoverable value per consultant-week, then fixed-scope sprint packing |
| `scvr/commercial.py` | Tier 1/2/3 pricing inside the published bands, plus the client's ROI check |
| `scvr/library.py` | The pattern library: cohort benchmarks, failure-pattern frequency, dormancy frequency |
| `scvr/economics.py` | The firm's own P&L, capacity check, and the net-60/90 cash trap simulator |
| `scvr/report.py` | Markdown deliverable and a self-contained HTML render of the same text |

---

## Commands

```bash
# Run an audit. Exit code 2 means the qualification gate says walk away.
python -m scvr audit examples/client-zero-northgate-3pl.json          # markdown to stdout
python -m scvr audit <file> --out out --format all --record           # md + html + json, recorded

# Start a new engagement from a blank, pre-populated file
python -m scvr scaffold engagements/acme.json --platform kinaxis
python -m scvr validate engagements/acme.json

# Inspect a platform catalog
python -m scvr catalog --platform blue_yonder
python -m scvr catalog --json

# The pattern library
python -m scvr library stats --platform blue_yonder
python -m scvr library stats --platform blue_yonder --sub-vertical 3pl

# Firm economics and cash flow
python -m scvr economics
python -m scvr economics --set consultants=2 --set retainer_clients=0 --set starting_cash=60000
python -m scvr economics --config firm.json --out out
```

---

## The engagement file

One JSON file per client. `scaffold` writes a blank one with every capability
for the chosen platform already listed.

```json
{
  "engagement_id": "acme-2026-q2",
  "client": { "name": "Acme", "platform": "kinaxis", "sub_vertical": "3pl",
              "annual_revenue": 300000000, "live_months": 22,
              "business_case_annual_benefit": 4000000 },
  "capabilities": { "kx.io.meio": "licensed_unused", "kx.dp.stat_forecast": "full" },
  "operations":   { "forecast_mape": 0.31, "exceptions_per_week": 400 },
  "governance":   { "executive_sponsor": "VP Supply Chain", "documented_baseline": true },
  "evidence":     { "default": "estimated", "exception_handling": "measured" }
}
```

**Capability states** — `not_assessed`, `not_licensed`, `licensed_unused`,
`deployed_unused`, `partial`, `full`. Capture is value-weighted across licensed
capability only; a client is not accountable for capability they never bought.
Anything left `not_assessed` is excluded from the denominator and reported as
assessment coverage, so a partial walkthrough cannot flatter the number.

**Evidence quality** — `measured` (±20% band), `estimated` (±40%), `anecdotal`
(±65%). Evidence widens the band; it never moves the point estimate.

---

## Three rules the code enforces

**A model without its inputs is skipped, not guessed.** Missing metrics produce
a "not assessed — requires X" line in the report, not a plausible number. The
whole product is a firm that can be believed about dollars.

**Gross is not recoverable.** Every finding reports the size of the problem and,
separately, the share a fixed-scope sprint can take back within twelve months.
Only the second number is ever quoted as a commitment. Idle subscription cost is
carried in its own category and excluded from the recovery total, because it is
sunk spend, not cash.

**Sequencing is enforced.** A dormant capability whose prerequisites are
themselves dormant cannot enter a sprint. Optimization layered on a plan nobody
trusts produces a confident wrong answer.

---

## The pattern library

Each `--record` appends one line to `library/patterns.jsonl`. Cohort statistics
stay suppressed until three comparable engagements exist; below that the report
falls back to catalog priors and says so. The cohort filter widens from
platform + revenue band + sub-vertical down to platform alone, but never drops
the platform — capture rates are not comparable across platforms.

At three or more, the report produces the section 7 line directly:

> Comparable deployments (blue_yonder, n=3) capture a median 55% of licensed
> capability (p25 36% / p75 58%). This client is at 36%.

The committed `library/patterns.jsonl` is seeded from the four example
engagements, which are illustrative rather than real. Delete it before recording
actual client work:

```bash
rm library/patterns.jsonl
for f in engagements/*.json; do python -m scvr audit "$f" --record --format json --out out; done
```

---

## Firm economics

`python -m scvr economics` models the mix, the capacity it needs, and the cash
gap between net-60/90 collections and fortnightly payroll. Two findings worth
knowing before they cost money:

- The plan's "4 audits plus 2 sprints covers one senior consultant plus
  overhead" is profitable, but at ~132% utilization for one person — it needs
  about 1.5 people, or subcontractors.
- Tier 1 cannot break even on its own at any team size the model allows. Audits
  buy the Tier 2 and Tier 3 pipeline; the retainers pay the bills. That is the
  same conclusion the plan reaches from the other direction with its 60%
  recurring-revenue target.

---

## Tests

```bash
python -m unittest discover -s tests -t .
```

72 tests covering the leakage formulas against hand-computed values, the
qualification gate's block conditions, sprint packing constraints, pricing
clamps, cohort suppression below the floor, cash-flow timing under payment
terms, and an end-to-end run on all three platforms.

---

## Calibration

Three sets of numbers are the firm's priors, not facts, and are meant to be
replaced by observed data as engagements accumulate:

- `catalog.typical_capture` — cohort priors per capability, superseded by
  `library.stats` once a cohort clears three engagements.
- `leakage.RECOVERY` — the share of each gross problem a sprint actually
  recovers. Check these against delivered outcomes first; they drive both the
  client's ROI case and the sprint price.
- `qualify` thresholds — the underwriting standards. Tighten them when the
  library shows which engagements went badly.
