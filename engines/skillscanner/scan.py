# ADR-0242 — the skill-scanner driver. Runs Cisco skill-scanner on ONE agent skill (a directory holding SKILL.md
# and any bundled files) with ONLY its core local analyzers, built through skill-scanner's own
# `build_core_analyzers` (static signatures with the baked YARA-X rules, bytecode, pipeline taint, correlation).
# It never calls `build_analyzers`, so the LLM, meta, behavioural-LLM, VirusTotal, Cisco AI Defense, OSV,
# trigger and System One analyzers are never constructed.
#
#   python -I scan.py <skill-dir> <output-file>
#
# <output-file> receives a `regulait.admission-scan.v1` report: rule ids, severities, categories and file
# names only, never a snippet of the skill (the gateway already holds the text).
#
# Fail closed: an analyzer error, an unreadable skill, a rules digest that does not match the baked manifest,
# or any finding at an unknown severity makes the report `failed` and the process exit 2.
import hashlib
import json
import os
import sys

ENGINE = "skillscanner"
ENGINE_VERSION = "2.3.2"
SCHEMA = "regulait.admission-scan.v1"
# the signature packs skill-scanner itself loads (YARA-X rules, signature YAML, CEL gates), shipped inside its
# wheel and therefore inside this image; the digest below is over exactly the directory the scanner reads
RULES_DIR = os.environ.get("REGULAIT_SKILLSCANNER_RULES_DIR", "/opt/skillscanner/venv/lib/python3.12/site-packages/skill_scanner/data/packs")
RULES_MANIFEST = os.environ.get("REGULAIT_SKILLSCANNER_RULES_MANIFEST", "/opt/skillscanner/rules.sha256")
MAX_INPUT_BYTES = 8 * 1024 * 1024
EXPECTED_ANALYZERS = ["BytecodeAnalyzer", "CorrelationAnalyzer", "PipelineAnalyzer", "StaticAnalyzer"]

REMOTE_SWITCHES = (
    "SKILL_SCANNER_LLM_API_KEY",
    "SKILL_SCANNER_LLM_MODEL",
    "SKILL_SCANNER_LLM_BASE_URL",
    "SKILL_SCANNER_META_LLM_API_KEY",
    "SKILL_SCANNER_SYSTEM_ONE_ENDPOINT",
    "VIRUSTOTAL_API_KEY",
    "AI_DEFENSE_API_KEY",
    "AI_DEFENSE_API_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_OPENAI_API_KEY",
)
# ORT_DISABLE_TELEMETRY: onnxruntime (under magika, the file-type check) otherwise writes a random device id and a
# session file under $HOME/.cache and /tmp on its first model load (measured in the 2.3.2 image)
OFFLINE_ENV = {"LITELLM_LOCAL_MODEL_COST_MAP": "True", "LITELLM_TELEMETRY": "False", "HF_HUB_OFFLINE": "1", "ORT_DISABLE_TELEMETRY": "1"}
SEVERITIES = {"INFO": "info", "LOW": "low", "MEDIUM": "medium", "HIGH": "high", "CRITICAL": "critical", "SAFE": "info"}


def rules_digest(rules_dir):
    h = hashlib.sha256()
    for root, dirs, files in os.walk(rules_dir):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for name in sorted(files):
            if name.endswith(".pyc"):
                continue
            p = os.path.join(root, name)
            with open(p, "rb") as f:
                h.update(os.path.relpath(p, rules_dir).encode() + b"\0" + hashlib.sha256(f.read()).hexdigest().encode() + b"\n")
    return h.hexdigest()


def failed(out_path, reason, extra=None):
    report = {"schema": SCHEMA, "engine": ENGINE, "engineVersion": ENGINE_VERSION, "status": "failed", "error": reason[:200]}
    report.update(extra or {})
    with open(out_path, "w") as f:
        json.dump(report, f)
    sys.exit(2)


def use_writable_tempdir(out_path):
    """a read-only sandbox may have no /tmp: the output directory, which the sandbox must give us anyway, serves then"""
    import tempfile

    try:
        tempfile.gettempdir()
    except FileNotFoundError:
        os.environ["TMPDIR"] = os.path.dirname(os.path.abspath(out_path))
        tempfile.tempdir = None


def slug(text):
    return "".join(c if c.isalnum() else "_" for c in str(text).strip().lower()).strip("_")[:64] or "unnamed"


def value(x):
    return getattr(x, "value", x)


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: scan.py <skill-dir> <output-file>\n")
        sys.exit(64)
    skill_dir, out_path = argv[1], argv[2]
    present = [k for k in REMOTE_SWITCHES if os.environ.get(k)]
    if present:
        failed(out_path, "remote analyzer switch set: " + ",".join(present))
    for k, v in OFFLINE_ENV.items():
        os.environ[k] = v
    try:
        with open(RULES_MANIFEST) as f:
            expected = f.read().split()[0]
        actual = rules_digest(RULES_DIR)
    except OSError as e:
        failed(out_path, f"rules unreadable: {type(e).__name__}")
    if actual != expected:
        failed(out_path, "rules digest mismatch", {"rulesSha256": actual})
    if not os.path.isfile(os.path.join(skill_dir, "SKILL.md")):
        failed(out_path, "no SKILL.md", {"rulesSha256": actual})
    total = 0
    for root, _dirs, files in os.walk(skill_dir):
        for name in files:
            total += os.path.getsize(os.path.join(root, name))
    if total > MAX_INPUT_BYTES:
        failed(out_path, "skill over the input limit", {"rulesSha256": actual})

    use_writable_tempdir(out_path)
    try:
        from skill_scanner.core.analyzer_factory import build_core_analyzers
        from skill_scanner.core.scan_policy import ScanPolicy
        from skill_scanner.core.scanner import SkillScanner

        policy = ScanPolicy.default()
        analyzers = build_core_analyzers(policy)
        built = sorted(type(a).__name__ for a in analyzers)
        if built != EXPECTED_ANALYZERS:
            failed(out_path, "unexpected analyzer set: " + ",".join(built), {"rulesSha256": actual})
        with SkillScanner(analyzers=analyzers, policy=policy) as scanner:
            result = scanner.scan_skill(skill_dir)
    except SystemExit:
        raise
    except Exception as e:  # an engine crash is never a pass
        failed(out_path, f"scan raised {type(e).__name__}", {"rulesSha256": actual})

    # no remote client may have been imported along the way (they are hard dependencies upstream, never used here)
    leaked = [m for m in ("litellm", "openai", "anthropic") if m in sys.modules]
    if leaked:
        failed(out_path, "remote client imported: " + ",".join(leaked), {"rulesSha256": actual})

    try:
        data = result_dict(result)
    except Exception as e:  # no to_dict, or it raised: never an empty pass
        failed(out_path, f"scan result did not serialise: {type(e).__name__}", {"rulesSha256": actual})
    report = summarise(data, actual)
    with open(out_path, "w") as f:
        json.dump(report, f)
    sys.exit(0 if report["status"] == "completed" else 2)


# The analyzer names skill-scanner 2.3.2 reports in `analyzers_used` for the core set, slugged; the gateway pins the
# same list (ADR-0242 §4, packages/shared/src/engines/admission-scan.ts).
EXPECTED_ANALYZERS_USED = ["static_analyzer", "bytecode", "pipeline", "correlation"]


def result_dict(result):
    """the scan result as a dict; raises when skill-scanner's result has no to_dict or does not return a dict"""
    to_dict = getattr(result, "to_dict", None)
    if not callable(to_dict):
        raise TypeError("scan result has no to_dict")
    data = to_dict()
    if not isinstance(data, dict):
        raise TypeError("to_dict did not return an object")
    return data


def summarise(data, rules_sha256):
    """skill-scanner's ScanResult.to_dict() -> a regulait.admission-scan.v1 report. Pure, so the image build can test it
    on recorded and crafted results (selftest.py). Fail closed on every failure signal skill-scanner 2.3.2 records:
    the top-level `analyzers_failed` list (strict-load fallback, rule-contract and analyzer `last_error` failures),
    `scan_metadata.rule_contract.status` other than "passed" (or missing), the older `scan_metadata` error keys, an
    unknown severity, and an analyzer set other than the core one."""
    reasons = []
    if not isinstance(data, dict):
        data = {}
        reasons.append("result is not an object")
    findings = []
    for f in data.get("findings") or []:
        if not isinstance(f, dict):
            reasons.append("finding is not an object")
            continue
        sev = SEVERITIES.get(str(value(f.get("severity", ""))).upper())
        if sev is None:
            reasons.append("finding at an unknown severity")
            continue
        findings.append(
            {
                "rule": f"{ENGINE}.{slug(f.get('rule_id'))}",
                "severity": sev,
                "kind": slug(value(f.get("category") or "unknown")),
                "name": str(f.get("file_path") or "SKILL.md")[:256],
            }
        )
    if data.get("analyzers_failed"):
        reasons.append("analyzers_failed is not empty")
    meta = data.get("scan_metadata")
    if not isinstance(meta, dict):
        meta = {}
        reasons.append("no scan_metadata")
    contract = meta.get("rule_contract")
    if not isinstance(contract, dict) or contract.get("status") != "passed":
        reasons.append("rule_contract did not pass")
    for key in ("analyzer_errors", "errors"):
        if meta.get(key):
            reasons.append(f"scan_metadata.{key} is not empty")
    used = [slug(a) for a in data.get("analyzers_used") or []]
    if sorted(used) != sorted(EXPECTED_ANALYZERS_USED):
        reasons.append("unexpected analyzers_used")
    ok = not reasons
    report = {
        "schema": SCHEMA,
        "engine": ENGINE,
        "engineVersion": ENGINE_VERSION,
        "status": "completed" if ok else "failed",
        "analyzers": used,
        "rulesSha256": rules_sha256,
        "items": [{"kind": "skill", "name": "SKILL.md", "status": "completed" if ok else "failed"}],
        "findings": findings,
    }
    if not ok:
        report["error"] = ("; ".join(reasons))[:200]
    return report


if __name__ == "__main__":
    main(sys.argv)
