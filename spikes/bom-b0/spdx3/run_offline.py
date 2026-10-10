"""B0: run spdx3-validate 0.0.7's own checks (JSON schema + SHACL via pyshacl) with NO network.

spdx3-validate's CLI downloads the JSON schema and the SHACL model from spdx.org on every run
(`load_validation_data`, `urllib.request.urlopen`), and rdflib's JSON-LD parser fetches the
`@context` URL. That is unpinned content at run time and fails air-gapped. This driver uses the
library's public functions (`schema_validator`, `check_graph`, `SPDX_VERSIONS`) with the three
files vendored in ../schemas (sha256 recorded in R12), and parses the graph with the vendored
context substituted for the context URL (the URL is unchanged in the document itself).

Usage: python -I run_offline.py <spdx.json> [...]; exit 0 only if every document conforms.
A document named *.expect-fail.json must FAIL (negative control)."""
import json
import sys
from pathlib import Path

import rdflib
from spdx3_validate.core import check_graph, schema_validator
from spdx3_validate.spdx_versions import SPDX_VERSIONS

HERE = Path(__file__).resolve().parent
SCHEMAS = HERE.parent / "schemas"
VERSION = next(v for v in SPDX_VERSIONS if v.pretty == "3.0.1")

schema = json.loads((SCHEMAS / "spdx-3.0.1-json-schema.json").read_text("utf-8"))
context = json.loads((SCHEMAS / "spdx-3.0.1-context.jsonld").read_text("utf-8"))
shacl = rdflib.Graph()
shacl.parse(str(SCHEMAS / "spdx-3.0.1-model.ttl"), format="turtle")
validator = schema_validator(schema)

failures = 0
for name in sys.argv[1:]:
    text = Path(name).read_text("utf-8")
    data = json.loads(text)
    assert data.get("@context") == VERSION.context_url, f"{name}: not an SPDX 3.0.1 document"
    schema_errors = [f"{e.json_path}: {e.message}"[:200] for e in validator.iter_errors(data)]
    local = dict(data)
    local["@context"] = context["@context"]
    graph = rdflib.Graph()
    graph.parse(data=json.dumps(local), format="json-ld")
    shacl_errors = check_graph(graph, shacl, VERSION, True)
    ok = not schema_errors and not shacl_errors
    expect_fail = name.endswith(".expect-fail.json")
    verdict = "PASS" if ok != expect_fail else "UNEXPECTED"
    if ok == expect_fail:
        failures += 1
    print(json.dumps({"file": Path(name).name, "triples": len(graph), "schemaErrors": len(schema_errors),
                      "shaclErrors": len(shacl_errors), "conforms": ok, "expectFail": expect_fail, "verdict": verdict}))
    for e in (schema_errors + shacl_errors)[:5]:
        print("   ", e.replace("\n", "\n    ")[:600])
sys.exit(1 if failures else 0)
