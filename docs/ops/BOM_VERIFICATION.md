# Decision BOM and AI BOM verification, air-gapped and BYOC — runbook

**For an auditor** who has received a RegulAIt BOM bundle (`regulait.export-bundle/3`, subject `decision-bom` or
`ai-bom`) and must check it on a machine with **no network**, and for the **customer operator** who produces that
bundle in a BYOC or air-gapped deployment. ADR-0189 slice B8; the design is ADR-0189 §6 (verification, offline), §10
(air-gapped and BYOC fit), R19 (one verifier for both subjects) and B4.1 to B4.10 (the bundle and signature
specification).

> **M-041 status of this file.** Every command in a fenced block below was executed on 2026-10-16 at commit
> `6b35301` (Node 22.22.2, pnpm 10.34.5, CPython 3.11.15, OpenSSL 3.0.13, Linux x86_64), and the output shown is
> the real output, shortened only where marked `…`. The air-gapped steps (Part B) were executed inside
> `unshare --net` (a Linux network namespace with no interface but loopback), so nothing in them reached a network.
> The bundles verified were the specification's own TEST-ONLY vectors, not a bundle exported by a running
> deployment. Steps that need a running stack are listed under **Pending** with no command, because none has been
> run. Read that list before relying on this runbook for a real engagement.

## What a successful verification proves, and what it does not

`scripts/verify-bom.mjs` checks, with trust roots **you** supply out of band:

- the export key's signature over `manifest.json`, and that every file is listed, unaltered, and nothing extra is
  present;
- the receipt key's signature over the BOM body (`content/decision-bom.json` or `content/ai-bom.json`);
- for a Decision BOM: the decision receipt's signature and payload hash, that the receipt's `factsHash` is the
  facts in the body, that the body's sections re-derive from those facts, the hash-only audit-chain segment link by
  link, and the anchor and its RFC 3161 token when present;
- for an AI BOM: the serial number, `supersedes`, and that every carried CycloneDX or SPDX file is exactly the bytes
  the signed body commits to (`rendering_hashes`).

It prints a fixed **"This verification cannot prove"** list with every result. Read it: for example, it never proves
that the recorded facts were true, only that they were recorded and signed, and a `chain_signed` BOM has no external
commitment. The outcome is `VALID` (exit 0), `UNVERIFIABLE` (exit 3: evidence that should be there is missing),
`INVALID` (exit 1) or a usage refusal (exit 2). A check reported `unverifiable` "by design" (such as
`decision_content_binding: preimage_not_exported`, R39) does not lower a `VALID` outcome.

**The keys inside the bundle are never the trust root.** `signing-key.pub` and `receipt-keys.json` are convenience
copies; whoever forged a bundle would ship their own. Both verifiers refuse to run without a trust root you supply
(executed, Part B step 4).

## Who holds what

| Role | Holds | Hands over, out of band, once per engagement |
|---|---|---|
| Customer operator (control plane) | the export signing key (ADR-0116, `infra/export-keys/README.md`) and the receipt signing key (deploy-time, ADR-0186) | the export key fingerprint (`sha256:` + 64 hex), or its `<keyId>.pub`; the receipt keyring (`GET /v1/receipts/keys`, or `GET /v1/receipts/export`, which also carries `receiptV2FromAuditSeq`) |
| Auditor | the verifier kit (Part A) | nothing; the auditor only receives |

**BYOC.** The control plane builds and signs every BOM from control-plane records (ADR-0189 §10). Facts from an
execution plane arrive as ADR-0188 identity and grant ids, never as content, so a bundle respects the ADR-0015 data
boundary and can be carried across it. The signing keys are the customer's own deploy-time keys; no private key
leaves its plane, and the auditor never needs access to either plane: the bundle, the export fingerprint and the
receipt keyring are the whole input. Verification is therefore the same for BYOC, air-gapped and hosted installs.

**Air-gapped.** No BOM route makes an outbound call. The CycloneDX and SPDX schemas are bundled, never fetched. An
RFC 3161 timestamp exists only if the deployment has an internal TSA (ADR-0186 S); without one the anchor carries no
token and the verifier says so.

## Part A — prepare the verifier kit (once, on a connected staging machine)

The kit is a built checkout of the RegulAIt release whose bundles you will verify, plus a wheelhouse for the SPDX
SHACL validator. Pick a working directory for the evidence and tools:

```bash
# where: staging (connected). Run from the root of the checkout.
export WORK="${WORK:-$HOME/regulait-bom-audit}"   # keeps a WORK you have already chosen
mkdir -p "$WORK"
pnpm install --frozen-lockfile
pnpm -r build
```

Real output (the tail):

```text
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 1.1s using pnpm v10.34.5
…
apps/gateway build$ tsc -p tsconfig.json
apps/gateway build: Done
```

Download the SPDX validator's hash-locked closure (`spdx3-validate` 0.0.7, CI-only, never shipped; ADR-0189
amendment 4) so it can be installed with no network later:

```bash
# where: staging (connected)
python3 -m pip download --disable-pip-version-check --no-deps --require-hashes \
  -r scripts/spdx3/requirements.lock -d "$WORK/wheelhouse"
```

```text
…
Successfully downloaded attrs colorama halo html5rdf importlib_metadata jsonschema jsonschema-specifications log-symbols owlrl packaging prettytable pyparsing pyshacl rdflib referencing rpds-py six spdx3-validate spinners termcolor typing_extensions wcwidth zipp
```

The lock was resolved for CPython 3.11 on Linux x86_64. `halo` 0.0.31 arrives as a source archive; the offline
install below builds it with the `setuptools` that Python 3.11's `venv` bundles (79.0.1 here). On Python 3.12 or
later `venv` bundles no `setuptools`, so that install is **not verified** there.

Then move the checkout (with its `node_modules` and built `dist` directories) and `$WORK/wheelhouse` to the
air-gapped machine by your site's approved media process. **Pending:** packing and moving the kit was not executed
(see Pending).

## Part B — verify, on the air-gapped machine

All of Part B ran inside `unshare --net` from the root of the built checkout, with `WORK` set as in Part A.

### Step 1. Install the SPDX validator from the wheelhouse

```bash
# where: air-gapped
python3 -m venv "$WORK/spdx3-venv"
"$WORK/spdx3-venv/bin/pip" install --disable-pip-version-check --no-index --find-links "$WORK/wheelhouse" \
  --no-build-isolation --no-deps --require-hashes -r scripts/spdx3/requirements.lock
```

```text
…
Successfully built halo
…
Successfully installed attrs-26.1.0 colorama-0.4.6 halo-0.0.31 html5rdf-1.2.1 importlib_metadata-9.0.1 jsonschema-4.26.0 jsonschema-specifications-2025.9.1 log-symbols-0.0.14 owlrl-7.6.2 packaging-26.3 prettytable-3.18.0 pyparsing-3.3.3 pyshacl-0.40.1 rdflib-7.6.0 referencing-0.37.0 rpds-py-2026.9.1 six-1.17.0 spdx3-validate-0.0.7 spinners-0.0.24 termcolor-3.3.0 typing_extensions-4.16.0 wcwidth-0.9.2 zipp-4.1.1
```

`--no-build-isolation` is required offline: with build isolation pip tries to fetch `setuptools` for `halo` and,
with no index, fails (`pip subprocess to install build dependencies did not run successfully`; executed). Hashes
are still enforced for every package in the lock.

### Step 2. Prove the toolchain on known answers before trusting it

A verifier that accepts everything would also "verify" a forgery. Run it first on bundles whose answer is fixed by
the specification: the B4 vectors (`packages/shared/test-vectors/decision-bom/b4-vectors.json`, written from the
ADR text alone, ADR-0191 decision 4). `scripts/bom-vector-bundle.mjs` writes one vector as a real archive plus its
TEST-ONLY trust root, and refuses if the archive is not the vector's pinned tar.

```bash
# where: air-gapped
node scripts/bom-vector-bundle.mjs P01 "$WORK/selftest/P01"
node scripts/verify-bom.mjs "$WORK/selftest/P01/regulait-export-decision-bom-a0000000-0000-4000-8000-000000000042-v1.tar.gz" \
  --keyring "$WORK/selftest/P01/trust/export-keyring" \
  --receipt-keyring "$WORK/selftest/P01/trust/receipt-keyring.json" --now 2026-10-11T00:00:00.000Z
echo "exit code: $?"
```

```text
vector P01 (positive, decision-bom): The B4.6 worked example, byte for byte: chain_signed, v2 receipt (captured), one usage event and one span
wrote …/selftest/P01/regulait-export-decision-bom-a0000000-0000-4000-8000-000000000042-v1.tar.gz
tar sha256 08869812cfd0c9b973fbcd0e72034eeadd165bbaa2a52f50f9a515fe5d790201 (16384 bytes), as pinned by the vector
expected outcome: valid
…
==> …/selftest/P01/regulait-export-decision-bom-a0000000-0000-4000-8000-000000000042-v1.tar.gz
    Decision BOM b0000000-0000-4000-8000-000000000001 v1 of decision a0000000-0000-4000-8000-000000000042; finality chain_signed (reported chain_signed); receipt v2
    [valid] bundle_manifest_signature
    [valid] bundle_manifest_files
    [valid] bundle_subject
    [valid] bundle_email_scan
    [valid] body_version
    [valid] body_schema
    [valid] body_signature
    [valid] receipt_signature
    [valid] receipt_payload_hash
    [valid] receipt_facts_binding
    [valid] sections_projection
    [valid] chain_links
    [unverifiable] decision_content_binding: preimage_not_exported
    [unverifiable] anchor_record: anchor_absent
    [unverifiable] anchor_imprint: anchor_absent
    [unverifiable] tsa_token: anchor_absent
    [valid] finality
    This verification cannot prove:
      - That nothing was omitted after the anchor.
      - That the facts were true: only that they were recorded and signed.
      - The signing time, beyond the anchor timestamp.
      - That the anchor destination is tamper-resistant: this is the server's recorded observation.
      - That the audit row's content is the decision described: the content hash is chained and anchored, but its preimage is not disclosed.
      - That the chain row was committed outside this deployment: this BOM is chain_signed and has no anchor.

    OUTCOME: VALID

exit code: 0
```

Then an AI BOM with a CycloneDX rendering (A02), and its forged twin (NA01: the CycloneDX file is not the bytes the
signed body commits to, though the manifest lists and signs it):

```bash
# where: air-gapped
node scripts/bom-vector-bundle.mjs A02 "$WORK/selftest/A02"
node scripts/bom-vector-bundle.mjs NA01 "$WORK/selftest/NA01"
node scripts/verify-bom.mjs "$WORK/selftest/NA01/regulait-export-ai-bom-ab000000-0000-4000-8000-000000000001-cyclonedx-1.7.tar.gz" \
  --keyring "$WORK/selftest/NA01/trust/export-keyring" \
  --receipt-keyring "$WORK/selftest/NA01/trust/receipt-keyring.json" --now 2026-10-11T00:00:00.000Z
echo "exit code: $?"
```

```text
…
expected outcome: invalid
…
    AI BOM snapshot ab000000-0000-4000-8000-000000000001 v1 (install 00000000-0000-0000-0000-000000000000), urn:uuid:589e3cf8-69ef-8a44-acc8-a8c6bda58790
    [valid] bundle_manifest_signature
    [valid] bundle_manifest_files
    [valid] bundle_subject
    [valid] bundle_email_scan
    [valid] body_version
    [valid] body_schema
    [valid] body_signature
    [invalid] rendering_hashes (cyclonedx-1.7): hash_mismatch
    [valid] serial_number
    …
    OUTCOME: INVALID

exit code: 1
```

If either answer differs, stop: the kit is not the one the specification describes. Every vector id (33 positives,
108 negatives) is listed in `packages/shared/test-vectors/decision-bom/README.md`; the writer refuses the two
negatives whose archive holds a directory or symlink entry (N-M16, N-M18).

**Every key in these vectors is a published CANARY test key.** Never configure one, and never accept a real bundle
signed by one.

The B4 vectors carry `regulait.decision-bom.v1` bodies. Since ADR-0190 I8 a deployment writes
`regulait.decision-bom.v2` bodies, which add an `execution` section; the same verifier checks both versions. No v2
bundle has been through this runbook yet (Pending, item 1).

### Step 3. Fix the trust root

For a real bundle, the operator gives you the export fingerprint and the receipt keyring out of band (see
**Who holds what**). If you were given the export key's `.pub` rather than its fingerprint, compute the fingerprint
(SHA-256 of the DER SubjectPublicKeyInfo, ADR-0116) and compare it with the value from the engagement letter:

```bash
# where: air-gapped
openssl pkey -pubin -in "$WORK/selftest/A02/trust/export-keyring/TEST-ONLY-CANARY-export-key-1.pub" -outform DER | sha256sum
```

```text
3133075a6bffc999dede86075e66ac42685946d768c1ffbfdacb7c7009096b20  -
```

A receipt key's fingerprint (B4.2) is the SHA-256 of `302a300506032b6570032100` followed by the base64url-decoded
`x` of its JWK. To list the fingerprints of a receipt keyring file, to compare them with the operator's:

```bash
# where: air-gapped
node -e 'const k=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const e of k.keys){const d=Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),Buffer.from(e.jwk.x,"base64url")]);console.log(e.keyId,"sha256:"+require("crypto").createHash("sha256").update(d).digest("hex"))}' \
  "$WORK/selftest/A02/trust/receipt-keyring.json"
```

```text
TEST-ONLY-CANARY-receipt-key-1 sha256:505e806b…4c746deb
```

The fingerprint is elided here (the command was executed; the full value is the `fingerprint` of
`TEST-ONLY-CANARY-receipt-key-1` in `packages/shared/test-vectors/decision-bom/b4-vectors.json`).

The keyring file's `receiptV2FromAuditSeq` is the receipt v2 boundary (R42); it is part of the trust root, never
read from the bundle. With pinned fingerprints instead of a keyring file, pass the boundary yourself with
`--receipt-v2-from <seq>` or `--receipt-v2-from none`.

### Step 4. Verify the bundle you received

Set `BUNDLE` to the archive you received, `EXPORT_FPR` to the export fingerprint and `RECEIPT_KEYRING` to the receipt
keyring file. In the rehearsal they were the A02 vector:

```bash
# where: air-gapped
BUNDLE="$WORK/selftest/A02/regulait-export-ai-bom-ab000000-0000-4000-8000-000000000001-cyclonedx-1.7.tar.gz"
EXPORT_FPR="sha256:3133075a6bffc999dede86075e66ac42685946d768c1ffbfdacb7c7009096b20"
RECEIPT_KEYRING="$WORK/selftest/A02/trust/receipt-keyring.json"
```

**4a. The envelope, with stock tools only** (ADR-0116; `openssl`, `sha256sum`, `tar`, a POSIX shell):

```bash
# where: air-gapped
scripts/verify-export-bundle.sh "$BUNDLE" --fingerprint "$EXPORT_FPR"
echo "exit code: $?"
```

```text
==> Verifying …/selftest/A02/regulait-export-ai-bom-ab000000-0000-4000-8000-000000000001-cyclonedx-1.7.tar.gz
  [pass] structure: manifest and signature present
  [pass] manifest: regulait.export-bundle/3, subject 'ai-bom', signed by key id 'TEST-ONLY-CANARY-export-key-1'
  [pass] signing key fingerprint matches the one you pinned: sha256:3133075a6bffc999dede86075e66ac42685946d768c1ffbfdacb7c7009096b20
  [pass] signature verifies over manifest.json's exact bytes
  [pass] all 6 signed files match their SHA-256
  [pass] bundle contains nothing the manifest does not list
  AI BOM bundle: no audit chain segment is carried (ADR-0189 B4.1).
  ENVELOPE ONLY: the signed BOM body, the receipt and any renderings are checked by
  scripts/verify-bom.mjs with your receipt-key trust root (ADR-0189 R19).

[VERIFIED] regulait export — subject ai-bom, install <none recorded>
           exported 2026-10-10T12:30:00.000Z (database clock), signed by TEST-ONLY-CANARY-export-key-1
           sha256:3133075a6bffc999dede86075e66ac42685946d768c1ffbfdacb7c7009096b20

exit code: 0
```

The envelope alone is not the evidence: the export key can forge an envelope, never a body (R19).

**4b. The body, the receipt, the chain and the renderings.** Keep the JSON report with your working papers:

```bash
# where: air-gapped
node scripts/verify-bom.mjs "$BUNDLE" --fingerprint "$EXPORT_FPR" --receipt-keyring "$RECEIPT_KEYRING" \
  --now 2026-10-11T00:00:00.000Z
echo "exit code: $?"
node scripts/verify-bom.mjs "$BUNDLE" --fingerprint "$EXPORT_FPR" --receipt-keyring "$RECEIPT_KEYRING" \
  --now 2026-10-11T00:00:00.000Z --json > "$WORK/verify-report.json"
grep '"outcome"' "$WORK/verify-report.json"
```

```text
==> …/selftest/A02/regulait-export-ai-bom-ab000000-0000-4000-8000-000000000001-cyclonedx-1.7.tar.gz
    AI BOM snapshot ab000000-0000-4000-8000-000000000001 v1 (install 00000000-0000-0000-0000-000000000000), urn:uuid:589e3cf8-69ef-8a44-acc8-a8c6bda58790
    [valid] bundle_manifest_signature
    [valid] bundle_manifest_files
    [valid] bundle_subject
    [valid] bundle_email_scan
    [valid] body_version
    [valid] body_schema
    [valid] body_signature
    [valid] rendering_hashes (cyclonedx-1.7)
    [valid] serial_number
    This verification cannot prove:
      - That the facts were true: only that they were recorded and signed.
      - The signing time, beyond the anchor timestamp.

    OUTCOME: VALID

exit code: 0
  "outcome": "valid",
```

`--now` fixes the verification time; it decides `anchored_lapsed` for an Object Lock that has expired (R44). The
rehearsal pins it to the vectors' time. For a real bundle, omit it to use this machine's clock, or set it to the
time your engagement fixes.

Without a trust root, the verifier refuses rather than trusting the bundle's own keys:

```bash
# where: air-gapped
node scripts/verify-bom.mjs "$BUNDLE" --fingerprint "$EXPORT_FPR"
echo "exit code: $?"
```

```text
REFUSED: no receipt-key trust root. Pass --receipt-keyring or --receipt-fingerprint, obtained out of band; the bundle's own receipt-keys.json is never trusted.
exit code: 2
```

### Step 5. Check the CycloneDX and SPDX renderings against the official schemas

`rendering_hashes` (step 4b) already proves each carried rendering is the exact file the signed body commits to.
This step checks the file against the standard itself, offline, with the schemas the product bundles (the same Ajv
and schema files the product validated with when it froze the snapshot). Unpack the bundle and cross-check the
committed hash by hand:

```bash
# where: air-gapped
mkdir -p "$WORK/unpacked" && tar -xzf "$BUNDLE" -C "$WORK/unpacked"
R="$WORK/unpacked/regulait-export-ai-bom-ab000000-0000-4000-8000-000000000001-cyclonedx-1.7/content"
sha256sum "$R/ai-bom.cyclonedx-1.7.json"
node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).renderings))' "$R/ai-bom.json"
node scripts/validate-bom-rendering.mjs --format cyclonedx-1.7 "$R/ai-bom.cyclonedx-1.7.json"
echo "exit code: $?"
```

```text
6d6c7a7601df04683145f8354e2e8441dc42a8edda7cda9e27d8d2d5b869b2c2  …/content/ai-bom.cyclonedx-1.7.json
{"cyclonedx-1.7":{"bytes":849,"sha256":"6d6c7a7601df04683145f8354e2e8441dc42a8edda7cda9e27d8d2d5b869b2c2","status":"rendered","validator":"ajv 8.20.0 ajv-formats 3.0.1 cyclonedx-library 10.3.0 bom-1.7.SNAPSHOT.schema.json"},"spdx-3.0.1":{"bytes":3326,"sha256":"bb69d44087a694d4ca9ec9b8734d62082b3933ef9fc5d9c9ed25d3a1c4037012","status":"rendered","validator":"ajv 8.20.0 ajv-formats 3.0.1 spdx-json-schema-3.0.1 sha256:582c64e809d5b3ef9bd0c4de13a32391b47b0284a3e8d199569fb96f649234b1"}}
[valid] …/content/ai-bom.cyclonedx-1.7.json: cyclonedx-1.7 schema
exit code: 0
```

The format is stated, never guessed, and must match the document: the same 1.7 file stated as `cyclonedx-1.6` is
refused (`not a CycloneDX 1.6 document`, exit 1; executed), because the bundled 1.6 schema alone would accept it.

**SPDX 3.0.1.** None of the B4 vectors carries an SPDX file (the vectors use `?format=native` and
`?format=cyclonedx-1.7` only), so the rehearsal used the product's own SPDX renderings of the B5 fixtures, written
by the built product code. For a real bundle, run the two validation commands on its `content/ai-bom.spdx-3.0.1.json`.

```bash
# where: air-gapped
node scripts/spdx3/render-fixtures.mjs "$WORK/spdx"
node scripts/validate-bom-rendering.mjs --format spdx-3.0.1 "$WORK/spdx/install.spdx.json"
"$WORK/spdx3-venv/bin/python" -I scripts/spdx3/run_offline.py --require-offline "$WORK/spdx/install.spdx.json"
echo "exit code: $?"
```

```text
use_case.spdx.json 22589 bytes
agent.spdx.json 22579 bytes
builder_agent.spdx.json 22590 bytes
install.spdx.json 24810 bytes
with-datasets.draft.spdx.json 31543 bytes
with-datasets-declared.spdx.json 33044 bytes
use_case.supplied-by-tool.expect-fail.json 22552 bytes
[valid] …/spdx/install.spdx.json: spdx-3.0.1 schema
{"file": "install.spdx.json", "triples": 312, "schemaErrors": 0, "shaclErrors": 0, "conforms": true, "expectFail": false, "verdict": "PASS"}
exit code: 0
```

`run_offline.py` runs `spdx3-validate`'s own JSON-schema and SHACL checks with the vendored, sha256-pinned schema,
model and context. The JSON schema is necessary but not sufficient: the fixture `use_case.supplied-by-tool.expect-fail.json`
passes the schema and fails SHACL (R12 §5; executed: `"shaclErrors": 1, "conforms": false`). `--require-offline`
refuses to run if an outside TCP connection succeeds; on a connected machine it answered
`run_offline.py: reached 1.1.1.1:443; this run is NOT network-isolated (refused)` and exit 3 (executed).

### Reading the results

| Report line | Meaning | Action |
|---|---|---|
| `OUTCOME: VALID`, exit 0 | every required check passed under your trust root | record the report; read the "cannot prove" list into your findings |
| `[unverifiable] supersedes: earlier_snapshot_not_in_bundle` | an AI BOM above version 1 names the snapshot it supersedes, which is not in the bundle | by design (B4.8); request the earlier snapshot's bundle if its content matters |
| `[unverifiable] anchor_record: anchor_absent` with finality `chain_signed` | the deployment's finality is relaxed to `chain_signed` (an audited relaxation, ADR-0189 §7) | by design; the "cannot prove" list says there is no external commitment |
| `OUTCOME: UNVERIFIABLE`, exit 3 | evidence that should be there is missing | ask the operator for a fresh export; do not treat it as valid |
| `[invalid] … unknown_key` | a signature by a key your trust root does not hold | re-confirm the keyring and fingerprint with the operator, out of band |
| `OUTCOME: INVALID`, exit 1 | a signature, hash, link or binding failed | treat the bundle as not evidence; report it |
| `REFUSED: …`, exit 2 | no trust root, or a usage error | supply the trust root; never use the bundle's own keys |

## Part C — BYOC and air-gapped operator steps

The operator's side needs a running deployment. **None of it was executed for this runbook**; the routes and files
are named from the code, and no command or output is given for them.

1. Confirm the deployment can sign: ADR-0189 §10 specifies that the posture page reports the Decision BOM as
   unavailable until a receipt key is set, and export signing needs `REGULAIT_EXPORT_SIGNING_KEY` and
   `REGULAIT_EXPORT_SIGNING_KEY_ID` (`infra/export-keys/README.md`).
2. Publish the export key fingerprint to the auditor out of band, once. `GET /v1/exports/signing-key` reports it.
3. Give the auditor the receipt keyring: `GET /v1/receipts/keys` (keys only) or `GET /v1/receipts/export`, which also
   carries `receiptV2FromAuditSeq`. Retired keys stay listed; they are needed to verify older BOMs.
4. Export the bundle as a person in `bom_export_roles` (admins only by default; an auditor grant is an audited
   admin act): `GET /v1/decisions/:auditId/bom/bundle` for a Decision BOM; `GET /v1/ai-bom/snapshots/:snapshotId/bundle`
   or `GET /v1/ai-bom/snapshots/:snapshotId?format=native|cyclonedx-1.7|cyclonedx-1.6|spdx-3.0.1` for an AI BOM.
   Each export is audited and rate-limited. A Decision BOM can answer 409 `bom_anchor_pending` or 409
   `bom_signing_unavailable`.
5. Optionally cross-check online with `POST /v1/boms/verify`, which runs the same pure verifier with the server's
   recorded keys as the trust root and says so in its result (`trust: "deployment_registry"`). It is a convenience
   for the operator, not evidence for the auditor: the auditor's trust root must come from outside the deployment.
6. Air-gapped deployments name the public export keyring in a file, `REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS_FILE`
   (ADR-0189 B4.2), so the online verifier needs no network either.

## Pending — not executed, do not rely on until run

Each line says what must be done; none has a command here, because none has been run.

1. **A bundle exported by a running deployment** (Part C steps 1 to 5), verified end to end with this runbook,
   for each subject: a Decision BOM (a `regulait.decision-bom.v2` body), and an AI BOM in each of `native`, `cyclonedx-1.7`, `cyclonedx-1.6` and
   `spdx-3.0.1`. Needs a running stack with a receipt key, an export key and (for `anchored`) an anchor sink.
2. **An anchored Decision BOM with an RFC 3161 token checked with `--tsa-trust`.** No B4 vector carries a TSA token,
   and no internal TSA was available. Needs a deployment configured with an internal TSA and its trust bundle.
3. **An SPDX file taken out of a real AI BOM bundle** through step 5 (the rehearsal used the product's renderings
   of the B5 fixtures instead).
4. **Packing the built kit and moving it to an air-gapped machine** (end of Part A), then re-running Part B there.
   Part B was executed in a network namespace on the build machine, not on a separate machine.
5. **Part B on Python 3.12 or later**, where `venv` bundles no `setuptools` for building `halo` offline.
6. **Verifying the release's own AI BOM (ADR-0189 B7) offline.** Its SBOM identity file is signed keylessly by the
   release workflow, and its air-gapped trust root is ADR-0189 owner item 2, not yet decided.
7. **The receipt v2 cutover and the replica drain it requires** (R43): see
   [RECEIPT_V2_CUTOVER.md](RECEIPT_V2_CUTOVER.md). Until it runs, every receipt is v1, and a Decision BOM bound to a
   v1 receipt reports `receipt_facts_binding` as `unverifiable` `receipt_v1_no_factsHash` (B4.8; R46: facts captured
   under a v1 receipt are shown but not claimed as receipt-bound).
