<!-- fold: state-recap -->
**C2, signed offline detection content (ADR-0367, 2026-11-17).** An admin can import one pinned, signed injection-rule
stream and explicitly enable it (default off). Exact-byte Ed25519 verification, strict RE2/schema bounds and a
transactional version watermark precede rule use. Every import is audited; active corrupt or untrusted content
blocks. Verified rules join the existing guarded dispatch without replacing built-ins or contacting a publisher.
Secret/MCP rule kinds are refused by the initial format. The three API-only screen gaps are tracked on #453.

Validation note (2026-11-24): renumbered from ADR-0351, which main had already used, to ADR-0367. The three gaps now live in
`scripts/known-ui-gaps/adr-0367-c2-detection-feed.json` (main's per-file format), and the route census passes.

Review fixes (2026-11-24, S4 and R2 on #1006):

- Governed calls reuse one verified, compiled snapshot. It is keyed by the row's `xmin`, version, digest, feed id, issue time and keyring fingerprint, and the keyring file is read asynchronously.
- The signed `issuedAt` is monotonic and refused when post-dated. Status reports the feed's age, and the daily `detection-feed-health-sweep` audits a stale or unverifiable feed.
- The docs and the ADR now state that an unverifiable enabled feed blocks every call in every mode, and give the safe key-rotation order.
- The ADR-0176 comparison now covers tuf-js, DSSE/Sigstore, jose and minisign, and writes down the §4 exception.
- Settings refusals are audited.
