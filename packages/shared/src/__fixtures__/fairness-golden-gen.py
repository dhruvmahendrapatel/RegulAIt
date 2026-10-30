# ADR-0222: regenerates fairness-golden.json with fairlearn 0.13.0 (test-time only; never shipped).
# Run: pip install fairlearn==0.13.0 && python3 -I fairness-golden-gen.py > fairness-golden.json
import json, random
import fairlearn
from fairlearn.metrics import demographic_parity_difference as dpd, demographic_parity_ratio as dpr, equalized_odds_difference as eod, equal_opportunity_difference as eop
rng = random.Random(20261030)
rows = []
for i in range(240):
    sex = rng.choice(["female", "male"])
    band = rng.choice(["18-30", "31-50", "51+"])
    y = 1 if rng.random() < (0.45 if sex == "female" else 0.55) else 0
    bias = {"female": -0.12, "male": 0.0}[sex] + {"18-30": 0.05, "31-50": 0.0, "51+": -0.08}[band]
    p = y if rng.random() < 0.8 else 1 - y
    if rng.random() < abs(bias):
        p = 1 if bias > 0 else 0
    rows.append({"sex": sex, "age_band": band, "label": y, "prediction": p})
y = [r["label"] for r in rows]; p = [r["prediction"] for r in rows]
out = {"fairlearn": fairlearn.__version__, "rows": rows, "expected": {}}
for a in ["sex", "age_band"]:
    s = [r[a] for r in rows]
    out["expected"][a] = {
        "demographic_parity_difference": dpd(y, p, sensitive_features=s),
        "disparate_impact_ratio": dpr(y, p, sensitive_features=s),
        "equal_opportunity_difference": eop(y, p, sensitive_features=s),
        "equalized_odds_difference": eod(y, p, sensitive_features=s),
    }
print(json.dumps(out, separators=(",", ":")))
