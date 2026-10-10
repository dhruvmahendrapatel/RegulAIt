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

The snapshot admits 61 default Pipelock secret shapes, the Pipelock normalisation data,
and 25 stateless AGT tool-description heuristics. Three checksum-dependent rules and two unresolved Go constant expressions are not represented. Preset-only Ethereum Address is excluded from the default set. Seven carrier/path/cryptographic audience
exemptions cannot be represented by a host-only list, so those credentials
receive no audience exemption. Six AGT context/decode/sample-policy categories
are excluded. All five pinned NeMo rules have compound/group/order/loop
conditions outside ADR-0186's any/N-of-them grammar: **zero injection rules are
imported**, and the API/UI say so. This is a coverage residual, not a claim of
NeMo injection protection. Claude accepted the zero-rule result as a documented
ADR residual in the 2026-10-07 22:15 coordination review; the five exclusions
remain visible.

Runtime matching uses RE2 only. A combined RE2 set selects candidates before
individual matchers locate spans in the original text. Conservative mandatory-fragment gates bypass absent patterns on all text, folding the RE2 ASCII-equivalent Unicode long-s and Kelvin sign before candidate selection. Full-pattern proof inputs are pinned in prefix-proofs.json. Candidate selection retains the gates when more than eight rules are active; reviewed bounded prefix offsets permit scanning the suffix while preserving the preceding boundary. Unbounded prefix offsets retain the full candidate scan. Folding preserves UTF-16 offsets, including dotted capital I; exact matches still use the original text. For patterns proved to
consume ASCII spaces only via flexible `\s` quantifiers, the candidate scan
collapses space runs; unproved patterns still scan original text. Candidate
failures retain every rule. Provider left boundaries are checked separately so
a credential's preceding delimiter is not redacted.

Normalisation follows invisible removal, NFKC, confusable folding, NFD/mark
removal, NFC and whitespace folding. It also removes discarded Mn marks before
ICU normalization, preventing a quadratic alternating-combining-class run. All Unicode mark runs (including spacing marks) are capped at 30 code points before NFKC.
This intentional extra pass is not a byte-for-byte upstream runtime port.

Audit redaction always applies irrespective of pack settings. Other detector
and admission consumers honor the current pack selection. Results expose
rule IDs/counts/spans, not matched secrets or descriptions. Scrubbing makes at most two linear passes. If newly introduced marker boundaries reveal another credential in an unredacted fragment, the second pass redacts that whole fragment (field marker), preventing an unbounded chain of boundary changes. Only markers whose labels are known detector rule IDs or the field label stay opaque; caller-supplied unknown labels are scanned. the pathological fragment may lose non-secret surrounding prose.

`credentialAudienceViolations` provides host/TLS matching, including wildcard
apex/subdomains and suffix-spoof refusal. Its consumer is the gateway's
`outbound-audience.ts` (ADR-0186 decision 30), called at the MCP tool, MCP
protocol and connector dispatch points on the caller's own content; the org
setting `outboundCredentialAudience` (strict `enforce`) governs it and
`GET /v1/detection-content` reports `outboundAudienceEnforced` from that setting
and the secrets pack. A rule with no audience hosts is refused for every
destination; the SSN shape is personal data, not a credential, and is left to
the piiMode cascade there. Manifest exclusions and normalisation limits remain visible.
