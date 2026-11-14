# ADR-0242 — the mcp-scanner driver. Runs Cisco mcp-scanner's STATIC (offline) mode on an MCP manifest with
# exactly two local analyzers: YARA (the rules baked into this image) and the schema-reference check. It never
# builds the Cisco AI Defense API analyzer, the LLM analyzer, the meta-analyzer, the VirusTotal analyzer, the
# behavioural analyzer or the vulnerable-package analyzer (pip-audit, which would reach PyPI and OSV).
#
#   python -I scan.py <input-dir> <output-file>
#
# <input-dir> holds any of tools.json, prompts.json, resources.json (MCP tools/list, prompts/list and
# resources/list results). <output-file> receives a `regulait.admission-scan.v1` report: counts, rule ids,
# severities and item names only, never a description or resource text (the gateway already holds those).
#
# Fail closed: any analyzer error, an unreadable input, a missing rule file or a rules digest that does not
# match the baked manifest makes the report `failed` and the process exit 2. The gateway treats a failed,
# missing or invalid report as not clean (ADR-0187 not-clean semantics).
import hashlib
import json
import os
import sys

ENGINE = "mcpscanner"
ENGINE_VERSION = "4.8.7"
ANALYZERS = ("yara", "schema")
SCHEMA = "regulait.admission-scan.v1"
RULES_DIR = os.environ.get("REGULAIT_MCPSCANNER_RULES_DIR", "/opt/mcpscanner/yara_rules")
RULES_MANIFEST = os.environ.get("REGULAIT_MCPSCANNER_RULES_MANIFEST", "/opt/mcpscanner/yara-rules.sha256")
MAX_INPUT_BYTES = 8 * 1024 * 1024

# Every credential or endpoint that would turn on a remote analyzer. The driver refuses to run when any is set,
# so a mis-set environment can never quietly add a cloud call (the analyzers are not built either way).
REMOTE_SWITCHES = (
    "MCP_SCANNER_API_KEY",
    "MCP_SCANNER_ENDPOINT",
    "MCP_SCANNER_LLM_API_KEY",
    "MCP_SCANNER_LLM_BASE_URL",
    "MCP_SCANNER_LLM_MODEL",
    "VIRUSTOTAL_API_KEY",
    "MCP_SCANNER_VIRUSTOTAL_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
)
# litellm (a hard upstream dependency, imported by mcpscanner's package root) fetches a remote model price map
# at import time unless told not to. Measured 2026-11-07: six AF_INET connect() calls without this, none with it.
OFFLINE_ENV = {"LITELLM_LOCAL_MODEL_COST_MAP": "True", "LITELLM_TELEMETRY": "False", "HF_HUB_OFFLINE": "1"}

SEVERITIES = {"SAFE": "none", "LOW": "low", "MEDIUM": "medium", "HIGH": "high", "CRITICAL": "critical", "UNKNOWN": "unknown"}


def rules_digest(rules_dir):
    h = hashlib.sha256()
    for name in sorted(os.listdir(rules_dir)):
        if not name.endswith((".yara", ".yar")):
            continue
        with open(os.path.join(rules_dir, name), "rb") as f:
            h.update(name.encode() + b"\0" + hashlib.sha256(f.read()).hexdigest().encode() + b"\n")
    return h.hexdigest()


def failed(out_path, reason, extra=None):
    report = {"schema": SCHEMA, "engine": ENGINE, "engineVersion": ENGINE_VERSION, "status": "failed", "error": reason[:200]}
    report.update(extra or {})
    with open(out_path, "w") as f:
        json.dump(report, f)
    sys.exit(2)


def use_writable_tempdir(out_path):
    """litellm (imported by mcpscanner's package root) asks for a temp dir at import. A read-only sandbox may have
    no /tmp: the output directory, which the sandbox must give us anyway, serves then."""
    import tempfile

    try:
        tempfile.gettempdir()
    except FileNotFoundError:
        os.environ["TMPDIR"] = os.path.dirname(os.path.abspath(out_path))
        tempfile.tempdir = None


def slug(text):
    return "".join(c if c.isalnum() else "_" for c in str(text).strip().lower()).strip("_")[:64] or "unnamed"


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: scan.py <input-dir> <output-file>\n")
        sys.exit(64)
    in_dir, out_path = argv[1], argv[2]
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

    inputs = {}
    for kind in ("tools", "prompts", "resources"):
        p = os.path.join(in_dir, f"{kind}.json")
        if os.path.exists(p):
            if os.path.getsize(p) > MAX_INPUT_BYTES:
                failed(out_path, f"{kind}.json over the input limit", {"rulesSha256": actual})
            inputs[kind] = p
    if not inputs:
        failed(out_path, "no input", {"rulesSha256": actual})

    import asyncio

    use_writable_tempdir(out_path)
    try:
        from mcpscanner.core.analyzers.schema_reference_analyzer import SchemaReferenceAnalyzer
        from mcpscanner.core.analyzers.static_analyzer import StaticAnalyzer
        from mcpscanner.core.analyzers.yara_analyzer import YaraAnalyzer

        analyzers = [YaraAnalyzer(rules_dir=RULES_DIR), SchemaReferenceAnalyzer()]
        static = StaticAnalyzer(analyzers=analyzers)
    except Exception as e:  # an engine that cannot start is never a pass
        failed(out_path, f"engine did not start: {type(e).__name__}", {"rulesSha256": actual})
    # fail closed: an analyzer set we cannot read is not the expected one
    built = sorted(type(a).__name__ for a in getattr(static, "analyzers", None) or [])
    if built != ["SchemaReferenceAnalyzer", "YaraAnalyzer"]:
        failed(out_path, "unexpected analyzer set", {"rulesSha256": actual})

    async def run():
        results = []
        if "tools" in inputs:
            results += [("tool", r.get("tool_name"), r) for r in await static.scan_tools_file(inputs["tools"])]
        if "prompts" in inputs:
            results += [("prompt", r.get("prompt_name"), r) for r in await static.scan_prompts_file(inputs["prompts"])]
        if "resources" in inputs:
            results += [("resource", r.get("resource_uri"), r) for r in await static.scan_resources_file(inputs["resources"])]
        return results

    try:
        results = asyncio.run(run())
    except Exception as e:  # an engine crash is never a pass
        failed(out_path, f"scan raised {type(e).__name__}", {"rulesSha256": actual})

    items, findings, errors = [], [], 0
    for kind, name, r in results:
        item_failed = r.get("status") != "completed" or bool(r.get("analyzer_errors"))
        errors += 1 if item_failed else 0
        items.append({"kind": kind, "name": str(name or "")[:256], "status": "failed" if item_failed else "completed"})
        for f in r.get("findings") or []:
            sev = SEVERITIES.get(str(getattr(f, "severity", "UNKNOWN")).upper(), "unknown")
            if sev == "none":
                continue
            if sev == "unknown":
                errors += 1
                continue
            taxonomy = getattr(f, "mcp_taxonomy", None) or {}
            ident = taxonomy.get("aisubtech") or taxonomy.get("aitech") or getattr(f, "threat_category", None)
            analyzer = slug(getattr(f, "analyzer", "unknown"))
            findings.append({"rule": f"{ENGINE}.{analyzer}.{slug(ident)}", "severity": sev, "kind": kind, "name": str(name or "")[:256]})
    report = {
        "schema": SCHEMA,
        "engine": ENGINE,
        "engineVersion": ENGINE_VERSION,
        "status": "failed" if errors else "completed",
        "analyzers": list(ANALYZERS),
        "rulesSha256": actual,
        "items": items,
        "findings": findings,
    }
    if errors:
        report["error"] = f"{errors} item(s) did not scan cleanly"
    with open(out_path, "w") as f:
        json.dump(report, f)
    sys.exit(2 if errors else 0)


if __name__ == "__main__":
    main(sys.argv)
