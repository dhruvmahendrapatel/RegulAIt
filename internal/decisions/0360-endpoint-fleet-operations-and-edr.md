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

- The setting `selfUpdate` is per ADR-0350 device group (owner decision D-2026-11-22-04; first built per source) and
  `false` by default (`endpoint_device_group_fleet_settings`, absent row = off; deleting the group deletes its row).
  Turning it on is a `settings_relax` step-up whose facts bind it to the group (`requireStepUp` with `{op, groupId,
  selfUpdate}`, so a grant for another group or setting does not count), audited under the group, and the step-up method and audit
  row are recorded on the settings row (a CHECK holds "on" to a recorded relaxation, as migration 0208 does for long
  token expiry). Turning it off needs no step-up and is audited.
- A rollout starts or resumes only when every stage whose group still exists has self-update on; the refusal names the
  groups that do not. A device is offered an update only while the group of the stage that offers it has it on.
- The agent's local config cannot turn it on: `config.go` names self-update a server-side relaxation, and the config
  file has no member for it. The device only acts on a signed directive (below).

### 3. Staged rollouts: a declared lifecycle

A rollout names one target version and an ordered list of stages, each one ADR-0350 device group. At most one rollout per
source is open (not `completed` or `aborted`; a partial unique index).

Rollout lifecycle (`endpoint_update_rollouts.state`, declared once as `ENDPOINT_ROLLOUT_MACHINE` in `@regulait/shared`):

| Event | From | To | By |
|---|---|---|---|
| `request_start` | `draft` | `start_requested` | admin; refused while self-update is off (slice 1c) |
| `approve_start` | `start_requested` | `running` (stage 1 becomes `active`) | a second admin, never the requester, with an `approval_decide` step-up bound to the rollout and the decision (slice 1c) |
| `reject_start` | `start_requested` | `draft` | a second admin, as above (slice 1c) |
| `expire_start` | `start_requested` | `draft` | system: undecided for 24 hours (slice 1c) |
| `advance` | `running` | `running` (the active stage is `done`, the next is `active`) | admin |
| `complete` | `running` (last stage active) | `completed` | admin |
| `pause` | `running` | `paused` | admin |
| `request_resume` | `paused`, `halted` | `resume_requested` | admin; refused while self-update is off (slice 1c) |
| `approve_resume` | `resume_requested` | `running` | a second admin, never the requester, with an `approval_decide` step-up (slice 1c) |
| `reject_resume` | `resume_requested` | `paused` | a second admin, as above (slice 1c) |
| `expire_resume` | `resume_requested` | `paused` | system: undecided for 24 hours (slice 1c) |
| `halt` | `running` | `halted` | system: failed installs or rollbacks reached the rollout's halt threshold (strict default 1: the first failure halts) |
| `abort` | `draft`, `start_requested`, `running`, `paused`, `halted`, `resume_requested` | `aborted` | admin |

**Two people for a start or resume (slice 1c, review lessons of #979).** Starting or resuming a rollout is the step that
replaces the agent binary across a fleet, so one signed-in admin asks and a different signed-in admin decides. Every
rollout action needs a person's session (the bootstrap credential and keys get 403 `user_required`). The rollout row
records the requester and the decider (`approval_requested_by`, `approval_decided_by`; user FKs restrict), and CHECKs
hold that a waiting rollout names its requester and that the decider is never the requester. `advance` stays a single
admin's step: it moves through the stages the second admin already approved. Pause, abort and the system's halt only
stop the offer.

`completed` and `aborted` are terminal. Stage lifecycle (`endpoint_update_rollout_stages.state`): `pending → active →
done`, `done` terminal. Every write is a guarded `UPDATE … WHERE state IN (sources of the event)`, so a concurrent or
stale write matches no row and is refused (409), never overwriting a newer state. Turning self-update off does not
change a rollout's state; it stops every directive at once (the device route answers "no update" while it is off).

**The halt threshold** (owner decision D-2026-11-22-04: configurable but bounded). `endpoint_update_rollouts.halt_threshold`
counts the failed installs or rollbacks that halt the rollout. Its strict default is 1 and its bounds are 1 to 10
(`ENDPOINT_ROLLOUT_HALT_THRESHOLD`, held by a CHECK). `PUT /v1/discovery/update-rollouts/:rolloutId/halt-threshold`
changes it on an open rollout. Lowering it is a tightening and needs no step-up. Raising it is a relaxation: a
`settings_relax` step-up bound to `{op, rolloutId, haltThreshold}`, never past 10. The step-up method and audit row are
recorded on the rollout (a CHECK holds any value above 1 to a recorded relaxation) and cleared when the value returns to
1. Every change is audited. The count is a number of devices, not a percentage, so the cap means the same thing in a
small fleet as in a large one.

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
  notAfter}` (at most 24 hours). Only while the rollout is running and the device's group has an active stage whose
  group has self-update on.
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
  key never signed. The mitigations are the offline release key, the per-group switch (off by default, a step-up to
  turn on), staged rollouts, and the halt threshold (the first failed install by default, at most 10).

### 4a. Delivery (slice 1c, as built)

The update offer has its own device routes (the config route still answers 503 until the collection pack is signed):

- `GET /v1/endpoint-agent/update` (the device's self token): `{update: null}`, or the device's offer: `attemptId`, the
  directive, the release manifest, and `{path, os, arch, length, sha256}` of the binary. A device is offered the update
  only while its source has a `running` rollout, the device is in the set the rollout's start or resume approval
  captured (below) and still in its stage's group, that stage has been reached (`active` or `done`), the group's
  self-update is still on (read at every offer), the device does not already run the
  version, its attempt is not settled, the execution dial is `normal` (the signature is behind the ADR-0338 barrier,
  `device_policy.sign_payload`) and the release verifies. The device's updater still refuses anything not newer than
  what runs, so the gateway never orders versions itself.
- `GET /v1/discovery/update-rollouts/:rolloutId/attempts` (admin): the rollout's per-device attempts, paged under the
  list contract, each with its declared lifecycle and reported code, so an admin deciding a resume after a halt sees
  which devices failed and why.
- `GET /v1/endpoint-agent/update/binary`: the binary of the device's own open offer, nothing else (no parameters).
- `POST /v1/endpoint-agent/update-results`: the root updater's one outcome. It settles the attempt (a repeat is 409
  `already_reported`; another device's attempt is 404), and failed or rolled-back attempts reaching the halt threshold
  halt the rollout in the same transaction.

**The directive** is signed by the rotatable device-policy signer over its own domain
(`regulait.endpoint-update-directive/1` and a NUL, then the payload: the #1033 rule), so it never verifies as a policy or
an ADR-0331 directive. Slice 1b's updater verified the bare payload; slice 1c changes both ends to the domain. It lives
at most 60 minutes and never past its attempt's expiry (the device refuses one longer than 24 hours).

**The approval fixes the devices** (security review of #1248). When a second admin approves a start or resume, the
gateway captures every unrevoked device then in the stage groups into `endpoint_update_rollout_devices`, each with the
first stage (in ordinal order) whose group held it; the audit row of the approval records the count. The offer reads
that set, not the live membership, so adding devices to a stage's group afterwards (one admin, or an enrolment token
bound to the group) never widens what two people approved: those devices wait for the next resume approval, which
re-captures the membership. Removing a device from its group, or turning the group's self-update off, still narrows
the rollout at once.

**Stopping a rollout.** Pause, abort and halt stop new offers at once: the offer route holds the rollout row `FOR SHARE`
until the directive is signed, and each of those writes takes it `FOR UPDATE`, so no directive is signed for a rollout
that has already stopped, and the binary route re-checks the offer. A device that already holds a signed directive and
its binary can still install it until the directive's `notAfter`, at most 60 minutes later; that window is accepted
(the device still checks the release signature and refuses anything not newer) and is the reason the lifetime is short.
The halt count is cumulative over the rollout: a resume after a halt does not reset it, so with the strict threshold of
one the next failure halts again, and an admin who wants more failures tolerated raises the threshold (a step-up).
Rejecting or letting expire a resume request returns the rollout to `paused`, also when it was asked from `halted`; the
halt itself stays on the record as its audit row (`endpoint-update-rollout-halt`) and in the failed attempts.

**Releases** come from a read-only directory the operator deploys (`REGULAIT_AGENT_RELEASES_DIR`: `<version>/release.json`
and `<version>/regulait-agent-<os>-<arch>`). It works air-gapped and adds no upload surface. The release public keys are
`REGULAIT_AGENT_RELEASE_KEYS`, a JSON file of one or two `{keyId, x}`; they rotate by overlap (add the next key, publish
releases signed with it, drop the old one), matching the at-most-two keys a device pins. Both are read at every offer.
The gateway serves the manifest byte for byte, but first checks it against those keys and checks the binary's length
and SHA-256; a release that does not verify is never offered, and the refusal is audited with a fixed code.

**Attempt lifecycle** (`endpoint_update_attempts.state`, `ENDPOINT_UPDATE_ATTEMPT_MACHINE`): `directed` →
`installed` | `current` | `refused` | `failed` | `rolled_back` (the device's report), `directed → expired` (no report
within 24 hours, the `endpoint-update-expiry` job) and `expired → directed` (offered again while the rollout still
offers it; a late report still settles an expired attempt). One attempt per device and rollout.

**The per-user agent** fetches the offer each sync and writes the spool: the binary first (streamed to a temporary file,
its length and SHA-256 checked, then renamed), then the manifest, the directive last, so the root updater never sees a
directive without its binary. It reports `result.json` back with the attempt id, only if the file is root's (a local user
cannot forge a failure to halt a rollout), and keeps it until the gateway records it. The update sync runs on every
sync whether or not the collection half (the config route) succeeds, so delivery does not wait for the pack.

**One outcome per directive** (review of #1248). The root updater runs hourly, the per-user agent syncs daily, so the
root updater consumes the directive as soon as it reads it and never overwrites a result the agent has not reported:
while `result.json` is pending it does nothing. The agent removes the result once the gateway records it (or refuses
it for good: a 4xx other than 401, 403, 408 and 429), or, where the sticky spool stops it removing root's file, writes
`result.ack` holding the result's SHA-256, which the root updater treats as reported. The first real outcome (an
install, a failure, a rollback) is the one the gateway sees, so a rollback is never re-installed and a failure is never
replaced by a later `directive_stale`. Every version is at most 32 characters, at both ends.

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

- **Adapters.** One vendor-neutral interface (`EdrAdapter`, `apps/gateway/src/edr/adapters.ts`): `listDevices`,
  `listAlerts`, `requestIsolation`, `releaseIsolation`, `actionStatus`, `verifyWebhook`. Three implementations:
  Defender for Endpoint (`/api/machines`, `/api/alerts`, `/api/machines/{id}/isolate|unisolate`,
  `/api/machineactions/{id}`; Entra client credentials), Falcon (`devices-scroll`, `alerts/v2`,
  `devices-actions/v2?action_name=contain|lift_containment`; OAuth client credentials) and SentinelOne (`agents`,
  `threats`, `agents/actions/disconnect|connect`; API token). Every answer is zod-validated and reduced to fixed enums
  and counts; a failure is a fixed code, never the vendor's body.
- **Credentials stay server side.** A connection's secret and webhook secret are sealed with the data key
  (`encryptSecret`) and never returned; the webhook secret is shown once, at creation. Both rotate in place without
  losing the connection's evidence, each behind a `settings_relax` step-up bound to the connection and audited:
  `POST /v1/edr-connections/:id/credential` replaces the vendor credential, and
  `POST /v1/edr-connections/:id/webhook-secret/rotate` shows a new webhook secret once and stops the old one at once.
- **Guarded fetch.** Every call goes through `guardConnectionCall` with a new `edr_connection` surface: the base URL is
  checked against the egress allow-list and audited, and the returned guarded fetch re-checks every request (DNS
  pinned, SSRF blocked, no redirects), so Defender's sign-in host must be allow-listed too. A disallowed base URL is
  refused when the connection is created.
- **Read-only by default.** A new connection can only read. Sync (every 15 minutes, or on demand) maps each EDR device
  to an enrolled device of the same source by the device pseudonym (the EDR host name keyed-hashed with the discovery
  data key; no host name is stored) and replaces its signal (`edr_device_signals`: `risk` none to critical, open alert
  counts by severity, isolated at the vendor). Falcon has no per-host risk, so a host's risk is its worst open alert.
  A rise to high or critical writes an `edr-device-risk-raised` audit row (effect `deny`), which the detection engine
  and the SIEM export read from the audit stream.
- **Webhooks** are verified before anything is read from the body, with one 401 answer for every refusal:
  - Falcon: `X-Cs-Primary-Signature` = base64(HMAC-SHA256(secret, body ‖ `X-Cs-Delivery-Timestamp`)), compared in
    constant time (`constantTimeEqual`), with a 5-minute window against the database clock.
  - SentinelOne sends no signature: the console is configured to send the RegulAIt-generated token in
    `x-regulait-webhook-token`, compared in constant time, and the event's own `createdAt` must be within 5 minutes.
    A slow or retried SentinelOne delivery is therefore refused (401, audited `deny`); the 15-minute sync covers the gap.
    Whether SentinelOne can send a delivery timestamp to check instead is part of the live-tenant check in the E41
    pending fragment, item (c).
  - Defender pushes no webhooks (it streams to Event Hubs), so none is accepted.
  - Replay: one row per (connection, vendor event id) in `edr_webhook_deliveries`, kept 24 hours.
- **Isolation (optional, narrowing only).** Turning isolation on for a connection is a `settings_relax` step-up bound to
  that connection, recorded on the row (CHECK) and audited. A request names one device that EDR has reported, with a
  reason. **Two people, both signed in:** a request, a release request and every decision need a person's session (the
  bootstrap credential and keys get 403 `user_required`), the requester column is NOT NULL, and the user FKs restrict so
  the people stay on the evidence. An admin other than the requester decides (also a CHECK on the row), with a fresh
  `approval_decide` step-up bound to the request and the decision, before anything is sent to the vendor. Releasing
  widens access back, so it is the same with a `settings_relax` step-up bound to the request. One open request per
  device.
- **Isolation lifecycle** (`EDR_ISOLATION_MACHINE` in `@regulait/shared`'s `edr.ts`, an ADR-0348 `defineMachine` registered in `STATE_MACHINES`): `requested →(approve)
  submitting →(confirm) isolated →(request_release) release_requested →(approve_release) releasing →(confirm_release)
  released`; `requested →(reject | expire) rejected`; `submitting →(fail) failed →(vendor_isolated) isolated`;
  `release_requested →(reject_release | expire_release) isolated`; `releasing →(fail_release) isolated`;
  `isolated →(vendor_released) released`. `rejected` and `released` are terminal; `failed` is not, but it does not
  hold the device's one open-request slot. Every write is a guarded UPDATE (`whereFrom`) with its audit row in the
  same transaction. The system events, every minute and on each sync:
  - the vendor's action status settles `confirm`, `fail`, `confirm_release` and `fail_release`. Falcon and SentinelOne
    have no action object, so a host that has not moved yet counts as pending;
  - an action still pending after 30 minutes (`EDR_ACTION_SETTLE_MINUTES`) fails `vendor_timeout`, and a request left
    in submitting or releasing with no vendor action id for 10 minutes (a restart mid-call) fails `stranded`, so no
    row holds a device's slot for good;
  - a request or release request nobody decides within 24 hours (`EDR_DECISION_TTL_HOURS`, a strict compiled default)
    expires: `requested → rejected`, `release_requested → isolated`;
  - each sync reconciles against the vendor's real isolation state when the vendor reports it (MDE may omit it). A
    `failed` request whose device the vendor did isolate (a timeout, MDE's "already in progress") goes back to
    `isolated`, so its release is governed again. An `isolated` request whose device the vendor no longer isolates
    (released in the vendor console) goes to `released`, audited `edr-release-outside-governance` (effect `deny`).
- **Device quarantine.** Lane E15's detection responses (PR #865) have no device quarantine yet. This lane builds no
  parallel one: when E15's lands, an `isolated` request applies it too (PENDING).

### As built: why not the Approvals Queue rows

The brief asks for approval and step-up. The Approvals Queue's rows (`approvals`) are bound to a tool call's arguments
and are spent when the requester re-submits the same call (`spendBoundApproval`). An isolation is not a re-submittable
call, so the request row carries its own two-person decision under the declared lifecycle, with the same rules: the
requester never decides, and the approver steps up with `approval_decide`. Listing these requests in the Approvals
Queue screen is a UI follow-up on #453.

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
3. **1c (gateway and agent):** the signed directive and release manifest on the device's update route (§4a), the binary
   download route, the per-user agent's spool writer, the device's update-result route (which halts a rollout), and two
   people for a rollout's start and resume (§3).
4. **2 (gateway):** EDR adapters, signal ingest, verified webhooks and governed isolation.

## Owner questions (answered 2026-11-22, DecisionLog D-2026-11-22-04)

- The halt threshold is configurable but bounded: tightening is free, loosening is capped and audited (§3).
- The self-update setting is per device group, default off (§2).
