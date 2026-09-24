# ADR-0122 — MCP discovery: detection is half a capability, the registry diff is the other half

- **Status**: Accepted
- **Date**: 2026-09-24
- **Relates to**: [ADR-0055](0055-shadow-ai-discovery.md) (shadow-AI discovery from
  customer-supplied evidence — the posture this ADR inherits, and the frozen catalogue it could not
  extend), [ADR-0097](0097-mcp-admission-scanning-and-auth-discovery.md) (what a *registered* MCP
  server is put through, which is what an unregistered one is not)
- **Migration**: **none.** Discovery reads supplied text and diffs it against the existing
  `mcp_servers` registry. It stores no new state; `mode: "apply"` writes one audit row using the
  existing vocabulary.

## Context

ADR-0055 built shadow-AI discovery as evidence triage: an operator supplies a proxy export, a DNS
log or a dependency manifest, and the product classifies it against a frozen catalogue of provider
hostnames and SDK package names. The posture is deliberate and stated on every payload — **nothing
is scanned, resolved, crawled or connected to.**

That catalogue was **MCP-blind**, and structurally so. Every signature in it is "does this hostname
equal a known vendor's". An MCP server is not a vendor endpoint. The interesting ones are
self-hosted, on hostnames nobody can enumerate in advance, and there is no `api.openai.com`
equivalent to match against. So no catalogue entry could ever fire on one, and the finding
vocabulary had no kind to record one as.

This matters more than a missing signature, because of what ADR-0097 does to the servers we *do*
know about: admission scanning, auth discovery, tool-level entitlement, per-call audit. An MCP
server outside the registry gets none of it. "Which MCP servers are running that we do not govern"
is a question a buyer asks in the first meeting, and the product could not answer it at all.

## Decision

### 1. A separate module, not catalogue entries

`packages/shared/src/mcp-discovery.ts`, distinct from `shadow-discovery.ts`.

Two reasons, and the second one is the constraint:

- **The matching rule is different in kind.** MCP is identified by the *shape* of a call — the
  protocol's transport paths, its version header, its JSON-RPC method names — with the host read off
  the same line. That is not "does this hostname equal a known vendor's", and folding it in would
  have meant pretending a path is a hostname.
- **`SHADOW_AI_CATALOG_V1` is deep-frozen and the shared suite pins its entry count and a content
  hash.** ADR-0055 made that choice on purpose: detection does not change under people's feet, and
  changing it means shipping a v2. Adding entries to serve a new detection class would have
  defeated the guard rather than respected it.

### 2. Confidence is GRADED and never collapsed to a number

`/mcp` is the Streamable HTTP convention; `/sse` and `/messages` are the older HTTP+SSE transport's
two halves. `/sse` in particular belongs to a great many things that are not MCP.

So a bare transport path grades **medium** and says why (`indicators: ["transport-path:/sse"]`). A
path corroborated by the `MCP-Protocol-Version` header or a JSON-RPC method name — `initialize`,
`tools/list`, `tools/call` — grades **high**. The indicators travel with the finding; the operator
is never handed a score alone. Averaging the two into one number would have made a convention and a
protocol observation indistinguishable, which is exactly the judgement the operator needs to make.

Transport paths match as a **full trailing path segment**, so `/mcp` matches `/mcp` and `/api/mcp`
and not `/mcpartner`.

### 3. THE REGISTRY DIFF — the part that makes detection an answer

Finding an MCP endpoint in a log is half a capability. The half that matters is **"and it is not one
of mine"**.

`POST /v1/shadow-ai/mcp-discovery` loads `mcp_servers`, normalizes **both sides** through the same
host normalizer the evidence went through, and returns per host: `registered`, `registeredAs`, and a
`verdict` sentence. Normalizing only one side is how a registered server gets reported as shadow —
a raw `https://host:8443/mcp` compared against a parsed host never matches.

The verdict is prose as well as a boolean, because it is the sentence an operator reads out, and it
carries its own limits: *"UNREGISTERED — this host appears in your evidence and matches no MCP
server in this deployment's registry, so nothing about its tool calls is governed here."* That is a
statement about the registry and the evidence. It is not a claim to have searched an estate, and
`MCP_DISCOVERY_POSTURE` rides on every response saying so.

### 4. `preview` writes nothing; `apply` writes exactly one audited row

Preview is the default and is a pure read. `apply` emits one `mcp-discovery-applied` row naming the
unregistered hosts. The input is bounded by the same `EVIDENCE_MAX_BYTES` the evidence front door
uses — one size rule for supplied evidence, rather than a second one that drifts from it.

### 5. The tests are mostly negative, on purpose

A discovery feature is judged on what it does **not** report. The shared suite spends more
assertions on traffic that must stay silent — ordinary web traffic, `/mcpartner/signup`, `mcp` in a
query string, `mcp-guide.pdf` — than on the happy path, and pairs the silence with a positive
(`observed === 2`) so an empty result is discrimination rather than a parser that found nothing.

The gateway suite's load-bearing assertion is the **diff in one response**: from the same evidence,
a registered host comes back governed and named, and an unknown one comes back unregistered.
Asserting only the unregistered half would pass just as well against a route that called everything
unregistered (M-033).

## Consequences

**Easier.** "Which MCP servers are running that we do not govern" is now answerable from a proxy
export, and answerable in front of a customer. It is a natural wedge: the answer is a list of hosts,
and the product that produced the list is the one that governs them under ADR-0097.

**Harder / given up.** Detection keys on protocol surface, so it sees only what the evidence
contains. An MCP server that never appears in the supplied logs is invisible, and a *stdio* MCP
server — a local subprocess, which is a very common deployment — produces no network line at all and
is therefore out of reach of this input entirely. The `MCP_SDK_PACKAGES` list gives a partial answer
from dependency manifests, with the same caveat the shadow catalogue puts on every SDK signature: a
dependency is a *capability* to speak MCP, never proof that anything did.

**A known false-positive source, disclosed rather than tuned away.** A bare `/sse` on an ordinary
streaming endpoint will be reported at medium confidence. That is the intended trade: this feature's
job is to surface candidates for a human to judge, and suppressing the medium grade to make demos
cleaner would lose the self-hosted servers that have no other signature.

**Follow-up this creates.**

- A finding kind. Results are returned and audited but not written into the shadow-AI inventory as
  first-class findings, so an unregistered MCP host does not yet flow into the "pull into
  governance" workflow ADR-0055 built. That is the obvious next step and deliberately not smuggled
  in here.
- No UI. This is an API-only capability today.
- `mcpServers` is diffed by host, so two servers on one host are indistinguishable to the diff.
  Fine for "is this governed at all", wrong if the question ever becomes "which one".
