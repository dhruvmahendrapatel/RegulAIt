# ADR-0095 — Mock-routing honesty + the versioned agent model edit (batch B1.5)

- **Status**: Accepted
- **Date**: 2026-08-22
- **Driven by**: the two findings of the owner's live-instrument run,
  [LIVE_VERIFICATION_2026-08.md](../product/LIVE_VERIFICATION_2026-08.md) — an
  owner-EXPERIENCED routing defect (V7's note read as "the optimizer doing its job"; it was
  not) and the retired seeded Google model id.
- **Amends in spirit**: the pillar-6 routing behaviour ADR-0021 dials configure and the
  candidate filter the invoke path applies; extends ADR-0073's batch-B1 amendment (the
  `agent_config` versioning) with its ordinary edit surface for agents.

## F1 — a mock agent is not a routing candidate while a credentialed live agent can serve

### The defect, as experienced

With a real `GOOGLE_API_KEY` configured and `costSensitivity: "cost-sensitive"`, requesting
the live gemini agent got the request RIGHT-SIZED onto the seeded `fast-mock` — which
"answered" with canned demo prose — and the usage row recorded
`measured_cost_saved_usd ≈ $0.0004` against the live baseline's list price. The verification
record initially filed this under "the optimizer doing its job, mocks are cheaper at every
tier". It is not the optimizer's job: the user asked a real model a real question and
received a non-answer, plus a savings figure for money nobody saved on work nobody did.

### The rule

Mocks exist for the KEYLESS demo — the out-of-box roster must route and answer with no
credential configured anywhere. So the eligibility line is drawn at the ROSTER, where the
invoke path already withholds non-dispatchable candidates from the kernel:

- An agent whose provider is the mock kind is a ROUTING candidate **only while no
  credentialed live agent in the caller's entitled roster is strictly dispatchable**
  (model id + known provider + configured credential, the existing filter). "Live" means
  provider ≠ `mock`; `custom` and `regulait_llm` count as live — they serve real answers.
- The withheld mock is DISCLOSED, not vanished: it joins `skippedCandidates` with the new
  reason **`mock_shadowed_by_live`** (additive to the trace, same shape as
  `no_model_credential`).
- **Direct invocation of a mock is untouched.** The requested agent was already exempt from
  the roster filter, and stays exempt: an explicit choice is not routing.
- Decision-only invokes (`dispatch: false`) keep previewing over the whole entitled set,
  exactly as they already did for uncredentialed candidates — the preview has never claimed
  dispatchability.

### The savings rule

`measured_cost_saved_usd` is **never computed where the SERVING agent is a mock and the
baseline is not** — a canned answer priced as savings against a live model's list price is a
fabricated measurement. Mock-vs-mock stays measured (both sides are the same demo economy;
the shipped demo-suite behaviour is byte-identical). The per-technique `model_routing`
ESTIMATE row is unchanged — it records the routing decision under its explicit
`estimationBasis` and is labelled as an estimate, not a measurement.

With F1's eligibility rule in place the mock-serves/live-baseline pairing can only arise in
the keyless demo (live baseline present but uncredentialed); the measured column is null
there too, so no savings row anywhere pairs a mock serving agent with a live baseline.

### Verified (routing-mock-honesty.test.ts, 4 cases, non-vacuous per M-002)

- Credentialed-live roster + cost-sensitive: routing selects the cheapest LIVE agent, the
  mock appears in `skippedCandidates` as `mock_shadowed_by_live`, the live agent serves
  (asserted at a stubbed provider adapter), live-vs-live measured savings intact. Reverting
  the eligibility line reddens exactly this case; the keyless cases stay green.
- Direct mock invoke with live agents present: still 200, mock serves, mock-vs-mock measured
  column non-null (the in-file control; mcp-proxy's routed-dispatch case is the suite-level
  control).
- Keyless roster: mock still routes and serves — the demo preserved; `skippedCandidates`
  empty.
- The keyless usage row: `provider=mock`, live baseline, `cost_usd > 0`,
  `measured_cost_saved_usd IS NULL`, while the `model_routing` estimate row remains.
  Reverting the measured-savings guard reddens exactly this case.

### Deliberately NOT narrowed here

The §5 compaction summarizer roster and decompose's worker roster keep their existing
strictly-dispatchable filter without the mock-shadowing rule — same disease class, separate
call, recorded as a follow-up in PENDING.md rather than smuggled into this change.

## F2 — the seeded Google model id + the missing agent-model edit affordance

### (a) Seed refresh, with the re-seed semantics stated

The seed's google agent now pins `gemini-3.6-flash` (proven working in the live run) instead
of the retired `gemini-2.5-pro`. The seed's established semantics WIN and are now stated in
the seed itself: an existing agent row is matched by name and **never mutated on re-seed**,
so already-seeded databases keep their stale id until an admin edits it — which is (b)'s
job. No other seeded agent uses a Google id.

### (b) `PATCH /v1/agents/:agentId` — the ordinary edit surface, on the versioned path

The live run found NO API route that edits an agent's model (the fix was psql). Batch B1 had
just made `model`/`costPerMTokIn`/`costPerMTokOut` a VERSIONED dispatch-execution config
(`agent_config`, ADR-0073 amendment) whose ACTIVE version the dispatch core resolves — so a
raw column write would update every list surface and change NOTHING about what dispatches,
the exact silent divergence ADR-0074 removed. The new route therefore rides `applyRuleEdit`
(ADR-0074's one choke point), inheriting the four-outcome semantics verbatim: versioned
agent → **mint + activate in one transaction**; unversioned agent → plain row write
(invariant 4, byte-identical to pre-versioning); no-op → nothing minted; versions-but-none-
active → 409 naming the remedy. Scope is the ADR-0073 line at the route edge: exactly the
three `agent_config` fields; everything else is refused 422 `field_not_editable` with the
right control named (provider/customProviderId = a new agent; tier = entitlement input;
enabled/lifecycle/systemPrompt = their own audited routes). Admin-only via the global gate;
audited `agent-config-edited` through the choke point's own audit row. Registered
`internal` in the OpenAPI registry.

SPA: a self-contained "Model & pricing" card on the existing Agents admin page (select an
agent → prefilled model/prices → save), stating the versioning behaviour in its help text.

### Verified (agent-model-edit.test.ts, 5 cases, non-vacuous per M-002)

Unversioned edit dispatches the new model with no version minted; versioned edit mints v3,
supersedes v2, and THE DISPATCH SERVES THE MINTED MODEL (asserted on the served dispatch,
never a column); no-op mints nothing; all six non-config columns refused by name; 404/403.
Replacing the route's `applyRuleEdit` with a raw `db.update(agents)` reddens 4 of 5 —
including the versioned case, where dispatch demonstrably kept serving the OLD model while
the row showed the new one.

## Honest limits

- The compaction-summarizer and decompose-worker rosters can still pick a mock when live
  agents exist (disclosed above; PENDING follow-up).
- `estimated_cost_saved_usd` on `model_routing` rows keeps recording estimates for
  mock-routed keyless dispatches against the (unservable) live baseline's list price — it is
  labelled an estimate with an explicit basis; tightening it was not part of this batch.
- Decision-only previews still list mocks as selectable outcomes; they execute nothing.
- The seed refresh helps fresh installs only, by design; existing rows need one PATCH.
- Nothing here is re-proven against a live provider; the live run's evidence stands, and the
  new tests prove the mechanism offline (a stubbed adapter for the live-serve case).

---

## Amendment — 2026-08-22: the other two rosters (batch B6a, no migration)

The section above ("Deliberately NOT narrowed here") named this ADR's own residual: routing
selection was narrowed, but the **§5 compaction-summarizer roster** and **decompose's worker
roster** were not, so a mock could still be picked in either while a credentialed live agent
could serve. This amendment closes both. The owner experienced the ROUTING version of the
defect directly (a mock answered a chat with canned prose while a live Gemini credential
existed); the two remaining paths produce the same failure with quieter symptoms:

- **Compaction.** A mock summary is canned prose written over a conversation's *retained
  context*. Nothing errors; every later turn in that thread silently carries a summary that
  never read the turns it replaced.
- **Decomposition.** A mock plan is a nonsense task graph — and worse, the implicit lead was
  *by construction* "the cheapest granted mock", so the agent that WRITES the plan was the
  mock whenever the caller set no default agent.

### The rule is now one function, reused — not restated

`mockShadowedByLive(roster, dispatchable)` (`apps/gateway/src/agents-connectors.ts`) is the
single predicate. It returns the ids of mock-provider agents that are dispatchable **while a
non-mock member of the same roster is dispatchable**, and an empty set otherwise. All three
call sites now consume it:

| Call site | Roster | `dispatchable` |
|---|---|---|
| `POST /v1/agents/:id/invoke` routing | the caller's `evaluateAgent`-entitled set | model id + known provider kind + stored credential |
| the compaction-summarizer roster (same handler) | the same entitled set | the same strict test |
| `POST /v1/runs/decompose` worker roster | the caller's worker-mode-entitled, already-strictly-dispatchable set | `() => true` (the roster is pre-filtered) |

Three copies of this rule would be three places for it to drift, and the drift would be
silent. That the reuse is real is *measured*, not asserted: neutralising the one predicate
reddens ADR-0095's own routing test alongside the three new ones (probe 3 below).

### What is preserved, unchanged

1. **The keyless demo is byte-identical.** Nothing is shadowed unless a non-mock agent in the
   *same* roster can genuinely serve, so with no credential anywhere the summarizer and the
   worker roster still select mocks and nothing is reported as skipped.
2. **An explicit choice is not routing.** Routing already exempted the requested agent. The
   compaction analogue is ADR-0021's `summarizerSelection: 'fixed_agent'`: an admin who names
   a mock summarizer on purpose still gets it — shadowing it would have turned a deliberate
   configuration into `fixed_summarizer_unavailable`. The decompose analogue is
   `body.leadAgentId`, which is resolved from the full registry and was never affected; the
   worker roster stays narrowed underneath an explicit mock lead, because the exemption is for
   the agent the caller *named*, not for the plan's workers.
3. **Savings are never priced mock-vs-live.** Untouched — the measured-savings guard sits on
   the usage row and this change never reaches it.
4. **A roster can never be emptied by shadowing.** Shadowing fires only when a dispatchable
   non-mock member exists, and that member is exactly what survives. So no new
   `no_compaction_agent` / `no_worker_agents` path is reachable from this change.

### The implicit decompose lead, stated precisely

`cheapestMock` was the third fallback for both the lead and the substitution owner. It becomes
`implicitLead`: the cheapest agent of the **surviving** roster under the identical sort when
mocks are shadowed, and the cheapest granted **mock** when they are not. This is surgical
rather than a policy change, and two facts make it so: the narrowed roster is all-mock or
all-live and never both (a dispatchable live member is precisely what triggers shadowing), so
with nothing shadowed the expression *is* the old `cheapestMock`; and a caller who names a
lead explicitly bypasses it entirely.

### Disclosure

The same reason string, `mock_shadowed_by_live`, in both new places:

- compaction — `skippedCandidates` on the `context-compaction` audit row's detail, beside the
  `servedAgentId` that did the work;
- decompose — `skippedCandidates` on the `run-decomposed` audit row's detail **and** on the
  `POST /v1/runs/decompose` response body (additive; the route's OpenAPI registration is
  unchanged).

### Verified (`mock-shadowing-rosters.test.ts`, 6 cases; non-vacuous per M-002, each probe reverted by exact Edit reversal per M-016)

Every positive case asserts the **served dispatch**, never merely a reported roster: the
compaction audit row's `servedAgentId` (cross-checked against the `usage_events` row's
provider), the decompose response's `dispatch.servedAgentId`, the planning prompt's own
roster listing, and each proposal node's `ownerAgentId`.

| Probe (the fix removed) | Reddens |
|---|---|
| 1. compaction narrowing dropped (`compactionCandidates` back to the plain strict filter) | **1** — `expected 'b7e5a17e…' to be '32f72a6d…'` on `detail.servedAgentId`: the summarization dispatch that really ran was served by the mock |
| 2. decompose narrowing dropped (`roster = entitledDispatchable`) | **2** — the implicit lead reverts to the mock, and under an explicit mock lead the worker nodes revert to being owned by it |
| 3. the shared predicate neutralised (`liveCanServe` forced false) | **4** — the three above **plus** ADR-0095's own `routing-mock-honesty.test.ts` roster/dispatch case, which is what proves the three call sites share one predicate rather than three copies |

The two keyless cases stay **green under all three probes** — they are the controls, and a
probe that reddened them would mean the fix had changed the out-of-box demo.

### Honest limits (this amendment)

- The first honest limit above ("the compaction-summarizer and decompose-worker rosters can
  still pick a mock") is **superseded**; the other four stand unchanged.
- Offline only. The live-serve case is a stubbed adapter, exactly as the F1 tests are; nothing
  here was re-proven against a live provider.
- `regulait_llm` (ADR-0065) counts as **live**, not as a mock — it is credential-free but
  serves a real artifact. Unchanged from F1's semantics, restated because the predicate is now
  shared by three call sites and the question will recur.
- A decision-only invoke (`dispatch: false`) still previews the whole entitled set, mocks
  included; it executes nothing, compacts nothing and plans nothing.
