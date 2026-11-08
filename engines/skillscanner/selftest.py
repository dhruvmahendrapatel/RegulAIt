# ADR-0242 — the skill-scanner driver's fail-closed self-test, run in the image build (no network) and by
# packages/shared/src/engines/admission-scan.test.ts when python3 is available. It feeds the driver's pure `summarise`
# step recorded skill-scanner 2.3.2 results (fixtures/results/clean.json, bad.json) and crafted failure results, and
# checks `result_dict` refuses a result with no usable to_dict.
#
#   python -I selftest.py <fixtures/results dir>
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scan  # noqa: E402  (the driver, next to this file)

DIGEST = "0" * 64
EXPECT = {
    "clean": ("completed", None),
    "bad": ("completed", None),
    "analyzers-failed": ("failed", "analyzers_failed is not empty"),
    "rule-contract-failed": ("failed", "rule_contract did not pass"),
    "rule-contract-missing": ("failed", "rule_contract did not pass"),
    "analyzers-empty": ("failed", "unexpected analyzers_used"),
}


def main(argv):
    d = argv[1]
    problems = []
    for name, (status, reason) in EXPECT.items():
        with open(os.path.join(d, f"{name}.json")) as f:
            r = scan.summarise(json.load(f), DIGEST)
        if r["status"] != status:
            problems.append(f"{name}: status {r['status']}, expected {status}")
        if reason and reason not in r.get("error", ""):
            problems.append(f"{name}: error {r.get('error')!r} does not name {reason!r}")
        if status == "failed" and r["items"][0]["status"] != "failed":
            problems.append(f"{name}: item not marked failed")
    bad = scan.summarise(json.load(open(os.path.join(d, "bad.json"))), DIGEST)
    if not any(f["severity"] in ("high", "critical") for f in bad["findings"]):
        problems.append("bad: no high or critical finding")

    class NoToDict:
        pass

    class BadToDict:
        def to_dict(self):
            return ["not", "a", "dict"]

    for label, obj in (("no to_dict", NoToDict()), ("to_dict not a dict", BadToDict())):
        try:
            scan.result_dict(obj)
            problems.append(f"result_dict accepted a result with {label}")
        except TypeError:
            pass
    if scan.summarise(None, DIGEST)["status"] != "failed":
        problems.append("summarise(None) did not fail")
    if problems:
        sys.stderr.write("\n".join(problems) + "\n")
        sys.exit(1)
    print(f"skillscanner driver self-test: {len(EXPECT) + 3} cases passed")


if __name__ == "__main__":
    main(sys.argv)
