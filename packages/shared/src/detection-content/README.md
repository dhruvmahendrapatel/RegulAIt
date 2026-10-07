# Pinned detection content (ADR-0186 V)

Only data is ported. Upstream code is never loaded or executed. Each vendor
folder retains its permissive licence, notices, exact Git commit, retrieval time
and per-file SHA-256 in `PROVENANCE.json`. Pipelock enterprise/ee content is
excluded. The scanner files establish the upstream case-insensitive flag
semantics; they are attribution/source evidence, not runnable dependencies.

From the repository root, run `node scripts/vendor/convert-detection-content.mjs`
to regenerate or add `--check` to verify identical output without writing. No
network is used. Source changes, unresolved expressions or unsupported rules
are refused or recorded in the manifest; imported patterns must compile on RE2.

The snapshot admits 62 Pipelock secret shapes, the Pipelock normalisation data,
and 25 stateless AGT tool-description heuristics. Five checksum-dependent
Pipelock rules are not represented. Seven carrier/path/cryptographic audience
exemptions cannot be represented by a host-only list, so those credentials
receive no audience exemption. Six AGT context/decode/sample-policy categories
are excluded. All five pinned NeMo rules have compound/group/order/loop
conditions outside ADR-0186's any/N-of-them grammar: **zero injection rules are
imported**, and the API/UI say so. This is a coverage residual, not a claim of
NeMo injection protection.

Runtime matching uses RE2 only. A combined RE2 set selects candidates before
individual matchers locate spans in the original text. For patterns proved to
consume ASCII spaces only via flexible `\s` quantifiers, the candidate scan
collapses space runs; unproved patterns still scan original text. Candidate
failures retain every rule. Provider left boundaries are checked separately so
a credential's preceding delimiter is not redacted.

Normalisation follows invisible removal, NFKC, confusable folding, NFD/mark
removal, NFC and whitespace folding. It also removes discarded Mn marks before
ICU normalization, preventing a quadratic alternating-combining-class run.
This intentional extra pass is not a byte-for-byte upstream runtime port.

Audit redaction always applies irrespective of pack settings. Other detector
and admission consumers honor the current pack selection. Results expose
rule IDs/counts/spans, not matched secrets or descriptions.

`credentialAudienceViolations` provides host/TLS matching, including wildcard
apex/subdomains and suffix-spoof refusal. **The guarded outbound integration is
not installed by this slice:** `outboundAudienceEnforced: false` reports that
fact. A URL/header/body consumer and its integration test remain an owner-file
prerequisite. Manifest exclusions and normalisation limits remain visible.
