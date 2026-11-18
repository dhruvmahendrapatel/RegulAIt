<!-- fold: state-recap -->
**C2, signed offline detection content (ADR-0351, 2026-11-17).** An admin can import one pinned, signed injection-rule
stream and explicitly enable it (default off). Exact-byte Ed25519 verification, strict RE2/schema bounds and a
transactional version watermark precede rule use. Every import is audited; active corrupt or untrusted content
blocks. Verified rules join the existing guarded dispatch without replacing built-ins or contacting a publisher.
Secret/MCP rule kinds are refused by the initial format. The three API-only screen gaps are tracked on #453.

Validation note: the three API-only controls add three documented screen gaps. The existing gap ceiling and its pinned test stay unchanged; the route census currently fails at 76 versus 73. Master approval for an API-only exception or a UI-builder assignment was requested on #935. No READY claim is made while that gate fails.
