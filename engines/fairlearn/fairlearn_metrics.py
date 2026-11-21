# ADR-0346 — the fairlearn metric step of the fairness-evaluation engine. Run by the task (never the runner) as
#   /opt/fairlearn/venv/bin/python -I -B /opt/fairlearn/fairlearn_metrics.py < job.json > metrics.json
# Input (stdin, JSON): {"labels": [0|1, ...], "predictions": [0|1, ...], "attributes": {"<name>": ["<group>", ...]}}
#   every array the same length; the rows are the ones the gateway will also measure (unparseable replies and
#   suppressed groups already removed by the task, exactly as the gateway removes them).
# Output (stdout, JSON): {"fairlearn": "<version>", "attributes": {"<name>": {"<metric>": number | null}}}
#   null where fairlearn raised or returned a non-finite value; the gateway reads null as "not computable".
# Pure computation: no network, no file access beyond stdin/stdout, no pickle, no eval.
import json
import math
import sys

import fairlearn
from fairlearn.metrics import (
    demographic_parity_difference,
    demographic_parity_ratio,
    equal_opportunity_difference,
    equalized_odds_difference,
)

METRICS = {
    "demographic_parity_difference": demographic_parity_difference,
    "disparate_impact_ratio": demographic_parity_ratio,
    "equal_opportunity_difference": equal_opportunity_difference,
    "equalized_odds_difference": equalized_odds_difference,
}
MAX_ROWS = 100_000
MAX_ATTRIBUTES = 5


def fail(code):
    sys.stdout.write(json.dumps({"error": code}))
    sys.exit(2)


def binary(values):
    if not isinstance(values, list) or len(values) > MAX_ROWS or any(v not in (0, 1) or isinstance(v, bool) for v in values):
        fail("bad_outcomes")
    return values


def main():
    try:
        job = json.load(sys.stdin)
    except Exception:
        fail("bad_json")
    if not isinstance(job, dict):
        fail("bad_json")
    labels = binary(job.get("labels"))
    predictions = binary(job.get("predictions"))
    attributes = job.get("attributes")
    if len(labels) != len(predictions) or len(labels) == 0:
        fail("bad_lengths")
    if not isinstance(attributes, dict) or not 1 <= len(attributes) <= MAX_ATTRIBUTES:
        fail("bad_attributes")
    out = {}
    for name, groups in attributes.items():
        if not isinstance(name, str) or not isinstance(groups, list) or len(groups) != len(labels):
            fail("bad_attributes")
        if any(not isinstance(g, str) for g in groups):
            fail("bad_attributes")
        values = {}
        for metric, fn in METRICS.items():
            try:
                v = float(fn(labels, predictions, sensitive_features=groups))
                values[metric] = v if math.isfinite(v) else None
            except Exception:
                values[metric] = None
        out[name] = values
    sys.stdout.write(json.dumps({"fairlearn": fairlearn.__version__, "attributes": out}, separators=(",", ":")))


if __name__ == "__main__":
    main()
