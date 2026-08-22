# RegulAIt — Owner Testing Checklist (2026-08-21)

One row per feature, ordered as a walkthrough. Sign-in: `admin` / `dana` / `avery`
(one-time passwords from `docker compose logs gateway | grep -A20 "demo data"`),
each sets a real password on first sign-in. Mark rows as you go; report the row
number + what you saw for anything off.

## A. The two-minute headline
| # | Feature | Where | Try this | Expect |
|---|---|---|---|---|
| 1 | First-run orientation | `admin` → Home | Read the "Start here" card; dismiss; reload | Three live numbers; stays dismissed |
| 2 | Compliance cascade (§8.3) | `dana` → Chat billed to *hipaa-project* | Paste an SSN (123-45-6789) | Denied BEFORE the model runs — PII badge, zero cost |
| 3 | Cascade-forced sign-off | `avery` → Inbox | Open the PHI export item | Parked at *compliance-signoff*, a stage no rule routed |

## B. The new governance suite (ADR-0080…0093)
| # | Feature | Where (admin) | Try this | Expect |
|---|---|---|---|---|
| 4 | Use-case intake | AI Governance → Use cases | Propose; fill questionnaire; drive the sign-off | Status moves only via the decision; no status control |
| 5 | EU-AI-Act screening | in the questionnaire | Social-scoring purpose | PROHIBITED banner + Art. 5 reason + disclaimer; human still decides |
| 6 | Risk register | AI Governance → Risks | Add from library; open detail | Evidence computed live; measured vs declared never blended |
| 7 | Vendor portal | AI Governance → Vendors | Propose; assess; record attestation | "vendor-attested — not verified"; never pack evidence |
| 8 | Shadow-AI discovery | AI Governance → Shadow-AI | Paste package.json with `openai` / DNS lines | Findings classified; governed-vs-shadow; gaps named |
| 9 | Agent inventory | Access Reviews → Inventory | Open an agent detail | Granted (may) vs Observed (did), never blended; ownership flag |
| 10 | Agent lifecycle | agent detail / Agents page | Set owner; retire; invoke retired agent | Dispatch 409s by name; deprecated only warns |
| 11 | Recommendations | Access Reviews → Recommendations | Review flags; open campaign from them | Rule + evidence per flag; campaign snapshot matches |
| 12 | Certification campaigns | Access Reviews → Campaigns | Keep one item, revoke another | Revoke really deletes the grant; own-grant review refused |
| 13 | SoD rules | Access Reviews → SoD rules | Rule on a held pair; try minting the pair; escalate | 409 naming rule+reason; violators surfaced never auto-revoked; arm's-length override mints with record |
| 14 | Posture one-pager | Overview → Posture | Read; print-preview | Board-shaped; "unmeasured, not resisted" on empties |
| 15 | Model-card autofill | AI Governance → Model risk | Open card; run an eval; reopen | Ledger block updates; staleness counts since certification |
| 16 | Packs + version diff | Compliance → Packs | View 7 packs incl. SOC 2; diff versions | Evidence is queries; cascadeTag change flagged HIGH |
| 17 | External scorers | Quality & Security → External scorers | Register scorer at 169.254.169.254 | Refused — SSRF/egress guard |

## C. Established core
| # | Feature | Where | Try this | Expect |
|---|---|---|---|---|
| 18 | Users/roles/grant bundles | Identity & Access | Create `dhruv`; role bundle; sign in | Bundle confers; default-deny without |
| 19 | Rules + config versions | Policies & Gates → Rules | Edit a rule; check versions | Edit mints a version or refuses — never silent |
| 20 | ABAC + Simulation | Policies & Gates | Run a simulation | Blast radius before activation |
| 21 | Guardrails | Policies & Gates → Guardrails | semantic_dlp → block; marked prompt | Blocked, detector named |
| 22 | Approvals + self-review bar | Approvals & Audit | Decide items; try own request | Self-review refused (decider-keyed) |
| 23 | Audit chain + WORM | Audit log | Chain-verify | tamperResistant: true, observed at runtime |
| 24 | Traces + lineage | Approvals & Audit | Open a dispatch trace | Real tree; DENY is a span with reason |
| 25 | Plan-only stage | Workflows | Build-mode invoke against a planning instance | 409 plan_only_stage; Finish-planning lifts |
| 26 | Template gallery | Workflows | Browse | Stages annotated with forcing profiles |
| 27 | Orchestration | Runs | Decompose; run the DAG | Workers inherit YOUR entitlements/budget |
| 28 | Cost dashboard | Cost & Optimization | Check after test dispatches | Per-project attribution; savings only on success |
| 29 | Evals + red team | Quality & Security | Run seeded suite; red-team run | Method-stamped scores; ASR with Wilson interval |
| 30 | RegulAIt-LLM | Quality & Security → Training | Train local demo model | Real loss curve; remote adapters refuse w/o creds |

## B2. Shipped since this list was written (2026-08-22 wave)
| # | Feature | Where | Try this | Expect |
|---|---|---|---|---|
| 31 | Suite launcher + scoped nav | Home, then any suite | Click a tile; note the sidebar; use the switcher; press `/` and search a page from ANOTHER suite | One suite at a time; `/` still finds everything (anti-stranding); every URL unchanged |
| 32 | Governance copilot (LIVE) | Overview → Governance copilot | Ask "What governance denials happened recently and why?" with a live narrator | `generation: model`, citations to real audit ids, decision-support notice + scope caveat |
| 32b | Copilot narrator entitlement | same, as a user with no agent grant | Ask with a narrator agent you lack | 403 `narrator_not_entitled` — you cannot narrate with an agent you may not invoke |
| 33 | Copilot: unresolved subject | same | Ask about an object that does not exist ("the Zorblatt Widget approvals") | **422 `copilot_entity_unresolved`** — refuses outright, names the six resolvable kinds, will not answer broadly and label it with your words (ADR-0096) |
| 33b | Copilot: real entity narrows | same | `How much have we spent this month on "demo-project"?` then drop the project name | Filtered run returns FEWER rows than unfiltered (15 vs 20 when retested), `subjectFiltered: true`, the entity's id/kind/name are named |
| 33c | Copilot: empty retrieval | same, as a user with no projects | Ask an ordinary question with no entity | `groundedRefusal: true`, rows 0 — a **different** signal from 33's 422, so you can tell "can't find your subject" from "nothing matched" |
| 33d | Copilot: scope honesty | ask about a REAL project you cannot see | Compare with a genuinely nonexistent name | Both 422s are byte-identical after substituting your own word; no id leaks — invisible is indistinguishable from nonexistent |
| 34 | Copilot proposal applier | same | Approve a proposal, then Apply | Applies through the same endpoints an admin uses; pending/denied refuse by name; second apply refuses |
| 35 | Judged recommendations (opt-in) | Settings → org knob, then Access Reviews → Recommendations | Enable the judge knob with a live agent | Annotations labelled `model-judged`; deterministic evidence byte-identical; knob off = no annotations |
| 36 | Use-case dispatch gate | Settings (org) → use-case gate | Set `warn`, then `enforce`, dispatch on a linked project | Off = unchanged; warn = annotated; enforce = 409 before any provider call |
| 37 | Staleness recertification | Settings → Model risk enforcement | Enable staleness recert, drift a card, dispatch | 409 naming the drift evidence; recertify clears it |
| 38 | SoD N-way + patterns | Access Reviews → SoD rules | Build a 3-side rule; hold 2 of 3; then take the third | Any 2 of 3 fine; the completing mint refused |
| 39 | Campaign expiry + reassignment | Access Reviews → Campaigns | Let one pass its due date; reassign an item | `expired-incomplete` on read; reassignment audited; never to the grant's holder |
| 40 | Key re-encryption walk | CLI (ops) | `REGULAIT_DATA_KEY=<new> REGULAIT_DATA_KEY_OLD=<old> pnpm --filter @regulait/gateway reencrypt` | Resumable; rows readable under the new key only; corrupt rows → `completed_with_failures` |
| 41 | Tier flags enforced | Identity & Access → SAML/SCIM | Try enabling SAML/SCIM without a license | 403 naming feature and tier (unlicensed installs now refuse enablement) |

## D. Needs external setup (test when available)
Live model dispatch (add a credential) · SSO/SCIM/group-mapping (IdP) · PM sync
(Jira/Linear creds) · BYOC/air-gapped install (separate box) · MinIO-backed
anchor is in compose already; real S3 needs a bucket.
