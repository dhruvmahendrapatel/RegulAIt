# ADR-0050: Data-lineage / provenance graph — which source touched which run touched which output

- **Status**: Accepted
- **Date**: 2026-08-01 (proposed) / 2026-08-02 (accepted + implemented, migration 0062)

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

---

## Implementation amendment — 2026-08-02 (migration 0062)

Accepted and built. What follows is the honest record of what the graph claims, what it refuses to
claim, and which capture points are actually wired.

### THE SCOPE SENTENCE — read this before anything else

**Lineage here is SUPPLIED-INPUTS PROVENANCE, not intra-model attribution.**

It answers: *"which inputs did the gateway SUPPLY to this dispatch, and what did that dispatch
produce?"* — chained across runs through pillar 4's already-versioned context items.

It does **not** answer, and must never be read as answering: *"which of those inputs actually
INFLUENCED the output, and how much?"* That second question is not observable from outside a model.
A dispatch receives a system prompt, a message list and a set of tool results and returns text;
nothing at the gateway boundary can say which sentence of which supplied document moved which clause
of the answer. Claiming otherwise is the single most tempting overstatement available to a lineage
feature, and an auditor who believed it would draw false conclusions from it.

That sentence is not confined to this ADR. `LINEAGE_COMPLETENESS_NOTE` is returned on **every**
traversal, every per-run answer, every node listing and the overview, and it is asserted in the
tests — a caveat that lives only in a document is a caveat nobody reads.

Three further bounds ride the same note:
1. **Gateway visibility.** Only what flowed through a governed call is captured. Something pasted
   into a prompt from an ungoverned source, or absorbed in training, is invisible — the exact
   analogue of ADR-0024's "we meter what we intercept".
2. **Node granularity.** A node is a call or an item VERSION, never a column or a sentence.
   Field-level lineage is not claimed.
3. **Metadata by default.** A node records THAT source X flowed into run Y, not the content of X
   (GOVERNANCE §8.4). `content_recorded` on each node says which a reader is looking at, and a DB
   CHECK ties the flag and the column together in both directions.

### What shipped

**Pure half — `packages/shared/src/lineage.ts` (+ 16 unit tests):** the vocabularies, the derived
natural key, and the traversal — breadth-first, bounded in depth AND breadth, cycle-safe, and
visibility-filtered.

**Gateway half — `apps/gateway/src/lineage.ts` (+ 16 integration tests):** the capture helpers, the
entitlement-scoped queries, `GET /v1/lineage` (forward/backward/both), `GET /v1/lineage/runs/:runId`
(the headline one-hop answer), `GET /v1/lineage/nodes`, and the admin-only `GET /v1/lineage/overview`.

**Migration 0062:** `lineage_nodes` + `lineage_edges`.

**Admin SPA:** `/admin/lineage`, next to the audit log — the audit log answers "who did what", this
answers "what flowed into what".

### Two structural decisions worth naming

1. **`natural_key`, UNIQUE per project, DERIVED not random.** Two captures describing the same real
   thing must land on one node, or the graph silently forks and every traversal under-reports while
   looking healthy. The derivation lives in `@regulait/shared` so writer and tests cannot disagree,
   and it is passed EXPLICITLY at each call site rather than inferred from the columns — a context
   item is identified by `(key, revision)` so an API caller can name it without a uuid lookup, while
   a run node is identified by `(runId, graphNodeId)`, and one inference rule would silently pick
   the wrong one for half the subtypes.
2. **Every edge points in the DIRECTION OF DATA FLOW.** `derived_from` is therefore STORED
   predecessor → successor (`v1 → v2`) despite how its name reads. An edge stored in the direction
   its name reads would invert a third of the graph and make a backward walk stop silently at every
   version boundary — a bug that produces plausible, incomplete answers.

### It builds on pillar 4 rather than beside it

A `context_item` node IS the §9.2 provenance tag promoted to a graph node: same key, same revision,
same versioning, no copied content. `project_context_items` stays the source of truth and this is a
**derived read-model** over it plus `usage_events`/`audit_log` — if it were lost it could be rebuilt.
Capture is therefore best-effort at every call site and swallows its own failure: a lineage write
must never turn a governed dispatch that has already been metered and audited into an error.

### The one behaviour change outside lineage, and why it is not decorative

`dispatchNodeSchema` gains an optional `contextKeys: string[]`. Each key resolves to the **current
accepted revision of that key in the run's OWN project** (never cross-project — that would be a
pillar-4 entitlement hole wearing a convenience feature's clothes), and that ONE resolved list drives
**both** the injection into the worker's system prompt **and** the `flowed_into` edges. Deriving both
from one list is what makes it structurally impossible for lineage to record an input the worker
never received. The injected block's first line is the supplied-item MANIFEST (`spec v1, findings
v1`), so the claim is visible in the transcript too — and the integration test asserts that manifest
appears in the REAL dispatch output before it asserts anything about the graph. Omitting
`contextKeys` is byte-identical to the pre-lineage dispatch, and that is asserted.

### What is GENUINELY VERIFIED vs. what is STRUCTURAL ONLY

**Genuinely verified — every node and edge below is created as a side effect of a real governed
call; nothing in the integration test inserts a lineage row:**

- **THE CROSS-RUN CHAIN IS REAL AND TRAVERSABLE.** The test builds
  `spec v1 → run A → findings v1 → run B → output` through actual context writes and actual node
  dispatches, then asserts a BACKWARD traversal from run B's output reaches run A and the original
  `spec v1` — by walking, not by re-reading what the test wrote. The FORWARD traversal from `spec v1`
  is asserted to reach run B through the version chain.
- **THE PER-RUN ANSWER IS THE VERSION ACTUALLY SUPPLIED.** `GET /v1/lineage/runs/:id` for run B
  returns `findings` **v1** — not the v2 that exists by the time the query runs.
- **CAPTURE CANNOT DRIFT FROM INJECTION** (see above).
- **A CALLER WITHOUT ACCESS DOES NOT SEE A NODE — NOT EVEN ITS EXISTENCE.** An outsider's node list
  is empty; their per-run query 404s; and the 404 for an INVISIBLE node is asserted **byte-identical**
  to the 404 for a nonexistent one (`expect(real.body).toBe(fictional.body)`), with the classified
  node asserted to genuinely exist in the DB. Every outsider-facing payload is asserted not to
  contain the hidden node's **id**, its key, or its content. In the unit tests an invisible endpoint
  is asserted to produce no edge at all, the whole result is `JSON.stringify`d and asserted not to
  contain the id, and the walk is asserted **not to continue through** an invisible node to visible
  ancestors beyond it.
- **CYCLES AND DEEP CHAINS TERMINATE.** A cycle is built THROUGH THE API (run C consumes `findings`
  v2 and writes v3) and the traversal is asserted to terminate visiting each node once. Unit tests
  cover a direct cycle, a self-loop, a depth cap and a breadth cap — each asserting `truncated` so a
  partial answer is never mistaken for a complete one.
- **IDEMPOTENCE.** Re-dispatching the same node is asserted not to multiply edges.
- **ADMIN GATING.** The org-wide census is admin-only; the three read routes are non-admin and
  narrow inside the handler. Audited refusals carry the stable ruleId `lineage-node-not-visible`.

**Structural only — the shape exists and is honest, but nothing exercises it end to end:**

- **`content_recorded` / `content`.** The opt-in content-level path is modelled (column, DB CHECK,
  API field, UI badge) but there is **no cascade-driven switch that turns it on**: every capture
  today records metadata only, and `contentLevelLineageEnabled` is a hard `false` in the overview.
  Wiring it to the ADR-0027 compliance cascade is a follow-up.
- **`connector_result`, `document`, `agent_dispatch`, `pull_request`, `pm_work_item` subtypes** are
  in the vocabulary and the DDL but **nothing writes them yet**.
- **Rebuild-from-ledgers** is a property of the design (nothing is stored that is not derivable);
  there is **no rebuild command**.

### Deviations from the proposal above

1. **Capture is wired at TWO interception points, not everywhere §2 implies.** Live today: the
   shared-context write path (item versions, the `derived_from` version chain, and the
   `run --produced--> item` edge when a write declares its producing run) and the orchestration
   node-dispatch path (the run node, `flowed_into` from supplied context items and nested-run
   workflow artifacts, `flowed_into` from governed MCP tool results returned into the worker loop,
   and `run --produced--> output`). **NOT wired:** direct `/v1/messages` dispatches, connector
   invocations outside a run, PR opens and PM work-item updates. Those produce **no lineage today**
   rather than a partial record that looks complete, and the overview says so in those words.
2. **§3's UI is a NEW page, not an extension of the ADR-0026 context-graph view.** The context graph
   renders one project's context keys and their revisions; lineage renders a heterogeneous
   source/run/output graph spanning runs. Bending one component to do both would have made the
   context view worse to avoid adding a route. The deviation is here rather than glossed.
3. **Rendering is a TABLE of nodes and edges, not a drawn graph.** No graph-layout library is pulled
   into the SPA. Depth, kind, subtype, version and relationship are all present and sortable; the
   picture is a follow-up.
4. **`GET /v1/lineage` returns the traversal, not a paginated cursor.** Depth (max 12) and breadth
   (max 500 nodes) are capped instead, with `truncated` reported. ADR-0050's fan-out consequence is
   handled by refusing to return an unbounded answer rather than by paging one.
5. **The graph is materialised at capture time, not queried from the ledgers.** §2 allows either;
   this is the "materialize later" option taken now because the write points already existed.
6. **Retention is not implemented.** §4 says lineage retention rides the cascade's audit tiers;
   nothing prunes `lineage_nodes`/`lineage_edges` today. They cascade on project delete and that is
   all.

### Verification performed

See the combined verification block in this session's ADR-0049/0050 pair — both slices were built and
verified in one session and share one test run.

### Follow-ups this slice leaves open

- Capture on direct `/v1/messages` dispatches, standalone connector invocations, PR opens and PM
  work-item updates.
- Cascade-gated content-level lineage (the column and the CHECK are ready; the switch is not).
- Retention/pruning under the §8.3 audit tiers.
- A rebuild-from-ledgers command for the derived read-model.
- A drawn graph in the SPA, and reconciling it with the ADR-0026 context-graph view.
- ADR-0058's framework-specific queries (DPIA data-flow map, GDPR data-subject traversal) on top of
  this graph — the named downstream consumer.
