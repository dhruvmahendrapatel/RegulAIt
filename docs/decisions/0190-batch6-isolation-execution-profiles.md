# ADR-0190: Batch 6 item 3 — isolation and execution profiles (PF-06)

- **Status:** Accepted (owner, 2026-10-10)
- **Date:** 2026-10-10
- **Deciders:** owner (the OWNER DECISION items below); the rest follows ADR-0180 (secure by default) and ADR-0176
  (open source first)
- **Builds on:** ADR-0183 §1 batch 6 item 3 (DELIVERY_PLAN_2026-10-06 §Batch 6: "Isolation (PF-06): an OpenShell
  spike behind execution profiles, with task-scoped credentials"), PathForward **PF-06** (and its two extension rows),
  ENTERPRISE_READINESS_PLAN §1 PF-06 and §3 ("do not ship anything called a sandbox until there is a real OS/runtime
  boundary"), ADR-0177 row 10 and §4 step 7 (OpenShell spike "needs the PF-06 contract ADR"), ADR-0176 (admission
  rules), ADR-0185 (stdio MCP transport and its residuals), ADR-0187 (sidecar engine contract, decisions 1, 19, 79,
  104 and 170–174), **ADR-0188** (workload identity, delegation grants), **ADR-0189** (Decision BOM facts, AI BOM),
  ADR-0180 §5 (autonomy class floors), ADR-0181 (strictness registry), ADR-0015 (deploy modes and the
  control-plane / execution-plane boundary)
- **Sequencing:** batch 6 runs one item at a time. This ADR is built after ADR-0188 and ADR-0189. It is written now so
  the owner can decide early; slice I0 (a research spike, no product code) can run before then. See the slice table.

## Context

### What is asked

- **PF-06** (PathForward.md §PF-06): "Do not call an in-process permission check a sandbox. Define execution profiles
  that select a real backend: container, gVisor/Kata, microVM, or customer-provided isolation. Profiles should control
  filesystem, network destinations, process execution, CPU/memory/time, secrets, and cross-session persistence.
  Unknown or low-assurance agents start in the most restricted profile." PF-06 also asks for per-user upstream
  authorization brokering (OAuth 3LO/OBO, a managed token vault), task-scoped short-lived credentials, and
  compensation (reversibility, undo windows, sagas). Its extension rows add OpenShell as the first real isolation
  backend (RegulAIt as its policy interceptor; changes its prover flags as risky become approvals), later pipelock's
  Apache core as an egress-containment option, and token-endpoint binding for OAuth brokering.
- **Wave 2** (PathForward.md): "sandbox profiles … Exit only when … isolation is verified at the actual OS/runtime
  boundary."
- **ADR-0177 §3:** an execution profile appears as an option on the agent builder, not a new navigation group.
- **Scope of this ADR:** isolation and execution profiles, and the task-scoped credentials an isolated workload
  needs. **Out of scope** (each gets its own ADR): per-user OAuth brokering and a token vault, and compensation/sagas.
  Both are PF-06 items; neither is needed to make isolation real, and neither is designed here.

### What runs today, and where (read for this ADR at `main` @ 20e11ee)

| Workload | Where it runs today | Isolation today |
|---|---|---|
| **Model calls** | In the gateway process (`executeGovernedDispatch`) | None needed: it is our own code making an HTTP call through the egress guard |
| **Connector calls** | In the gateway process (`connector-call.ts`), credentials held by the gateway | Same: our code, egress guard, no third-party code runs |
| **Remote MCP servers** (HTTP/SSE) | On someone else's host; the gateway proxies (`mcp-proxy.ts`) | Not ours to isolate; admission, egress and (after ADR-0188) identity apply at the hop |
| **stdio MCP servers** (ADR-0185) | **Child processes of the gateway, on the gateway's host**, spawned by `GovernedStdioTransport` (`apps/gateway/src/mcp-transports.ts:261`, launched with `env: getDefaultEnvironment()`, `cwd: launch.allowedDir`, lines 357–359) | A minimal environment, a pinned entry-file sha256, owner-only directories, a process cap. **No OS boundary.** ADR-0185's residuals defer three things to PF-06 by name: the digest TOCTOU between hash and spawn, interpreter and module pinning, and credential binding for stdio children |
| **Engine runners and workers** (ADR-0187) | Sidecar containers pulling work over an `internal: true` network; the gateway has no Docker socket and no Kubernetes API (ADR-0187 decision 1) | Hardened OCI containers on the default runtime: read-only root, `cap_drop: [ALL]`, `no-new-privileges`, non-root, memory/CPU/pids limits; the modelscan scanner and the promptfoo worker split from their runners (decisions 104, 170). **Shared host kernel.** |
| **Agent code execution / computer use** | Not found. `computerUse` is a declared builder-agent flag read by `apps/gateway/src/builder.ts` and `autonomy.ts` only (grep of `apps/gateway/src`); `builder-runtime.ts` has no reference to it, and no code-execution route was found (searched `run_code`, `code_interpreter`, `executeCode`, `sandbox exec`) | — |

The product's own compliance pack already tells the truth about this: the ISACA pack marks item 5 (sandboxed execution
and network segmentation) `unaddressed` and attestation-required (`packages/shared/src/isaca-pack.ts:12-15`).

### Inputs the design must honour

- **ADR-0187 decision 1:** the gateway gets no Docker socket and no Kubernetes API. Whatever starts sandboxes is not
  the gateway.
- **ADR-0187 decisions 19 and 173:** an isolation claim is proved from inside the isolated process at run time (an
  egress probe with no resolver; a check that no runner credential is reachable), and a missing or stale proof fails
  the self-test. ADR-0187 decision 174 flips `credentialIsolation` only on a verified layout.
- **ADR-0188:** every workload that crosses a process boundary has a workload identity (`workload_identities`, kind
  `worker_runtime` for an external runtime), authenticates with `private_key_jwt` or mTLS or SPIFFE, and holds only
  DPoP- or certificate-bound, short-lived, audience-bound tokens; every use re-reads the live delegation chain
  (decision 17). Bearer workload secrets (`rge_`, `pdp` keys) are retired in its slice S7.
- **ADR-0189:** `decision_facts` are captured in the decision's transaction; a missing fact is `not_recorded` with a
  reason, never inferred.
- **The pillar-3 cascade:** `compliance_profiles` (`packages/db/src/schema.ts:3097`) already composes per-framework
  floors strictest-wins (`pii_mode`, `guardrail_modes`, red-team floors, budget ceilings). Projects carry a data
  sensitivity of `public | internal | confidential | regulated` (`AI_USE_CASE_DATA_SENSITIVITIES`,
  `packages/shared/src/index.ts:3514`).
- **ADR-0180 §5:** the agent autonomy class sets control floors; isolation is a natural floor to add.

### Open-source backends and standards surveyed (ADR-0176), checked 2026-10-10

**Source access.** The GitHub API and github.com pages were refused by this session's proxy ("sessions are bound to
their configured repositories"). That was not routed around: no repository was attached and no mirror of GitHub
content was used. Facts below come from each project's own site or documentation, the official package registries
(PyPI, crates.io, the Go module proxy, the gVisor release bucket), Repology's distribution index, and, where marked,
secondary sources. Anything not confirmed from a primary source says so.

| Project | What it isolates | Licence | Latest release seen | Air-gapped fit | AWS / Azure / GCP / on-prem fit | Verdict |
|---|---|---|---|---|---|---|
| **gVisor** (`runsc`) | A user-space kernel between the workload and the host: the workload's syscalls are served by gVisor's Sentry, so the host kernel's attack surface is much smaller. An OCI runtime, so it slots under Docker (`--runtime=runsc`) or Kubernetes (RuntimeClass). Its default platform needs no KVM | Apache-2.0 (Repology: every distribution package) | `release-20261005.0` (official release bucket `storage.googleapis.com/gvisor/releases/release/`, listed 2026-10-10); Go module commit 2026-10-10 | Yes: one static binary plus a shim, no runtime fetch. **Note:** a gVisor-users mailing-list post (2026-07-23, secondary) says `runsc` stops bundling companion files and may drop auto-download, recommending the Debian APT package; the I0 spike confirms the offline install path | Any Linux VM on any cloud or on-prem, no nested virtualisation needed; some managed Kubernetes services offer it as a managed option | **Chosen: first real isolation backend (class L2)** |
| **Kata Containers** | Each pod or container in its own lightweight VM (hardware virtualisation) with its own guest kernel; an OCI runtime selected by RuntimeClass; can use several hypervisors | Apache-2.0 (Repology) | Repology newest packaged: 3.28.0. NVD's CVE-2026-41326 says 3.4.0–3.28.0 are affected and **3.29.0** fixes it; a vendor's release notes (secondary) list 4.0.0 in August 2026. Go module commit 2026-10-09 (active). **Exact latest tag and date not confirmed** | Yes, with images and guest kernel pre-staged | Needs hardware virtualisation exposed to the node: bare metal, or an instance type with nested virtualisation. Availability differs by cloud and instance type and is checked per deployment, never assumed | **Chosen: microVM class (L3) for Kubernetes deployments, BYOC first.** Pin at or above the release fixing CVE-2026-41326 |
| **Firecracker** | A minimal KVM microVM monitor (with a `jailer`) | Apache-2.0 (Repology) | 1.17.0 (Arch Linux package built 2026-09-04; the project's own release page is on GitHub and was not reachable) | Yes | KVM required, as for Kata | **Not integrated directly.** Running VMs ourselves (kernels, rootfs, networking, jailer) is a VM manager we would write. Reached through Kata (which can use it as its hypervisor) or not at all |
| **NVIDIA OpenShell** (ADR-0177 row 10) | An agent sandbox runtime: a control-plane gateway, a trusted per-sandbox **supervisor**, and the sandbox. The workload runs as one non-root identity with no capabilities, under Landlock (filesystem) and seccomp (user-notification staging of TCP opens and DNS); all egress goes over one mutually authenticated channel to the supervisor, which checks policy, **injects credentials only for approved endpoints** (the agent never holds them), and relays. Compute drivers: Docker, Podman, Kubernetes (Helm), MicroVM (libkrun). A **policy prover** flags risky proposed rules and blocks their auto-approval. A **gateway interceptor** (protobuf gRPC) lets an external system validate proposed control-plane writes; **supervisor middleware** can inspect, transform or deny allowed HTTP traffic before credential injection (docs.nvidia.com/openshell, architecture, support matrix and extensibility pages) | Apache-2.0 (PyPI licence expression) | `openshell` **0.1.3, 2026-10-09** (PyPI); 95 releases since 2026-03-10; classifier "Development Status :: 3 - Alpha" | Partly: the default workload image is pulled on first use unless preloaded (support matrix). Telemetry is not covered by its docs; ADR-0177 recorded a `defaults-without-telemetry` build, **not re-verified here** | Linux x86_64/aarch64 with **Landlock ABI ≥ 3 (Linux 6.2+)** and seccomp user notification; Kubernetes 1.29+; macOS only through a Linux VM. Fits all three clouds and on-prem where the kernel qualifies | **Spike (I0), then an optional backend (I7)**, not a required one: alpha, pre-1.0, very fast release cadence. Two frictions recorded below |
| **nsjail** | A process jail: Linux namespaces, seccomp-bpf (Kafel policy language), cgroups, rlimits | Apache-2.0 (Repology) | 3.6 (Arch Linux package built 2026-05-28; upstream release page not reachable) | Yes | Any Linux | **Not chosen for v1.** Inside our hardened containers (`cap_drop: [ALL]`, no user namespaces under the default seccomp profile, ADR-0187 decision 79) it cannot create its namespaces; under gVisor it adds little. Candidate for a later non-container install |
| **bubblewrap** | Unprivileged namespace sandbox | **LGPL-2.0-or-later** (Repology) | 0.13.0 (Repology) | Yes | Any Linux | **Rejected** for shipped code: outside the ADR-0176 licence list. A customer may run it themselves under the BYOC "customer-provided" class |
| **Landlock** | A Linux security module letting an unprivileged process restrict its own filesystem access; network rules are **TCP (ABI 4) and UDP (ABI 10) port rules, not destination rules** (docs.kernel.org, Landlock userspace API) | Kernel feature (no library shipped by us); `landlock` crate 0.4.7 MIT OR Apache-2.0 (crates.io, 2026-07-27); `go-landlock` v0.10.1 (Go proxy, 2026-09-13; licence not checked) | — | Yes | Linux ≥ 5.13 for ABI 1; OpenShell needs ABI ≥ 3 | **Used through OpenShell, not called by us in v1.** Because its network rules are port-based, it is never our egress control |
| **seccomp** | Syscall filtering | Kernel feature. The container runtimes' default profiles ship with them (`RuntimeDefault`); libseccomp is LGPL-2.1 and is not linked by us | — | Yes | Any Linux | **Required at every class ≥ L1** as `RuntimeDefault` (or a stricter `Localhost` profile) |
| **AppArmor / SELinux** | Mandatory access control on the host | Kernel features; host-distribution specific | — | Yes | AppArmor on Debian/Ubuntu, SELinux on the RHEL family | **Defence in depth where the host has one; never required** (no portable guarantee) |
| **Kubernetes RuntimeClass** | The standard way to select an OCI runtime (`runsc`, `kata`) per pod; schedules onto nodes that have it | Apache-2.0 (Kubernetes); stable since 1.20; current stable **v1.37.1** (`dl.k8s.io/release/stable.txt`) | — | Yes | All managed and self-run Kubernetes | **Chosen** as the placement mechanism on Kubernetes |
| **Pod Security Standards** (`restricted`) | Pod-spec hardening: non-root, `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault`/`Localhost` required, drop `ALL` capabilities, limited volume types (kubernetes.io). Its FAQ: "There is currently no API standard that controls whether a Pod is considered sandboxed", and PSS does not control network egress | Apache-2.0 | — | Yes | All | **Chosen as the L1 floor** for every isolated workload; egress needs a **NetworkPolicy** with a CNI that enforces it |
| **Wasmtime** (WASI) | A WebAssembly runtime: capability-based (no ambient filesystem or network authority), memory limits and fuel/epoch interruption | **Apache-2.0 WITH LLVM-exception** (crates.io) | **49.0.2, 2026-10-02** (crates.io) | Yes | Any host, any OS | **Later, its own class** for WebAssembly tool sandboxes (OWNER DECISION 8). Node's built-in `node:wasi` is **not** an option: its docs say it "does not currently provide the comprehensive file system security properties … do not rely on it to run untrusted code" (nodejs.org, wasi) |
| **microsandbox** | libkrun microVM sandboxes with an SDK | Apache-2.0 (PyPI classifier) | 0.7.8, 2026-10-09 (PyPI; "Beta"; the repository link has moved owner) | Unverified | KVM required | **Not chosen** (young; overlaps OpenShell's MicroVM driver). Named in PathForward; re-check later |
| **OpenSandbox** | Sandboxed execution environments with an SDK | Apache-2.0 (PyPI `opensandbox`) | SDK 1.1.1, 2026-10-09 (PyPI; "Alpha"). Its repository link points to an organisation other than the one PathForward cites; **provenance not confirmed** | Unverified | Unverified | **Not chosen**; provenance first |
| **runc** | The default OCI runtime (namespaces, cgroups, seccomp) | Apache-2.0 | 1.5.2 (Repology) | Yes | All | The L1 runtime, as today |
| **crun** | Alternative OCI runtime | GPL-2.0-or-later / LGPL-2.1 | 1.30.1 (Repology) | — | — | Not shipped by us; a customer's own node choice is theirs |

**What no open-source module does, and is therefore ours (ADR-0176 §4):** deciding which isolation a call
**requires** (from sensitivity, compliance tags, autonomy class, workload kind and agent), refusing when nothing
available meets it, binding that requirement to the ADR-0188 delegation chain, checking the applied-profile report,
and writing it into our audit and Decision BOM. The isolation itself is always a third-party runtime.

### Two frictions with OpenShell, recorded before the spike

1. **Its interceptor authenticates with bearer tokens.** The extensibility docs say interceptor tokens "are bearer
   credentials that share the gateway's signing key, and mTLS client authentication isn't available." ADR-0188 makes
   unbound bearer tokens an invariant we never issue or accept for **our** delegated tokens. Validating OpenShell's
   token on our interceptor endpoint is a different direction (it calls us), but it is still a bearer secret on a
   governance path. Mitigation: the interceptor listens only on a `unix://` socket shared with the OpenShell gateway's
   container (no network listener), pins `EdDSA`, the exact audience and issuer, and the spike records it as an
   ADR-0176 §4 deviation if it stays.
2. **It is alpha.** 0.1.x with near-daily releases. ADR-0177 §1 forbids a single-maintainer project as a required
   sidecar; OpenShell is not single-maintainer, but an alpha runtime should not be the only path to a required
   class. Hence gVisor and Kata carry the classes; OpenShell is an optional backend that adds credential injection and
   L7 egress policy on top.

## Options considered

**A. Harden the existing paths only (more seccomp, AppArmor, nsjail around stdio children on the gateway host).**
Cheap and local. But the workload still shares the gateway's kernel and host, nsjail cannot run inside our hardened
containers (it needs namespaces the default seccomp profile blocks), and there is no selection, no evidence and no
binding to sensitivity. It is the "in-process permission check" PF-06 warns about, one layer down. Rejected.

**B. Adopt OpenShell as the isolation system.** It solves egress, credential injection and policy proving in one
runtime. But it is alpha, its kernel floor (Landlock ABI ≥ 3, Linux 6.2+) excludes some customer hosts, its
interceptor is bearer-authenticated, and making it mandatory would make every required class depend on it. Kept as an
optional backend (I7).

**C. A provider-neutral execution-profile contract, enforced by the gateway, with isolation done by standard OCI
runtimes (gVisor, Kata) through executors that pull work, and OpenShell as an optional backend (recommended).** The
gateway decides the required class and refuses when it is unavailable; executors (our thin shim, like ADR-0187's
runners) run where the container runtime is, hold no long-lived secret (ADR-0188 identity), start each workload in the
required runtime, and prove the applied profile from inside it. The same contract covers hosted, BYOC (on the
customer's Kubernetes with RuntimeClass) and air-gapped installs.

**D. Run our own microVM manager on Firecracker.** Strongest isolation per workload, but we would write and maintain a
VM lifecycle manager (kernels, images, networking, jailer), which ADR-0176 forbids when Kata already does it. Rejected;
Firecracker stays reachable through Kata.

## Decision (Accepted 2026-10-10)

### 1. Isolation classes: a fixed, ordered vocabulary

| Class | Meaning | Backends that may attest it |
|---|---|---|
| **L0 `in_gateway`** | Our own code in the gateway process (model and connector calls). **Not isolation, and never called a sandbox** in product text or evidence | — |
| **L1 `hardened_container`** | OCI container on the default runtime with the PSS `restricted` posture plus our additions: non-root, `cap_drop: [ALL]`, `no-new-privileges`, seccomp `RuntimeDefault` or stricter, read-only root, no host mounts, resource limits, no network except decision 4's channel. Shares the host kernel | runc (compose or Kubernetes) |
| **L2 `user_space_kernel`** | L1, plus the workload's syscalls served by a user-space kernel | gVisor `runsc`; OpenShell's Docker/Podman/Kubernetes drivers **only** when its pod or container itself runs under `runsc` (OpenShell's Landlock and seccomp layers alone attest L1) |
| **L3 `microvm`** | L1, plus a separate guest kernel under hardware virtualisation | Kata Containers; OpenShell's MicroVM driver (libkrun) |
| **`customer_declared`** | A BYOC execution plane's own isolation, declared by the customer, not verified by us | Customer runtime; satisfies a requirement only where an admin has mapped it to a class (decision 7), and the evidence always says "declared" |

A class is a floor: a backend attesting L3 satisfies an L2 requirement. Classes are compared by order only; there is
no score.

### 2. The execution profile contract `regulait.execution-profile.v1`

An **execution profile** is a named, versioned, immutable record (a change makes version `n+1`; a running workload
keeps the version it started with). Its body is canonical JSON (RFC 8785, `canonicalize`, as ADR-0186/0189), and its
SHA-256 is the profile digest that every placement, report and fact names.

| Field | Content | Strict default (the shipped `restricted` profile) |
|---|---|---|
| `workloadKinds` | which kinds it may run (decision 3) | all isolable kinds |
| `minClass` | the isolation class floor | L2 |
| `filesystem` | read-only root from a digest-pinned image; one writable tmpfs work directory with a size cap; declared read-only inputs; never a host path | root read-only; `/work` tmpfs 256 MiB; no inputs |
| `network` | `none`, or `gateway_only` (decision 4's channel), or `allow_list` (exact hosts and ports, each also on the egress-guard allow-list; DNS resolved on the trusted side only) | `gateway_only` |
| `process` | non-root uid, no capabilities, `no-new-privileges`, seccomp profile name, pids limit, whether the workload may exec other programs (`exec: image_only` = only files present in the pinned image) | uid 10001, no caps, `RuntimeDefault`, 128 pids, `image_only` |
| `resources` | CPU, memory, wall-clock per call and per session, output size | 1 CPU, 1 GiB, 300 s per call, 30 min per session, 16 MiB output |
| `secrets` | `none`, `task_scoped` (decision 5), or `injected_at_egress` (credentials added by the trusted side to approved requests; OpenShell's supervisor model) | `none` |
| `persistence` | `none` (fresh sandbox per session, wiped after), or `scoped_volume` (one volume per agent × project, retention by the compliance cascade) | `none` |
| `attestation` | the probes the executor must report (decision 6) and their maximum age | all probes; 2 h for the executor, per run for the workload |

Profiles are admin-managed (create, version, retire), audited, and a relaxation of any field below the shipped
`restricted` value needs the `settings_relax` step-up (ADR-0186). The shipped profiles are `restricted` (above),
`restricted-microvm` (same, `minClass` L3) and `engine-worker` (ADR-0187's worker posture as data, decision 9).

### 3. What runs where: workload kinds and their placement

| Workload kind | Runs in | Minimum class (strict default, before sensitivity) | Notes |
|---|---|---|---|
| `model_call` | gateway (L0) | — | Not isolable; governed by the gateway as today |
| `connector_call` | gateway (L0) | — | Our code; the profile's `network.allow_list` and `secrets` fields still bound its egress and credential reach |
| `remote_mcp` | the upstream's host | — (recorded as `external`) | We cannot isolate a third party's server; admission, egress guard and ADR-0188 identity apply. Its Decision BOM says `external`, never a class |
| `mcp_stdio` | an executor, never the gateway host | **L2** | **Invariant (OWNER DECISION 2): third-party code never runs in the gateway's process or host namespaces.** The in-gateway spawn of ADR-0185 is removed when I4 ships (first load, no grandfathering) |
| `code_exec` | an executor | **L2** (L3 for `confidential`/`regulated`, decision 7) | Reserved: nothing executes agent-written code today. Any future feature that does must declare this kind or it is refused |
| `engine_worker` | an executor-managed container (ADR-0187 runner/worker split) | **L2** (OWNER DECISION 4) | The workers parse hostile input (model artifacts, red-team outputs) |
| `byoc_worker` | the customer's execution plane | the class the placement requires | The worker is an ADR-0188 `worker_runtime`; its class is attested (decision 6) or `customer_declared` |

### 4. Executors: the only things that start sandboxes

- An **executor** is a thin, long-running shim (package `packages/sandbox-executor`, reusing `packages/engine-runner`'s
  loop and process code) deployed beside a container runtime: a compose service with access to a runtime that has
  `runsc` configured, or a Kubernetes Deployment with RBAC to create pods in one dedicated namespace. **The gateway
  never gets a Docker socket or a Kubernetes API credential** (ADR-0187 decision 1 stands); the executor has them,
  scoped to its own namespace, and holds nothing else.
- It authenticates as an ADR-0188 workload identity of kind `worker_runtime` (`private_key_jwt` + DPoP, or SPIFFE on
  BYOC), never a bearer token. Its registration declares the classes it can provide; decision 6 proves them.
- **Pull model.** It holds an outbound, mutually authenticated stream to the gateway (no listening port, as ADR-0187
  runners and OpenShell supervisors). The gateway offers a placement; only an executor whose **fresh** attestation
  meets the required class may take it (as ADR-0187's "a runner leases only jobs for its own engine").
- **The channel is the network.** A sandbox at `gateway_only` has no network interface of its own except the one the
  executor wires to the gateway's sandbox endpoint (a dedicated internal network or a socket); MCP stdio traffic is
  carried as a stream over the executor's channel. Egress to anything else is denied by the network layer
  (`network_mode: none` plus the channel, a deny-all NetworkPolicy, or OpenShell's outer fence), **never** by
  Landlock, whose network rules are port-based.
- **Image closure pinning.** A stdio MCP server runs from an image built from its package with the interpreter and
  every module inside, pinned by digest at registration. This closes ADR-0185's three PF-06 residuals: the hash-to-spawn
  TOCTOU (the runtime starts a digest, not a path), interpreter and module pinning (the closure is the image), and
  credential binding (decision 5). Building those images is slice I4's subject; air-gapped installs bring them in the
  image bundle (`build-image-bundle.sh`).

### 5. Secrets reach and task-scoped credentials

- **Default `none`.** Nothing secret is in a sandbox's environment, filesystem or arguments.
- **`task_scoped`:** the sandbox generates its own key pair at start (the private key never leaves it) and receives an
  ADR-0188 delegated token bound to that key (`cnf.jkt`), audience-bound to one resource, lifetime at most the
  profile's per-call wall clock (default 300 s, the ADR-0188 TTL), under a child delegation grant of the calling
  agent's grant. Model calls from a sandbox use a run-scoped virtual key only where ADR-0187 already does (engine
  workers) until ADR-0188 S7 moves them. Revocation is ADR-0188's: the next use is refused.
- **`injected_at_egress`:** available only on a backend that can do it (OpenShell's supervisor, or a later egress
  proxy); the sandbox holds a placeholder, and the trusted side adds the credential only on requests to the
  profile's allow-listed endpoints.
- Long-lived upstream credentials for a user (OAuth refresh tokens, PATs) are **out of scope** here: they belong to
  the per-user brokering ADR. Until it exists, a stdio server that needs a user's upstream credential is refused under
  `secrets: none`.

### 6. Attestation of the applied profile

Two levels, both written to the audit chain:

- **Executor self-test** (at registration, then hourly with a 2 h freshness limit, as ADR-0187 decision 173's worker report): a canary sandbox started
  with the profile under test reports, from inside: the runtime it observes (gVisor identifies itself in the kernel
  version and boot messages; a microVM shows a hypervisor CPU flag and a guest kernel distinct from the host's, which
  the executor reports from outside), uid and capability sets from `/proc/self/status` (`CapEff` zero, `NoNewPrivs` 1,
  `Seccomp` 2), a write to the root filesystem failing, the egress probe of ADR-0187 decision 19 (a public literal
  address, no resolver, must fail; DNS must fail), the absence of any executor or runner credential (decision 173's
  check), and the cgroup limits. The executor signs the report with its workload key; the gateway evaluates it
  against the profile and stores the verdict with the report's SHA-256. A missing, stale or failing report removes
  that class from the executor until the next pass.
- **Per-placement report:** every sandbox start reports the same probe set for the workload's own sandbox before the
  workload's first byte of input is released to it, plus the image digest and the profile digest applied. The
  gateway compares it with the placement's requirement **before** delivering the call. A mismatch is refused
  (`execution_profile_mismatch`), the sandbox is killed, the executor is **quarantined** (its classes withdrawn until
  an admin re-enables it, audited), and an alert is raised.
- **What this cannot prove (stated in the evidence):** both reports are produced by software on the same host. A
  compromised host or executor can lie. Hardware-rooted attestation (TPM-measured boot, confidential-computing
  reports) is not in v1 (open question 3). The evidence says "software-attested", never "verified isolation".

### 7. Required class per call: the cascade, and refusal when unavailable

The gateway computes the **required class** for every isolable call as the maximum of:

1. the workload kind's floor (decision 3);
2. the project's **data-sensitivity floor**: `public` L2, `internal` L2, `confidential` L2, `regulated` **L3**
   (OWNER DECISION 3);
3. every compliance tag's `min_isolation_class` (new nullable `compliance_profiles` column, composed MAX like
   `guardrail_modes`; a tag can only raise);
4. the agent's **autonomy class** floor (ADR-0180 §5 gains an isolation floor; an agent with schedules, delegation or
   write tools without Ask-first starts at L2 at least);
5. the agent's or MCP server's own configured profile (`minClass`), and for an **unknown or low-assurance agent**
   (no ADR-0188 identity, or an observed autonomy class above its declared one) the most restrictive shipped profile,
   as PF-06 requires;
6. the **parent's** required class on a delegated call: a child grant can never run below its parent's class
   (decision 8).

Then:

- If no executor holds a fresh attestation at or above the required class for that profile, the call is **refused
  before any upstream contact** with `409 execution_profile_unavailable` and a fixed reason
  (`no_executor`, `attestation_stale`, `class_below_required`, `executor_quarantined`, `profile_retired`). There is
  **no fallback to a lower class** and no queueing that could later run it lower (an invariant). Engine runs that
  cannot be placed end `not_run` with reason `isolation_unavailable` (ADR-0187's never-clean rule).
- The kernel decision gains a rule id `execution-profile`, so the refusal appears like every other policy refusal
  (governance view, alerts, receipts).
- **`customer_declared`** satisfies a class only if an admin has mapped that BYOC plane to it (audited, step-up); the
  default maps it to nothing, so a regulated call refuses on an unmapped plane.

### 8. Composition with ADR-0188 (identity)

- `workload_identities` (ADR-0188 decision 2) gain `execution_profile_id` for agent and builder-agent identities: the
  profile that agent's isolable workloads must run under (a floor input, decision 7 item 5).
- `delegation_grants` gain `required_isolation_class` and `execution_profile_digest`. On creation (ADR-0188 decision
  22 admit), a child's class must be **at least** its parent's: refused `delegation-isolation` otherwise. This makes
  "a sub-agent never runs looser than its parent" a stored, checked property, as scope and budget already are.
- The live-chain check (ADR-0188 decision 17) adds: the executor identity that holds the placement is active, not
  quarantined, and its attestation for the required class is fresh at the moment of use.
- Executors and sandboxes authenticate with ADR-0188 credentials only; a sandbox's task-scoped token (decision 5) is
  a child grant whose actor is the sandboxed workload's identity.

### 9. Composition with ADR-0189 (Decision BOM facts) and the AI BOM

- `decision_facts` gain an **`execution`** section, captured in the decision's transaction: workload kind, required
  class and the inputs that set it (which floor won), profile id, version and digest, applied class, backend and
  runtime version, image digest, executor identity id, and the SHA-256 of the per-placement report. L0 calls record
  `class: in_gateway`; remote MCP calls record `external`.
- The Decision BOM gains an `execution` section with ADR-0189's completeness rules: decisions before this ADR's fact
  capture are `not_recorded, reason: pre_isolation`; nothing is back-filled.
- The **AI BOM** lists each executor as a CycloneDX `service` with its trust zone and runtime as properties, each
  workload image as a `container` component with its digest, and each profile as a `data` component
  (`configuration`) with its digest. A use case whose MCP servers run at L1 or `customer_declared` gets a composition
  marked `incomplete` for isolation evidence, never `complete`.
- The ISACA pack's item 5 moves from `unaddressed` to evidenced by a collector over placements and attestations once
  I4 ships, and only for the workloads actually placed.

### 10. The ADR-0187 engines under this contract

- Engine workers and the modelscan scanner become the `engine_worker` kind, placed by the same rules. The compose and
  Kubernetes templates add `runtime: runsc` (compose) or `runtimeClassName: gvisor`, and their self-tests add the
  decision 6 runtime probe. ADR-0187's `credentialIsolation` flag stays as it is; isolation class is a separate fact.
- Whether engines may still run at L1 on a host without gVisor is OWNER DECISION 4.

### 11. Strict defaults (ADR-0180)

| Setting | Default (strict) | Relaxable to | Notes |
|---|---|---|---|
| `isolation_enforcement` | `enforce` | `warn` (place at what is available, record the shortfall as a gate warning) | audited, `settings_relax` step-up; posture page shows "Isolation: not enforced"; never relaxes the invariants below |
| Sensitivity floors | public/internal/confidential L2, regulated L3 | down to L1 per sensitivity, never below | audited, step-up |
| `mcp_stdio` floor | L2 | L1 | audited, step-up |
| `engine_worker` floor | L2 | L1 (OWNER DECISION 4) | audited, step-up |
| `executor_attestation_max_age` | 2 h | up to 24 h | audited |
| Profile `network` | `gateway_only` | `allow_list` entries, each exact host:port and on the egress allow-list | each entry audited |
| Profile `secrets` | `none` | `task_scoped`, `injected_at_egress` | audited |
| Profile `persistence` | `none` | `scoped_volume` | audited; retention by the compliance cascade |
| Profile resources | 1 CPU, 1 GiB, 128 pids, 300 s/call, 30 min/session, 16 MiB output | admin may raise | audited |
| `customer_declared` mapping | maps to nothing | an admin maps a BYOC plane to a class | audited, step-up; evidence says "declared" |
| Third-party code in the gateway process or host namespaces | **never** | not relaxable | invariant (OWNER DECISION 2) |
| Falling back to a lower class than required | **never** | not relaxable | invariant |
| Calling L0 or L1 a "sandbox" in UI, docs or evidence | **never** | not relaxable | invariant (ENTERPRISE_READINESS_PLAN §3); L1 is "hardened container" |
| A child grant below its parent's class | **never** | not relaxable | invariant |
| A secret in a sandbox's environment, arguments or image | **never** | not relaxable | invariant; enforced by the executor and the image build |

Build as for a first load: no grandfathering. Existing stdio servers stop working until an executor at their required
class exists; the demo seeds one (decision 12).

### 12. Deploy modes (pillar 3)

- **Hosted fast-start:** executors run beside the gateway with gVisor; L3 only where the host exposes KVM.
- **BYOC (AWS, Azure, GCP, on-prem):** executors run in the customer's cluster, in one namespace, with RuntimeClasses
  `gvisor` and (where nodes allow) `kata`, the namespace labelled `pod-security.kubernetes.io/enforce: restricted`,
  and a deny-all NetworkPolicy except the channel to the gateway. The control plane keeps only profiles, placements,
  report hashes and audit; workload content never crosses the ADR-0015 boundary. Real BYOC execution stays
  owner-gated (ADR-0183).
- **Air-gapped:** `runsc`, Kata artefacts, executor and stdio closure images ship in the image bundle with
  `pull_policy: never`; nothing is fetched at run time; the egress probe proves it per sandbox.
- **Demo / local:** the demo seeds a gVisor executor in compose when `runsc` is installed; otherwise stdio and engine
  calls refuse with `execution_profile_unavailable` and the demo story says why (no silent L1).

### 13. Audit and evidence trail

New audit actions (all on the hash chain, all naming the profile digest): `execution-profile-created`, `-versioned`,
`-retired`, `-relaxed`; `executor-registered`, `executor-attestation-passed`, `-failed`, `executor-quarantined`,
`executor-reenabled`; `execution-placed` (call or run id, required class and the floor that set it, executor, report
hash); `execution-refused` (reason); `execution-profile-mismatch`. Placements also stamp `trace_spans` and
`usage_events` (as ADR-0188 does for the actor chain). Reports are stored for the audit-retention period of the
compliance profile; their hashes for as long as the audit row.

### 14. Data model sketch (migration `0183+`; not written here)

- `execution_profiles` (`id`, `name`, `version`, `body` canonical text, `digest`, `min_class`, `retired_at`,
  `created_by`, `created_at`; UNIQUE (`name`, `version`); append-only).
- `executors` (`id`, `workload_identity_id` → ADR-0188, `backend` `runc | gvisor | kata | openshell | customer`,
  `runtime_version`, `classes_declared`, `status` `active | quarantined | revoked`, `last_seen_at`).
- `executor_attestations` (`executor_id`, `profile_digest`, `class`, `report_sha256`, `report` jsonb (no secrets,
  fixed vocabulary), `verdict`, `observed_at`, `expires_at`).
- `execution_placements` (`id`, `audit_id`, `workload_kind`, `required_class`, `required_by` (which floor),
  `profile_digest`, `executor_id`, `applied_class`, `report_sha256`, `outcome`, `created_at`).
- `compliance_profiles.min_isolation_class`; `workload_identities.execution_profile_id`;
  `delegation_grants.required_isolation_class`, `execution_profile_digest`.
- Settings rows for decision 11 in the strictness registry (ADR-0181).

## Amendments after slice I0 (2026-10-10)

The I0 spike ([R13](../research/R13-isolation-i0-spike.md), PR #269) returned **GO for gVisor as the L2 backend**,
**no change for Kata** (not testable without `/dev/kvm`), and **OpenShell GO for L1 and L3 only**. These amendments
bind the slices that follow. Where one changes a decision above, it wins over the original text. None relaxes a
strict default: each makes a default stricter or a definition more exact (ADR-0180).

- **A. The runsc configuration is part of the profile (decisions 4 and 10).** Without `--oci-seccomp`, runsc ignores
  the OCI seccomp filter (measured `Seccomp: 0`, `unshare` allowed). The executor starts runsc with `--oci-seccomp`,
  `--network=none` (or the decision 5 channel), `--sidecar-usage-policy=STRICT`,
  `--sidecar-release-enforcement-policy=ALWAYS` and a named platform. The attestation records these flags. The
  self-test's `Seccomp: 2` check now passes for the right reason.
- **B. `--directfs=false` is the default.** With directfs on, the Sentry runs with weaker syscall filters. Turning
  directfs on is an audited relaxation. Slice I4 measures its cost.
- **C. `process.pids` maps to `RLIMIT_NPROC` (decision 2).** Under runsc the OCI `pids` limit is a host cgroup limit
  that also counts the Sentry's threads; at 64 a fork-heavy workload crashed the Sentry. The workload limit (128) is
  `RLIMIT_NPROC` (measured: a clean EAGAIN). The executor also sets a host cgroup `pids.max` with headroom for the
  Sentry (512 worked in I0). A Sentry crash is a fail-closed outcome and is reported as one.
- **D. Probe definitions (decision 6).** "Read-only root" means EROFS, or `ro` on `/` in `/proc/self/mounts`; EACCES
  as a non-root user proves nothing. The resource probes split into what the sandbox sees (`MemTotal`, `RLIMIT_*`) and
  what only the executor sees (host cgroup CPU quota, memory limit, `pids.max`, throttling counters). The in-sandbox
  CPU count is derived from the quota and proves nothing about it.
- **E. gVisor installs as one unit (decision 12 and the survey row).** The release tarball (`runsc`, the shim and the
  `gvisor-bin/` sidecars), pinned by sha512 and installed together on a world-traversable path. A bare `runsc` copy no
  longer runs.
- **F. OpenShell never attests L2 (decision 1).** The L2 row's OpenShell clause is replaced: OpenShell's container
  drivers attest **L1** only, and OpenShell reaches **L3** only through its MicroVM driver. Its baseline (Landlock ABI
  3 or later, seccomp user notification) is absent inside gVisor. The executor refuses an OpenShell placement with
  `runtimeClassName: gvisor`.
- **G. OpenShell admission conditions (slice I7).** Gateway and supervisor are built from source without telemetry
  (`--no-default-features --features defaults-without-telemetry`). A release image with telemetry compiled in is not
  admitted, and the telemetry host is still blocked at the network layer. Air-gapped installs use image pull policy
  `Never` with preloaded images. Landlock is a hard requirement. `allow_insecure_transport` is refused. Only
  interceptors are used, because supervisor middleware is https-only and outside owner decision 7. Decision 7's
  mitigations gain an `SO_PEERCRED` check and a `0600` socket. OpenShell reuses tokens until rotation, so `jti` replay
  detection is not available; this is recorded as a residual.
- **H. Survey corrections.** The survey table is corrected as in R13 §4: Kata 4.2.0 and 3.32.0, the nsjail date, the
  OpenShell PyPI scope, and `go-landlock` (MIT). Open question 8 drops the items R13 verified.
- **I. Open question 6.** Rootless `runsc` works on Linux without root. The macOS and Windows path is still untested
  and needs a run inside a Linux VM.
- **J. Migration number.** ADR-0189 slice B1 takes `0182`, so slice I1 uses `0183+` (decision 14 and the slice table).

Still to run on a real host or in CI (R13, "Needs a real host or CI"): the ADR-0187 worker under runsc in compose and
the decision 19 egress probe (I4), the Kata and MicroVM probes (I6/I7), Kubernetes `RuntimeClass` (I6), timings on a
quiet host, cgroup v2 behaviour, and the OpenShell kernel floor on our CI runners.

## Amendments after slice I3 (2026-10-10)

Slice I3 built `packages/sandbox-executor` and the gateway's executor channel (PR "ADR-0190 I3 executor core"). The
decisions it had to make, each recorded here; none relaxes a strict default.

- **K. The executor authenticates every channel request with a one-use signed proof, not a token (decision 4).**
  ADR-0188 S5's token endpoint issues a token only from a human delegation proof (decision 15), which a long-running
  service workload does not have; the service-workload token path is S7's. Until S7 lands, every request on
  `/v1/executor-channel/*` carries one `Executor-Proof` header: a compact JWS under a LIVE `jwk` credential of the
  executor's `worker_runtime` identity (`iss` = `sub` = the identity, `aud` = the issuer, `htm`, `htu`, `iat` within
  60 s and at most 5 s ahead on the database clock, a one-use `jti` claimed atomically in `replay_claims` namespace
  `executor_channel`, and `bh` = SHA-256 of the exact raw body). It is RFC 7523 client authentication carrying RFC
  9449's request binding: nothing bearer, nothing reusable, nothing that outlives one request, and no secret in the
  executor's environment (the key is a 0600 file on its own volume). The two files that build and check it are the
  one adapter S5/S7 changes touch: `packages/sandbox-executor/src/channel-credential.ts` and
  `apps/gateway/src/executor-channel-auth.ts`. **Open question for S7:** whether the executor moves to a DPoP-bound
  access token from `/oauth/token` (a client-credentials-shaped exchange for `worker_runtime` identities) or keeps the
  per-request proof; both satisfy ADR-0188 decision 5's "sender-constrained, short-lived, audience-bound", and the
  proof is the stricter of the two.
- **L. The outbound stream is newline-delimited JSON over a bounded HTTP window (decision 4).** `GET
  /v1/executor-channel/stream?window=1..60` answers `hello`, then offers and status changes as they happen, keepalives
  and `bye`; the executor reconnects at once. Offers are rows (`execution_offers`, migration 0187), so a placement
  decided on one gateway replica reaches the executor's stream held by another; a sent-set per connection and the
  offer id keep a re-sent offer harmless. A WebSocket was not adopted: it would add a dependency (ADR-0176) for no
  property the bounded window lacks, and the per-request proof fits a request. Slice I4 decides whether MCP stdio
  bytes ride this stream or a sibling stream on the same proof.
- **M. The attestation report is `regulait.executor-report.v1` (decision 6, amendment D).** A fixed probe
  vocabulary with a bounded observation shape per probe (`packages/shared/src/isolation/attestation.ts`), canonical
  text by RFC 8785 (as the profile body) and its SHA-256 as the report hash, signed by the executor as a DETACHED JWS
  (RFC 7797) so the stored body can be re-verified later against the identity's public key. The executor never judges
  its own report: the gateway evaluates every observation against the profile, the executor's registered backend and
  declared classes, and (for a placement) the required class and the offer's image digest; any failure fails the
  whole report. The same evaluator runs on the executor so a host that fails its own profile is logged where someone
  can fix it. `strength: software_attested` is in every report (OWNER DECISION 5).
- **N. The latest verdict decides freshness (decision 6).** An executor's attestation for a profile is its most recent
  self-test row: a `fail` after a `pass` withdraws the class until the next `pass`; a `pass` is fresh until
  `observed_at + min(profile.attestation.executorMaxAgeMinutes, org.executor_attestation_max_age_minutes)`, both
  stamped by the database. The executor remembers only the gateway's verdict and expiry, never its own opinion, and
  declines an offer whose attestation has expired on the gateway's clock.
- **O. Quarantine is one atomic transition (decision 6).** `active → quarantined` is a single conditional UPDATE; of
  two concurrent mismatches, the one whose UPDATE moved the row writes the audit row (`executor-quarantined`), raises
  the governance alert (`execution-profile-mismatch`, severity high) and withdraws the executor's open offers, each
  under its row lock (an offer whose report is being judged at that moment keeps that outcome). Re-enable is an
  admin's `settings_relax` step-up (it restores withdrawn classes) and is audited; the executor then runs a full
  self-test before taking work. Revoke is terminal: the row never changes again and the identity's proofs answer
  `403 executor_revoked`.
- **P. The broker refuses before any sandbox, with the most specific reason (decision 7).** `offerPlacement` picks one
  active executor whose latest attestation for the profile is a fresh `pass` at or above the required class (a
  customer plane only through its admin mapping) and the fewest open offers; otherwise it writes a refused placement
  row under an `execution-refused` audit row with `profile_retired` (also for a digest no row names, where the
  refusal is audited without a placement row), `executor_quarantined` (every executor quarantined), `attestation_stale`
  (an attestation exists but none is fresh), `class_below_required` (fresh but below) or `no_executor`. A declined or
  expired offer is a refused placement too (`no_executor`, or the executor's reason). The requirement is raised to
  the profile's own `minClass` where that is higher (decision 7 item 5).
- **Q. Audit actions added:** `executor-announced`, `executor-revoked`, `executor-declared-class-set`, and the channel
  refusal row `executor-channel-refused` (decision 13's list in `ISOLATION_AUDIT_ACTIONS`). Audit object types
  `executor` and `execution_placement`. Placement reports are kept in the `execution-placed` /
  `execution-profile-mismatch` audit rows' detail (with their signature); self-test reports in
  `executor_attestations.report`.
- **R. The fake backend is test-only.** `@regulait/sandbox-executor/testing` exports it; `main.ts` cannot name it and
  refuses to start without a real backend (I3 ships none: I4 adds `gvisor`). A fake that attests isolation that does
  not exist is the one thing the gateway cannot tell from the real thing.
- **S. Migration 0187** (`execution_offers`, the widened `replay_claims` namespace CHECK), `when` 1785122000000; the
  journal is re-ordered at merge time against 0184–0186 and S5's 0188.

Amendments from the independent review of the I3 PR (#323, reviewed at 985f5b3; master decisions, 2026-10-10). Each
tightens amendments K–S; none relaxes a strict default.

- **T. Quarantine voids every earlier attestation; re-enable needs a NEW pass (decision 6, ADR-0180; review M1).** This
  answers open question 4 below. The self-test route answers `409 executor_quarantined` (`next: quarantined`) unless
  the executor's status is `active`. The status is re-checked under a share lock on the executor row, in the same
  transaction that writes the verdicts, so a quarantine or a re-enable cannot cross a self-test while it is being
  judged. Re-enable stamps `executors.reenabled_at = now()` (database clock; migration 0187 adds the column).
  `freshAttestation`, the broker's refusal-reason query and the admin view share one predicate: they count only
  attestation rows with `observed_at > reenabled_at`. A pass written before the quarantine, or while it lasted, never
  counts again, even when its `expires_at` has not passed. Until the executor's next `pass`, the broker refuses and
  offers nothing.
- **U. The runtime probes cannot be dropped by a profile (decision 6, amendment D; review M3).** The evaluator
  requires `runtime_identity` in every report. It also requires `runtime_config` whenever the backend is `gvisor` or
  the claimed class is `user_space_kernel` (`requiredReportProbes`). This holds whatever `attestation.probes` lists,
  so a report with no runtime evidence fails `probe_missing`. The profile schema also refuses a body whose
  `attestation.probes` omits `runtime_identity` or `runtime_config`: every profile carries a `runsc` section, so any
  profile can be placed on gVisor.
- **V. The executor reaches the gateway over `https:` only (decision 4; review L1).** `REGULAIT_GATEWAY_URL` must be
  `https:`. A plain `http:` URL is accepted only for a loopback host (`localhost`, `127.0.0.0/8`, `::1`), or when
  `REGULAIT_EXECUTOR_ALLOW_INSECURE_HTTP=1` is set. That development flag defaults off and is logged at start.
- **W. Refusals before authentication (review L6; accepted, partly narrowed).** A refused channel request writes one
  `executor-channel-refused` audit row before any identity is proven, so an unauthenticated caller can add audit rows.
  Request bodies of up to 4 MiB (self-test, report) used to be read before the proof was checked. Both are bounded by
  the ADR-0031 global per-IP rate limit, so no extra limiter is added. The body read is also narrowed: the proof's
  header, signature, identity, credential, `htm`, `htu` and `iat` are now verified in an `onRequest` hook BEFORE the
  body is read. Only the body hash (`bh`), the one-use `jti` claim and the executor lookup wait for the body. An
  unproven caller can therefore no longer make the gateway buffer a large body. Re-check both if the channel moves
  behind a proxy that hides client addresses from the per-IP limit.

Open questions I3 leaves to the master (also in the PR):

1. S7's service-workload token path (amendment K) and whether the proof stays as the stricter option.
2. Whether a quarantined executor's withdrawn offers should be RE-OFFERED to another executor by the broker (today the
   placement is refused `executor_quarantined` and the caller decides); I4's governed path is the natural place.
3. The stream's transport for stdio bytes (amendment L): the same window, or a sibling stream.
4. ~~Whether re-enable should also require a fresh self-test on the gateway side before the executor's classes count
   again.~~ Answered by amendment T: yes. The gateway counts only attestations observed after the re-enable.

## Rollout: slices (one PR each)

Hot files as in earlier batches (`schema.ts`, migrations, `app.ts`, `route-classes.ts`, `openapi-registry.ts`, the
lockfile, shared zod) belong to I1. The governed call paths belong to ADR-0188 S4 and ADR-0189 B2 until they merge.
**Claude builds the backend slices; Codex owns the web UI (I9) and reviews every Claude slice**, and writes
escape and attestation test vectors from this ADR's text alone (not from the code), so the executor's probes are
checked against the specification rather than against themselves.

| Slice | Owner | Content | Depends on | Parallel? |
|---|---|---|---|---|
| **I0 spike** (research, no product code) | Claude | gVisor: the offline install path (APT package or bundled binary), an ADR-0187 worker under `runtime: runsc` in compose, the decision 6 probe set distinguishing runc, runsc and (on a KVM host, if one is available; otherwise recorded as not run) Kata; overhead for a stdio MCP round trip. OpenShell 0.1.x: gateway and a sandbox in compose, its interceptor contract over `unix://`, prover findings, its telemetry with an egress test (ADR-0177 §1), preloaded images air-gapped, its kernel floor on our CI hosts. Primary-source re-check of every release and licence in the survey table, including the ones GitHub refusal left unconfirmed (Kata's latest tag, Firecracker, nsjail). Output: a research note, go/no-go per backend | none | **Yes, now** |
| **I1 foundation** | Claude | Migration `0183+` (decision 14), `schema.ts`, shared zod for `regulait.execution-profile.v1`, the shipped profiles, strict settings with audited relaxation, routes as 501 stubs | I0 go; ADR-0188 S1 and ADR-0189 B1 merged (shared journal) | serial (hot files) |
| **I2 placement decision** | Claude | Required-class computation (decision 7), refusal codes, the `execution-profile` rule id, the `delegation-isolation` check in `delegation.ts`, audit actions | I1; ADR-0188 S3/S4 merged | serial |
| **I3 executor core** | Claude | `packages/sandbox-executor`: ADR-0188 registration and DPoP, the outbound stream, placement offers, the self-test and per-placement report, quarantine; a fake backend for tests | I1; ADR-0188 S5 merged | **Yes**, with I2 |
| **I4 gVisor backend and stdio move** | Claude | `runsc` backend (compose and Kubernetes), stdio closure images pinned by digest, MCP over the executor stream, **removal of the in-gateway stdio spawn**, ISACA item 5 collector | I2, I3 | serial |
| **I5 engines under profiles** | Claude | ADR-0187 workers and scanner placed as `engine_worker`, runtime probes in their self-tests | I4 | **Yes**, with I6 |
| **I6 Kubernetes and Kata** | Claude | RuntimeClass `gvisor`/`kata` manifests, PSS `restricted` namespace, deny-all NetworkPolicy, BYOC and air-gapped runbooks (every command executed first, M-041) | I4 | **Yes**, with I5 |
| **I7 OpenShell backend** (if I0 says go) | Claude | Compute via OpenShell's drivers, our interceptor on `unix://`, prover findings to the approvals queue as a new kind `isolation_policy_change`, `injected_at_egress` secrets | I4; owner go after I0 | **Yes**, with I5/I6 |
| **I8 evidence** | Claude | `decision_facts.execution`, the Decision BOM section, AI BOM executor and profile components | I2; ADR-0189 B2/B3 merged | **Yes**, with I5–I7 |
| **I9 web UI** | Codex | Execution profile option on the agent builder and the MCP server page (ADR-0177 §3: no new navigation group); profiles and executors under the existing Engines page (Integrations); placement refusals with their reason; attestation chips; posture rows | I1 stubs | **Yes** (web only); merges after I2–I4's real routes |

## Test strategy

Every rule gets a red proof (fails with the control removed, then passes), through the real app, with an upstream
counter that must stay at zero for every refusal (the `pillar7-inheritance.test.ts` style).

- **Fail closed.** A regulated project's stdio call with only an L2 executor → `409 execution_profile_unavailable`
  (`class_below_required`), zero sandboxes started. With no executor, a stale attestation, a quarantined executor or a
  retired profile → refused with each reason. `isolation_enforcement` relaxed to `warn` → placed, gate warning,
  audited relaxation; the invariants still hold (no in-gateway stdio, no L0 for `mcp_stdio`).
- **No fallback.** An L3 requirement while an L2 executor is idle is never placed on it, including after a retry, a
  queue, or a restart.
- **Mismatch.** An executor that claims L2 but whose per-placement report shows the host kernel (a fake backend
  lying in one probe at a time) → refused before input is delivered, executor quarantined, alert raised.
- **Escape probes (Codex vectors).** From inside a sandbox at each class: egress to a public literal address and
  through DNS fails; the root filesystem is read-only; no executor, runner or gateway credential is reachable; host
  paths are absent; `CapEff` is zero; exec of a file not in the image fails under `image_only`; resource limits kill
  the workload and the call ends `unknown`, never clean.
- **Delegation.** A child grant requesting a lower class than its parent → `delegation-isolation`; a middle actor's
  executor quarantined → the leaf's next call refused (ADR-0188 decision 17).
- **Cascade.** A compliance tag with `min_isolation_class` L3 raises an L2 project; a tag can never lower it; an
  unknown agent gets the most restrictive profile.
- **Credentials.** A sandbox's environment, arguments, image layers and filesystem contain no secret (canary
  secrets planted on the executor host); a `task_scoped` token is bound to a key generated inside the sandbox and is
  refused when presented from outside it.
- **Evidence.** Every placement has an audit row and a `decision_facts.execution` section matching it; a decision
  before I8 shows `not_recorded, reason: pre_isolation`; the AI BOM composition is `incomplete` while any stdio server
  runs below L2.
- **stdio residuals of ADR-0185.** Swapping the command file after registration has no effect (the digest-pinned
  image runs); a modified interpreter or module is not reachable from the sandbox.
- **Regression.** ADR-0187 engine suites, ADR-0185 stdio suites (re-targeted to the executor) and the ADR-0188 suites
  pass unchanged in behaviour apart from the placement.

## Owner decisions (accepted 2026-10-10)

The owner accepted all nine recommendations on 2026-10-10, as written below: gVisor for L2 and Kata for L3 (OpenShell
optional after the I0 spike); no third-party code on the gateway host (invariant); sensitivity floors L2/L2/L2/L3,
relaxable to L1 only with step-up and audit; engine workers at L2; software attestation in v1; `customer_declared`
maps to no class until an admin maps it; OpenShell over a local unix socket only; Wasmtime deferred; resource defaults
and a 2-hour attestation age as listed. Slice I0 may start now; I1 onward follows the slice plan.

1. **OWNER DECISION — first real backend.** *Recommended:* gVisor (`runsc`) for L2 everywhere and Kata for L3 on
   Kubernetes, behind the contract; OpenShell as an optional backend after spike I0, never the only path to a required
   class. Alternative: OpenShell first (more features sooner, but an alpha runtime on every required path).
2. **OWNER DECISION — third-party code never in the gateway host.** *Recommended:* an invariant, not a setting: stdio
   MCP servers (and any future code execution) run only in executors; the in-gateway spawn of ADR-0185 is removed in
   I4 with no grace period (nothing is live). This departs from "an admin may relax every setting" (ADR-0180), as
   ADR-0188 did for unbound tokens and ADR-0189 for content in BOMs. Alternative: keep in-gateway stdio as an audited
   relaxation labelled "not isolated".
3. **OWNER DECISION — sensitivity floors.** *Recommended:* L2 for `public`, `internal` and `confidential`; L3 for
   `regulated`; each relaxable down to L1 (never L0) with audit and step-up. Alternative: L3 for `confidential` too
   (stronger, but needs KVM-capable nodes for most real projects).
4. **OWNER DECISION — engines on hosts without gVisor.** *Recommended:* strict L2 floor for `engine_worker`, so an
   install without `runsc` cannot enable engines until an admin relaxes to L1 (audited, step-up), as ADR-0187 decision
   79 did for credential isolation. Alternative: L1 floor for engines (ADR-0187's posture as built).
5. **OWNER DECISION — attestation strength in v1.** *Recommended:* software attestation (decision 6) with its limits
   stated in every piece of evidence; hardware-rooted attestation is a later ADR. Alternative: require hardware
   attestation for L3 now (blocks L3 for most deployments).
6. **OWNER DECISION — BYOC customer-provided isolation.** *Recommended:* `customer_declared` maps to no class until an
   admin maps a named plane (audited, step-up), and evidence always says "declared". Alternative: accept a customer's
   declaration at face value (simpler onboarding, unverifiable evidence).
7. **OWNER DECISION — OpenShell's bearer-authenticated interceptor.** *Recommended:* accept it only over a `unix://`
   socket with no network listener, with pinned algorithm, issuer and audience, recorded as an ADR-0176 §4 deviation
   and re-checked each OpenShell release; drop OpenShell if the spike shows the socket cannot be confined.
   Alternative: wait for mTLS support upstream before any integration.
8. **OWNER DECISION — WebAssembly tool sandboxes.** *Recommended:* defer Wasmtime to a later ADR as its own class
   for WebAssembly-only tools; admitting it needs an explicit decision on its licence (Apache-2.0 WITH LLVM-exception,
   an exception that only grants permissions; the owner admitted the same terms inside the garak image, ADR-0187 Q21).
   Alternative: admit now and include a WASI tool path in I4.
9. **OWNER DECISION — defaults.** *Recommended:* the resource, persistence, network and secrets defaults of decision 2
   and the 2 h attestation age of decision 6. Alternative: a looser 24 h attestation age (fewer canary sandboxes,
   slower detection of a drifted host).

## Open questions

1. **Suite gating.** CLAUDE.md requires checking the suite capability map before building what another module may
   own (a sandbox runtime may be a suite capability). The suite documents are not reachable from this session.
   Proposed: the suite agent confirms RegulAIt owns execution profiles for its own gateway before I1, as ADR-0188 and
   ADR-0189 asked for PF-02 and PF-09.
2. **The other PF-06 halves.** Per-user OAuth brokering and a token vault (with PathForward's adversarial test for a
   foreign token endpoint), and compensation/sagas for mutating tools, each need their own ADR. Which goes first?
3. **Hardware-rooted attestation.** TPM-measured nodes or confidential-computing reports for L3; which, and when.
4. **Remote MCP servers.** Should a remote upstream be able to present an isolation claim we record (signed by its own
   identity, ADR-0188 decision 8), or does it stay `external` forever?
5. **GPU workloads.** Neither gVisor's nor Kata's GPU paths were assessed; any GPU-using tool is out of scope for v1.
6. **Developer machines.** gVisor and Kata are Linux-only; on macOS and Windows the demo runs inside a Linux VM. The
   I0 spike reports whether the demo can show L2 there.
7. **pipelock's Apache core** as an egress-containment option (PathForward extension row): evaluate after I7, since
   OpenShell's supervisor covers the same need where it runs.
8. **Unverified facts from the survey** (GitHub unreachable): Kata's latest tag and date, Firecracker's and nsjail's
   upstream release dates, `go-landlock`'s licence, OpenShell's telemetry defaults, and OpenSandbox's repository
   provenance. I0 re-checks each before any slice depends on it.

## Consequences

- RegulAIt can say, truthfully and per workload, what isolation a call ran under, and refuse it when the required
  isolation is missing. "Sandbox" appears in product text only for L2 and above, matching ENTERPRISE_READINESS_PLAN §3.
- ADR-0185's three stdio residuals (TOCTOU, interpreter pinning, credential binding) close when I4 ships, and
  third-party code leaves the gateway host.
- Installs gain an operational dependency: a container runtime with `runsc` (and KVM for L3) beside the gateway, plus
  executors. Installs without them cannot run stdio servers or engines until an admin relaxes a floor, which the
  posture page shows.
- Every isolable call pays a placement check and, for a new sandbox, a start-up cost. I0 measures it; there is no
  cache of attestations beyond their stated age, because a longer cache is what would let a drifted host keep serving.
- Evidence is software-attested only. The Decision BOM and the ISACA pack say so; hardware attestation is a later
  decision.
- The kernel gains one rule id, `delegation_grants` two columns, and the audit chain new actions; ADR-0188's identity
  and ADR-0189's facts carry isolation without a second evidence format.
- Not decided here: per-user OAuth brokering, compensation/sagas, WebAssembly tool sandboxes, pipelock's egress core,
  hardware attestation, real BYOC execution (owner-gated, ADR-0183), and any production designation (standing
  guardrail).

## Sources (read 2026-10-10)

- gVisor release bucket listing (`storage.googleapis.com/storage/v1/b/gvisor/o?prefix=releases/release/2026`), Go
  module proxy (`gvisor.dev/gvisor`, `.../kata-containers/src/runtime`, `go-landlock`), Repology project API
  (gvisor, kata-containers, firecracker, nsjail, bubblewrap, runc, crun, wasmtime).
- PyPI JSON API: `openshell`, `microsandbox`, `opensandbox`. crates.io API: `wasmtime`, `landlock`.
- OpenShell documentation (docs.nvidia.com/openshell: overview, architecture, support matrix, extensibility).
- kubernetes.io Pod Security Standards; `dl.k8s.io/release/stable.txt`.
- docs.kernel.org Landlock userspace API; nodejs.org `node:wasi`.
- Secondary (search results only, marked where used): NVD and SUSE entries for CVE-2026-41326, a vendor's
  confidential-containers release notes, the Arch Linux package pages for Firecracker and nsjail, a gVisor-users
  mailing-list post.
