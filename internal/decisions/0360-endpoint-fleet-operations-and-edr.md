# ADR-0360: Endpoint agent fleet operations (staged signed self-update, one-line enrolment) and EDR integration

- **Status**: Proposed (builder lane E41, 2026-11-17; owner decision 2026-11-17, competitor gap audit DarkControl row 21
  and Manifold row 14)
- **Date**: 2026-11-17
- **Index**: Endpoint fleet ops: staged rollouts over ADR-0350 groups, off-by-default signed staged self-update, one-line enrolment, EDR adapters
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
| go-tuf v2 (`theupdateframework/go-tuf/v2`, CNCF TUF) | Apache-2.0 | v2.4.2, 2026-05-19 | The strongest model: threshold keys, root rotation, metadata rollback and freeze protection, pluggable fetcher. | **Rejected at admission** (checked 2026-11-17 against `proxy.golang.org`): its linked closure (`metadata` imports `sigstore/sigstore/pkg/signature`, which imports `go-containerregistry/pkg/name`) includes `opencontainers/go-digest` v1.0.0 (2020-05-14) and `cenkalti/backoff/v5` v5.0.3 (2025-07-23), neither with a newer release, so it fails the 12-month rule as the agent applies it (`agents/endpoint/THIRD_PARTY.md` kept `wmi` and `go-ole` out for the same reason). It would also add about 12 MB and nine modules to a binary that root runs. Re-check when go-tuf's closure is maintained. |
| minio/selfupdate | Apache-2.0 | v0.6.0, 2022-10-19 | Binary swap with optional minisign check. | Rejected: no release in four years (fails "actively maintained"). |
| fynelabs/selfupdate | Apache-2.0 | v0.2.1, 2025-07-07 | Same lineage as minio's (inconshreveable/go-update). | Rejected: no release in the last 12 months. |
| creativeprojects/go-selfupdate | MIT | v1.7.1, 2026-11-10 | Release discovery from GitHub, GitLab and Gitea; checksum, ECDSA or PGP validation. | Rejected: built around public forge APIs (pulls go-github, the GitLab client and the Gitea SDK), which an air-gapped fleet cannot reach, and its validators are a single key, not a rotatable, threshold-signed root. |

**Chosen: the agent's existing signed envelope, with its own release keyring.** The agent already verifies the
device-policy signer's envelope (`{keyId, payload, signature}`, Ed25519 over the exact payload bytes, standard library
`crypto/ed25519`) against a pinned keyring of at most two keys (current and next, so a rotation never strands a device).
Release manifests use the same verifier (`enforce.VerifyEnvelope`, extracted for both) with a **separate** keyring,
`releaseKeys`, pinned in the root-owned config: one key per purpose, and the release key stays with the release
pipeline (offline), never on the control plane. Versions are compared by `golang.org/x/mod/semver` (BSD-3-Clause, the Go
team's module, already the reference implementation for Go module versions).

**What we write ourselves (narrow exception, ADR-0176 §4):** the manifest format (four fields), and the binary swap (stage
next to the binary, run the staged binary's health check, rename, keep the previous binary, restore it when the
post-install health check fails). The unmet requirement is the maintained-dependency rule above: no validated module
covers either. Re-check when go-tuf's closure or a maintained swap module qualifies.

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

### 1. Device groups: ADR-0350's, reused

The rollout stages are lane E31's device groups ([ADR-0350](0350-endpoint-command-file-package-rules.md):
`endpoint_device_groups`, `endpoint_device_group_members` and the `/v1/endpoint-device-groups` routes). This lane
adds no group concept of its own (first drafted as per-source rings; replaced on 2026-11-21 when ADR-0350 merged first).

- ADR-0350 groups are org-wide and a device may be in several. A stage offers the update to the members of its group
  that are devices of the rollout's source; a device in several staged groups is offered it by the first stage, in
  ordinal order, that holds it.
- An ADR-0350 group only narrows a device's policy (its rules are ask or deny), so placing a device in one, as the
  one-line enrolment does, is never a relaxation. Leaving or deleting a group stays ADR-0350's step-up.
- A rollout never blocks ADR-0350's group delete: the stage's and the token's foreign keys are `ON DELETE SET NULL`.
  The stage keeps the group's name as evidence (a point-in-time snapshot) and then offers the update to no device.

### 2. Self-update: off by default, a relaxation

- The per-source setting `selfUpdate` is `false` by default (`endpoint_fleet_settings`, absent row = off). Turning it on
  is a `settings_relax` step-up whose facts bind it to the source (`requireStepUp` with `{op, sourceId, selfUpdate}`, so a grant for another source or setting does not count), audited, and the step-up method and audit
  row are recorded on the settings row (a CHECK holds "on" to a recorded relaxation, as migration 0208 does for long
  token expiry). Turning it off needs no step-up and is audited.
- The agent's local config cannot turn it on: `config.go` names self-update a server-side relaxation, and the config
  file has no member for it. The device only acts on a signed directive (below).

### 3. Staged rollouts: a declared lifecycle

A rollout names one target version and an ordered list of stages, each one ADR-0350 device group. At most one rollout per
source is open (not `completed` or `aborted`; a partial unique index).

Rollout lifecycle (`endpoint_update_rollouts.state`, declared once as `ENDPOINT_ROLLOUT_MACHINE` in `@regulait/shared`):

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

Both tables are ADR-0348 machines declared with `defineMachine` (`packages/shared/src/endpoint-fleet.ts`) and
registered in `STATE_MACHINES`, so `GET /v1/state-machines` lists them and the CHECK-equality test covers both columns.
Every state write is guarded with `whereFrom(column, machine, event)`, and the API returns `machine.describe(state)`.

### 4. The device side (slice 1b and 1c)

- **Trust.** The release pipeline signs a release manifest per version with the offline release key:
  `{schema: "regulait.endpoint-release/1", version, issuedAt, targets: [{os, arch, sha256, length}]}` in the signed
  envelope. The admin pins the release public keys (`releaseKeys`, at most two) in the agent's MDM-placed, root-owned
  config; without a pinned release key the updater never runs. Pinning a trust anchor is not a relaxation: like the
  device-policy keys (ADR-0330 B4), it only says whose signatures count.
- **Directive.** The gateway answers the per-user agent's existing config request with an update directive signed by
  the device-policy signer (ADR-0330 B4 as lane E16 builds it, PR #867; the same envelope `{keyId, payload, signature}`
  and pinned keyring as the enforcement policy). Payload: `{schema, deviceId, rolloutId, targetVersion, issuedAt,
  notAfter}` (at most 24 hours). Only while self-update is on, the rollout is running and the device's group has an
  active stage.
- **Transport is untrusted, verification is not.** The per-user agent (which holds the self token) downloads the
  directive, the release manifest and the binary into a spool directory (`/var/lib/regulait-agent/update`). The root
  updater (`regulait-agent update`, a system timer the package installs) trusts none of it: it verifies the directive
  against the device-policy keys, checks it names this device (the ticket file's device id) and is fresh, verifies the
  manifest against the release keys, checks that the manifest's version is the directive's, copies the binary into a
  root-only staging file and checks its length and SHA-256 there (so a later change to the spool cannot swap what runs),
  and **refuses any version not greater than the running one**. A local user can replay an old directive or manifest but
  cannot forge either; an old one names an older or equal version, which is refused or a no-op.
- **Install.** It runs `<staged> health` (it must start, load the config and print its own version, equal to the
  target), renames it into place and keeps the previous binary. On the next run, the installed binary's health check runs
  again; a failure restores the previous binary. Every outcome (`installed`, `rolled_back`, `refused`, `failed`) is
  written with a fixed code to a result file the per-user agent reports, and a `rolled_back` or `failed` result halts
  the rollout.
- **Hardening the updater must meet (review of #962, checked against the slice 1b/1c code):**
  - the spool is read with `O_NOFOLLOW` (`openat` under the spool directory), bounded by the manifest's `length`, and
    copied into a root-only staging file before it is hashed, so the bytes hashed are the bytes run;
  - versions are compared with `golang.org/x/mod/semver` on a valid `v`-prefixed form only (an invalid version is
    refused, never treated as equal), and an install needs `semver.Compare(target, running) > 0`.
- **What self-update does not protect against (stated, not hidden).** There is no device-side off switch once the
  admin pins a release key and turns self-update on: a compromised gateway can direct a device to any *newer* release
  that the offline release key signed. It cannot supply an unsigned or older binary, a key, or a release the release
  key never signed. The mitigations are the offline release key, the source-level switch (off by default, a step-up to
  turn on), staged rollouts, and the halt on the first failed install.

### 5. One-line enrolment

`POST /v1/discovery/sources/:sourceId/one-line-enrolments` issues an enrolment token that is:

- **short-lived**: 15 minutes by default, at most 60 (a CHECK);
- **single-use**: device cap 1 (a CHECK), consumed by the first redemption;
- **scope-limited**: it redeems a device ticket for its own source only, and optionally places the device in one
  ADR-0350 device group (which only narrows the device's policy). It reaches no other route;
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

1. **1a (gateway):** this ADR, the self-update setting, rollouts over ADR-0350 device groups and their lifecycle, one-line
   enrolment tokens.
2. **1b (agent):** `regulait-agent enrol` (token on standard input) and the root updater: directive and manifest
   verification, the downgrade refusal, staging, health check and rollback.
3. **1c (gateway and agent):** the signed directive and release manifest in the config response, the binary download
   route, the per-user agent's spool writer, and the device's update-result route (which halts a rollout).
4. **2 (gateway):** EDR adapters, signal ingest, verified webhooks and governed isolation.

## Owner questions (built with the secure default)

- Should a halted rollout's failure threshold be configurable (for example 2 % of a stage)? Built: the first failure
  halts; an admin resumes after looking.
- Should the self-update setting be per source (built) or per device group?
