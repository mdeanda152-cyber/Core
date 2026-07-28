#!/usr/bin/env python3
"""Build the metro market dataset from BLS QCEW.

Where the market numbers come from, and what they are not:

  REAL      Establishment counts, employment and average pay by metropolitan
            statistical area and industry, from the Bureau of Labor Statistics
            Quarterly Census of Employment and Wages. QCEW is a census of
            employers covered by unemployment insurance -- roughly 95% of US
            jobs -- not a survey estimate. Public domain, no licence needed.

  NOT REAL  Which of those establishments run Blue Yonder, o9 or Kinaxis.
            Nobody publishes that. The scenario engine models it from stated,
            editable assumptions and labels every derived figure as modelled.
            This script never writes a modelled number into the dataset.

Suppressed cells (BLS withholds figures that would identify an employer) are
carried through as nulls rather than zeros, so the app can say "not disclosed"
instead of implying a market has no employment.

    python3 tools/fetch_market_data.py

Writes web/src/market.data.js (committed) so the app needs no network access.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JS = ROOT / "web" / "src" / "market.data.js"
OUT_JSON = ROOT / "data" / "metro-markets.json"

YEAR = "2023"
QCEW_URL = "https://data.bls.gov/cew/data/api/{year}/a/industry/{naics}.csv"
AREA_TITLES_URL = "https://data.bls.gov/cew/doc/titles/area/area_titles.csv"

SOURCE = {
    "name": "US Bureau of Labor Statistics, Quarterly Census of Employment and Wages",
    "short": "BLS QCEW",
    "year": YEAR,
    "basis": "annual averages, private ownership",
    "url": "https://www.bls.gov/cew/",
    "licence": "public domain (US Government work)",
    "coverage": "employers covered by unemployment insurance, ~95% of US jobs",
}

# The industries that buy supply chain planning platforms, mapped onto the
# sub-verticals the audit already understands.
INDUSTRIES = [
    {"naics": "493", "key": "warehousing", "label": "Warehousing & storage",
     "sub_verticals": ["3pl", "retail_dc"]},
    {"naics": "484", "key": "trucking", "label": "Truck transportation",
     "sub_verticals": ["3pl"]},
    {"naics": "423", "key": "wholesale_durable", "label": "Wholesale, durable goods",
     "sub_verticals": ["industrial_distribution"]},
    {"naics": "424", "key": "wholesale_nondurable", "label": "Wholesale, nondurable goods",
     "sub_verticals": ["industrial_distribution", "cold_chain"]},
    {"naics": "311", "key": "food_mfg", "label": "Food manufacturing",
     "sub_verticals": ["cold_chain", "manufacturing"]},
]

MSA_AGGREGATION_LEVEL = "45"   # MSA by NAICS 3-digit
PRIVATE_OWNERSHIP = "5"
# Below this the metro is too thin to build a practice around and the rows are
# mostly suppressed anyway.
MIN_ESTABLISHMENTS = 40


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "capture-market-data/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read().decode("utf-8-sig")


def number(raw: str, disclosure: str) -> int | None:
    """QCEW withholds identifying cells; carry those through as unknown."""
    if disclosure.strip().upper() == "N":
        return None
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def area_titles() -> dict[str, str]:
    titles = {}
    for row in csv.DictReader(io.StringIO(fetch(AREA_TITLES_URL))):
        fips = row["area_fips"]
        if fips.startswith("C"):
            titles[fips] = row["area_title"]
    return titles


def clean_name(title: str) -> tuple[str, str]:
    """'Dallas-Fort Worth-Arlington, TX MSA' -> ('Dallas-Fort Worth', 'TX')."""
    body = title.replace(" MSA", "").replace(" MicroSA", "").strip()
    if "," in body:
        cities, _, states = body.rpartition(",")
    else:
        cities, states = body, ""
    parts = [p for p in cities.split("-") if p]
    short = "-".join(parts[:2]) if len(parts) > 1 else cities
    return short.strip(), states.strip()


def collect() -> dict:
    titles = area_titles()
    metros: dict[str, dict] = {}

    for industry in INDUSTRIES:
        print(f"fetching NAICS {industry['naics']} ({industry['label']})…", file=sys.stderr)
        reader = csv.DictReader(io.StringIO(fetch(QCEW_URL.format(year=YEAR, naics=industry["naics"]))))
        for row in reader:
            if row["own_code"] != PRIVATE_OWNERSHIP:
                continue
            if row["agglvl_code"] != MSA_AGGREGATION_LEVEL:
                continue
            fips = row["area_fips"]
            if not fips.startswith("C") or fips not in titles:
                continue

            disclosure = row.get("disclosure_code", "")
            establishments = number(row["annual_avg_estabs"], disclosure)
            if establishments is None:
                continue

            metro = metros.setdefault(fips, {"fips": fips, "title": titles[fips], "industries": {}})
            metro["industries"][industry["key"]] = {
                "establishments": establishments,
                "employment": number(row["annual_avg_emplvl"], disclosure),
                "avg_annual_pay": number(row["avg_annual_pay"], disclosure),
            }

    records = []
    for metro in metros.values():
        total_estabs = sum(i["establishments"] for i in metro["industries"].values())
        if total_estabs < MIN_ESTABLISHMENTS:
            continue
        name, states = clean_name(metro["title"])
        employment = [i["employment"] for i in metro["industries"].values() if i["employment"]]
        records.append({
            "id": metro["fips"],
            "name": name,
            "states": states,
            "full_title": metro["title"],
            "establishments": total_estabs,
            "employment": sum(employment) if employment else None,
            "industries": metro["industries"],
        })

    records.sort(key=lambda r: -r["establishments"])
    return {"source": SOURCE, "industries": INDUSTRIES, "metros": records}


def main() -> int:
    payload = collect()
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    OUT_JS.write_text(
        "/* Generated by tools/fetch_market_data.py from BLS QCEW " + YEAR + ".\n"
        " * Real establishment and employment counts, public domain. Do not edit by\n"
        " * hand -- regenerate instead. Nothing modelled is stored here. */\n"
        "(function (root) {\n"
        "  var data = " + json.dumps(payload, indent=2) + ";\n"
        "  if (typeof module === 'object' && module.exports) { module.exports = data; }\n"
        "  else { root.CaptureMarketData = data; }\n"
        "})(typeof self !== 'undefined' ? self : this);\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT_JSON} and {OUT_JS}: {len(payload['metros'])} metros", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
