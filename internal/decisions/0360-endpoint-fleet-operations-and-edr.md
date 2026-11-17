# ADR-0360: Endpoint agent fleet operations (staged signed self-update, one-line enrolment) and EDR integration

- **Status**: Proposed (builder lane E41, 2026-11-17; owner decision 2026-11-17, competitor gap audit DarkControl row 21
  and Manifold row 14)
- **Date**: 2026-11-17
- **Index**: Endpoint fleet ops: device groups, off-by-default TUF-verified staged self-update, one-line enrolment, EDR adapters
- **Builds on**: ADR-0195 (SD4 endpoint agent), ADR-0197 (Q13 token expiry relaxation), ADR-0259 (endpoint MCP config
  discovery), ADR-0298 (on-device enforcement), ADR-0330 (hook adapters; B4 device-policy signer), and the open
  proposals of lane E16 (the device-policy signer as built, PR #867), lane E15 (the detection engine, PR #865) and lane
  E29 (declared state machines, PR #920); ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0200 (engineering guidelines), ADR-0252 (merge-time numbering)
- **Migration**: `pending/endpoint_fleet_operations.sql` (slice 1a), later slices add their own (numbered at merge)

## Context

The owner's competitor gap audit (2026-11-17) found two gaps in the endpoint agent (`agents/endpoint`, Go):

1. **Fleet operations.** The agent is installed and upgraded only by MDM. There is no way to roll a new agent version
   out in stages, and no quick way to enrol a single machine (the bulk token is a 30-day, many-device MDM secret).
2. **EDR.** The customer's EDR (Microsoft Defender for Endpoint, CrowdStrike Falcon, SentinelOne) already knows which
   devices are at risk. RegulAIt does not read that signal, and cannot ask the EDR to isolate a device that a
   RegulAIt detection flags.

The brief, as given (owner direction, quoted):

> (1) ADR-0360 and fleet operations: Self-update is off by default; an admin can relax it, and that is audited. It stays
> off because `config.go` names it a relaxation. Updates are signature-verified against the pinned key, staged by device
> group, refuse a downgrade and roll back on a failed health check. One-line enrolment uses a short-lived, single-use,
> scope-limited token that is never logged. Compare open-source updaters first, for example go-tuf / TUF and
> minio/selfupdate (licence per ADR-0176). The Intune/Jamf runbook is a docs issue (#951).
>
> (2) EDR integration behind a vendor-neutral adapter: Microsoft Defender for Endpoint, CrowdStrike Falcon and
> SentinelOne. Read-only by default: ingest the device's EDR risk and alerts as signals into the risk score and
> detection. Optional and audited, with approval and step-up: ask the EDR to isolate a device. This action narrows
> access only. Reuse the device quarantine that lane E15 is building; do not build a parallel one. Credentials stay
> server side, all calls go through the guarded fetch, and webhooks are verified with replay protection.
>
> The update lifecycle and the isolation lifecycle are each a declared transition table.

## Open-source comparison (ADR-0176, owner rule 2026-11-17)

### Updater

| Candidate | Licence | Last release | Fit | Verdict |
|---|---|---|---|---|
| **go-tuf v2** (`theupdateframework/go-tuf/v2`, CNCF TUF) | Apache-2.0 | v2.4.2, 2026-05-19 | Signed metadata with threshold keys and key rotation through a pinned `root.json`; rollback (version) and freeze (expiry) protection of the metadata; target length and hash checks; pluggable fetcher, so the repository can be any mirror, including the customer's own gateway in an air-gapped install. Transitive modules (sigstore, go-securesystemslib, go-containerregistry, protobuf) are Apache-2.0, MIT or BSD-3. | **Chosen** for "signature-verified against the pinned key" and "refuse a downgrade" of metadata. |
| minio/selfupdate | Apache-2.0 | v0.6.0, 2022-10-19 | Binary swap with optional minisign check. | Rejected: no release in four years (fails "actively maintained"). |
| fynelabs/selfupdate | Apache-2.0 | v0.2.1, 2025-07-07 | Same lineage as minio's (inconshreveable/go-update). | Rejected: no release in the last 12 months. |
| creativeprojects/go-selfupdate | MIT | v1.7.1, 2026-11-10 | Release discovery from GitHub, GitLab and Gitea; checksum, ECDSA or PGP validation. | Rejected: built around public forge APIs (pulls go-github, the GitLab client and the Gitea SDK), which an air-gapped fleet cannot reach, and its validators are a single key, not a rotatable, threshold-signed root. |

**What we write ourselves (narrow exception, ADR-0176 §4):** the binary swap (stage next to the binary, run the staged
binary's health check, rename, keep the previous binary, restore it when the post-install health check fails). The
only maintained swap libraries are the two rejected above; the swap is about 100 lines of `os.Rename` per platform.
Re-check when a maintained swap module appears.

### EDR clients

| Vendor | Official client | Verdict |
|---|---|---|
| Microsoft Defender for Endpoint | No JavaScript SDK for the MDE API (`api.security.microsoft.com`); the Graph SDK covers alerts only, not isolation | Thin adapter over the MDE REST API; the OAuth 2.0 client-credentials grant through `oauth4webapi` (already pinned in the gateway). |
| CrowdStrike Falcon | Python (FalconPy) and Go (gofalcon) SDKs; no maintained JavaScript SDK | Thin adapter over the Falcon REST API; client credentials through `oauth4webapi`. |
| SentinelOne | No official SDK | Thin adapter over the management API (API token). |

Every adapter call goes through the gateway's guarded fetch (`egress-guard.ts` / `pinned-fetch.ts`: DNS pinned, SSRF
blocked, the credential sent to the registered origin only). Webhook signatures use `node:crypto` HMAC-SHA256 with a
timing-safe compare and a replay window, the shape the PM webhooks already use.

## Decision

### 1. Device groups (staging rings)

A device group belongs to one endpoint-agent discovery source. A device is in at most one group (the join table's
primary key is the device), so a rollout stage selects a disjoint set of devices. Groups and memberships are
admin-only, audited, and in third normal form (`endpoint_device_groups`, `endpoint_device_group_members`).

### 2. Self-update: off by default, a relaxation

- The per-source setting `selfUpdate` is `false` by default (`endpoint_fleet_settings`, absent row = off). Turning it on
  is a `settings_relax` step-up bound to the source (`requireRelaxStepUp`), audited, and the step-up method and audit
  row are recorded on the settings row (a CHECK holds "on" to a recorded relaxation, as migration 0208 does for long
  token expiry). Turning it off needs no step-up and is audited.
- The agent's local config cannot turn it on: `config.go` names self-update a server-side relaxation, and the config
  file has no member for it. The device only acts on a signed directive (below).

### 3. Staged rollouts: a declared lifecycle

A rollout names one target version and an ordered list of stages, each one device group. At most one rollout per
source is open (not `completed` or `aborted`; a partial unique index).

Rollout lifecycle (`endpoint_update_rollouts.state`, declared once in `endpoint-fleet-lifecycle.ts`):

| Event | From | To | By |
|---|---|---|---|
| `start` | `draft` | `running` (stage 1 becomes `active`) | admin; refused while self-update is off |
| `advance` | `running` | `running` (the active stage is `done`, the next is `active`) | admin |
| `complete` | `running` (last stage active) | `completed` | admin |
| `pause` | `running` | `paused` | admin |
| `resume` | `paused`, `halted` | `running` | admin; refused while self-update is off |
| `halt` | `running` | `halted` | system: a device reported a failed install or a rollback (strict default: the first failure halts) |
| `abort` | `draft`, `running`, `paused`, `halted` | `aborted` | admin |

`completed` and `aborted` are terminal. Stage lifecycle (`endpoint_update_rollout_stages.state`): `pending → active →
done`, `done` terminal. Every write is a guarded `UPDATE … WHERE state IN (sources of the event)`, so a concurrent or
stale write matches no row and is refused (409), never overwriting a newer state. Turning self-update off does not
change a rollout's state; it stops every directive at once (the device route answers "no update" while it is off).

The tables are declared in lane E29's `MachineDef` shape (PR #920) (states, initial, terminal, transitions with from, to, by
and summary) so they move onto `defineMachine` when lane E29's PR merges, without a behaviour change.

### 4. The device side (slice 1b and 1c)

- **Trust.** The release pipeline publishes a TUF repository (root, targets, snapshot, timestamp, and the per-OS and
  per-arch agent binaries). The admin pins the TUF `root.json` in the agent's MDM-placed config (`updateRoot`, a file
  path, root-owned); without a pinned root the updater never runs. Pinning a trust anchor is not a relaxation: like the
  device-policy keys (ADR-0330 B4), it only says whose signatures count.
- **Directive.** The gateway answers the per-user agent's existing config request with an update directive signed by
  the device-policy signer (ADR-0330 B4 as lane E16 builds it, PR #867; the same envelope `{keyId, payload, signature}` and pinned keyring as the
  enforcement policy). Payload: `{schema, deviceId, rolloutId, targetVersion, issuedAt, notAfter}` (at most 24 hours).
  The agent writes it to a spool file; the root updater (a system timer the package installs) verifies it against the
  pinned device-policy keys, checks it names this device (the ticket file's device id) and is fresh. A local user can
  replay an old directive but cannot forge one; an old one can only name an older or equal version, which is refused or
  a no-op.
- **Install.** The updater refreshes the TUF metadata (go-tuf v2) from the gateway's read-only repository route,
  downloads the target `regulait-agent/<os>-<arch>/<version>`, which TUF checks for length and hash, and **refuses any
  version not greater than the running one** (semantic-version compare). It stages the binary beside the installed one,
  runs `<staged> health` (it must start, load the config and print its own version, equal to the target), renames it
  into place and keeps the previous binary. On the next run, the installed binary's health check runs again; a failure
  restores the previous binary. Every outcome (`installed`, `rolled_back`, `refused`, `failed`) is reported with a
  fixed code, and a `rolled_back` or `failed` result halts the rollout.

### 5. One-line enrolment

`POST /v1/discovery/sources/:sourceId/one-line-enrolments` issues an enrolment token that is:

- **short-lived**: 15 minutes by default, at most 60 (a CHECK);
- **single-use**: device cap 1 (a CHECK), consumed by the first redemption;
- **scope-limited**: it redeems a device ticket for its own source only, and optionally places the device in one
  device group of that source (a composite foreign key, so the group cannot belong to another source). It reaches no
  other route;
- **never logged**: only its SHA-256 is stored; the gateway logger redacts the Authorization header; the audit rows
  name the token id, never the secret. On the device, `regulait-agent enrol` reads the token from standard input, never
  from an argument (an argument is visible to every user in the process list), and never writes it to disk or a log.

The response carries the one line to paste as root, for example
`printf '%s\n' '<token>' | sudo regulait-agent enrol` (`printf` is a shell builtin, so the token is not in the
process list). The token is consumed on use, so a copy left in shell history is inert.

### 6. EDR integration (slice 2)

- **Adapters.** One vendor-neutral interface (`EdrAdapter`): `verifyWebhook`, `listDeviceRisk`, `listAlerts`,
  `requestIsolation`, `releaseIsolation`, `isolationStatus`. Three implementations: Defender for Endpoint, Falcon,
  SentinelOne. A connection's credentials are sealed server side (the existing connector-credential store) and are
  never returned by any route.
- **Read-only by default.** A new EDR connection can only read. Ingest maps the EDR's device record to a RegulAIt
  endpoint device by the device pseudonym (the EDR hostname keyed-hashed with the discovery data key; no hostname is
  stored in clear) and stores a normalised signal (`risk`: `none | low | medium | high | critical`, alert counts by
  severity, observed at). The signal feeds the device risk shown on the device and is offered to the detection engine
  (lane E15, PR #865) as an event source.
- **Isolation (optional).** Turning isolation on for a connection is a `settings_relax` step-up, audited. Each request to
  isolate a device goes through the Approvals Queue (an approver other than the requester) and a fresh step-up of the
  approver. It only narrows access: the EDR cuts the device's network, and RegulAIt applies the device quarantine lane
  E15 builds (its detection responses, PR #865 and its follow-ups), not a parallel one. Releasing isolation is the same flow with a `settings_relax`
  step-up, because it widens access back.
- **Isolation lifecycle** (declared table): `requested → approved → submitted → isolated`, `requested → rejected`,
  `submitted → failed`, `isolated → release_requested → released`, terminal `rejected`, `failed`, `released`.
- **Webhooks** carry an HMAC-SHA256 signature over `timestamp.body`, verified with a timing-safe compare, a 5-minute
  window, and a replay table keyed by the vendor's event id.

## Consequences

- An org that does nothing gets nothing new: self-update stays off, no rollout can start, no directive is signed, and
  EDR connections read only.
- A package-managed binary replaced by self-update differs from the package database until the next package upgrade
  overwrites it; MDM-managed fleets can keep self-update off (the default) and keep upgrading through MDM.
- The update path depends on the device-policy signer (lane E16, PR #867) for the directive; slice 1c lands after it.

## Slices

1. **1a (gateway):** this ADR, device groups, the self-update setting, rollouts and their lifecycle, one-line
   enrolment tokens.
2. **1b (agent):** `regulait-agent enrol` (token on standard input) and the TUF-verified updater with health check and
   rollback.
3. **1c (gateway):** the signed directive in the config response, the read-only TUF repository route and the device's
   update-result route (which halts a rollout).
4. **2 (gateway):** EDR adapters, signal ingest, verified webhooks and governed isolation.

## Owner questions (built with the secure default)

- Should a halted rollout's failure threshold be configurable (for example 2 % of a stage)? Built: the first failure
  halts; an admin resumes after looking.
- Should the self-update setting be per source (built) or per device group?
