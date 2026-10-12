"""Fail-closed, bounded projection of allowlisted synthetic Playwright failures.

Uses only Python's standard library. No raw resources, images, network records,
source files, arbitrary keys or text survive the projection.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import zipfile

ALLOWLIST = {"app-container.spec.ts", "ci-failure-artifacts.spec.ts"}
MAX_REPORT = 32 * 1024 * 1024
MAX_INPUT = 16 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_OUTPUT = 8 * 1024 * 1024
MAX_FAILURES = 3
MAX_ENTRIES = 128
MAX_RECORDS = 20_000
MAX_LINE = 1024 * 1024
SAFE_TEXT = {"Synthetic Button", "Synthetic Ready", "Synthetic Complete", "Synthetic Link"}
TAGS = set("HTML HEAD BODY BUTTON OUTPUT P A INPUT DIV SPAN SECTION MAIN NAV UL LI LABEL FORM SELECT OPTION H1 H2 H3 #document #shadow-root".split())
METHODS = set("goto click fill press evaluate setContent waitForSelector textContent isVisible screenshot setExtraHTTPHeaders addCookies route toHaveText toBe close newPage".split())
CLASSES = {"Page", "Frame", "Locator", "BrowserContext", "Browser", "Test", "APIRequestContext"}
TYPES = {"context-options", "before", "after", "input", "log", "frame-snapshot", "error"}
NUMERIC = {"startTime", "endTime", "time", "timestamp", "wallTime", "monotonicTime", "x", "y", "width", "height"}
IDENTITY = {"callId", "parentId", "stepId", "pageId", "frameId", "contextId", "objectId", "beforeSnapshot", "afterSnapshot", "inputSnapshot", "snapshotName"}


def identity(value):
    return "synthetic-" + hashlib.sha256(str(value).encode()).hexdigest()[:24]


def number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    return 0


def dom(value, depth=0):
    if depth > 80:
        raise ValueError("DOM depth limit")
    if isinstance(value, str):
        return value if value in SAFE_TEXT else "[redacted]"
    if isinstance(value, list):
        # Playwright uses numeric array references to previous snapshots.
        if all(isinstance(item, (int, float)) for item in value):
            return value
        if value and isinstance(value[0], str):
            tag = value[0] if value[0] in TAGS else "DIV"
            return [tag, {}, *[dom(child, depth + 1) for child in value[2:]]]
        return [dom(child, depth + 1) for child in value]
    return "[redacted]"


def record(raw):
    kind = raw.get("type")
    if kind not in TYPES:
        return None
    clean = {"type": kind}
    for key in NUMERIC:
        if key in raw:
            clean[key] = number(raw[key])
    for key in IDENTITY:
        if key in raw and isinstance(raw[key], str):
            clean[key] = identity(raw[key])
    if kind == "context-options":
        if raw.get("version") != 9:
            raise ValueError("unsupported trace version")
        clean.update(version=9, origin="testRunner" if raw.get("origin") == "testRunner" else "library",
                     browserName="chromium", channel="", platform="linux", title="Synthetic Failure",
                     options={"viewport": {"width": 1280, "height": 720}}, sdkLanguage="javascript")
    if kind == "before":
        method = raw.get("method")
        clean["method"] = method if method in METHODS else "evaluate"
        clean["class"] = raw.get("class") if raw.get("class") in CLASSES else "Page"
        api = raw.get("apiName", "")
        clean["apiName"] = api if api in {f"{cls.lower()}.{method}" for cls in CLASSES for method in METHODS} else "synthetic.interaction"
        clean["params"] = {}
    if kind == "after" and raw.get("error"):
        clean["error"] = {"name": "Error", "message": "Synthetic failure (details redacted)"}
    if kind == "error":
        clean["message"] = "Synthetic failure (details redacted)"
    if kind == "input":
        for key, dimensions in (("point", ("x", "y")), ("box", ("x", "y", "width", "height"))):
            if isinstance(raw.get(key), dict):
                clean[key] = {dimension: number(raw[key].get(dimension)) for dimension in dimensions}
    if kind == "log":
        clean["message"] = "Synthetic interaction (details redacted)"
    if kind == "frame-snapshot":
        snapshot = raw.get("snapshot", {})
        clean["snapshot"] = {
            **{key: identity(snapshot[key]) for key in ("frameId", "pageId", "snapshotName", "callId") if key in snapshot},
            "frameUrl": "https://synthetic.invalid/", "doctype": "html",
            "html": dom(snapshot.get("html", ["HTML", {}, ["BODY", {}]])),
            "viewport": {key: number(snapshot.get("viewport", {}).get(key, 0)) for key in ("width", "height")},
            "timestamp": number(snapshot.get("timestamp", 0)), "collectionTime": 0,
            "resourceOverrides": [], "isMainFrame": bool(snapshot.get("isMainFrame")),
        }
        if snapshot.get("phase") in {"before", "after", "input", "action"}:
            clean["snapshot"]["phase"] = snapshot["phase"]
    return clean


def sanitize_trace(source, destination):
    if source.stat().st_size > MAX_INPUT:
        raise ValueError("trace input size limit")
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
            raise ValueError("archive expansion limit")
        traces = [entry for entry in entries if re.fullmatch(r"(?:\d+-)?(?:trace|test)\.trace", entry.filename)]
        if not traces:
            raise ValueError("missing trace records")
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as output:
            total = 0
            records = 0
            for index, entry in enumerate(traces):
                projected = bytearray()
                with archive.open(entry) as stream:
                    while line := stream.readline(MAX_LINE + 1):
                        records += 1
                        if len(line) > MAX_LINE or records > MAX_RECORDS:
                            raise ValueError("trace record limit")
                        value = record(json.loads(line))
                        if value is not None:
                            data = (json.dumps(value, allow_nan=False, separators=(",", ":")) + "\n").encode()
                            total += len(data)
                            if total > MAX_OUTPUT:
                                raise ValueError("trace output size limit")
                            projected.extend(data)
                output.writestr(f"{index}-trace.trace", projected)
                output.writestr(f"{index}-trace.network", b"")


def error_context(source):
    if source.stat().st_size > MAX_INPUT:
        raise ValueError("context input size limit")
    lines = ["# Sanitized Synthetic Error Context", "", "```yaml"]
    roles = {"button", "heading", "link", "textbox", "paragraph", "generic", "main", "navigation", "list", "listitem", "dialog", "text"}
    for line in source.read_text().splitlines()[:2000]:
        match = re.match(r"^( {0,80})- ([a-z]+)\b", line)
        if match and match[2] in roles:
            lines.append(f'{match[1]}- {match[2]}: "Synthetic Node"')
    return "\n".join([*lines, "```", ""])


def bounded_file(raw, root):
    path = Path(raw)
    if not path.is_absolute():
        path = root.parent / path
    absolute = Path(os.path.abspath(path))
    absolute.relative_to(root)
    # Reject symlinks even when their destination is inside the results directory.
    for component in [absolute, *list(absolute.parents)[:len(absolute.parts) - len(root.parts)]]:
        if component.is_symlink():
            raise ValueError("symlink artifact")
    if not absolute.is_file():
        raise ValueError("missing artifact")
    return absolute


def collect(report, results, output, outcome, receipt):
    # A fresh dedicated destination ensures successes cannot upload stale captures.
    if output.exists():
        raise ValueError("artifact destination already exists")
    output.mkdir(parents=True)
    files = []
    rejected = 0
    if outcome == "failure" and report.is_file() and report.stat().st_size <= MAX_REPORT:
        document = json.loads(report.read_text())
        def specs(suites):
            for suite in suites:
                yield from suite.get("specs", [])
                yield from specs(suite.get("suites", []))
        attempts = 0
        for spec in specs(document.get("suites", [])):
            if spec.get("file") not in ALLOWLIST or spec.get("ok") is True:
                continue
            for case in spec.get("tests", []):
                for result in case.get("results", []):
                    if result.get("status") not in {"failed", "timedOut"} or attempts >= MAX_FAILURES:
                        continue
                    attempts += 1
                    directory = output / f"synthetic-failure-{attempts}"
                    directory.mkdir()
                    try:
                        for name, basename in (("trace", "trace.zip"), ("error-context", "error-context.md")):
                            attachment = next((item for item in result.get("attachments", []) if item.get("name") == name and "path" in item), None)
                            if attachment is None:
                                raise ValueError("missing required attachment")
                            source = bounded_file(attachment["path"], results)
                            if source.name != basename:
                                raise ValueError("unexpected attachment basename")
                            target = directory / basename
                            if name == "trace":
                                sanitize_trace(source, target)
                            else:
                                target.write_text(error_context(source))
                        files.extend(directory.iterdir())
                    except (ValueError, KeyError, TypeError, AttributeError, OSError, zipfile.BadZipFile, RecursionError):
                        shutil.rmtree(directory)
                        rejected += 1
    manifest = {"schema": 1, "synthetic": True, "failures": len(files) // 2, "rejected": rejected,
                **receipt, "files": [{"path": str(path.relative_to(output)), "sizeBytes": path.stat().st_size,
                                     "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files]}
    if files:
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    for name in ("report", "results", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--outcome", choices=["success", "failure"], required=True)
    for name in ("run-id", "attempt", "shard", "head"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    if not all(re.fullmatch(r"[0-9]{1,20}", value) for value in (args.run_id, args.attempt, args.shard)) or not re.fullmatch(r"[a-f0-9]{40}", args.head):
        parser.error("invalid synthetic receipt identity")
    try:
        manifest = collect(args.report, Path(os.path.abspath(args.results)), args.output, args.outcome,
                           {"runId": args.run_id, "attempt": args.attempt, "shard": args.shard, "headSha": args.head})
    except (ValueError, TypeError, AttributeError, OSError, RecursionError):
        print("Synthetic failure artifact sanitization failed closed")
        raise SystemExit(1)
    print(json.dumps({"retainedFailures": manifest["failures"], "rejected": manifest["rejected"]}))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"retained={'true' if manifest['failures'] else 'false'}\n")


if __name__ == "__main__":
    main()
