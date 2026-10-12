"""Synthetic-only regression checks, invoked by the repository's Node test runner."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("sanitizer", Path(__file__).parents[1] / "sanitize-browser-failure-artifacts.py")
sanitizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sanitizer)
SENTINELS = [f"SYNTHETIC_{kind}_SENTINEL" for kind in
             ("SECRET", "PROMPT", "TRANSCRIPT", "COOKIE", "AUTH", "PERSONAL", "PRIVATE_URL", "ERROR")]
DIRTY = " ".join(SENTINELS)
RECEIPT = {"runId": "123", "attempt": "1", "shard": "2", "headSha": "a" * 40}


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.results = self.base / "test-results"
        self.results.mkdir()
        self.trace = self.results / "trace.zip"
        self.context = self.results / "error-context.md"
        self.report = self.base / "report.json"
        self.output = self.base / "sanitized"
        raw = [
            {"type": "context-options", "version": 9, "title": DIRTY, "options": {"httpCredentials": DIRTY}, "monotonicTime": 1},
            {"type": "before", "callId": DIRTY, "pageId": DIRTY, "class": "Frame", "method": "click", "apiName": "locator.click", "startTime": 3,
             "params": {DIRTY: DIRTY}, DIRTY: DIRTY, "beforeSnapshot": DIRTY, "stack": [DIRTY]},
            {"type": "input", "callId": DIRTY, "point": {"x": 12, "y": 34, DIRTY: DIRTY}},
            {"type": "after", "callId": DIRTY, "endTime": 5, "result": DIRTY, "error": {"name": DIRTY, "message": DIRTY, "stack": DIRTY}},
            {"type": "frame-snapshot", "snapshot": {"frameId": DIRTY, "pageId": DIRTY, "snapshotName": DIRTY, "callId": DIRTY,
             "frameUrl": DIRTY, "phase": "before", "timestamp": 4, "viewport": {"width": 300, "height": 200},
             "html": ["HTML", {DIRTY: DIRTY}, ["BODY", {}, ["BUTTON", {"onclick": DIRTY}, "Synthetic Button"], ["P", {}, DIRTY]]],
             "resourceOverrides": [{"sha1": DIRTY}], DIRTY: DIRTY}},
            {"type": "log", "callId": DIRTY, "message": DIRTY},
            {"type": "error", "message": DIRTY, "stack": DIRTY},
            {"type": "resource-snapshot", "snapshot": {"request": {"headers": DIRTY}, "response": {"cookies": DIRTY}}},
        ]
        with zipfile.ZipFile(self.trace, "w") as archive:
            archive.writestr("1-trace.trace", "\n".join(json.dumps(row) for row in raw))
            for name in ("1-trace.network", "1-trace.stacks", "resources/secret.html", "src/secret.ts", "screencast/secret.jpeg", "attachments/secret"):
                archive.writestr(name, DIRTY)
        self.context.write_text(f"# {DIRTY}\n```yaml\n- button \"{DIRTY}\":\n  - paragraph: {DIRTY}\n```\n")
        self.write_report()

    def write_report(self, file="ci-failure-artifacts.spec.ts", status="failed", ok=False, count=1):
        result = {"status": status, "attachments": [
            {"name": "trace", "path": str(self.trace), "contentType": DIRTY},
            {"name": "error-context", "path": str(self.context)},
            {"name": "screenshot", "path": DIRTY},
        ]}
        self.report.write_text(json.dumps({"suites": [{"suites": [{"specs": [{"file": file, "ok": ok,
            "title": DIRTY, "tests": [{"results": [result] * count}]}]}]}]}))

    def collect(self, outcome="failure"):
        return sanitizer.collect(self.report, self.results, self.output, outcome, RECEIPT)

    def test_failure_projection_excludes_every_sentinel_and_preserves_structure(self):
        result = self.collect()
        self.assertEqual(result["failures"], 1)
        manifest = (self.output / "manifest.json").read_text()
        with zipfile.ZipFile(self.output / "synthetic-failure-1/trace.zip") as archive:
            self.assertEqual(archive.namelist(), ["0-trace.trace", "0-trace.network"])
            self.assertEqual(archive.read("0-trace.network"), b"")
            trace = archive.read("0-trace.trace").decode()
        context = (self.output / "synthetic-failure-1/error-context.md").read_text()
        for sentinel in SENTINELS:
            self.assertNotIn(sentinel, manifest + trace + context)
        rows = [json.loads(line) for line in trace.splitlines()]
        self.assertEqual(rows[1]["apiName"], "locator.click")
        self.assertEqual(rows[2]["point"], {"x": 12, "y": 34})
        self.assertEqual(rows[3]["endTime"] - rows[1]["startTime"], 2)
        self.assertEqual(rows[1]["callId"], rows[3]["callId"])
        self.assertEqual(rows[1]["beforeSnapshot"], rows[4]["snapshot"]["snapshotName"])
        self.assertIn("Synthetic Button", trace)
        self.assertIn('- button: "Synthetic Node"', context)

    def test_success_does_not_publish_even_with_failure_files(self):
        self.assertEqual(self.collect("success")["failures"], 0)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_passed_and_unallowlisted_tests_are_excluded(self):
        for file, status, ok in [("other.spec.ts", "failed", False), ("../app-container.spec.ts", "failed", False),
                                 ("app-container.spec.ts", "passed", True), ("app-container.spec.ts", "skipped", False)]:
            self.write_report(file, status, ok)
            self.assertEqual(self.collect()["failures"], 0)
            self.output.rmdir()

    def test_missing_required_file_drops_the_entire_pair(self):
        self.context.unlink()
        self.assertEqual(self.collect()["rejected"], 1)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_missing_report_and_stale_destination_are_safe(self):
        self.report.unlink()
        self.assertEqual(self.collect()["failures"], 0)
        with self.assertRaises(ValueError):
            self.collect()

    def test_paths_and_symlinks_cannot_escape_allowlisted_results(self):
        outside = self.base / "outside.zip"
        outside.write_bytes(self.trace.read_bytes())
        for path in (outside, self.results / "../outside.zip"):
            with self.assertRaises(ValueError):
                sanitizer.bounded_file(str(path), self.results)
        link = self.results / "link.zip"
        try:
            link.symlink_to(self.trace)
        except OSError:
            self.skipTest("host cannot create symlinks")
        with self.assertRaises(ValueError):
            sanitizer.bounded_file(str(link), self.results)

    def test_count_and_archive_size_bounds(self):
        self.write_report(count=10)
        self.assertEqual(self.collect()["failures"], 3)
        with zipfile.ZipFile(self.trace, "w") as archive:
            for index in range(sanitizer.MAX_ENTRIES + 1):
                archive.writestr(str(index), "")
        with self.assertRaises(ValueError):
            sanitizer.sanitize_trace(self.trace, self.base / "bad.zip")
        with self.trace.open("wb") as trace:
            trace.truncate(sanitizer.MAX_INPUT + 1)
        with self.assertRaises(ValueError):
            sanitizer.sanitize_trace(self.trace, self.base / "bad.zip")

    def test_unknown_versions_and_malformed_records_fail_closed(self):
        for data in ('{"type":"context-options","version":10}', 'not-json', '[]'):
            with zipfile.ZipFile(self.trace, "w") as archive:
                archive.writestr("0-trace.trace", data)
            self.assertEqual(self.collect()["rejected"], 1)
            self.assertEqual(list(self.output.iterdir()), [])
            self.output.rmdir()

    def test_expansion_output_report_and_context_limits(self):
        for limit in ("MAX_EXPANDED", "MAX_OUTPUT", "MAX_RECORDS", "MAX_LINE"):
            with patch.object(sanitizer, limit, 1):
                self.assertEqual(self.collect()["rejected"], 1)
            self.output.rmdir()
        with self.report.open("wb") as report:
            report.truncate(sanitizer.MAX_REPORT + 1)
        self.assertEqual(self.collect()["failures"], 0)
        self.output.rmdir()
        with self.context.open("wb") as context:
            context.truncate(sanitizer.MAX_INPUT + 1)
        with self.assertRaises(ValueError):
            sanitizer.error_context(self.context)


if __name__ == "__main__":
    unittest.main()
