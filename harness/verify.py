#!/usr/bin/env python3
"""ephemeris verification driver.

Serves the harness fixtures on 127.0.0.1, launches a headless Firefox
with the extension temporary-loaded via web-ext, lets the scripted
scenario (harness/orchestrate.js) run, & asserts the acceptance
invariants against the collected title-write logs:

  load     exactly 1 extension write decorates the initial title
  nav      exactly 2 writes per navigation: the page's, then ours
  echo     0 adjacent duplicate-value writes anywhere
  rest     0 writes across sustained head churn
  shift    exactly 1 write per tab-index shift on the observer tab;
           0 writes on the unshifted orchestrator (idempotent fan-out)
  reload   1 write per load & byte-identical titles across 3 reloads

Hermetic: ephemeral port, temp Firefox profile, no ambient state.
Exit code 0 = every invariant holds.

--old <dir> runs the same scenario with signed legacy XPIs sideloaded
into a plain Firefox instead (the RED receipt): expect FAILures.
--headed shows the browser.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HARNESS_DIR = Path(__file__).resolve().parent
REPO_DIR = HARNESS_DIR.parent

reports = []
reports_lock = threading.Lock()
done_event = threading.Event()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HARNESS_DIR), **kwargs)

    def do_POST(self):
        if self.path != "/report":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        with reports_lock:
            reports.append(body)
        if body.get("phase") in ("done", "shift-blocked"):
            done_event.set()
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args):
        pass


def latest(role, phase=None, load=None):
    with reports_lock:
        matches = [
            r
            for r in reports
            if r.get("role") == role
            and (phase is None or r.get("phase") == phase)
            and (load is None or r.get("load") == load)
        ]
    return matches[-1] if matches else None


def writes(log):
    return [e for e in log if e["origin"] != "mark"]


def segment(log, start_mark, end_mark):
    """Entries strictly between two marks (start may be None = log start)."""
    start = 0
    if start_mark is not None:
        start = next(
            i + 1
            for i, e in enumerate(log)
            if e["origin"] == "mark" and e["value"] == start_mark
        )
    end = next(
        i
        for i, e in enumerate(log)
        if e["origin"] == "mark" and e["value"] == end_mark
    )
    return writes(log[start:end])


DECORATED = re.compile(r"^(\d+) (.*) \[127\.0\.0\.1\]$")


def check_all():
    """Return a list of (name, ok, detail) acceptance checks."""
    checks = []

    def check(name, ok, detail):
        checks.append((name, bool(ok), detail))

    orch = latest("orchestrator", phase="pre-reload", load=1)
    if orch is None:
        check("scenario ran", False, "no pre-reload report from orchestrator")
        return checks
    log = orch["log"]

    load_seg = segment(log, None, "load-done")
    ext = [e for e in load_seg if e["origin"] == "extension"]
    page = [e for e in load_seg if e["origin"] == "page"]
    ok = (
        len(ext) == 1
        and len(page) == 0
        and DECORATED.match(ext[0]["value"]) is not None
        and DECORATED.match(ext[0]["value"]).group(2) == "Orchestrator"
    )
    check(
        "load: exactly 1 extension write, decorated",
        ok,
        "writes=%s" % [(e["origin"], e["value"]) for e in load_seg],
    )

    for k in (1, 2, 3):
        end = "nav-%d" % (k + 1) if k < 3 else "navs-done"
        seg = segment(log, "nav-%d" % k, end)
        ok = (
            len(seg) == 2
            and seg[0]["origin"] == "page"
            and seg[0]["value"] == "Route %d" % k
            and seg[1]["origin"] == "extension"
            and DECORATED.match(seg[1]["value"]) is not None
            and DECORATED.match(seg[1]["value"]).group(2) == "Route %d" % k
        )
        check(
            "nav %d: exactly 2 writes (page, then extension)" % k,
            ok,
            "writes=%s" % [(e["origin"], e["value"]) for e in seg],
        )

    rest_seg = segment(log, "rest", "rest-done")
    check(
        "rest: 0 writes across 50 head mutations",
        len(rest_seg) == 0,
        "writes=%s" % [(e["origin"], e["value"]) for e in rest_seg],
    )

    shift_seg = segment(log, "shift", "shift-done")
    check(
        "shift: 0 writes on the unshifted orchestrator",
        len(shift_seg) == 0,
        "writes=%s" % [(e["origin"], e["value"]) for e in shift_seg],
    )

    obs = latest("observer")
    if obs is None:
        check("shift: observer reported", False, "no observer report")
    else:
        olog = writes(obs["log"])
        ext = [e for e in olog if e["origin"] == "extension"]
        page = [e for e in olog if e["origin"] == "page"]
        indexes = [
            int(m.group(1))
            for e in ext
            if (m := DECORATED.match(e["value"])) and m.group(2) == "Observer"
        ]
        ok = (
            len(page) == 0
            and len(ext) == 3
            and len(indexes) == 3
            and indexes[1] == indexes[0] - 1
            and indexes[2] == indexes[1] - 1
        )
        check(
            "shift: observer wrote exactly once per index shift (-1 each)",
            ok,
            "extension writes=%s page writes=%d"
            % ([e["value"] for e in ext], len(page)),
        )

    titles = []
    for load in (2, 3, 4):
        rep = latest("orchestrator", phase="reload-%d" % load, load=load)
        if rep is None:
            check("reload %d: reported" % load, False, "no report")
            continue
        ext = [e for e in writes(rep["log"]) if e["origin"] == "extension"]
        ok = len(ext) == 1 and DECORATED.match(rep["title"]) is not None
        check(
            "reload %d: exactly 1 extension write, decorated" % load,
            ok,
            "title=%r writes=%d" % (rep["title"], len(ext)),
        )
        titles.append(rep["title"])
    check(
        "reload: titles byte-identical across 3 reloads (no accumulation)",
        len(titles) == 3 and len(set(titles)) == 1,
        "titles=%s" % titles,
    )

    all_logs = [writes(log)]
    if obs is not None:
        all_logs.append(writes(obs["log"]))
    echo = osc = accum = 0
    for wlog in all_logs:
        for i, e in enumerate(wlog):
            if i >= 1 and e["value"] == wlog[i - 1]["value"]:
                echo += 1
            if (
                i >= 2
                and e["value"] == wlog[i - 2]["value"]
                and e["value"] != wlog[i - 1]["value"]
                and e["ms"] - wlog[i - 2]["ms"] < 500
            ):
                osc += 1
            if e["value"].count(" [") > 1 or re.match(r"^\d+ \d+ ", e["value"]):
                accum += 1
    check("echo: 0 adjacent duplicate writes", echo == 0, "echo=%d" % echo)
    check("oscillation: 0 A-B-A flips inside 500ms", osc == 0, "count=%d" % osc)
    check("accumulation: 0 doubled prefixes/suffixes", accum == 0, "count=%d" % accum)

    return checks


def build_old_profile(old_dir, profile):
    """Sideload the signed legacy XPIs into a fresh profile."""
    ext_dir = profile / "extensions"
    ext_dir.mkdir(parents=True)
    for xpi in sorted(Path(old_dir).glob("*.xpi")):
        with zipfile.ZipFile(xpi) as z:
            manifest = json.loads(z.read("manifest.json"))
            gecko = manifest.get("browser_specific_settings") or manifest.get(
                "applications"
            )
            if gecko is not None:
                addon_id = gecko["gecko"]["id"]
            else:
                # An AMO-assigned id lives in the signature cert's CN.
                certs = subprocess.run(
                    ["openssl", "pkcs7", "-inform", "DER", "-print_certs"],
                    input=z.read("META-INF/mozilla.rsa"),
                    capture_output=True,
                    check=True,
                ).stdout.decode(errors="replace")
                match = re.search(r"CN\s*=\s*(\{[0-9a-fA-F-]+\}|[^,\s/]+@[^,\s/]+)", certs)
                if match is None:
                    raise SystemExit("no addon id found in %s" % xpi)
                addon_id = match.group(1)
        shutil.copy(xpi, ext_dir / ("%s.xpi" % addon_id))
        print("sideloaded %s as %s" % (xpi.name, addon_id))
    (profile / "user.js").write_text(
        "\n".join(
            'user_pref("%s", %s);' % (k, json.dumps(v))
            for k, v in {
                "extensions.autoDisableScopes": 0,
                "extensions.enabledScopes": 15,
                "browser.tabs.insertRelatedAfterCurrent": False,
                "dom.disable_open_during_load": False,
                "browser.link.open_newwindow": 3,
                "browser.shell.checkDefaultBrowser": False,
                "browser.sessionstore.resume_from_crash": False,
                "datareporting.policy.dataSubmissionEnabled": False,
                "toolkit.telemetry.enabled": False,
                "browser.aboutwelcome.enabled": False,
                "browser.startup.homepage_override.mstone": "ignore",
            }.items()
        )
        + "\n"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true", help="show the browser")
    parser.add_argument(
        "--old",
        metavar="DIR",
        help="RED mode: sideload legacy *.xpi from DIR instead of ephemeris",
    )
    parser.add_argument(
        "--firefox",
        metavar="BINARY",
        help="Firefox binary to launch (default: web-ext discovery / PATH)",
    )
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/index.html" % port
    print("collector serving %s" % url)

    tmp = Path(tempfile.mkdtemp(prefix="ephemeris-verify-"))
    try:
        if args.old:
            profile = tmp / "profile"
            build_old_profile(args.old, profile)
            binary = args.firefox or "firefox"
            cmd = [binary, "-no-remote", "-profile", str(profile), url]
            if not args.headed:
                cmd.insert(1, "-headless")
        else:
            cmd = [
                "npx",
                "web-ext",
                "run",
                "--source-dir=%s" % REPO_DIR,
                "--no-input",
                "--no-reload",
                "--start-url=%s" % url,
                "--pref=browser.tabs.insertRelatedAfterCurrent=false",
                "--pref=dom.disable_open_during_load=false",
            ]
            if args.firefox:
                cmd.append("--firefox=%s" % args.firefox)
            if not args.headed:
                cmd.append("--arg=-headless")
        browser_log = open(tmp / "browser.log", "w")
        proc = subprocess.Popen(
            cmd, cwd=REPO_DIR, stdout=browser_log, stderr=subprocess.STDOUT
        )

        finished = done_event.wait(timeout=150)
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()

        if not finished:
            print("FAIL: scenario did not finish inside 150s")
            with reports_lock:
                phases = [(r.get("role"), r.get("phase")) for r in reports]
            print("reports received: %s" % phases)
            print("browser log tail:")
            print("\n".join((tmp / "browser.log").read_text().splitlines()[-20:]))
            return 1

        checks = check_all()
        width = max(len(name) for name, _, _ in checks)
        failures = 0
        for name, ok, detail in checks:
            marker = "OK  " if ok else "FAIL"
            print("%s %-*s %s" % (marker, width, name, "" if ok else detail))
            if not ok:
                failures += 1
        print(
            "%d/%d checks passed%s"
            % (len(checks) - failures, len(checks), " - RED mode" if args.old else "")
        )
        if args.old:
            # RED mode demonstrates the legacy pair failing this same
            # harness: success = the failures actually showed up.
            return 0 if failures > 0 else 1
        return 0 if failures == 0 else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
