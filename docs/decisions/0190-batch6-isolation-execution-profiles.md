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
| `isolation_enforcement` | `enforce` | none: `enforce` is the only value (owner decision A, 2026-10-11). To run where a class is unavailable, an admin lowers the requirement itself through the floor relaxations below | not relaxable; a request to set any other value is refused 400 |
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
  journal is re-ordered at merge time against 0184–0186 and S5's 0188. `execution_offers.decline_reason` is named in
  the ADR-0102 prose-scrub EXCLUSIONS (`PROSE_SCRUB_EXCLUSIONS`), not registered for scrubbing: a DB CHECK limits it to
  the five decline codes and the channel route accepts only that enum, so no operator text can reach it.

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

## Amendments from the conformance-vector gaps (2026-10-10)

The specification vectors merged in PR #334 (`packages/shared/test-vectors/placement/`) list the places where this
ADR left a behaviour undefined. Each numbered item below closes one. Where the decisions already imply the answer, it
is written down. Where the code on `main` (slice I3) answers it securely and consistently with the decisions, the
code's behaviour is adopted and cited. Where the code is weaker, the strict rule is written and marked **code
follow-up required**. Where the rule binds a slice that is not built yet (I2, I4, I7), it says so. Two product choices
are left to the owner at the end. None of these items relaxes a strict default (ADR-0180).

1. **An expired offer is a refused placement with reason `no_executor`. `offer_expired` is never a placement
   reason.** An offer that nobody accepts in time, or that is accepted but has no report by the deadline, expires on
   the database clock. It gets a refused placement row with `no_executor` under an `execution-refused` audit row.
   `offer_expired` is only the channel's answer to the executor (`409`), when it tries to accept or report on an
   offer that has already expired. The caller never sees it. *Adopted from the code:* `expireLockedOffer` and the
   accept and report routes in `apps/gateway/src/executor-channel.ts`.
2. **The five decline codes, and the placement reason each one gives.** An executor declines with one of these codes,
   which a database CHECK and the route's enum enforce (amendment S): `attestation_stale` gives `attestation_stale`;
   `class_below_required` gives `class_below_required`; `capacity` gives `no_executor`; `quarantined` gives
   `executor_quarantined`; `profile_unknown` gives `profile_retired`. This is amendment P's "the executor's reason",
   expressed in decision 7's fixed vocabulary. *Adopted from the code* (`EXECUTION_OFFER_DECLINE_REASONS`,
   `declineToRefusal`).
3. **A latest failing self-test gives `attestation_stale`.** Decision 7 fixes five reasons, and none of them is
   "failed". Amendment P's `attestation_stale` means that an attestation exists but none counts as a fresh `pass`.
   Under amendment N, a latest `fail` is such an attestation. *Adopted from the code:* `offerPlacement` returns
   `attestation_stale` when a counting row exists and `freshAttestation` returns none. The audit trail still records
   the failure itself (`executor-attestation-failed`). Vector `attestation-failing`.
4. **Freshness ends at the boundary instant.** A `pass` is fresh while `now() < observed_at + limit`, where `limit` is
   amendment N's minimum. At exactly `observed_at + limit` it is stale. Both times come from the database, and both
   are stamped in the same statement. *Adopted from the code:* `expires_at = now() + limit` at insert, and
   `freshAttestation` refuses when `expires_at <= now`. Vector `freshness-boundary`.
5. **The insecure-HTTP flag is on only for the exact value `1`.** Any other value of
   `REGULAIT_EXECUTOR_ALLOW_INSECURE_HTTP` leaves the flag off, including `true`, `yes`, `0` and the empty string. A
   plain `http:` URL to a host that is not loopback then refuses to start. *Adopted from the code*
   (`packages/sandbox-executor/src/main.ts`). Vector `executor-url-flag-not-1`.
6. **Loopback is judged on the URL's normalised host.** The loopback hosts are `localhost`, `127.0.0.0/8` in any
   spelling that the WHATWG URL parser normalises into that range (for example `127.1`), and `[::1]` in any spelling
   that normalises to it (for example `[0:0:0:0:0:0:0:1]`). An IPv4-mapped address such as `[::ffff:127.0.0.1]` is
   not loopback, and neither is `localhost.` (with a trailing dot): over `http:` without the flag, both refuse to
   start. Prefix and suffix tricks such as `localhost.example.invalid` and `127.0.0.1.example.invalid` are refused.
   *Adopted from the code* (`checkGatewayUrl`, `packages/sandbox-executor/src/client.ts`). Vectors `executor-url-*`.
7. **A `bh` mismatch consumes nothing.** The order is fixed: the body hash is checked first, then the one-use `jti`
   is claimed, then the executor is looked up. A request whose valid proof header does not match its body is refused
   `401 proof_body`, writes one `executor-channel-refused` row and leaves the `jti` unclaimed. A substituted body
   therefore cannot burn the real request's proof, as ADR-0188 decision 23 rules for a delegation authorization.
   Replay stays closed, because the proof is only accepted with the exact body it hashes. *Adopted from the code*
   (`apps/gateway/src/executor-channel-auth.ts`, the body phase). Vector `channel-proven-header-then-bad-body-hash`.
8. **An unmapped `customer_declared` plane gives `class_below_required`.** Its attestation is fresh, but by
   owner decision 6 it maps to no class, so it is below every requirement. *Adopted from the code* (`offerPlacement`
   and the accept and report routes: `declaredClass` null satisfies nothing). Vector `customer-declared-unmapped`.
9. **Ties are unspecified on purpose.** Among eligible executors with the same number of open offers, the broker may
   pick any one. A test must not pin which one is chosen, and no tie order carries a security property. *Adopted from
   the code* (an unordered read, then a stable sort on open offers).
10. **A mismatch answers `409 execution_profile_mismatch`.** The executor's report route answers `409` with that
    error, `next: quarantined` and the failures. *Adopted from the code.* Binds I4: the governed call whose placement
    failed this way is refused to its caller with `409`, error `execution_profile_mismatch` and rule id
    `execution-profile`, and zero input bytes are delivered. Vector `placement-report-mismatch`.
11. **`delegation-isolation` takes the shape of a delegation refusal.** Binds I2. The check runs at child admission
    (ADR-0188 decision 22), at the same point as the budget and depth checks. On the token endpoint it is
    `invalid_grant` with `error_code` `delegation_isolation`, by decision 15's pattern for `delegation_budget` and
    `delegation_depth`; I2 adds the code to `DELEGATION_ERROR_CODES`. In process it is the delegation refusal with
    rule id `delegation-isolation`. Either way it is audited, and no grant is created. Vectors
    `delegation-L2-L1`, `delegation-L3-L1` and `delegation-L3-L2`.
12. **A middle actor's invalid placement is an `actor-chain-invalid` refusal.** Binds I2. Decision 8's live-chain
    addition is part of ADR-0188 decision 17, and ADR-0188 decision 28 refuses a chain with an actor that is not live
    as `actor-chain-invalid`. Three conditions trigger it: the executor that holds the middle actor's placement is not
    `active`, it is quarantined, or its attestation for the required class is not fresh. The refusal has the same
    envelope as every other `actor-chain-invalid` on that path. Its detail names the failing grant and which of the
    three conditions failed, and the upstream counter stays at zero. Vectors `middle-actor-executor-*`.
13. **An OpenShell placement on gVisor is refused at both ends.** The gateway side is built: an `openshell` report
    that claims `user_space_kernel` fails `class_not_attestable_by_backend` (`BACKEND_ATTESTABLE_CLASSES`). In a
    self-test, that withdraws the class. In a placement report, it is a mismatch: the executor is quarantined.
    *Adopted from the code.* Binds I7 on the executor side: an executor configured for the `openshell` backend with
    `runtimeClassName: gvisor` refuses to start (a configuration error, with no sandbox started), and it never offers
    to take such a placement. Vector `openshell-gvisor-refused`.
14. **`warn` never places below the required class, until the owner rules.** Decision 11's table makes "falling back
    to a lower class than required" an invariant that cannot be relaxed. The `warn` row contradicts it, and so does
    the Fail closed test strategy line. Until open item A below is decided, the invariant wins (ADR-0180): under
    `warn`, as under `enforce`, no call is placed below its required class. The broker already behaves this way:
    `offerPlacement` filters on the class whatever the mode. **Code follow-up required:** the per-placement report
    check exempts `warn` offers from the class comparison (`o.enforcement === "enforce" && …` in the report route of
    `executor-channel.ts`). A report whose applied class is below the requirement must be an
    `execution_profile_mismatch` in every mode. The `isolationEnforcement` help text in
    `packages/shared/src/isolation/settings.ts` ("placed on the best isolation available") must say the same. Vector
    `warn-shortfall`.
15. **Unresolved policy facts fail closed before any offer.** Binds I2. Several inputs can be missing or not
    resolvable: an unknown workload kind, an unknown sensitivity, an unknown class in a floor or a compliance tag, or
    a policy lookup that did not resolve. In each case the call is refused before any executor is offered work and
    before any upstream is contacted. No placement is offered, and the refusal is audited `execution-refused`. A
    missing fact is never coerced to a class, never dropped from the MAX, and never defaulted. The one exception is
    decision 7 item 5's unknown agent, which defaults to the most restrictive profile. The envelope is open item B
    below. Vectors `unknown-*`.

**Open for the owner** (decided 2026-10-11; see "Owner decisions on A and B" below).

- **A. What `warn` means.** *Recommended:* retire `warn` as a value of `isolation_enforcement`. An admin who cannot
  provide a class lowers the requirement itself, through the relaxations decision 11 already audits (each
  sensitivity floor down to L1, the `mcp_stdio` and `engine_worker` floors down to L1, each with a step-up). The
  requirement and the placement then never disagree, and no call is ever placed below what its own record says it
  required. Alternative: keep `warn` as "enforce, plus a posture warning when a call is refused", which also keeps
  the invariant. Either way, the decision 11 row and the Fail closed test strategy line are rewritten to match.
- **B. The envelope for an unresolved policy fact (item 15).** *Recommended:* `409 execution_profile_unavailable`,
  rule id `execution-profile`, with a sixth fixed reason `policy_unresolved` added to decision 7's list. The caller
  sees the same refusal family as every other isolation refusal, and the audit row can tell a configuration fault
  from a capacity fault. Alternative: answer with a server-side error (`503`), treating the fact as a fault in our own
  data rather than a policy outcome.

## Owner decisions on A and B (accepted 2026-10-11)

The owner accepted both recommendations ("go with your recommendations", master session, 2026-10-11).

- **A. `warn` is retired.** `warn` is removed as a value of `isolation_enforcement`. The only value is `enforce`
  (ADR-0180). An admin who cannot provide a class lowers the requirement itself, through the relaxations decision 11
  already audits: each sensitivity floor down to L1, and the `mcp_stdio` and `engine_worker` floors down to L1, each
  with a step-up. The requirement and the placement therefore never disagree, and no call is placed below what its own
  record says it required (PR #340 already enforces this in every mode).
  - **Code follow-up:** the setting, its schema, the UI control and its help text lose `warn`. A stored `warn` value is
    read as `enforce` (no grandfathering). The decision 11 row and the Fail closed line of the Test strategy are
    rewritten to match.
  - **Vectors:** `warn-shortfall` is pinned as a refusal, or retired as a case that can no longer be configured.
- **B. An unresolved policy fact answers `409 execution_profile_unavailable`.** Rule id `execution-profile`, with a
  sixth fixed reason `policy_unresolved` added to decision 7's list. The caller sees the same refusal family as every
  other isolation refusal, and the audit row tells a configuration fault from a capacity fault.
  - **Code follow-up:** the placement path maps every unresolved or missing policy fact to this envelope, and the
    `unknown-*` vectors are pinned to it.

**As built (PR #346, migration 0191; reviewed under ADR-0191).**
- **Stored values are rewritten.** A stored `warn` in `org_settings` and `execution_offers` is rewritten to `enforce`.
  Each rewritten row gets a `migration_audit_outbox` row (ADR-0181 FX2) carrying the old value, the new value and the
  reason. The migration is safe to run twice.
- **Historic placements keep their mode.** `execution_placements` is append-only evidence, so its rows keep the mode
  they were recorded under. The `enforce`-only and no-fallback CHECKs are added `NOT VALID`: they bind every new row,
  and history is not rewritten. No reader re-validates the old rows.
- **B's scope today.** `policy_unresolved` is enforced at the placement broker boundary. It covers a missing required
  class, a missing or malformed image digest, and a missing or malformed profile digest, each refused and audited
  before any offer. The gateway resolvers for sensitivity, compliance floors, autonomy and parent lookups arrive with
  slice I2, and they must call `unresolvedPlacementFact` before computing the MAX. Until I2 no route answers the HTTP
  409 envelope.

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

**I9 lands early as a preview (2026-10-11, PR #361).** ADR-0191 moved I9 to Claude, and the owner's branch cleanup
asked that Codex's I9 work (Codex PR #303) be kept rather than lost. So I9 merges before I2–I4's real routes, in place
of the "merges after I2–I4" rule above, under three conditions that keep the preview honest:
1. A screen whose route is still a 501 stub says so plainly and refuses a success response from that route; it never
   shows sample data. The profiles and placements cards and the agent-builder and MCP-server profile selector stay in
   this state, disabled with the reason shown, until their routes are built.
2. Only routes that exist today are driven: `GET /v1/executors` with the gateway's own freshness verdict, executor
   registration with the strict schema, and the isolation settings (enforce-only per decision A, step-up on save,
   audited relaxation per ADR-0180).
3. Each later slice (I2–I4, I8) that turns a stub into a real route also switches its card from the stub state to
   the live state in the same PR, with that card's tests. A merged stub screen is not counted as I9 being done.

## As built: slice I2 placement decision (2026-10-12)

I2 delivers the required-class computation (decision 7), the placement decision with its refusal envelope and
audit, the `delegation-isolation` check, and real profile, placement and assignment routes. Migration 0194 holds
the new columns and the database backstop that a child grant never drops below its parent's class. No governed
call path calls `decidePlacement` yet: I4 (stdio) and I5 (engines) wire it in. These points settle what the
decisions above leave open:

1. **Project sensitivity.** Projects carry no sensitivity of their own. The project's sensitivity is the strictest
   sensitivity among its AI use cases. A project with no use case, or a call with no project, cannot resolve the
   fact and is refused `policy_unresolved` (fail closed, ADR-0180). Once I4/I5 route calls through placement, a
   stdio call in a project without a use case is refused until one is registered. Whether projects should get
   their own sensitivity field is an open question for the owner. Until it is settled, the fail-closed rule stands.
2. **Agents with no autonomy class.** Registry agents and RegulAIt's own workers get a defined L1 autonomy floor.
   A floor that is genuinely null stays unresolved and is refused, as the `unknown-autonomyFloor` vector requires.
3. **Assurance vocabulary.** It adds `unknown`, for a workload kind that acts for an agent but names none. That
   case maps to `restricted-microvm` (L3).
4. **Additions to decision 14:**
   - columns `mcp_servers.execution_profile_id` (decision 7 item 5, "the MCP server's own profile") and
     `delegation_grants.execution_placement_id` (needed for the live-chain check, amendment item 12);
   - the `execution-profile-assigned` audit action;
   - the assignment routes `GET`/`PUT /v1/execution-profile-assignments/:targetKind/:targetId`, for agents,
     builder agents and stdio MCP servers.
   An assignment looser than the current one needs a `settings_relax` step-up and a compare-and-set.
5. **Shipped profiles.** `restricted`, `restricted-microvm` and `engine-worker` cannot be versioned or retired
   through the API. A new profile, or a new version, looser than `restricted` (or than the version it replaces)
   needs a `settings_relax` step-up and is audited `execution-profile-relaxed`. Lowering a compliance profile's
   `minIsolationClass` is treated as a relaxation.
6. **Token endpoint.** The `delegation_isolation` error code is mapped to `invalid_grant`. It cannot be produced
   there today, because a signed child body has no class field and always inherits its parent's class.
7. **Which floor is named (`requiredBy`).** When several floors give the same highest class, the first in
   decision 7's order is named: workload kind, data sensitivity, compliance tag, autonomy class, configured
   profile, unknown agent, parent grant. The configured-profile floor is the profile actually configured (the
   server's, else the agent's, else the shipped default), whatever the agent's assurance. An unknown or
   low-assurance agent's forced `restricted-microvm` counts as the unknown-agent floor, not the configured profile.
8. **Grants and placements.**
   - A grant that names a placement must carry a class at least as strict as the placement's required class. A
     child that inherits gets its parent's class.
   - A placement belongs to one actor in one chain. A grant from another actor, or under another root, is refused
     `placement_bound_elsewhere`.
   - A placement stays live only while its executor attests at the stricter of the grant's class and the
     placement's required class.
   - These rules hold in code, and the migration 0194 trigger enforces them too. A placement refusal on a root
     grant is audited like one on a child, and nothing is created if the audit write fails.
9. **Stdio and tags must resolve.**
   - An `mcp_stdio` call must name a stdio server. A missing, unknown or non-stdio server refuses
     `policy_unresolved`, with no fallback to the agent's or the default profile.
   - Malformed project classifications refuse `policy_unresolved`. A null column still means no tags.

## As built: slice I4 gVisor backend and the stdio move (2026-10-15)

I4 delivers the `runsc` backend, the stdio closure images, MCP over the executor's channel, the removal of the
in-gateway stdio spawn, the ISACA item 5 collector, and (from the I8 review) the governed stdio decision's own
placement row. Migration **0198** (`0198_isolation_stdio_placement_evidence.sql`) is hand-written; its journal entry
(idx 198) was added once 0196 and 0197 were on main. Items 2, 3, 6, 7 and 9 below were changed by the review round
listed after item 11; where they disagree, the review round wins. These points settle what the decisions above leave
open:

1. **The runsc backend is Docker's own CLI on a host whose daemon registers gVisor as a runtime** (decision 4,
   amendments A to E). `packages/sandbox-executor/src/runsc-backend.ts` starts each sandbox with `docker run -i
   --runtime runsc` from the image's content digest (`--pull never`), with every isolation property taken from the
   profile: `--network none`, `--ipc none`, a read-only root, one tmpfs work directory (`noexec` under `exec:
   image_only`), the profile's uid, `--cap-drop ALL`, `no-new-privileges`, the runtime-default or the profile's named
   seccomp profile, CPU, memory without swap, the host `pids.max` with headroom and `RLIMIT_NPROC` for the workload
   (amendment C), no log driver and no environment passed in. The executor-side observations come from the Docker
   Engine API (`/info`, `/containers/{id}/json`, `/containers/{id}/stats`). The executor image carries the official
   Docker CLI (pinned by digest, Apache-2.0); gVisor itself is installed on the host from the I0 tarball (amendment E).
   The backend attests `user_space_kernel` only, refuses a placement whose profile asks for inputs, a scoped volume,
   an allow-list network or secrets (none of those channels exists yet), and refuses to start when the daemon has no
   `runsc` runtime or that runtime's binary is not `runsc`.
2. **What proves the runtime is runsc** (decision 6, amendment U): from inside, the sandbox init reads
   `/proc/version` (gVisor names itself) and `dmesg`; from outside, the container's `HostConfig.Runtime` must be the
   configured runtime name and its binary must be `runsc`, and the runtime's `runtimeArgs` are reported verbatim as
   `runtime_config.flags`. A sandbox under any other runtime is reported as `runc` with no flags, so the gateway fails
   it (`backend_mismatch`, `class_above_observed_runtime`); a missing profile flag fails `runtime_flags_missing`.
3. **The sandbox init and the closure images** (decision 4). Every stdio closure image is built FROM the RegulAIt
   stdio base (`packages/sandbox-executor/stdio-base/`), which carries the init at `/regulait/sandbox-init` (a file
   of the pinned image, so `exec: image_only` holds and nothing is mounted in). The init probes from inside the
   sandbox, prints one observation line, then reads exactly one release line byte by byte: the gateway's `start`
   message carries the registered entry point and argv, and only then does the init run the server with the
   sandbox's own stdin and stdout. A canary (the self-test) is never given a workload. The registration keeps the
   `mcp_servers` stdio columns with a new meaning (no migration): `stdio_command` is the absolute entry point inside
   the image, `stdio_args` its argv, `stdio_command_digest` the closure image's content digest (`sha256:` + 64 hex).
   Images are pinned by the content digest Docker reports (`docker image inspect --format '{{.Id}}'`), which
   survives `docker save`/`docker load` for air-gapped bundles.
4. **MCP over the executor's channel: a sibling stream on the same proof** (answers I3 open question 3). Two
   routes join `EXECUTOR_CHANNEL_ROUTES`: `GET /v1/executor-channel/offers/:offerId/stdio?window=` (gateway to
   sandbox: `start`, `stdin` frames, `close`, keepalives, `bye`) and `POST …/stdio` (sandbox to gateway: `stdout`
   frames, `eof`). One frame is one JSON-RPC line (at most 768 KiB); sequence numbers per direction are contiguous
   and a gap or repeat ends the session. The gateway side is an MCP SDK `Transport` using the SDK's own
   `serializeMessage`/`deserializeMessage`.
5. **No in-gateway spawn, no fallback** (OWNER DECISION 2, ADR-0180). `mcp-transports.ts` has no spawn path, no
   process cap and no host opt-in; `REGULAIT_MCP_STDIO_ALLOWED_DIRS` and `REGULAIT_MCP_STDIO_MAX_PROCS` are gone. A
   static guard (`adr0190-i4-no-gateway-spawn.test.ts`) fails if any serving gateway module imports
   `node:child_process` or the SDK's stdio client. A stdio row registered before I4 (a host path, a 64-hex file hash)
   is refused at connect `mcp_stdio_image_unpinned` (first load, no grandfathering). The refusal codes are now
   `mcp_stdio_command_refused` (`not_absolute`, `invalid_argv`), `mcp_stdio_image_unpinned` and
   `execution_profile_unavailable` (rule id `execution-profile`).
6. **A governed `tools/call` on a stdio server decides its placement in its decision's transaction** (the I8
   contract, from the I8 review). In `executeGovernedToolCall`, an ALLOWED call on a stdio server with a pinned image
   runs decision 7 inside the transaction that writes its decision audit row, before that row, and writes the
   `execution_placements` row keyed to the decision's audit id:
   - `offered` (new outcome): the chosen executor, the class its fresh attestation shows, that attestation
     (`attestation_id`), the image (`image_digest`), the SHA-256 of the runtime flags that attestation reported
     (`runtime_flags_sha256`) and the offer (`offer_id`); the offer is inserted in the same transaction;
   - `refused`: decision 7's code. The decision itself then becomes the refusal: effect `deny`, rule id
     `execution-profile`, a plain-language reason. A policy fact that does not resolve writes no placement row
     (its columns would have to hold the fact) and refuses `policy_unresolved`.
   The executor's later report never rewrites that row (the table stays append-only): it is a LINKED row in the new
   `execution_placement_reports` table (`placed`, `mismatch` or `refused` with its code, its own audit row), at most
   one per placement. The I3 broker's selection is shared (`selectExecutor`), so both paths choose and refuse by one
   rule; the I3 broker also stamps `image_digest` on the rows it writes. The session for the offer is registered as
   soon as the decision commits; a call that a later gate refuses never attaches, and after 60 s the session is
   closed (a started sandbox then gets `close` and no workload). The placement list route and the Isolation panel
   show a linked placement's effective outcome; `offered` reads "Awaiting report".
7. **Connects with no governed decision behind them** (a `tools/list` manifest sync, an unknown-tool sync, a
   protocol method, the admission rescan and health sweeps) are placed at connect time with their own audited
   decision 7 (`execution-refused`, I2), and answer `409 execution_profile_unavailable` before the reply is hijacked.
   A sweep names no project, so it refuses `policy_unresolved`.
8. **ISACA item 5**: `isaca-ai-agents@2` (v1 unchanged, its content hash pinned) evidences item 5 as `partial` by the
   new `isolation_placements` collector: placements placed at L2 or L3 in the period. Org-scoped only (a placement
   carries no project). The owner note says it covers only the workloads placed and is software-attested.
9. **Where a session lives.** The stdio session (its queued frames and its MCP client) is held by the gateway
   process that placed the call. An executor request for a session this process does not hold is refused
   `stdio_session_unknown` and the call fails closed. A multi-replica gateway needs the stdio routes to reach the
   placing replica, or a frames table; see the open questions below.
10. **CI.** The runsc integration suite (`runsc-backend.integration.test.ts`) runs only where a Docker daemon with
    gVisor exists (`REGULAIT_TEST_RUNSC_RUNTIME`, `REGULAIT_TEST_STDIO_BASE_IMAGE`) and is otherwise SKIPPED with its
    reason in its title; the I0 spike did not run gVisor on CI runners (R13, "Needs a real host or CI"). The backend's
    arguments, the probe mapping (a gVisor observation passes the gateway's evaluator; each property made untrue one
    at a time fails with its code) and the real init's handshake (run on the host in place of `docker run`; its host
    report is correctly refused) run in CI. The stdio move itself is proven against the fake backend through the real
    app (`zz-adr0190-i4-stdio-move.test.ts`), including the decision-time placement row, the linked report and the
    decision's facts naming the placement (that last assertion needs I8's capture, migration 0197).
11. **Not executed here (M-041).** The session that built I4 had no Docker daemon. The image builds, the
    `daemon.json` registration and the compose `isolation` profile are written and marked unexecuted in their files
    and in INSTALL.md; they must be run on a test host before they are relied on.

**Review round 1 (2026-10-15, PR #383).** An independent review of the first build found that the probes did not
prove gVisor, and several evidence gaps. What changed:

- **H2, what proves gVisor (replaces items 2 and 3).** The class is decided only from OUTSIDE the sandbox: the
  container's own `HostConfig.Runtime` (`docker inspect` of that container, not the daemon's `/info`), and the
  daemon's binary for that runtime, which must be at the configured host path and whose sha512 must equal the pinned
  gVisor release (`packages/sandbox-executor/src/init-pin.ts`, from the I0-verified tarball; re-hashed on every
  self-test and whenever its size or mtime changes). The sandbox init is executor-controlled: the executor ships it,
  checks its pinned SHA-256, copies it into a volume it owns and mounts that volume read-only at `/.regulait-init`,
  and runs it as the entry point under the image's Node (`--entrypoint /usr/local/bin/node`). The stdio base image no
  longer carries the init. What the init prints corroborates the inside view (uid, capabilities, seccomp, root,
  egress, DNS, interfaces, credentials, limits) and its kernel strings are recorded only: `/proc/version` and `dmesg`
  never decide the runtime. A forged observation (an init that claims gVisor in a container the daemon ran under
  runc, or under an unpinned binary) is refused in tests. **L2 is unverified until this has run on a real gVisor
  host**: no session that built or fixed I4 had a Docker daemon (M-041).
- **M1, placements keyed to the decision (amends items 6 and 7).** Governed protocol methods (`resources/*`,
  `prompts/*`, `completion/complete`, `logging/setLevel`) now place inside their decision's transaction exactly as
  `tools/call` does and attach to that session. The pre-decision manifest syncs (an unknown-tool sync, a `tools/list`
  that needs the manifest, a worker's tool resolution) remain UNLINKED placements: their row is keyed to their own
  audit row, they are not decision evidence, and they are outside the I4/I8 contract. The admission rescan and the
  health sweep skip stdio servers before any connect, with no refusal row.
- **M2.** A `policy_unresolved` refusal writes a `refused` row keyed to the decision; the requirement columns are
  nullable for that code only (CHECK `execution_placements_requirement_check`).
- **M3, a session this process does not hold (amends item 9).** It is recorded as our own refusal: an
  `execution-session-lost` audit row and, for a governed placement, one `session_lost` report row (a second replica
  writes nothing). The process that holds the session watches the offer and fails the call at once; its pending
  requests are answered with a process-marked error that the retry classifier names `our_own_refusal`, so the
  upstream's breaker is never charged. Sticky routing on the offer id, or a frames table, is still the follow-up.
- **M4.** The compose default is https; plain http only through `compose.isolation-insecure-dev.yml`, with a warning.
  Each `start` and `stdin` window line carries an HMAC-SHA-256 over the offer id, the type and (for stdin) the
  sequence number and data. The key is derived per offer from the gateway's data key (HKDF), handed to the executor
  in its accepted report's answer over the channel's TLS; every replica derives the same one. Injected argv or stdin
  is never acted on.
- **M5.** stdout is split on bytes and each line decoded once with a fatal UTF-8 decoder (linear); the init decodes
  its release line once.
- **M6.** stdin frames stay with the gateway until the executor acknowledges them (`?from=` the next sequence it
  expects); a lost window loses nothing; one window per session at a time.
- **Lows.** A placement timeout and a lost session are labelled `placement_timeout` and `session_lost`, never
  `no_executor`. A session that a later gate stopped, that timed out or that nothing attached to is cancelled: a
  `cancelled` report row with its `end_code`, the offer withdrawn, audited `execution-cancelled`. 0198 adds a trigger
  that refuses a report whose parent is not `offered` and a `placed` report below the parent's required class, and a
  composite foreign key so a report's `offer_id` is its placement's. A process holds at most 256 live stdio sessions.
  A blank stdout line is skipped. The no-spawn guard flags any quoted `child_process` literal (dynamic `import()`,
  `require`).
- **Recheck fixes (N1 to N5, 2026-10-15).**
  - N1: compose mounts the gVisor directory read-only, not the `runsc` file (a single-file bind mount pins the
    inode at container start, so an upgrade in place would leave the executor hashing the old binary). The hash
    cache is keyed on device, inode, size, mtime and ctime, and a self-test always re-hashes.
  - N2: the lost-session decision is in-process state. Each answer carries a fresh single-use nonce, which is
    consumed and stripped from the error the first time it is classified, so no client sees a value it could replay.
  - N3: an offered placement's report row is chosen deterministically: the `placed` row if any, else the refusal,
    then the gateway's own ends, then time and id.
  - N4: every sandbox's `docker run` blanks the Node variables that load code (`NODE_OPTIONS`, `NODE_PATH`,
    `NODE_REPL_EXTERNAL_MODULE`, `NODE_COMPILE_CACHE`, the symlink switches, `NODE_ICU_DATA`). The per-placement
    probe report remains evidence from inside an interpreter the IMAGE chose (an image can replace `node`); the class
    itself is decided from outside. Bind-mounting a pinned Node for the init is a follow-up.
  - N5: a digest that names no profile writes a `refused` (`profile_retired`) row keyed to the decision, keeping
    its required class and floor with `profile_digest` NULL (the requirement CHECK allows exactly that).
  - The compose default no longer names a real host; the executor exits at start when its gateway URL is not
    reachable over TLS (see INSTALL.md).
- **H1, with I8.** I8's execution facts gain an `offered` branch: at decision time the facts record the offered row
  (executor, attested class, the broker's stamped `attestation_id`, the offer, the closure image and the runtime
  flags hash, no report hash), and a `policy_unresolved` refusal may name no requirement. The Decision BOM read
  returns the placement's linked report rows beside the signed body (`placementReports`, unsigned: they are written
  after the decision), and the Decision BOM panel shows them.

Open questions I4 leaves (for the owner or the master):

1. **Calls without an agent are placed as unknown agents (L3).** I2 maps `agent: null` on `mcp_stdio` to decision 7
   item 5's unknown agent, so a person's own stdio call requires `restricted-microvm` (L3) and refuses on a
   gVisor-only (L2) host. Should a person's own authenticated call count as a known subject (L2 floor), or stay L3?
2. **Multi-replica stdio sessions** (item 9): sticky routing of `/v1/executor-channel/offers/*/stdio`, or a frames
   table (a migration).
3. **A gVisor CI job**: GitHub-hosted runners have Docker and sudo, so a job could install the pinned tarball,
   register `runsc` and run the integration suite. It was not added because it has never been run (M-041).
4. **Engines (I5)** inherit the runsc backend for `engine_worker`; they need the input volume and task-scoped
   secrets channels the backend refuses today.
5. **An https gateway address on the `engines` network** (review M4). The executor now requires https, but the
   internal-only `engines` network has no route to the TLS profile's public host, so the stock stack needs
   `REGULAIT_EXECUTOR_GATEWAY_URL` set to a TLS front on that network (until then the executor fails closed). Putting
   Caddy on `engines` was not done: the gateway would then see some Caddy traffic from an untrusted address.
6. **gVisor's sidecar binaries.** The pin covers the `runsc` binary the daemon names; the release's `gvisor-bin/`
   sidecars (for example `gvisor_sentry`) are not hashed by the executor yet.

## Test strategy

Every rule gets a red proof (fails with the control removed, then passes), through the real app, with an upstream
counter that must stay at zero for every refusal (the `pillar7-inheritance.test.ts` style).

- **Fail closed.** A regulated project's stdio call with only an L2 executor → `409 execution_profile_unavailable`
  (`class_below_required`), zero sandboxes started. With no executor, a stale attestation, a quarantined executor or a
  retired profile → refused with each reason. An unresolved policy fact → `409 execution_profile_unavailable`
  (`policy_unresolved`), audited, no offer made. Setting `isolation_enforcement` to anything but `enforce` → 400
  (owner decision A); the invariants always hold (no in-gateway stdio, no L0 for `mcp_stdio`).
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
8. **Unverified facts from the survey** (GitHub unreachable when the survey was written). *Narrowed by I0
   (amendments G and H):* R13 §4 verified Kata's latest tags (4.2.0, 2026-09-15; 3.32.0 on the 3.x line), Firecracker's
   upstream `v1.17.0` (2026-09-04), nsjail's tag date (2026-03-18) and `go-landlock`'s licence (MIT), each from the
   upstream git repository; R13 §3 read OpenShell's telemetry defaults from source (compiled in and on by default; the
   telemetry-free build of amendment G is the admissible form). **Still unverified:** OpenSandbox's repository
   provenance and the Landlock UDP ABI number (neither re-checked by R13), and OpenShell's run-time egress with
   telemetry off (the egress test needs Docker and was not run; I7 runs it). Platform questions stay with open
   question 6.

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

## As built: slice I8 evidence (2026-10-15)

I8 puts decision 9 into the evidence: decision facts, the Decision BOM and the AI BOM. Migration 0197 only widens
two CHECKs (owner ruling: 0196 belongs to ADR-0188 S8, and 0197 sorts after it). This section covers I8 alone. I4
records its own changes separately.

1. **Format versions.**
   - **Decision facts → `regulait.decision-facts.v2`.** v2 is v1 plus an `execution` key. The capture writes v2.
   - **Decision BOM → `regulait.decision-bom.v2`.** v2 is v1 plus the `execution` section and its completeness
     entry. Every Decision BOM assembled from I8 on is v2, whatever version its facts are.
   - **What migration 0197 changes.** It widens `decision_facts_version_check` and `decision_boms_body_check` to
     admit v1 and v2, and refuses anything else. `decision_facts.facts_version` now defaults to v2.
     - **How (review L2).** Each widened CHECK is added `NOT VALID`, then validated by `VALIDATE CONSTRAINT`.
     - **What that buys.** `VALIDATE CONSTRAINT` scans under SHARE UPDATE EXCLUSIVE, not under the ACCESS
       EXCLUSIVE lock the DROP/ADD takes. That shorter lock applies only when the statements run on their own.
       drizzle's migrator applies all pending migrations in one transaction (checked in drizzle-orm 0.45.3), so
       there the ACCESS EXCLUSIVE lock is held until commit.
   - **Old rows.** Stored v1 rows are valid as recorded. Nothing is rewritten or back-filled (ADR-0180).
   - **Verifiers.** The online verifier and `scripts/verify-bom.mjs` both accept the two Decision BOM versions,
     for stored BOMs and bundles alike. Each version is checked against its own section list: twelve sections for
     v1, thirteen for v2. An unknown `v` is still refused (OWNER DECISION 2).
   - **Vector N-B09** used `decision-bom.v2` as its "unknown version". It now uses `v3`. This is a reviewed
     correction under ADR-0191: the case it tests is unchanged.
2. **The AI BOM stays `regulait.ai-bom.v1`** (owner ruling, 2026-10-15). Its `records` map is open-keyed, and its
   verifier checks only `v`, the signature and the rendering hashes. A v1 verifier therefore still verifies a body
   that carries the new lists.
   - **New lists.** `executionProfiles`, `executors` and `executionAssignments`. They are optional on input and
     always present (possibly empty) in the body, as B9's `spdxFields` is.
   - **Worked example.** The B4.9 example blocks remain byte-identical apart from those empty lists. The test that
     pins this now says so.
3. **What `execution` records** (`decisionExecutionFactsSchema`). Fields:
   - workload kind, placement, placement id;
   - required class and the floor that set it (`requiredBy`);
   - applied class and refusal code;
   - the profile: id, name, version, digest;
   - the executor: id, backend, runtime version, ADR-0188 identity id and SPIFFE URI;
   - the attestation references: the per-placement report SHA-256, and the executor self-test the placement relied
     on. That self-test is chosen by the broker's own predicate as of the placement (review H1):
     - the LATEST counting self-test for that executor and profile decides (amendment 3), counting only those
       observed after the executor's last re-enable (amendment T);
     - it is named only if it is a `pass`, unexpired at the placement, for the class the placement applied;
     - so a fail after a pass, or a pass from before a quarantine and re-enable, names none.

     The query is defined once, in `packages/db/src/executor-attestation.ts` (`attestationCounts`,
     `latestCountingAttestation`). The gateway's `freshAttestation`, which the broker, the live delegation chain and
     the AI BOM loader use, is built on it. If I4 stamps the broker's own attestation reference on the placement row,
     the capture will prefer that reference.
   - **What `appliedClass` means.** For `placed`, it is the class the call ran under. For `mismatch`, it is the class
     the per-placement report claimed. The gateway refused that claim, so the call never ran under it (review L1). The
     UI labels it "Reported class (disputed)" and shows no "software-attested" note.

   Decision 9 also names the image digest and the runtime flags. `execution_placements` has no column for either,
   so the facts do not repeat them. The per-placement report, which is bound by its hash, carries both (I4).
4. **Where the facts come from: the I4/I8 contract (coordinator ruling).**
   - **With a placement row.** The `execution_placements` row is written in the decision's own transaction, before
     the audit row. The shared audit writer's capture (`packages/db/src/decision-facts.ts`) reads it in that same
     transaction. When the row exists, it is the authority.
   - **Obligation on I4 (review M2).** I4 must key each placement row to the governed decision's own audit id
     (`execution_placements.audit_id` = the decision row's `id`), and write it in that decision's transaction.
     Today's broker (`executor-channel.ts`) writes its own `execution-placed` audit row, keys the placement to that
     row, and records the report in a later transaction. I8's capture therefore cannot match a governed call to its
     placement until I4 changes this: such calls read `not_recorded, no_placement`, which is true and never a
     guess. The same obligation went to the I4 builder.
   - **With no placement row:**
     - an `agent` decision is a model call, recorded `in_gateway`;
     - a `connector` decision is a connector call, recorded `in_gateway`;
     - an `mcp_tool` decision on a `streamable_http` or `sse` server is recorded `external`.
   - **Recorded as null (NOT RECORDED).** A stdio call with no placement, an MCP decision whose server cannot be
     resolved, and an approval decision.
   - **What the Decision BOM says when execution is null:**
     - `not_applicable` for an approval (nothing executes);
     - `not_recorded, no_placement` for every other v2 decision;
     - `not_recorded, pre_isolation` for v1 facts.
   - **A malformed placement fails the capture.** A placement row the contract cannot represent fails the capture,
     and the decision with it (fail closed, as B2 does for a broken actor chain).
   - **Engine runs (review M1).** An engine run's entitlement decision (`agent`, `detail.phase` =
     `engine-run-entitlement`) governs an engine worker, which an executor places from I5 on. It is not a model call
     in the gateway. Until I5 writes its placement row it is null, so the BOM reads `not_recorded, no_placement`.
     Signed evidence never states a location known to be false. The phase is one shared constant
     (`ENGINE_RUN_ENTITLEMENT_PHASE`), used by both `engine-runs.ts` and the capture.
5. **A format change is not a new fact.** A decision frozen as v1 keeps its v1 BOM. A v2 assembly of it is the
   same version (`decisionBomSameContent`) when two conditions both hold:
   - it adds nothing but `v` and an execution section that records nothing (`pre_isolation`, `pre_facts` or
     `capture_off`);
   - everything else is identical.

   A recorded execution, or any other difference, freezes version n+1 as before.
6. **AI BOM content (decision 9).**
   - **Profiles.** Each profile is a CycloneDX `data` (`configuration`) component: hashed by its digest, versioned
     by its profile version, never its body.
   - **Executors.** Each executor is a `service`. Its trust zone is `regulait-execution-plane`, or
     `customer-execution-plane` for a customer plane. Its properties are:
     - backend, runtime version and status;
     - declared classes, and the class a customer plane is mapped to;
     - its workload identity;
     - each fresh passing self-test (`class:profileDigest` and the report SHA-256).
   - **Self-test freshness (review H1).** For each (executor, profile), the loader applies the broker's
     `freshAttestation`:
     - the latest counting row decides (amendments 3 and T);
     - it must be a `pass` unexpired at the capture's database clock (M-075).

     A fail after a pass therefore lists no attestation, and a stdio server whose only executors are in that state
     is an isolation gap. The AI BOM never shows as attested a server the broker would refuse to place.
   - **Assignments.** Each assignment is a granted edge from an agent, builder agent or stdio server to its
     profile.
   - **Placement property.** MCP servers carry `regulait:execution:placement`: `executor` for stdio, `external`
     for remote.
   - **Disclosure property.** MCP servers also carry `regulait:identity:discloseAgentWorkloadIds`, next to
     `regulait:identity:propagation`. It is ADR-0188 S8's `mcp_servers.disclose_agent_workload_ids` (migration
     0196), a required record field: a record without it is refused.
   - **SPDX.** Profiles map to SPDX `software_File` (configuration). Executors are services, so they appear in
     CycloneDX only, as MCP servers and connectors already do. The SPDX document comment is unchanged, so the
     B4.9 worked example stays byte-identical.
7. **Isolation evidence makes a composition incomplete.** This rule is not relaxable. A stdio MCP server is a gap,
   and so sits in an `incomplete` composition, never `complete`, unless all of these hold:
   - its assigned profile is current;
   - the profile is at L2 or above;
   - an active executor holds a fresh passing self-test for that profile at that class or stricter.

   The gap reasons are `execution_profile_not_assigned`, `execution_profile_retired`,
   `isolation_hardened_container`, `isolation_customer_declared` and `isolation_not_attested`. A
   customer-declared plane is never verified evidence.
8. **UI.**
   - **Decision BOM panel.** It shows a v2 BOM's execution facts from the signed body only: where the call ran, the
     required class and the floor that set it, the applied class, the profile, the executor and the attestation
     references.
   - **Wording.** The panel says "software-attested". L0 and L1 are never called a sandbox (decision 11).
   - **Reading the section.** The browser reader refuses an execution section it cannot read in full.
   - **Drift view.** It names executors and execution profiles.
   - **Routes.** No route was added, so the UI census is unchanged.
9. **Tests.**
   - **Shared:** `i8-execution.test.ts` covers the contract, capture, both Decision BOM versions verified as
     stored BOMs and as bundles, and the AI BOM.
   - **Gateway:** `zz-adr0190-i8-evidence.test.ts`, on a scratch database, covers:
     - migration 0197;
     - a placement written in the decision's transaction being captured;
     - the negative control, a placement written after the decision's transaction, not being captured;
     - the AI BOM loader.
   - **Web:** `bomExecution.test.tsx`.
   - **Existing suites.** The B2 suite's invariant now checks that every capture is v2 with the right `execution`.

**Open for the owner or a later slice.** Should the facts also record the image digest and the runtime flags
directly, rather than through the report hash? Doing so needs new `execution_placements` columns, which I4 owns.

## As built: slice I5 engines under profiles (2026-10-16)

I5 moves the ADR-0187 engine workers (the garak and promptfoo workers, the modelscan scanner) under decision 3's
`engine_worker` kind. A worker now runs **only** as an engine TASK in a sandbox an executor starts under the run's
placement. There is no long-lived worker container and no other place a worker can run. Migration **0199**
(`0199_engine_task_placement.sql`, hand-written; journal idx 199) adds `engine_runs.task_placement_id`. These points
settle what the decisions above leave open:

1. **The task start is the decision.** The placement is decided when the runner holding a live lease asks to start
   the run's task (`POST /v1/engine-runner/runs/:runId/task/input`), not at the lease. In ONE transaction the
   gateway:
   - re-checks the run (leased to this runner, live on the database clock, no task yet);
   - for an agent run, re-checks the run-as person's entitlement to the target and judge agents;
   - resolves decision 7 through I2's `resolveRequirement` (workload kind `engine_worker`, no agent, the run's
     project, no parent grant), then I4's linked offer (`offerLinkedPlacement`) or a refused row
     (`refusedLinkedPlacement`), keyed to the decision's audit id;
   - writes the decision: for an agent run, an `agent` row with `detail.phase` = `engine-run-entitlement`
     (receipt-eligible, so its facts capture the placement); for an artifact scan, an `engine_run` row (not
     receipt-eligible). Allowed: rule `engine-run-task-started`. Refused: rule `execution-profile`, effect `deny`;
   - names the placement on the run (`task_placement_id`, set once by a trigger, unique).
   A refusal ends the run `not_run` with `isolation_unavailable` in the same transaction and answers
   `409 execution_profile_unavailable` with the decision 7 code. A `policy_unresolved` refusal still writes a
   refused placement row (I4 review M2). Placing at the task start rather than the lease keeps the lease's
   contract (ADR-0187 decisions 67 to 98) unchanged; the lease's own refusals write no placement.
2. **OWNER DECISION C (recorded in its own docs PR).** `resolveRequirement` already treats `agent: null` on
   `engine_worker` as a known subject: an engine task is placed at the `engine_worker` floor (L2, OWNER DECISION 4),
   MAX the sensitivity floor, the compliance tags and the parent grant, never the unknown-agent rule. Pinned by
   `zz-adr0190-i5-engines.test.ts` (an `internal` project requires L2; the negative control, `code_exec` with no
   agent, requires L3).
3. **The task image** is the manifest's new `taskImage` (the Docker content digest the executor runs by,
   `docker image inspect --format '{{.Id}}'`) with its `taskEntry` (`/usr/local/bin/node /app/dist/task-main.js`).
   Every shipped `taskImage` is null until the engine images are built: such an engine places nothing
   (`policy_unresolved`), so the secure default holds by construction, as `imageDigest` already did.
4. **I8.** `buildExecutionFacts` records an engine run entitlement decision's placement like any other. An ALLOWED
   one with no `engine_worker` placement in its transaction fails the capture, and the decision with it: the I5
   contract is broken, and nothing is recorded as if it ran. A refusal written before any task start (run
   creation) placed nothing and stays `not_recorded, no_placement`.
5. **The two channels the runsc backend gains** (I4 open question 4):
   - **Input volume.** After accepting the offer and BEFORE starting the sandbox, the executor fetches the task's
     manifest and each file (`GET /v1/executor-channel/offers/:offerId/input[/:n]`, only while the offer is
     `accepted`). It writes them under its input volume (`REGULAIT_EXECUTOR_INPUT_DIR`, the Docker volume
     `REGULAIT_EXECUTOR_INPUT_VOLUME`) and checks each file's size and sha256 as it writes (`task-input.ts`). A
     mismatch removes everything and starts nothing. Files are 0444 and directories 0555. The sub-directory is
     mounted READ-ONLY at the profile's one `jobs` input (`--mount type=volume,…,readonly,volume-subpath=`, Docker
     Engine 26 or later) and removed with the sandbox. The run's artifact is streamed to the executor by the gateway
     from its artifact store (audited `engine-run-artifact-streamed`, phase `task_input`), never through the runner.
     The per-placement report gains `inputSha256`, computed from the bytes WRITTEN (`engineTaskInputDigest`). A
     profile with inputs fails `placement_fields_missing` without it. The gateway compares it with the input it
     holds: a difference fails `input_digest_mismatch`, so the sandbox is killed before any input is released and
     the executor is quarantined.
   - **Task-scoped secret** (decision 5). The run's key leaves the runner only as the task secret. The gateway
     holds it in the task's session, in memory, and sends it only in the MACed `start` line: the MAC covers it, and
     a `start` with no secret is MACed exactly as in I4. The gateway forgets it once the sandbox has spoken (its
     first stdout POST) or the session ends. The executor writes it once, on the release line, to the hash-pinned
     init's stdin (the pin moves with this change). The init hands it to the workload on fd 3, a pipe. It is never
     in the sandbox's environment, argv or labels (nothing `docker inspect` shows), never logged and never on a
     disk the executor owns. A profile with `secrets: none` refuses one. The run's key is revoked when the run
     ends (ADR-0187).
   - The class is still decided only from outside (review H2). The session caps are I4's (the live-session cap,
     the output and wall-clock limits). `injected_at_egress`, a scoped volume and an allow-list network are still
     refused.
6. **The gateway channel** (decision 4, `gateway_only`). The sandbox has no network (runsc `--network=none`). A
   worker that calls models (garak, promptfoo) reaches the gateway through a loopback proxy inside the sandbox
   (`runSandboxTask`): each request becomes an `http` stdout frame. The RUNNER, the trusted side on the engines
   network, sends it to the gateway with exactly the headers the sandbox gave (the run's key, never the runner's
   credentials). It forwards only under the gateway's base path and never to the runner, executor or OAuth
   routes; anything else is answered `not_gateway` (403 inside). Each request and answer body is at most 512 KiB.
   Streaming answers are not carried.
7. **The runner side.** Each runner keeps its ADR-0187 exchange (a job directory written whole, results read once
   `done.json` exists). The new `ExecutorTaskBridge` (`@regulait/engine-runner`) plays the worker's half over the
   gateway:
   - it uploads a published job (inline files, the artifact only placed, `apiKey` moved out of `job.json` into
     the task secret);
   - it long-polls the task's frames (`GET`/`POST /v1/engine-runner/runs/:runId/task/frames`), writes each result
     file in verified chunks, renamed into place so `done.json` appears whole and last, and carries the gateway
     channel;
   - it closes the task on a cancel.
   The task in the sandbox (`task-main.ts` per engine) runs the engine's existing one-job code (the worker tick,
   moved to `worker.ts`) on the read-only input. The run's key goes back into a copy of the job only on the
   sandbox's tmpfs, which is removed when the engine is done.
8. **No fallback, proven statically** (`adr0190-i5-engine-runner-no-spawn.test.ts`). The process-group runner and
   the in-sandbox helper move to `@regulait/engine-runner/worker`. The guard walks every runner entry point's import
   closure (static, side-effect and dynamic imports, re-exports and `require`, through relative modules and into the
   engine-runner package). It shows that no runner can reach a process spawn or the worker side, and that the task
   entries do (the guard fires). The only engine source that names `child_process` is the process-group runner.
   The long-lived `worker-main.ts`/`scanner-main.ts` entries and their compose services are gone. Each runner owns
   both exchange volumes, and its result volume is no longer read-only.
9. **Runtime probes in the engines' self-tests** (decision 10). Each worker self-test (garak, promptfoo, the
   scanner) gains `runtime`: the kernel release, whether `/proc/version` names gVisor, uid, `CapEff`,
   `NoNewPrivs` and `Seccomp` as seen from inside. It is recorded, never decisive (review H2). The task writes it
   at the start of every task, and the bridge stores it where the runner's self-test reads it. A sandbox that
   reaches the network or sees a runner credential runs nothing (fail closed).
10. **Where a task lives.** Like an I4 stdio session, a task lives in the gateway process that decided it. A request
    for a task this process does not hold is refused `engine_task_unknown`, and a report for one is refused (not
    quarantined: it is our own gap). Sticky routing on the run and offer ids is the same follow-up as I4's. The
    gateway holds at most 32 MiB of unacknowledged task output; past that the task is stopped
    (`output_overflow`). A watchdog stops a task whose run is no longer leased.
11. **Tests.**
    - **Shared:** `i5-engine-task.test.ts`.
    - **Executor:** `engine-task.test.ts`. The real init runs on the host in place of `docker run`; its fd 3
      workload proves the secret reaches only fd 3. It also covers the input refusals and `handleOffer`'s order.
    - **Engine runner:** `task-bridge.test.ts`, the bridge and the sandbox task end to end over a relay, including
      the gateway channel's path rule.
    - **Gateway, on a real database:** `zz-adr0190-i5-engines.test.ts`, driven by the real executor package with
      its fake backend. It covers the refusals with their rows, an end-to-end scan, input digest mismatch, and
      the I8 facts of an agent run's entitlement decision.
    - The B5 and I4 suites are unchanged except `zz-b5-compose.test.ts` (the worker containers are gone) and the
      decision-writer list.

**Not verified (M-041).**
- **Real gVisor.** Nothing here has run under gVisor: no session that built I5 had a Docker daemon. The PR #385
  gVisor CI job found that `runsc` release-20261005.0 maps every OCI seccomp `ERRNO` rule to `EPERM` and ignores
  `errnoRet`. Docker's default profile answers `clone3` with `ENOSYS`, so under that release glibc 2.34 or later gets
  `EPERM`, does not fall back, `pthread_create` fails and Node aborts. Every engine task image is glibc-based (the
  Node and Python bases in `engines/*/Dockerfile`), so **I5 under real gVisor depends on the same re-pin of
  `RUNSC_RELEASES`** to a release with gVisor commit 7be4160. Until then nothing is worked around: no unconfined
  seccomp and no custom profile.
- **Docker's `volume-subpath`** (Engine 26 or later) and the executor's input volume in compose are not set up.
  `REGULAIT_EXECUTOR_INPUT_DIR`/`REGULAIT_EXECUTOR_INPUT_VOLUME` and a volume on the `sandbox-executor` service are
  pending execution on a test host. Until then an executor refuses every engine task (no input volume), fail
  closed. The compose service is left to the executor TLS slice that owns it.
- **No engine image is built.** `imageDigest` and `taskImage` are null in the shipped manifest, so the image builds,
  the in-image task entries and the gateway channel with the real garak and promptfoo are unexercised.

**Open questions I5 leaves (for the owner or the master).**
1. **How an engine is first enabled.** The garak, promptfoo and scanner isolation switches are still proven by the
   worker's own self-test, which now exists only once a task has run. Engine enablement needs a passing self-test
   first, so a newly built engine cannot be enabled. *Recommended:* the gateway satisfies those switches from a
   fresh executor attestation for the engine's profile at or above the `engine_worker` floor. That attestation is
   the same decision 6 probe set, taken from outside and per placement, which is stronger. The worker switches
   would then leave the runner's report. This does not bite until an engine image is built.
2. **The runner's artifact copy.** The modelscan runner still downloads the artifact to stage its job (ADR-0187)
   although the sandbox receives it from the gateway. Should the stage skip the download? It is harmless but
   wasteful for large artifacts.
3. **Streaming model answers** through the gateway channel are not supported. If an engine needs them, the channel
   needs chunked answer frames.
