# ADR-0350: On-device command, file and package rules for coding agents

- **Status**: Proposed (slice 1 built, default off)
- **Date**: 2026-11-17
- **Index**: On-device shell-command, file and package rules (Allow / Ask / Deny) for coding agents
- **Builds on**: ADR-0298 (on-device enforcement, signed policy, fail closed), ADR-0330 (the adapter layer for Claude
  Code, Cursor, Copilot CLI and Codex; §8 B4, the single device-policy signer), ADR-0040 (Cedar for ABAC),
  ADR-0014/ADR-0310 (per-user entitlements and the managed-settings bundles compiled from them), ADR-0180 (secure by
  default), ADR-0176 (open source first), ADR-0200 rule 12 (explicit state machines).
- **Gap analysis**: `internal/product/GAP_ANALYSIS_DARKCONTROL_2026-11.md` §3 items 1 and 3 (capabilities #1, #2, #3, #7).

## Context

Our hook adapters decide MCP tool calls only. A coding agent's built-in shell, its file reads and writes, and the
packages it installs get "no decision" by design (ADR-0298 §1, ADR-0330 §1). Endpoint-only products sell exactly
that missing piece: command, file and package rules with Allow, Ask or Deny, assigned per group or device, with
time-boxed exceptions. Owner decision 2026-11-17: close those gaps on the same signed device policy.

The four vendor contracts were re-checked on **2026-11-17** against first-party docs only (code.claude.com/docs/en/hooks,
cursor.com/docs/hooks, docs.github.com/en/copilot/reference/hooks-reference, developers.openai.com/codex/hooks). What
each lets a hook see differs a lot, so the capability matrix (§4) is part of the decision.

## Decision

### 1. One neutral `Command` decision beside the MCP decision

`Call` gains `Command *CommandCall`: a shell command line (or an argv), or the file accesses a file tool performs,
with the call's working directory and workspace roots. `Decide` routes it to one engine shared by every adapter; the
adapters only translate. Verdicts gain `Ask`, rendered through each agent's own permission prompt. An ask that the
agent cannot show for that action is a **deny** (fail closed), with the reason saying so. With no valid policy every
governed built-in call is denied, as MCP calls already were. Audit mode decides but never blocks (`WouldDeny`,
`WouldAsk`). Each decision names the rule (or default) that decided it, for the decision record (§7).

The policy schema becomes `regulait.endpoint-enforcement/2` with a **required** `commands` section. Schema 1 was never
issued (no signer was live), so nothing is grandfathered and schema 1 is refused.

### 2. A closed rule list, argv-aware

Rules are data, never code, and every default is stated in the policy (the device never invents one):

| Kind | Matches | Default when no rule matches |
|---|---|---|
| exec | one doublestar glob per argument; `argv[0]` by base name unless the pattern has a `/`; a final `**` is "any remaining arguments" | `default` |
| file | access (`read`, `write`, `any`) and an absolute path glob (`/`, `~/`, `**/`, `C:/`) | inside the workspace: allow; outside: `outsideRead` / `outsideWrite` |
| package | ecosystem (`npm`, `pypi`, `apt`, `dnf`, `apk`, `brew`, `cargo`, `go`, `gem`, `*`) and a name glob | `packages.default` |
| unresolved | anything the parser cannot reduce to literal words | `unresolved` (ask or deny, never allow) |

Each call is reduced to actions and **the strictest verdict of every action wins** (deny, then ask, then allow), so an
allow never overrides a deny. A catch-all allow rule is refused at load (the default is the catch-all). Rule ids are
unique; `default.*` and `unresolved` are reserved.

A command line is parsed as bash by `mvdan.cc/sh` (§8): lists, pipelines, subshells, quoting and escapes are split
as a shell splits them, every simple command is one exec action, commands inside a substitution are found and
decided on their own, and redirections to files are file actions (`/dev/null` and the standard streams excepted). A
declared table unwraps programs that run another program (`sudo`, `doas`, `env`, `nice`, `nohup`, `time`, `timeout`,
`command`, `exec`, `builtin`, `stdbuf`, `ionice`, `xargs`, `watch`, `find -exec`, `sh -c` up to three levels), and
both the wrapper and what it wraps are decided. `eval`, `source`, `.`, a shell started on a script file, a variable or
command substitution in a word, `$'…'`, a coprocess and PowerShell are **unresolved**. A second declared table
recognises installs and run-a-package launchers (`npm/pnpm/yarn/bun install|add|ci`, `npx`, `bunx`, `pnpm dlx`,
`pip`, `python -m pip`, `uv`, `uvx`, `pipx`, `apt`, `apt-get`, `dnf`, `yum`, `apk`, `brew`, `cargo`, `go install|get`,
`gem`) with each manager's value-taking options, so a value is never read as a name. Names lose their version, extra
or tag (`left-pad@1` is `left-pad`; `Flask_Login[x]>=1` is `flask-login`); an install from a manifest is one install
with an empty name.

File paths are made absolute against the call's working directory, cleaned (so `..` cannot step out of a rule), and
resolved through symlinks on the longest existing prefix. The workspace is the call's `cwd` plus the agent's own root
(Claude Code's `CLAUDE_PROJECT_DIR`, Cursor's `workspace_roots`). Path matching is case-insensitive on Windows and
macOS.

**This is a guardrail, not containment.** Matching is on what the command line says, never on what a program does: a
renamed or copied binary, a script file, an interpreter one-liner (`python -c`), an option order a rule did not
foresee, or an agent that writes files through its shell rather than its file tool is not seen through. We ship and
describe it that way. The gateway stays the enforcement point that cannot be bypassed for model and MCP calls.

### 3. Exceptions and device binding

A policy may carry `exceptions`: each relaxes one named rule to a less strict verdict until `notAfter`. The device
refuses an exception that tightens, names no rule, has no expiry, ends after the policy, or lasts more than **seven
days** from issue; a policy with exceptions must name its `device`, and an exception applies only when that device id
equals this device's. Expiry is checked on the device clock on every call, so an exception lapses on time offline.
Slice 1 never sets the device id on the device (the hook runs as the user and cannot read the agent's owner-only
state), so **no exception applies yet**: strict until slice 2 delivers the policy with the device id beside it.

### 4. Capability matrix, stated per agent (`regulait-agent hook-capabilities`, `capabilities.commands`)

| Agent | Shell | File read | File write | Vendor limits we state |
|---|---|---|---|---|
| Claude Code (`PreToolUse`) | ask | ask | ask | `@`-mentioned files are read with no tool call; PowerShell is unresolved; `NotebookEdit`'s `notebook_path` and `MultiEdit` are not in the field table |
| Cursor (`beforeShellExecution`, `beforeReadFile`) | ask | block (allow/deny only) | **none** | no documented pre-write hook with a path (`afterFileEdit` runs after); `failClosed` only in the enterprise hooks file |
| Copilot CLI (`preToolUse`) | ask | **none** | **none** | `toolArgs` fields are undocumented (we read `command`; without it the call is unresolved); ask is a deny under autopilot; a timeout always fails open |
| Codex (`PreToolUse`) | block | **none** | block (`apply_patch` headers) | deny only (ask is a deny); no read hook; hook errors and timeouts let the call run |

Where a cell says none, we decide nothing and say so. Contract versions move to `2026-11-17` with new fixture
directories. Four expected answers in older fixture directories changed (inputs untouched): built-in shell calls are
now governed, so with no policy they deny.

### 5. Device groups and time-limited exceptions on the control plane (slice 3)

- **Device groups narrow, never replace, the person.** The subject stays the user (pillar 1). A device group's rules
  join the user's, and may only add ask or deny rules or raise a default's strictness; a group allow rule is refused,
  so a shared runner never carries anyone's widened entitlements.
- **Exceptions** ("lift rule R on device D for N hours") are rows with a declared lifecycle, one table in shared code,
  enforced server side and readable by agents:

  | From | To |
  |---|---|
  | requested | approved, rejected, cancelled |
  | approved | revoked, expired |
  | rejected, cancelled, revoked, expired | (terminal) |

  A reason is mandatory. Approval is a step-up (`requireStepUp`, a fresh MFA) by someone other than the requester,
  bound to the exact rule, device and expiry, and reuses the approvals queue's payload binding (ADR-0104/0105) rather
  than a second approval path. The expiry is mandatory; the default maximum is 24 hours and an admin may raise it to
  seven days (a `settings_relax` step-up, audited). Every transition is audited. `expired` is derived from the clock
  (database `now()`), and the device's own expiry check (§3) means a lapsed exception stops applying even before the
  next policy fetch.

### 6. One compiler, from the gateway's own entitlements (slice 2)

The control plane compiles each device policy from the **same per-user entitlement resolution the gateway enforces**
(roles, overrides, IdP groups; ADR-0014, ADR-0310), so device and gateway cannot disagree: the MCP section's allowed
servers are the user's entitled MCP servers, and command rule packs are a new entitlement kind assigned through roles
like any other, resolved by the same code path. Cedar stays where our policy semantics already live (ADR-0040,
`packages/policy-kernel`); the device receives only the compiled closed list. The policy is signed by ADR-0330 B4's
single device-policy signer (`device-policy-signer.ts`, lane E16), never a second signer. Compiled defaults are the
strict values (owner question below): exec `ask`, unresolved `ask`, outside read `ask`, outside write `deny`,
packages `ask`. Relaxing any of them is an audited `settings_relax` step-up.

### 7. Decision records

Every hook decision (including audit mode's would-deny and would-ask) is evidence. Lane E1 owns the endpoint
decision-audit slice; this lane emits through the interface E1 defines and writes no audit path of its own. Slice 1
exposes the fields a record needs (`Rule`, `Verdict`, `WouldDeny`, `WouldAsk`, the agent) and records nothing.

### 8. Open source compared (ADR-0176)

| Need | Option | Licence | Maintained | Fit | Chosen |
|---|---|---|---|---|---|
| Rule engine on the device | Cedar (`cedar-go` v1.9.2) | Apache-2.0 | yes (2026-11) | already our policy language on the control plane; but Cedar is permit/forbid only (no ask), has no ordered-argument matching, and would put a policy-text parser on every device | control plane only |
| | OPA / Rego (embedded) | Apache-2.0 | yes | general, but a large dependency tree and a full language interpreter on the device for a closed list | no |
| | A closed rule list over parsed argv (ours) | n/a | n/a | the smallest thing that meets "closed list, argv-aware, ask"; our own semantics, which is where ADR-0176 rule 4 allows our code | **yes** |
| Shell parsing | `mvdan.cc/sh/v3` v3.14.1 | BSD-3-Clause | yes (2026-09) | a full bash parser (shfmt's); we use only `syntax` | **yes** |
| | `github.com/google/shlex` | Apache-2.0 | no release since 2019 | splits words, not lists, pipes or substitutions | no |
| | a regex over the joined line | n/a | n/a | forbidden by the brief and trivially bypassed | no |
| Globs | `github.com/bmatcuk/doublestar/v4` v4.10.4 | MIT | yes (2026-10) | `**` that `path.Match` lacks; no dependencies | **yes** |

Both modules are pinned in `go.mod`/`go.sum` and listed in `agents/endpoint/THIRD_PARTY.md`; nothing is fetched at
run time.

### 9. One policy, every route (master brief 2026-11-17, owner-approved from the Manifold review)

The same action must get the same decision whether an agent reaches it through an MCP tool, a CLI on the device or a
direct API call. Creating a gist is the worked example: the GitHub MCP `create_gist` tool, `gh gist create`, and
`curl -X POST https://api.github.com/gists` are one action.

- **A declared action catalogue** in shared code (`packages/shared`, one JSON file, embedded in the Go agent and held
  equal to it by a CI check, as the secret rules already are). Each entry is a canonical action id
  (`github.gist.create`) with its recognisers on every route: MCP (server and tool names), CLI (argv globs, through
  §2's parser and wrapper table) and HTTP (method, host and path glob; on the device from `curl`, `wget`, `http` and
  `gh api` argv, on the gateway from the governed connector or egress request).
- **Action rules** (`actions: [{id, action, verdict}]`) live in the one policy the control plane compiles (§6). The
  compiler emits the gateway's rule and the device's rule from the same entry, so neither can be edited alone.
- **Conformance test:** one shared fixture file lists each action's equivalent calls on every route and the expected
  verdict for a given policy. The Go engine and the gateway's decision core each run the whole file in CI; a
  disagreement fails both suites. The gist example is the first fixture.
- **Unknown routes stay unknown.** An HTTP call whose method or URL is not literal is unresolved (§2), and an action
  the catalogue does not list is decided by the ordinary exec rules. Matching on the device is still textual.

### 10. Response vocabulary (lane E35)

Lane E35 defines graduated responses (advise, correct, block-session, disable) on the same decision model. On-device
decisions use that vocabulary when lane E35's ADR lands on main, rather than a second one. Until then the device's answers are the
agents' own (allow, ask, deny), and the mapping is agreed with E35 through the master: the proposed one is ask as
"advise" with confirmation, deny as a block of the call, and block-session and disable as control-plane responses
the device carries out by refusing every call (as a missing policy already does). Slice 2 builds that mapping.

### 11. Credential reuse across endpoints (owner-approved addition, 2026-11-17)

The same credential on several devices or users is a finding, found without anyone, including us, learning it.

- **On the device:** every reported key carries `fingerprint`, an HMAC-SHA256 of its value (domain-separated) under the
  tenant's **credential-reuse key**, and `fingerprintKeyId`, a 16-hex name of that key. The value is used only to
  compute the HMAC and is never reported or kept. The key is 32 random bytes made by `regulait-agent
  credential-reuse-key` and deployed by the admin, the same on every device of the tenant, in the agent's root-owned
  config (`credentialReuseKey`). No key: no fingerprints. A malformed key refuses the config.
- **On the control plane:** fingerprints are stored per agent identity (device and user pseudonym joined, never
  copied: `endpoint_credential_fingerprints`, migration `pending/endpoint_credential_fingerprints.sql`, RLS
  admin-only). A fingerprint held by two or more devices or users under the same key id is a finding: raised once per
  identity in the audit trail (`endpoint-credential-reuse-detected`) and listed by `GET /v1/endpoint-credential-reuse`,
  which shows a 12-character prefix only. Revoked devices stop counting. Env-name facts and switched-off MCP facts,
  which the report path refuses, contribute nothing.
- **The control plane never holds the key**, so a copy of its database cannot be used to test guesses offline. Anyone
  who can read the device's config can compute fingerprints of guesses, but sees no one else's; that is stated, and
  it is why the key is per tenant and rotatable (a new key id starts a fresh comparison).

### Slices

1. **This PR:** §1–4 and §8 in `agents/endpoint` (the engine, the four adapters, fixtures, the matrix). Default off.
2. The compiler (§6) in shared code and the gateway, signed by the B4 signer (stacks on #867), and policy delivery to
   the device with its device id; the action catalogue, action rules and the cross-route conformance test (§9); the
   E35 response mapping (§10).
3. Device groups and exceptions (§5): migration, routes (known UI gaps on #453), the lifecycle table, step-up, audit.
4. Credential reuse across endpoints (§11). Built.

## Owner questions open (built with the secure default)

- The compiled default for commands no rule matches: **ask** (secure default). Allow would make rules a deny-list only.
- The maximum exception length: **24 hours by default**, raisable to seven days; the device refuses longer.

## Consequences

- Shell, file and package actions on four agents are governed by the same signed policy as MCP calls, with an honest
  per-agent matrix; Cursor and Copilot CLI writes, and Copilot CLI and Codex reads, stay undecided until their vendors
  document a pre-hook that shows them.
- Registrations must name the built-in tools (Claude Code's matcher, Cursor's two extra events); `agents/endpoint/README.md`
  says how.
- A rule can be stepped around by anyone who controls the command text. That is stated in the matrix and the README,
  and is why the gateway, not the device, remains the boundary.
