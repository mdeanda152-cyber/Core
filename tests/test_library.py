"""Tests for the pattern library -- the cross-engagement asset."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scvr import library
from scvr.audit import run
from scvr.model import Engagement

EXAMPLES = [
    "examples/harborlink-3pl.json",
    "examples/meridian-cold-chain.json",
    "examples/valeron-distribution.json",
    "examples/client-zero-northgate-3pl.json",
]


class PercentileTests(unittest.TestCase):
    def test_median_and_quartiles(self):
        values = [0.2, 0.4, 0.6]
        self.assertAlmostEqual(library.median(values), 0.4)
        self.assertAlmostEqual(library._percentile(values, 0.25), 0.3)
        self.assertAlmostEqual(library._percentile(values, 0.75), 0.5)

    def test_single_value(self):
        self.assertAlmostEqual(library.median([0.5]), 0.5)


class LibraryStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "nested" / "patterns.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def _record(self, engagement_id: str, **overrides) -> dict:
        record = {
            "engagement_id": engagement_id,
            "platform": "blue_yonder",
            "sub_vertical": "3pl",
            "revenue_band": "250m_1b",
            "capture_rate": 0.4,
            "license_waste_share": 0.3,
            "leakage": {"exception_handling": 100_000.0},
            "dormant_capabilities": ["by.ct.playbooks"],
        }
        record.update(overrides)
        return record

    def test_missing_file_reads_as_empty(self):
        self.assertEqual(library.load(self.path), [])

    def test_add_creates_directories_and_appends(self):
        library.add(self._record("a"), self.path)
        library.add(self._record("b"), self.path)
        self.assertEqual(len(library.load(self.path)), 2)

    def test_duplicate_engagement_id_is_rejected(self):
        library.add(self._record("a"), self.path)
        with self.assertRaises(ValueError):
            library.add(self._record("a"), self.path)

    def test_malformed_line_is_reported_with_its_number(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('{"engagement_id": "ok"}\nnot json\n')
        with self.assertRaises(ValueError) as ctx:
            library.load(self.path)
        self.assertIn(":2:", str(ctx.exception))

    def test_small_cohorts_are_not_reportable(self):
        for i in range(library.MIN_COHORT - 1):
            library.add(self._record(f"e{i}"), self.path)
        stats = library.stats(library.load(self.path), "blue_yonder")
        self.assertFalse(stats.reportable)
        self.assertIn("below the", stats.describe(0.3))

    def test_cohort_at_the_floor_is_reportable(self):
        for i, rate in enumerate([0.2, 0.4, 0.6]):
            library.add(self._record(f"e{i}", capture_rate=rate), self.path)
        records = library.load(self.path)
        stats = library.stats(records, "blue_yonder")
        self.assertTrue(stats.reportable)
        self.assertAlmostEqual(stats.median_capture, 0.4)
        self.assertAlmostEqual(stats.percentile_of(0.5, records), 2 / 3)
        self.assertIn("median 40%", stats.describe(0.5))

    def test_cohort_filters_are_applied(self):
        library.add(self._record("a", platform="o9"), self.path)
        library.add(self._record("b", sub_vertical="cold_chain"), self.path)
        library.add(self._record("c"), self.path)
        records = library.load(self.path)
        self.assertEqual(len(library.cohort(records, platform="blue_yonder")), 2)
        self.assertEqual(len(library.cohort(records, sub_vertical="3pl")), 2)
        self.assertEqual(
            len(library.cohort(records, platform="blue_yonder", sub_vertical="3pl")), 1
        )

    def test_pattern_and_dormancy_frequency(self):
        library.add(self._record("a"), self.path)
        library.add(
            self._record(
                "b",
                leakage={"exception_handling": 300_000.0, "expedite_freight": 50_000.0},
                dormant_capabilities=["by.ct.playbooks", "by.io.meio"],
            ),
            self.path,
        )
        records = library.load(self.path)
        patterns = {row["model_id"]: row for row in library.pattern_frequency(records)}
        self.assertAlmostEqual(patterns["exception_handling"]["frequency"], 1.0)
        self.assertAlmostEqual(patterns["exception_handling"]["median_recoverable"], 200_000.0)
        self.assertAlmostEqual(patterns["expedite_freight"]["frequency"], 0.5)

        dormancy = {row["capability_id"]: row for row in library.dormancy_frequency(records)}
        self.assertAlmostEqual(dormancy["by.ct.playbooks"]["frequency"], 1.0)
        self.assertAlmostEqual(dormancy["by.io.meio"]["frequency"], 0.5)


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "patterns.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def _seed(self) -> None:
        for example in EXAMPLES[:-1]:
            audit = run(Engagement.load(example), library_path=self.path)
            library.add(library.record_from_audit(audit), self.path)

    def test_benchmark_widens_until_the_cohort_is_reportable(self):
        self._seed()
        engagement = Engagement.load(EXAMPLES[-1])
        stats, records = library.benchmark_for(engagement, self.path)
        self.assertTrue(stats.reportable)
        self.assertEqual(stats.platform, "blue_yonder")
        # Widened past band and sub-vertical, but never past the platform.
        self.assertIsNone(stats.sub_vertical)
        self.assertEqual(len(records), 3)

    def test_client_is_never_benchmarked_against_itself(self):
        self._seed()
        audit = run(Engagement.load(EXAMPLES[-1]), library_path=self.path)
        library.add(library.record_from_audit(audit), self.path)  # all four recorded
        stats, records = library.benchmark_for(Engagement.load(EXAMPLES[0]), self.path)
        self.assertNotIn(
            "harborlink-3pl-2025-q3", [r["engagement_id"] for r in records]
        )
        self.assertEqual(stats.n, 3)

    def test_record_captures_what_the_next_audit_needs(self):
        audit = run(Engagement.load(EXAMPLES[-1]), library_path=self.path)
        record = library.record_from_audit(audit, engagement_date="2026-03-01")
        self.assertEqual(record["platform"], "blue_yonder")
        self.assertEqual(record["date"], "2026-03-01")
        self.assertGreater(record["capture_rate"], 0)
        self.assertIn("exception_handling", record["leakage"])
        self.assertIn("by.io.meio", record["dormant_capabilities"])
        self.assertEqual(record["qualification"], "GO")

    def test_empty_library_yields_an_unreportable_cohort(self):
        stats, records = library.benchmark_for(Engagement.load(EXAMPLES[0]), self.path)
        self.assertFalse(stats.reportable)
        self.assertEqual(records, [])


if __name__ == "__main__":
    unittest.main()
