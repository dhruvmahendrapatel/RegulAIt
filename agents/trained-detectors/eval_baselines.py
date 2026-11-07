#!/usr/bin/env python3
"""ADR-0244 (P25): measure the trained prompt-injection classifier offline.

Runs the same model, windowing and score reduction the service uses
(``server.load_models`` and ``detector_core.score_injection``) over the
vendored injection snapshots, and writes the ``trained_prompt_injection``
entry of ``injection-baselines.expected.json``. The image is about 2 GB and
not built in CI (ADR-0220 §8), so these numbers are recorded, not gated:
re-run this after any change to the model pin, the windowing or the default
threshold, and commit the diff with the ADR.

    DETECTOR_MODELS_DIR=<dir with prompt-injection/> python3 eval_baselines.py [--threshold 0.5] [--write]

``MODELS_DIR`` is the directory ``fetch_models.py`` fills (sha256-checked);
loading is ``local_files_only``, so nothing is downloaded here. Offline.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import detector_core  # noqa: E402
import server  # noqa: E402

ROOT = HERE.parent.parent
DATA = ROOT / "packages/shared/src/eval-datasets"
VENDOR = DATA / "vendor/injection-baselines"
EXPECTED = DATA / "injection-baselines.expected.json"
DATASETS = ("notinject", "injecagent", "agentdojo")


def ratio(num: int, den: int):
    return None if den == 0 else round(num / den, 4)


def metrics(m: dict) -> dict:
    return {
        **m,
        "precision": ratio(m["tp"], m["tp"] + m["fp"]),
        "recall": ratio(m["tp"], m["tp"] + m["fn"]),
        "fpr": ratio(m["fp"], m["fp"] + m["tn"]),
    }


def load_cases(sid: str, manifest: dict) -> list[dict]:
    entry = next(s for s in manifest["sources"] if s["id"] == sid)
    data = (VENDOR / entry["file"]).read_bytes()
    if hashlib.sha256(data).hexdigest() != entry["sha256"]:
        sys.exit(f"{sid}: snapshot does not match MANIFEST.json")
    return json.loads(data)["cases"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.5, help="the ADR-0220 default is 0.5")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()
    lock = json.loads((HERE / "models.lock.json").read_text("utf-8"))
    pin = next(m for m in lock["models"] if m["dir"] == "prompt-injection")
    classify = server.load_models(["prompt_injection"])["prompt_injection"]
    manifest = json.loads((VENDOR / "MANIFEST.json").read_text("utf-8"))

    per: dict = {}
    pooled = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    for sid in DATASETS:
        m = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
        for c in load_cases(sid, manifest):
            hit = detector_core.score_injection(c["text"], classify)["score"] >= args.threshold
            if c["label"] == "injection":
                m["tp" if hit else "fn"] += 1
            else:
                m["fp" if hit else "tn"] += 1
        per[sid] = metrics(m)
        for k in pooled:
            pooled[k] += m[k]
        print(sid, json.dumps(per[sid]))
    print("pooled", json.dumps(metrics(pooled)))

    if args.write:
        doc = json.loads(EXPECTED.read_text("utf-8"))
        doc["detectors"]["trained_prompt_injection"] = {
            "gated": False,
            "measuredWith": (
                f"agents/trained-detectors/eval_baselines.py: {pin['repo']}@{pin['revision']} through server.load_models and "
                "detector_core.score_injection (1,500-character windows, max score), CPU. Offline: the image is not built in CI."
            ),
            "threshold": args.threshold,
            "datasets": per,
            "pooled": metrics(pooled),
        }
        EXPECTED.write_text(json.dumps(doc, indent=2) + "\n", "utf-8")
        print(f"wrote {EXPECTED.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
