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

Runtime matching uses RE2 only. For the shipped rules, the converter derives a
scan plan for each rule from RE2's own compiled program (ADR-0186 decision 31):
a prefilter of up to 24 code-point classes that every match begins with, and the
rule's maximum match length when the program has no loop. A native scan for the
prefilter (a fixed sequence of classes: nothing to backtrack) finds every position where a match can
start; a rule with no such position needs no RE2 work. A bounded rule is matched
by RE2 in a window at each position (one unit of left context, maximum length
plus one unit after it), which reproduces the full-text match; an unbounded rule
gets one RE2 scan from its first position. The derivation is pinned to the
re2js version whose program layout it reads, and a differential test holds the
result to a full RE2 scan of every rule. A custom rule list still uses one
combined RE2 set to select candidates; candidate failures retain every rule.
Provider left boundaries are checked separately so a credential's preceding
delimiter is not redacted.

Normalisation follows invisible removal, NFKC, confusable folding, NFD/mark
removal, NFC and whitespace folding. It also removes discarded Mn marks before
ICU normalization, preventing a quadratic alternating-combining-class run. All Unicode mark runs (including spacing marks) are capped at 30 code points before NFKC.
This intentional extra pass is not a byte-for-byte upstream runtime port.

Audit redaction always applies irrespective of pack settings. Other detector
and admission consumers honor the current pack selection. Results expose
rule IDs/counts/spans, not matched secrets or descriptions. Scrubbing makes at most two linear passes. If newly introduced marker boundaries reveal another credential in an unredacted fragment, the second pass redacts that whole fragment (field marker), preventing an unbounded chain of boundary changes. Only markers whose labels are known detector rule IDs or the field label stay opaque; caller-supplied unknown labels are scanned. The pathological fragment may lose non-secret surrounding prose.

`credentialAudienceViolations` provides host/TLS matching, including wildcard
apex/subdomains and suffix-spoof refusal. **The guarded outbound integration is
not installed by this slice:** `outboundAudienceEnforced: false` reports that
fact. A URL/header/body consumer and its integration test remain an owner-file
prerequisite. Manifest exclusions and normalisation limits remain visible.

Dense audit inputs reuse per-invocation fragment decisions, marker-label checks and
short credential fingerprints (each cache admits at most 256 entries and only
strings up to 256 characters). Nothing is retained between audit writes, and
unseen strings still receive the full scan. The second pass uses the first
pass's surviving fragments rather than reparsing newly generated markers.
