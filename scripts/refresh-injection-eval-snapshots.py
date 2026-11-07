#!/usr/bin/env python3
"""ADR-0244 (P25): refresh the vendored prompt-injection evaluation snapshots.

A DEVELOPER tool, like `refresh-framework-imports.mjs` (ADR-0215). The product and
CI never download: they read the snapshots this script writes to
`packages/shared/src/eval-datasets/vendor/injection-baselines/`. Run it, read the
diff, run the baseline (`node scripts/injection-eval-baseline.mjs`), commit.

    python3 -I scripts/refresh-injection-eval-snapshots.py               # fetch the pinned commits with git
    python3 -I scripts/refresh-injection-eval-snapshots.py --from <dir>  # air-gapped: <dir>/<repo-name> checkouts

Standard library only, and NO upstream code is executed. AgentDojo's tasks are
Python classes; they are read with `ast` and a small evaluator that accepts only
string constants, f-strings over names already resolved, and string `+`.
Anything else fails the refresh (fail closed) instead of being guessed.

To move to a newer upstream revision: change its `commit` below, run this, read
the diff and the new baseline numbers, and update ADR-0244 and THIRD_PARTY.md.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "packages/shared/src/eval-datasets/vendor/injection-baselines"

#: recorded in MANIFEST.json; changing it changes the InjecAgent sample
SEED = 20261107
#: InjecAgent cases kept per stratum (kind x setting x attack type: 12 strata)
INJECAGENT_PER_STRATUM = 25
#: JailbreakBench attack prompts kept per attack method (5 methods)
JBB_PER_METHOD = 30

SOURCES = {
    "notinject": {
        "title": "NotInject (InjecGuard / PIGuard)",
        "repo": "leolee99/PIGuard",
        "commit": "1b5751e88bf7475acbedfc8eda795ce060307c84",
        "licence": "MIT",
        "licenceFile": "LICENSE",
        "copyright": "Copyright (c) 2024 Hao Li",
    },
    "injecagent": {
        "title": "InjecAgent",
        "repo": "uiuc-kang-lab/InjecAgent",
        "commit": "f19c9f2c79a41046eb13c03c51a24c567a8ffa07",
        "licence": "MIT",
        "licenceFile": "LICENCE",
        "copyright": "Copyright (c) 2023 Qiusi Zhan",
    },
    "jailbreakbench": {
        "title": "JailbreakBench (artifacts and JBB-Behaviors)",
        "repo": "JailbreakBench/artifacts",
        "commit": "909e68c01d94222b8ad2e397a017e2e12e2adb73",
        "licence": "MIT",
        "licenceFile": "LICENSE",
        "copyright": "Copyright (c) 2024 JailbreakBench Team and artifacts authors",
        # the benign behaviours come from the Hugging Face dataset repository, also MIT (its own LICENSE file)
        "second": {
            "url": "https://huggingface.co/datasets/JailbreakBench/JBB-Behaviors",
            "dir": "JBB-Behaviors",
            "commit": "886acc352a31533ffbcf4ef22c744658688086fc",
            "licenceFile": "LICENSE",
            "copyright": "Copyright (c) 2023 JailbreakBench Team",
        },
    },
    "agentdojo": {
        "title": "AgentDojo (benchmark v1)",
        "repo": "ethz-spylab/agentdojo",
        "commit": "089ed468cf3ed0322acc66b0211f26d9d90dbf60",
        "licence": "MIT",
        "licenceFile": "LICENSE",
        "copyright": "Copyright (c) 2024 Edoardo Debenedetti, Jie Zhang, Mislav Balunovic, Luca Beurer-Kellner, Marc Fischer, and Florian Tramer",
    },
}

#: checked and left out; the manifest carries the reason so the gap stays visible
EXCLUDED = [
    {
        "id": "wasp",
        "title": "WASP (Web Agent Security against Prompt injection)",
        "upstream": "github.com/facebookresearch/wasp; arXiv:2504.18575",
        "licence": "CC BY-NC 4.0",
        "reason": (
            "Non-commercial licence, outside ADR-0176. No WASP data, prompt or template is vendored, copied, translated "
            "or paraphrased; only its published security-violation category names are cited, to organise the original "
            "regulait-web-agent scenarios."
        ),
    },
    {
        "id": "hackaprompt",
        "title": "HackAPrompt",
        "upstream": "huggingface.co/datasets/hackaprompt/hackaprompt-dataset (revision 25b87fbedfb86840abaf8cd09af7a029208a971a)",
        "licence": "MIT (dataset card, cardData.license)",
        "reason": (
            "Gated (auto-approval): the files are served only to a Hugging Face account that has accepted the gate, "
            "which asks the account to share its username and email. The card states MIT and the gate page shows no "
            "redistribution term, so vendoring is allowed by the licence, but no account holding that acceptance is "
            "available to this build. Not vendored until the owner accepts the gate and a refresh runs with --from."
        ),
    }
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checkout(repo: str, commit: str, src: Path | None, tmp: Path, url: str | None = None, name: str | None = None) -> Path:
    """a checkout of `repo` at exactly `commit` (fetched, or read from --from)"""
    name = name or repo.split("/")[1]
    if src is not None:
        d = src / name
        head = subprocess.run(["git", "-C", str(d), "rev-parse", "HEAD"], capture_output=True, text=True, check=True)
        if head.stdout.strip() != commit:
            sys.exit(f"{d} is at {head.stdout.strip()}, the pin is {commit}")
        return d
    d = tmp / name
    subprocess.run(["git", "init", "-q", str(d)], check=True)
    subprocess.run(["git", "-C", str(d), "fetch", "-q", "--depth", "1", url or f"https://github.com/{repo}.git", commit], check=True)
    subprocess.run(["git", "-C", str(d), "checkout", "-q", "FETCH_HEAD"], check=True)
    return d


def norm_text(s: str) -> str:
    return s.replace("\r\n", "\n")


# ---------------------------------------------------------------- NotInject
def build_notinject(d: Path) -> list[dict]:
    cases = []
    for n, part in ((1, "one"), (2, "two"), (3, "three")):
        rows = json.loads((d / f"datasets/NotInject_{part}.json").read_text("utf-8"))
        for i, r in enumerate(rows):
            if not isinstance(r.get("prompt"), str) or not isinstance(r.get("category"), str):
                sys.exit(f"NotInject_{part}[{i}]: unexpected record shape")
            cases.append(
                {
                    "id": f"notinject/{part}/{i:03d}",
                    "label": "benign",
                    "stratum": f"trigger_words_{n}/{r['category']}",
                    "text": norm_text(r["prompt"]),
                }
            )
    return cases


# --------------------------------------------------------------- InjecAgent
def build_injecagent(d: Path) -> tuple[list[dict], dict]:
    by_stratum: dict[str, list[dict]] = {}
    total = 0
    for kind in ("dh", "ds"):
        for setting in ("base", "enhanced"):
            rows = json.loads((d / f"data/test_cases_{kind}_{setting}.json").read_text("utf-8"))
            for i, r in enumerate(rows):
                total += 1
                text = r.get("Tool Response")
                if not isinstance(text, str) or not isinstance(r.get("Attack Type"), str):
                    sys.exit(f"InjecAgent {kind}_{setting}[{i}]: unexpected record shape")
                stratum = f"{kind}/{setting}/{r['Attack Type']}"
                by_stratum.setdefault(stratum, []).append(
                    {"id": f"injecagent/{kind}_{setting}/{i:04d}", "label": "injection", "stratum": stratum, "text": norm_text(text)}
                )
    rng = random.Random(SEED)
    cases = []
    for stratum in sorted(by_stratum):
        pool = by_stratum[stratum]
        k = min(INJECAGENT_PER_STRATUM, len(pool))
        picked = sorted(rng.sample(range(len(pool)), k))
        cases.extend(pool[j] for j in picked)
    sampling = {
        "method": "stratified random sample without replacement (Python random.Random(seed).sample per stratum, strata sorted by name)",
        "seed": SEED,
        "strata": "kind (dh direct harm, ds data stealing) x setting (base, enhanced) x attack type",
        "perStratum": INJECAGENT_PER_STRATUM,
        "population": total,
        "populationPerStratum": {s: len(v) for s, v in sorted(by_stratum.items())},
        "textField": "Tool Response (the tool output carrying the attacker instruction, what the agent reads next)",
    }
    return cases, sampling


# ----------------------------------------------------------- JailbreakBench
JBB_METHODS = ("DSN", "GCG", "JBC", "PAIR", "prompt_with_random_search")


def build_jailbreakbench(artifacts: Path, behaviors: Path) -> tuple[list[dict], dict]:
    """attack prompts only (never the model responses), deduplicated, sampled per method;
    and every benign behaviour. The plain harmful goals are not used: they are harmful
    requests, not injected or adversarial text."""
    by_method: dict[str, dict[str, dict]] = {m: {} for m in JBB_METHODS}
    population = 0
    for f in sorted((artifacts / "attack-artifacts").glob("*/*/*.json")):
        method = f.parts[-3]
        if method not in by_method:
            continue  # test-artifact and anything new is left out until reviewed
        doc = json.loads(f.read_text("utf-8"))
        for j in doc["jailbreaks"]:
            prompt = j.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                continue  # not submitted for this behaviour
            population += 1
            text = norm_text(prompt)
            key = hashlib.sha256(text.encode()).hexdigest()
            if key not in by_method[method]:
                model = f.stem
                by_method[method][key] = {
                    "id": f"jailbreakbench/{method}/{f.parts[-2]}/{model}/{int(j['index']):03d}",
                    "label": "injection",
                    "stratum": f"attack/{method}",
                    "text": text,
                }
    rng = random.Random(SEED)
    cases: list[dict] = []
    for method in JBB_METHODS:
        pool = sorted(by_method[method].values(), key=lambda c: c["id"])
        k = min(JBB_PER_METHOD, len(pool))
        cases.extend(pool[i] for i in sorted(rng.sample(range(len(pool)), k)))
    import csv

    with open(behaviors / "data/benign-behaviors.csv", newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            cases.append(
                {
                    "id": f"jailbreakbench/benign/{int(r['Index']):03d}",
                    "label": "benign",
                    "stratum": f"benign/{r['Category']}",
                    "text": norm_text(r["Goal"]),
                }
            )
    sampling = {
        "method": "attack prompts: deduplicated by text per method, then Python random.Random(seed).sample per method (pool sorted by id); benign: complete",
        "seed": SEED,
        "perMethod": JBB_PER_METHOD,
        "methods": list(JBB_METHODS),
        "population": population,
        "uniquePerMethod": {m: len(v) for m, v in by_method.items()},
        "injection": "the adversarial prompt each attack submitted (field `prompt`); model responses are never read into the snapshot. Label `injection` here means an adversarial jailbreak prompt.",
        "benign": "the 100 JBB-Behaviors benign behaviours (topic-matched to the harmful ones), the over-refusal counterweight",
        "notUsed": "the 100 plain harmful goals (harmful requests, not adversarial text) and the test-artifact directory",
    }
    return cases, sampling


# ---------------------------------------------------------------- AgentDojo
class Unsupported(Exception):
    pass


def eval_str(node: ast.AST, scope: dict) -> str:
    """string constants, f-strings over known names, and string `+`; nothing else"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name) and isinstance(scope.get(node.id), str):
        return scope[node.id]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return eval_str(node.left, scope) + eval_str(node.right, scope)
    if isinstance(node, ast.JoinedStr):
        out = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                out.append(str(v.value))
            elif isinstance(v, ast.FormattedValue) and v.format_spec is None and v.conversion == -1:
                out.append(eval_value(v.value, scope))
            else:
                raise Unsupported(ast.dump(v)[:120])
        return "".join(out)
    raise Unsupported(ast.dump(node)[:120])


def eval_list(node: ast.AST, scope: dict) -> list[str]:
    """a list of strings: a literal, or a name already resolved to one"""
    if isinstance(node, ast.List):
        return [eval_str(e, scope) for e in node.elts]
    if isinstance(node, ast.Name) and isinstance(scope.get(node.id), list):
        return scope[node.id]
    raise Unsupported(ast.dump(node)[:120])


def eval_value(node: ast.AST, scope: dict) -> str:
    """a value inside an f-string: a resolved name, a number, or `"sep".join(<list of strings>)`"""
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float)):
        return str(node.value)
    if isinstance(node, ast.Name) and isinstance(scope.get(node.id), str):
        return scope[node.id]
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "join"
        and isinstance(node.func.value, ast.Constant)
        and isinstance(node.func.value.value, str)
        and len(node.args) == 1
        and not node.keywords
    ):
        return node.func.value.value.join(eval_list(node.args[0], scope))
    raise Unsupported(ast.dump(node)[:120])


def module_scope(tree: ast.Module) -> dict[str, str]:
    scope: dict[str, str] = {}
    for st in tree.body:
        if isinstance(st, (ast.Assign, ast.AnnAssign)):
            targets = st.targets if isinstance(st, ast.Assign) else [st.target]
            if st.value is None or len(targets) != 1 or not isinstance(targets[0], ast.Name):
                continue
            try:
                scope[targets[0].id] = eval_str(st.value, scope)
            except Unsupported:
                pass
    return scope


def class_strings(cls: ast.ClassDef, base: dict) -> dict:
    """the class-body string attributes, in order (a later one may use an earlier one)"""
    scope = dict(base)
    for st in cls.body:
        if isinstance(st, (ast.Assign, ast.AnnAssign)):
            targets = st.targets if isinstance(st, ast.Assign) else [st.target]
            if st.value is None or len(targets) != 1 or not isinstance(targets[0], ast.Name):
                continue
            try:
                scope[targets[0].id] = eval_list(st.value, scope) if isinstance(st.value, ast.List) else eval_str(st.value, scope)
            except Unsupported:
                if targets[0].id in ("PROMPT", "GOAL"):
                    raise
    return scope


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", re.sub(r"(\d+)$", r"_\1", name)).lower().replace("__", "_")


def decorated_with(cls: ast.ClassDef, method: str) -> bool:
    for dec in cls.decorator_list:
        if isinstance(dec, ast.Attribute) and dec.attr == method:
            return True
    return False


def suite_tasks(path: Path, method: str, field: str) -> dict[str, str]:
    tree = ast.parse(path.read_text("utf-8"))
    base = module_scope(tree)
    tasks: dict[str, str] = {}
    for st in tree.body:
        if isinstance(st, ast.ClassDef) and decorated_with(st, method):
            tasks[snake(st.name)] = class_strings(st, base)[field]
    if method == "register_user_task":
        # combined tasks: create_combined_task("Name", suite.user_tasks["a"], suite.user_tasks["b"], prompt=?)
        for st in tree.body:
            call = st.value if isinstance(st, ast.Expr) else None
            if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == "create_combined_task"):
                continue
            name = eval_str(call.args[0], {})
            refs = []
            for a in call.args[1:3]:
                if not (isinstance(a, ast.Subscript) and isinstance(a.slice, ast.Constant)):
                    raise Unsupported(ast.dump(a)[:120])
                refs.append(tasks[a.slice.value])
            prompt = None
            if len(call.args) > 3:
                prompt = eval_str(call.args[3], base)
            for kw in call.keywords:
                if kw.arg == "prompt":
                    prompt = eval_str(kw.value, base)
            if prompt is None:
                # task_suite/task_combinators.py, _create_combined_task
                prompt = f"Perform the following tasks in the order they are given: 1. {refs[0]} 2. {refs[1]}"
            tasks[snake(name)] = prompt
    return tasks


def attack_templates(d: Path) -> dict[str, str]:
    """the task-independent attack strings, read from the attack classes"""
    base = ast.parse((d / "src/agentdojo/attacks/base_attacks.py").read_text("utf-8"))
    defaults = module_scope(base)
    out: dict[str, str] = {}
    tree = ast.parse((d / "src/agentdojo/attacks/baseline_attacks.py").read_text("utf-8"))
    for cls in (n for n in tree.body if isinstance(n, ast.ClassDef)):
        attrs = class_strings(cls, {})
        name = attrs.get("name")
        if name not in ("direct", "ignore_previous", "system_message", "injecagent"):
            continue
        init = next(f for f in cls.body if isinstance(f, ast.FunctionDef) and f.name == "__init__")
        call = next(n for n in ast.walk(init) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "__init__")
        out[name] = eval_str(call.args[0], {})
    tree = ast.parse((d / "src/agentdojo/attacks/important_instructions_attacks.py").read_text("utf-8"))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ImportantInstructionsAttack")
    jb = class_strings(cls, {})["_JB_STRING"]
    # the `_no_names` variant: the upstream defaults, so no model or user name is invented here
    out["important_instructions_no_names"] = jb.replace("{user}", defaults["DEFAULT_USER_NAME"]).replace(
        "{model}", defaults["DEFAULT_MODEL_NAME"]
    )
    if set(out) != {"direct", "ignore_previous", "system_message", "injecagent", "important_instructions_no_names"}:
        sys.exit(f"AgentDojo attack templates changed: {sorted(out)}")
    return out


AGENTDOJO_EXPECTED = {  # benchmark v1: 97 user tasks, 27 injection tasks, 629 user x injection pairs
    "banking": (16, 9),
    "slack": (21, 5),
    "travel": (20, 7),
    "workspace": (40, 6),
}


def build_agentdojo(d: Path) -> tuple[list[dict], dict]:
    suites = d / "src/agentdojo/default_suites/v1"
    attacks = attack_templates(d)
    cases: list[dict] = []
    pairs = 0
    for suite, (n_user, n_inj) in AGENTDOJO_EXPECTED.items():
        users = suite_tasks(suites / suite / "user_tasks.py", "register_user_task", "PROMPT")
        injs = suite_tasks(suites / suite / "injection_tasks.py", "register_injection_task", "GOAL")
        if (len(users), len(injs)) != (n_user, n_inj):
            sys.exit(f"AgentDojo {suite}: {len(users)} user / {len(injs)} injection tasks, expected {n_user} / {n_inj}")
        pairs += len(users) * len(injs)
        for tid in sorted(users, key=lambda t: int(t.rsplit("_", 1)[1])):
            cases.append({"id": f"agentdojo/{suite}/{tid}", "label": "benign", "stratum": f"user_task/{suite}", "text": norm_text(users[tid])})
        for tid in sorted(injs, key=lambda t: int(t.rsplit("_", 1)[1])):
            for attack in sorted(attacks):
                text = attacks[attack].replace("{goal}", injs[tid])
                cases.append(
                    {"id": f"agentdojo/{suite}/{tid}/{attack}", "label": "injection", "stratum": f"{attack}/{suite}", "text": norm_text(text)}
                )
    if pairs != 629:
        sys.exit(f"AgentDojo v1 should have 629 injection cases, found {pairs}")
    sampling = {
        "method": "complete, no sampling",
        "benchmarkVersion": "v1 (97 user tasks, 27 injection tasks, 629 user x injection pairs)",
        "benign": "each user task's PROMPT (what the user asks the agent)",
        "injection": (
            "each injection task's GOAL wrapped in each task-independent attack template "
            "(direct, ignore_previous, system_message, injecagent, important_instructions_no_names). "
            "A text detector sees the same string for every user task an injection is paired with, so the 629 pairs "
            "reduce to 27 goals x 5 attacks = 135 distinct texts; the attacks that depend on the user task "
            "(tool_knowledge, the named important_instructions variants) are not included."
        ),
        "attackTemplates": attacks,
    }
    return cases, sampling


# ------------------------------------------------- our own web-agent scenarios
#: authored by RegulAIt in the vendor directory (not downloaded); this script only validates and pins it
OWN_ID = "regulait-web-agent"
#: the security-violation categories of WASP (Evtimov et al., arXiv:2504.18575, Table 5), cited by name only.
#: WASP is CC BY-NC, so none of its tasks, prompts or templates are used; every scenario is written fresh.
WASP_CATEGORIES = (
    "exfiltration", "data_destruction", "gaining_access", "access_removal", "impair_defenses",
    "execution", "phishing", "harassment", "misinformation", "snooping",
)
CARRIERS = ("page_text", "hidden_html", "form_field", "search_result", "tool_output")


def check_own() -> tuple[bytes, dict]:
    data = (OUT / f"{OWN_ID}.json").read_bytes()
    doc = json.loads(data)
    cases = doc.get("cases")
    if doc.get("source") != OWN_ID or not isinstance(cases, list):
        sys.exit(f"{OWN_ID}: unexpected file shape")
    want = {f"{c}/{v}" for c in WASP_CATEGORIES for v in CARRIERS} | {f"lookalike/{v}" for v in CARRIERS}
    for c in cases:
        if set(c) != {"id", "label", "stratum", "text"} or c["stratum"] not in want:
            sys.exit(f"{OWN_ID}: bad case {c.get('id')}")
        if (c["label"] == "benign") != c["stratum"].startswith("lookalike/"):
            sys.exit(f"{OWN_ID}: {c['id']} label does not match its stratum")
    if len({c["id"] for c in cases}) != len(cases) or {c["stratum"] for c in cases} != want:
        sys.exit(f"{OWN_ID}: duplicate ids or a category/carrier without a case")
    return data, {
        "method": "complete; original content written for RegulAIt (clean room)",
        "categories": "WASP security-violation categories (arXiv:2504.18575, Table 5), cited by name only",
        "carriers": list(CARRIERS),
        "benign": "look-alikes per carrier: help text, developer comments, form placeholders, search snippets and tool output using the same vocabulary",
    }


# ---------------------------------------------------------------- write
def write_json(path: Path, doc) -> bytes:
    data = (json.dumps(doc, ensure_ascii=False, indent=1) + "\n").encode("utf-8")
    path.write_bytes(data)
    return data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", type=Path, help="directory of checkouts named after each repo, at the pinned commits")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_sources = []
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        for sid, meta in SOURCES.items():
            d = checkout(meta["repo"], meta["commit"], args.src, tmp)
            sampling = {"method": "complete, no sampling"}
            second = meta.get("second")
            d2 = checkout("", second["commit"], args.src, tmp, url=second["url"], name=second["dir"]) if second else None
            if sid == "jailbreakbench":
                cases, sampling = build_jailbreakbench(d, d2)
            elif sid == "notinject":
                cases = build_notinject(d)
            elif sid == "injecagent":
                cases, sampling = build_injecagent(d)
            else:
                cases, sampling = build_agentdojo(d)
            ids = [c["id"] for c in cases]
            if len(set(ids)) != len(ids):
                sys.exit(f"{sid}: duplicate case ids")
            licence = (d / meta["licenceFile"]).read_bytes()
            (OUT / f"LICENSE-{sid}").write_bytes(licence)
            extra = {}
            if second:
                licence2 = (d2 / second["licenceFile"]).read_bytes()
                (OUT / f"LICENSE-{sid}-behaviors").write_bytes(licence2)
                extra = {
                    "second": {
                        "upstream": second["url"].removeprefix("https://"),
                        "commit": second["commit"],
                        "licence": "MIT",
                        "copyright": second["copyright"],
                        "licenceFile": f"LICENSE-{sid}-behaviors",
                        "licenceSha256": sha256(licence2),
                    }
                }
            data = write_json(OUT / f"{sid}.json", {"source": sid, "cases": cases})
            manifest_sources.append(
                {
                    "id": sid,
                    "title": meta["title"],
                    "upstream": f"github.com/{meta['repo']}",
                    "commit": meta["commit"],
                    "licence": meta["licence"],
                    "copyright": meta["copyright"],
                    "licenceFile": f"LICENSE-{sid}",
                    "licenceSha256": sha256(licence),
                    "file": f"{sid}.json",
                    "sha256": sha256(data),
                    "bytes": len(data),
                    "cases": len(cases),
                    "injection": sum(1 for c in cases if c["label"] == "injection"),
                    "benign": sum(1 for c in cases if c["label"] == "benign"),
                    "sampling": sampling,
                    **extra,
                }
            )
    data, sampling = check_own()
    cases = json.loads(data)["cases"]
    manifest_sources.append(
        {
            "id": OWN_ID,
            "title": "RegulAIt web-agent prompt-injection scenarios (original)",
            "upstream": "none: written for RegulAIt; categories cite WASP (arXiv:2504.18575) by name only, no WASP content",
            "commit": None,
            "licence": "LicenseRef-RegulAIt-Proprietary",
            "copyright": "Copyright (c) 2026 Dhruv Patel (the repository LICENSE)",
            "licenceFile": None,
            "licenceSha256": None,
            "file": f"{OWN_ID}.json",
            "sha256": sha256(data),
            "bytes": len(data),
            "cases": len(cases),
            "injection": sum(1 for c in cases if c["label"] == "injection"),
            "benign": sum(1 for c in cases if c["label"] == "benign"),
            "sampling": sampling,
        }
    )
    write_json(
        OUT / "MANIFEST.json",
        {
            "schema": "regulait.injection-eval-snapshots.v1",
            "note": "ADR-0244: written by scripts/refresh-injection-eval-snapshots.py; never edit by hand. The test rehashes every file against this manifest and the pins in injection-baselines.ts.",
            "seed": SEED,
            "sources": manifest_sources,
            "excluded": EXCLUDED,
        },
    )
    for s in manifest_sources:
        print(f"{s['id']:<18} {s['cases']:>4} cases ({s['injection']} injection, {s['benign']} benign)  {s['bytes']:>7} B  {s['sha256']}")


if __name__ == "__main__":
    os.umask(0o022)
    main()
