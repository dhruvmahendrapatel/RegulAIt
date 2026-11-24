<!-- fold: state-recap -->
**C2, signed offline detection content (ADR-0367, 2026-11-17).** An admin can import one pinned, signed injection-rule
stream and explicitly enable it (default off). Exact-byte Ed25519 verification, strict RE2/schema bounds and a
transactional version watermark precede rule use. Every import is audited; active corrupt or untrusted content
blocks. Verified rules join the existing guarded dispatch without replacing built-ins or contacting a publisher.
Secret/MCP rule kinds are refused by the initial format. The three API-only screen gaps are tracked on #453.

Validation note (2026-11-24): renumbered from ADR-0351, which main had already used, to ADR-0367. The three gaps now live in
`scripts/known-ui-gaps/adr-0367-c2-detection-feed.json` (main's per-file format), and the route census passes.
