# ADR-0351: Evidence extras from the DarkControl comparison: syslog delivery, an EU AI Act deployer register, an endpoint benchmark pack

- **Status**: Accepted (builder lane E32, owner decision 2026-11-17 on the DarkControl gap analysis)
- **Date**: 2026-11-17
- **Index**: Evidence extras: syslog over TLS, EU AI Act deployer register, AI coding-agent endpoint benchmark
- **Migration**: `pending/siem_syslog_tls.sql` (slice 1; numbered at merge, ADR-0252)

## Context

The DarkControl gap analysis (`internal/product/GAP_ANALYSIS_DARKCONTROL_2026-11.md`, rows 15, 16 and 17, item 5)
found three small evidence gaps:

- **Row 15.** SIEM delivery (ADR-0303) sends the hash-chained audit as signed JSON over HTTPS only. Many SOCs ingest
  syslog, and there is no RFC 5424 destination.
- **Row 17.** The `eu-ai-act` pack (ADR-0058) maps provider-side articles. There is no register of the duties of a
  *deployer* (Art. 26 and related) that says, per duty, whether the system observes it or a person attests it.
- **Row 16.** The compliance packs cover ISO, SOC 2, OWASP, NIST and AIUC-1, but nothing benchmarks the AI
  coding-agent endpoints the endpoint agent (ADR-0298, ADR-0259) already inventories.

The owner decided on 2026-11-17 to build all three as small slices, reusing ADR-0303's delivery queue and the
compliance packs (ADR-0058, ADR-0243) rather than adding new frameworks, with the UI left to the design builders
(#453).

## Decision

### 1. Syslog over TLS is a second SIEM destination kind (slice 1)

- `siem_destinations.kind` gains `syslog_tls`. A syslog destination uses everything ADR-0303 built: the cursor over
  `audit_log.seq`, the lease, chain order, backoff, dead-letter, recover, the audited enable (a step-up relaxation)
  and the one allow-list of event fields (`siemEventFromAuditRow`). Only the sender differs.
- **Message.** One RFC 5424 message per event: `<PRI>1 TIMESTAMP HOSTNAME regulait - audit - MSG`. PRI is facility 13
  ("log audit"), severity 4 for a deny row and 6 otherwise. MSG is the `regulait.siem.audit.v1` event as JSON with its
  `schema`. STRUCTURED-DATA is `-`, because our own SD-IDs would need an IANA private enterprise number we do not
  hold. Rows pruned before delivery produce one `audit-gap` message, as the webhook's `gap` flag does.
- **Transport.** RFC 5425: TLS 1.2 or later, octet-counted framing, port 6514 by default, URL
  `syslog+tls://host[:port]`. The receiver's certificate is always verified, against the system trust store or a CA
  bundle stored on the destination (`tls_ca_pem`, public certificates only, CA certificates only, no private key).
  There is no UDP, plain TCP or "skip verification" mode, so there is nothing insecure to relax into (ADR-0180).
- **Egress.** The host passes the same `checkEgress` decision as the webhook (the default-deny admin allow-list and the
  blocked ranges), and the socket dials the address that decision accepted, with SNI and the certificate check on
  the host name. A DNS answer cannot change between the check and the connect.
- **Acknowledgement.** RFC 5425 has no application-level acknowledgement. A batch counts as delivered once every byte
  was written to the verified session and the session closed without an error. Only then does the cursor move. Any
  error resends the batch, so delivery is at least once and receivers deduplicate on the event id.
- **No secret.** A syslog destination has no Standard Webhooks secret, because the receiver is authenticated by its
  certificate. `secret_ciphertext` becomes nullable, a CHECK ties it to the kind, and `rotate-secret` answers 409
  `not_applicable`. A new fixed error code, `tls_handshake`, covers a refused certificate or handshake. No receiver
  text is stored.
- **Libraries (ADR-0176).** We compared the maintained and unmaintained options. `syslog-client` (MIT) last released
  in 2017 and has no TLS, so it fails "actively maintained". `pino-syslog` (MIT, released 2026-07) formats pino log
  lines rather than arbitrary events, and its companion transport `pino-socket` connects by host name, which would
  bypass the pinned-address egress guard. `winston-syslog` (MIT) depends on `glossy`, last released in 2015. None
  fits, because a stricter security posture (the pinned egress address) is a hard requirement. The format is a few
  lines of RFC 5424 and the transport is `node:tls`. Re-check this if a maintained RFC 5424 formatter with no
  transport of its own appears.

### 2. The EU AI Act deployer-obligation register is a pack plus a typed view (slice 2)

- The deployer duties ship as a compliance pack, `eu-ai-act-deployer@1`, in the existing pack format. Each duty
  (Art. 26(1) to 26(12), with Art. 4, 27, 49(3), 50(3) and (4), 73 and 86 where they bind a deployer) is one control.
  A duty the platform can evidence uses a real collector over a ledger we already keep. Its basis is **observed**, and
  the register links to the evidence. A duty only a person can confirm is `attestationRequired`. Its basis is
  **attested**, and the register shows who attested it, when, the evidence reference and the review date. Attesting
  writes a `compliance_pack_attestations` row and an audit row, as pack attestations already do.
- The register adds no framework and no copy of the pack data. It is a typed view over the active
  `eu-ai-act-deployer` pack's evaluation: per item, the basis, the evidence link or the attestation, and a lifecycle
  state.
- **Lifecycle (a declared transition table).** One table in `@regulait/shared` declares the states and transitions,
  and the server enforces it:
  - States: `open`, `observed`, `attested`, `review_due`.
  - `open → observed` and `observed → open` happen when the system evaluation finds evidence or loses it. These
    transitions exist for observed items only.
  - `open → attested`, `review_due → attested` and `attested → attested` (renewal) are the `attest` action, for
    attested items only. It always carries a review date, at most 12 months ahead.
  - `attested → review_due` happens when the review date passes.
  - An observed item cannot be attested. A person cannot override what the system observes.
- **Secure defaults.** An attestation needs a review date (no open-ended attestations). The register is admin-only
  through the default gate. The pack is honest about coverage: it says that a duty observed by the system is evidence
  that a control ran, not a legal finding.

### 3. A CIS-style benchmark pack for AI coding-agent endpoints (slice 3)

- `ai-coding-endpoint-benchmark@1` is a compliance pack in the existing format, in our own words. It is not a CIS
  Benchmark and does not reproduce CIS text, which CIS licenses separately. Each control follows the CIS layout:
  an id, a profile level (L1 or L2) and a check.
- Each control maps to a real check. Where an existing collector already is the check, the control uses it. The
  fleet-wide endpoint checks (devices reporting, hardware-protected agent keys, no credentials sighted in agent
  configuration, MCP definitions pinned) use one new collector, `endpoint_benchmark_check`. Its `endpointCheck`
  parameter names the check from a closed list. It counts 1 when the check passes across at least one enrolled
  device and 0 otherwise, so the existing satisfaction rule (count of 1 or more) is the check. A control the platform
  cannot check is `attestationRequired` and says what to attest.

## Consequences

- SOCs that ingest syslog get the same scrubbed, ordered, at-least-once audit stream as the webhook, over
  authenticated TLS only. The weaker acknowledgement (a closed TLS session, not a 2xx) is stated in the route's
  envelope description and in this ADR.
- The deployer register answers "which Art. 26 duties do we evidence, and who signed the rest", with review dates.
  It is a control-mapping report under ADR-0058's disclaimer, not a conformity statement.
- The endpoint benchmark gives procurement a CIS-shaped checklist backed by live checks.
- The UI for all three is not built here. The routes are KNOWN_UI_GAPS on #453.
