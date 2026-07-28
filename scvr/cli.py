"""Command line interface.

    python -m scvr audit engagements/client-zero.json --out out --record
    python -m scvr catalog --platform blue_yonder
    python -m scvr scaffold engagements/new-client.json --platform kinaxis
    python -m scvr library stats --platform blue_yonder
    python -m scvr economics --config firm.json
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from pathlib import Path

from . import audit as audit_mod
from . import catalog, economics, library, report
from .model import Engagement, EngagementError, template


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# --- audit ------------------------------------------------------------------


def cmd_audit(args: argparse.Namespace) -> int:
    engagement = Engagement.load(args.engagement)
    result = audit_mod.run(engagement, library_path=args.library)
    payload = result.to_dict()

    if args.format == "json" and not args.out:
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        markdown = report.render_markdown(result)
        if not args.out:
            sys.stdout.write(markdown)
        else:
            out = Path(args.out)
            stem = engagement.engagement_id or Path(args.engagement).stem
            written = []
            if args.format in ("md", "all"):
                written.append(_write(out / f"{stem}.md", markdown))
            if args.format in ("html", "all"):
                written.append(
                    _write(
                        out / f"{stem}.html",
                        report.render_html(markdown, report.audit_title(engagement)),
                    )
                )
            if args.format in ("json", "all"):
                written.append(
                    _write(out / f"{stem}.json", json.dumps(payload, indent=2) + "\n")
                )
            for path in written:
                print(f"wrote {path}", file=sys.stderr)

    if args.record:
        record = library.record_from_audit(result)
        try:
            path = library.add(record, args.library)
        except ValueError as exc:
            print(f"library: {exc}", file=sys.stderr)
            return 1
        print(f"recorded {record['engagement_id']} in {path}", file=sys.stderr)

    verdict = result.qualification.verdict
    print(
        f"{engagement.client.name}: capture {result.capture_rate:.0%}, "
        f"recoverable {result.leakage.recoverable_total:,.0f}/yr, "
        f"qualification {verdict}",
        file=sys.stderr,
    )
    return 2 if verdict == "WALK_AWAY" else 0


# --- catalog ----------------------------------------------------------------


def cmd_catalog(args: argparse.Namespace) -> int:
    platforms = [args.platform] if args.platform else catalog.platforms()
    if args.json:
        payload = {
            p: [dataclasses.asdict(c) for c in catalog.get_catalog(p)] for p in platforms
        }
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    for platform in platforms:
        caps = catalog.get_catalog(platform)
        print(f"\n{catalog.PLATFORM_NAMES.get(platform, platform)}  [{platform}]  "
              f"{len(caps)} capabilities")
        print("-" * 92)
        current_module = None
        for cap in caps:
            if cap.module != current_module:
                current_module = cap.module
                print(f"\n  {current_module}")
            print(
                f"    {cap.id:<28} w{cap.value_weight}  {cap.value_driver:<10} "
                f"prior {cap.typical_capture:>5.0%}  {cap.activation_effort_weeks:>4.1f}wk  "
                f"{cap.name}"
            )
    print()
    return 0


# --- scaffold / validate ----------------------------------------------------


def cmd_scaffold(args: argparse.Namespace) -> int:
    path = Path(args.path)
    if path.exists() and not args.force:
        print(f"{path} exists; pass --force to overwrite", file=sys.stderr)
        return 1
    _write(path, json.dumps(template(args.platform), indent=2) + "\n")
    print(f"wrote {path}", file=sys.stderr)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    engagement = Engagement.load(args.engagement)
    ops = engagement.operations
    provided, missing = ops.provided(), ops.missing()
    coverage = len(provided) / (len(provided) + len(missing)) if (provided or missing) else 0
    assessed = sum(1 for v in engagement.capabilities.values() if v != "not_assessed")
    total = len(engagement.catalog())
    print(f"{engagement.engagement_id}: valid")
    print(f"  platform            {engagement.client.platform}")
    print(f"  capabilities        {assessed}/{total} assessed")
    print(f"  operating metrics   {len(provided)}/{len(provided) + len(missing)} "
          f"({coverage:.0%})")
    if missing:
        print("  missing:            " + ", ".join(missing))
    return 0


# --- library ----------------------------------------------------------------


def cmd_library(args: argparse.Namespace) -> int:
    records = library.load(args.path)
    if not records:
        print(f"no records in {args.path}", file=sys.stderr)
        return 0

    subset = library.cohort(records, args.platform, args.revenue_band, args.sub_vertical)
    stats = library.stats(subset, args.platform, args.revenue_band, args.sub_vertical)

    print(f"library: {len(records)} engagement(s) in {args.path}")
    print(f"cohort:  {stats.n} engagement(s)")
    if stats.reportable:
        print(
            f"  capture rate   median {stats.median_capture:.0%}  "
            f"p25 {stats.p25_capture:.0%}  p75 {stats.p75_capture:.0%}"
        )
        if stats.median_license_waste is not None:
            print(f"  license waste  median {stats.median_license_waste:.0%}")
    else:
        print(
            f"  below the {library.MIN_COHORT}-engagement floor -- no benchmark quoted"
        )

    patterns = library.pattern_frequency(subset)
    if patterns:
        print("\n  failure pattern            seen   freq   median recoverable")
        for row in patterns:
            print(
                f"  {row['model_id']:<25} {row['engagements']:>4}  "
                f"{row['frequency']:>5.0%}   ${row['median_recoverable']:>12,.0f}"
            )

    dormancy = library.dormancy_frequency(subset, args.platform)
    if dormancy:
        print("\n  most often dormant         seen   freq")
        for row in dormancy[:10]:
            print(
                f"  {row['capability_id']:<25} {row['engagements']:>4}  "
                f"{row['frequency']:>5.0%}"
            )
    return 0


# --- economics --------------------------------------------------------------


def cmd_economics(args: argparse.Namespace) -> int:
    fields = {f.name for f in dataclasses.fields(economics.FirmModel)}
    config: dict = {}
    if args.config:
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        unknown = sorted(set(config) - fields)
        if unknown:
            print(f"unknown firm model fields: {', '.join(unknown)}", file=sys.stderr)
            return 1
    for override in args.set or []:
        key, _, value = override.partition("=")
        key = key.strip()
        if key not in fields:
            print(f"unknown firm model field: {key}", file=sys.stderr)
            return 1
        config[key] = float(value) if "." in value else int(value)

    firm = economics.FirmModel(**config)
    econ = economics.unit_economics(firm)
    cash = economics.cash_flow(firm, args.horizon)
    markdown = report.render_economics_markdown(firm, econ, cash)

    if args.out:
        out = Path(args.out)
        _write(out / "firm-economics.md", markdown)
        _write(
            out / "firm-economics.html",
            report.render_html(markdown, "Firm economics"),
        )
        print(f"wrote {out / 'firm-economics.md'}", file=sys.stderr)
        print(f"wrote {out / 'firm-economics.html'}", file=sys.stderr)
    else:
        sys.stdout.write(markdown)
    return 0


# --- parser -----------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scvr",
        description="Supply chain AI value realization -- audit toolkit",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_audit = sub.add_parser("audit", help="run a Tier 1 adoption audit")
    p_audit.add_argument("engagement", help="path to the engagement JSON file")
    p_audit.add_argument("--out", help="output directory (default: stdout)")
    p_audit.add_argument(
        "--format", choices=("md", "html", "json", "all"), default="md"
    )
    p_audit.add_argument("--library", default=str(library.DEFAULT_PATH))
    p_audit.add_argument(
        "--record", action="store_true", help="append this audit to the pattern library"
    )
    p_audit.set_defaults(func=cmd_audit)

    p_cat = sub.add_parser("catalog", help="show platform capability catalogs")
    p_cat.add_argument("--platform", choices=catalog.platforms())
    p_cat.add_argument("--json", action="store_true")
    p_cat.set_defaults(func=cmd_catalog)

    p_scaffold = sub.add_parser("scaffold", help="write a blank engagement file")
    p_scaffold.add_argument("path")
    p_scaffold.add_argument(
        "--platform", choices=catalog.platforms(), default="blue_yonder"
    )
    p_scaffold.add_argument("--force", action="store_true")
    p_scaffold.set_defaults(func=cmd_scaffold)

    p_validate = sub.add_parser("validate", help="check an engagement file")
    p_validate.add_argument("engagement")
    p_validate.set_defaults(func=cmd_validate)

    p_lib = sub.add_parser("library", help="pattern library statistics")
    p_lib.add_argument("action", nargs="?", choices=("stats",), default="stats")
    p_lib.add_argument("--path", default=str(library.DEFAULT_PATH))
    p_lib.add_argument("--platform", choices=catalog.platforms())
    p_lib.add_argument("--revenue-band")
    p_lib.add_argument("--sub-vertical")
    p_lib.set_defaults(func=cmd_library)

    p_econ = sub.add_parser("economics", help="firm unit economics and cash flow")
    p_econ.add_argument("--config", help="JSON file of FirmModel overrides")
    p_econ.add_argument(
        "--set", action="append", metavar="field=value", help="override a field"
    )
    p_econ.add_argument("--horizon", type=int, default=24, help="months to simulate")
    p_econ.add_argument("--out", help="output directory (default: stdout)")
    p_econ.set_defaults(func=cmd_economics)

    return parser


def main(argv: list[str] | None = None) -> int:
    catalog.validate_catalogs()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except BrokenPipeError:
        # Piping into head/less is normal usage; exit quietly rather than
        # letting the interpreter complain at shutdown.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0
    except EngagementError as exc:
        print(f"engagement error: {exc}", file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print(f"not found: {exc.filename}", file=sys.stderr)
        return 1
    except (KeyError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
