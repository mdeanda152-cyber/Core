"""Tests for the web console: generated data, build freshness, self-containment.

The browser app carries a second implementation of the methodology. These
tests plus tests/test_web_parity.js are what keep that from becoming a
liability -- the JS must agree with the Python, and the shipped file must
contain everything it needs.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools import build_web, gen_web_data  # noqa: E402

DIST = ROOT / "web" / "dist"
SRC = ROOT / "web" / "src"


def extract_data(js: str) -> dict:
    match = re.search(r"var data = (\{.*\});\n  if \(typeof module", js, re.S)
    if not match:
        raise AssertionError("could not find the generated payload in catalog.data.js")
    return json.loads(match.group(1))


class GeneratedDataTests(unittest.TestCase):
    def setUp(self):
        self.data = extract_data((SRC / "catalog.data.js").read_text(encoding="utf-8"))

    def test_catalog_matches_the_python_source(self):
        self.assertEqual(
            self.data["catalogs"],
            json.loads(json.dumps(gen_web_data.catalog_payload())),
            "web/src/catalog.data.js is stale -- run tools/gen_web_data.py",
        )

    def test_samples_match_the_example_engagements(self):
        expected = [
            json.loads((ROOT / path).read_text(encoding="utf-8"))
            for path in gen_web_data.EXAMPLES
        ]
        self.assertEqual(self.data["samples"], expected)

    def test_every_platform_is_present(self):
        from scvr import catalog

        self.assertEqual(sorted(self.data["catalogs"]), catalog.platforms())
        self.assertEqual(self.data["platformNames"], catalog.PLATFORM_NAMES)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.standalone, self.fragment = build_web.build()

    def test_dist_is_current(self):
        self.assertEqual(
            build_web.main(check=True), 0,
            "web/dist is stale -- run tools/build_web.py",
        )

    def test_standalone_is_a_complete_document(self):
        self.assertTrue(self.standalone.startswith("<!doctype html>"))
        self.assertIn("<title>", self.standalone)
        self.assertIn("</html>", self.standalone)

    def test_fragment_has_no_document_scaffolding(self):
        # The artifact host supplies <head> and <body>; supplying our own
        # would nest a second document inside theirs.
        for tag in ("<!doctype", "<html", "<head>", "<body"):
            self.assertNotIn(tag, self.fragment.lower(), f"fragment must not contain {tag}")
        self.assertIn("<title>", self.fragment)

    def test_nothing_loads_from_the_network(self):
        for name, page in (("standalone", self.standalone), ("fragment", self.fragment)):
            with self.subTest(page=name):
                self.assertNotIn("<link", page.lower())
                for pattern in ('src="http', "src='http", 'href="http', "@import"):
                    self.assertNotIn(pattern, page, f"{name} reaches out to the network")

    def test_font_travels_inside_the_page(self):
        self.assertIn("@font-face", self.standalone)
        self.assertIn("data:font/woff2;base64,", self.standalone)

    def test_engine_and_catalog_are_inlined(self):
        for token in ("CaptureEngine", "CaptureData", "runAudit", "by.io.meio"):
            self.assertIn(token, self.standalone)

    def test_inlining_would_catch_a_tag_break_out(self):
        with self.assertRaises(SystemExit):
            build_web.guard("var x = '</script>';", "test")


class ParityTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_js_engine_agrees_with_python(self):
        result = subprocess.run(
            ["node", str(ROOT / "tests" / "test_web_parity.js")],
            capture_output=True, text=True, cwd=ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("parity ok", result.stdout)

    def test_fixtures_cover_every_example(self):
        fixtures = json.loads((ROOT / "tests" / "fixtures" / "parity.json").read_text())
        self.assertEqual(
            [f["source"] for f in fixtures["audits"]], gen_web_data.EXAMPLES,
            "parity fixtures are stale -- run tools/gen_web_data.py",
        )
        self.assertGreaterEqual(len(fixtures["firms"]), 3)


if __name__ == "__main__":
    unittest.main()
