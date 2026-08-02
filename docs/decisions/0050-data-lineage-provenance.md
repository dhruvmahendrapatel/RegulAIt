# ADR-0050: Data-lineage / provenance graph — which source touched which run touched which output

- **Status**: Proposed
- **Date**: 2026-08-01

## Context

Two provenance-adjacent capabilities already exist, but they answer different, narrower questions
than the one enterprises actually ask under audit:

1. **Pillar-4 shared-context provenance** (GOVERNANCE §9.2) — every piece of shared context is
   tagged with *which team/user contributed it and when*, with **versioning and conflict
   resolution** so a resolved conflict traces back to what each side proposed. There is a
   **context-graph UI** for it (the SPA's `/v1/projects/:id/context*` surface, ADR-0026 phase-3).
   This is *per-context-item* provenance: "who added this note."
2. **One attributed usage ledger** (ADR-0019/0024) — every governed call is attributed to a
   project/team/user/agent. This is *per-call* attribution: "who ran this."

Neither answers the **connecting** question: *which source data flowed into which agent run, which
produced which output/artifact — per run, and transitively across runs.* An auditor doing
e-discovery, a privacy officer building a **DPIA** (data-protection impact assessment) data-flow
map, or a GDPR data-subject "what touched this person's data" request needs to traverse
`source → run → output → (consumed by) → run → output …`. Today that requires manually stitching
context-item provenance to ledger attribution to workflow artifacts by hand. The compliance packs
(ADR-0058) need this stitch as a **query**, not a reconstruction — their evidence collectors
cannot ship without it.

The forces: the connecting graph must be **derived from events the gateway already emits** (no
second instrumentation pass — the ADR-0024 discipline); it must respect the **control-plane data
boundary** (GOVERNANCE §8.4 — metadata by default, content only on explicit opt-in, and it stays
inside the customer's boundary in BYOC/air-gapped); and it must be **honest about completeness** —
lineage can only ever prove what flowed *through the gateway*, not what an agent "knew."

## Decision

Extend pillar-4's provenance into a queryable **lineage graph**: a directed graph over **source**,
**run**, and **output** nodes, with edges captured at the same gateway interception point that
already meters and audits, traversable **per-run and cross-run**, feeding e-discovery / DPIA and
the compliance packs (**cross-ref ADR-0058**), and rendered by extending the existing context-graph
UI rather than a new surface.

### 1. The graph

- **Nodes**:
  - *Source* — a connector read result, an MCP tool result, an uploaded document, or a
    **shared-context item version** (the §9.2 provenance tag *becomes* a lineage node, not a
    parallel record).
  - *Run* — an agent dispatch / orchestration-worker run (keyed to the `usage_events` /
    orchestration identity that already exists).
  - *Output* — an artifact a run produces: a written-back context item, a plan/requirements
    artifact, a PR, or a PM work-item update (pillar 8).
- **Edges**: `flowed_into` (source → run), `produced` (run → output), and — because an output can
  be a source for a later run — `derived_from` chains form transitively. A context item produced by
  run A and loaded as context by run B yields `A → item(v3) → B`, so lineage **chains across runs**
  through the context store's existing versioned nodes; lineage always points at the **specific
  version** consumed (provenance already versions; lineage rides that, never re-implements it).

### 2. Capture — derived, not re-instrumented

The gateway already sees every governed read and every governed write (ADR-0024). The lineage edge
is emitted **as a side effect of the same event emission** that writes the usage/audit row: a
governed connector/MCP *read* by a run emits `source → run`; a context write / PR open / PM update
by a run emits `run → output`. The lineage store is a **derived read-model** built from the
append-only usage/audit/context ledgers — so if it is ever corrupted it can be **rebuilt** from
those ledgers, which remain the source of truth. (v1 may query the ledgers directly and materialize
the graph later; the model is the same either way.)

### 3. Query + UI

- `GET /v1/lineage` supports **forward** traversal (given a source: every run and output it
  reached) and **backward** traversal (given an output/artifact: every run and source that produced
  it), bounded-depth, over the one graph.
- The **existing context-graph UI (ADR-0026) is extended** to render source/run/output nodes and
  the three edge kinds — not a new visualization to learn and maintain.

### 4. Governance posture — metadata by default

Lineage is **metadata** (which node, which run, which version, when), consistent with the
control-plane/agent-plane boundary (§8.4): by default it records *that source X flowed into run Y*,
not the *content* of X. **Content-level lineage is opt-in**, gated behind the same
compliance-classification cascade that gates content-level audit logging, and — like all pillar-4
state — the graph **stays inside the customer's boundary** in BYOC/air-gapped mode. Retention of
lineage records reuses the compliance-cascade audit-retention tiers (§8.3) and ADR-0027's per-mode
retention; it is **not** a new retention knob.

### 5. Compliance feed (ADR-0058)

The compliance packs' evidence collectors are the primary consumer: "every run that touched
HIPAA-classified data and everything it produced" for an audit trail; a **DPIA data-flow map** as a
forward traversal from a classified source; a **GDPR data-subject request** as a backward+forward
traversal keyed to a subject's data. 0050 produces the graph; 0058 authors the framework-specific
queries and evidence formats on top of it.

## Consequences

- E-discovery, DPIA data-flow mapping, and compliance-pack evidence become a **query** over one
  graph instead of a manual reconstruction across three subsystems — the capability ADR-0058
  depends on to ship its regulatory wedge.
- **Completeness is bounded by gateway visibility, and this is stated plainly**: lineage captures
  what flowed through a governed connector/MCP/context call. Data an agent ingests *outside* a
  governed call (pasted into a prompt from an ungoverned source, baked into training) is **not**
  captured. Lineage proves data *flow through the gateway*, never everything an agent "knew" — the
  honest analogue of ADR-0024's "we meter what we intercept."
- **Granularity is node-level, not field-level**: a node is a call/item, not a column or a
  sentence. Which field of a query result influenced which clause of an output is **not claimed** —
  that needs content-level tracing and is deferred.
- **Content-level lineage is opt-in** and cascade-gated; the default is metadata-only, preserving
  the §8.4 boundary and the BYOC "content never leaves" guarantee.
- The graph **grows with every run**; it is a derived read-model over the append-only ledgers, so
  it is rebuildable and its retention rides the existing cascade tiers rather than a bespoke policy.
- Builds on the §9.2 provenance store + versioned conflict resolution and ADR-0019/0024 attribution
  (its producers), and reuses the ADR-0026 context-graph UI (its renderer) — **no new
  instrumentation pass and no new visualization surface**. Its named downstream consumer is
  ADR-0058; a secondary consumer is ADR-0049's potential-exfil signal, which flags anomalous spend
  and can hand the *what actually flowed* question to this graph.
- **Query cost grows with traversal depth.** A backward traversal from a widely-reused source
  (a coding-standards context item consumed by hundreds of runs) can fan out large; the API caps
  depth and paginates, and a materialized graph (§2) is the mitigation if direct-ledger queries
  prove too slow at scale — the read-model can be built later without changing the semantics,
  because the ledgers stay the source of truth.
- **Sequencing**: this is a *product-depth* item (enterprise-readiness Bucket 1) that is only fully
  valuable once ADR-0058 authors the framework queries on top of it; the graph can and should ship
  first (it is independently useful for internal e-discovery and DPIA drafting), with the
  compliance-pack queries following.
