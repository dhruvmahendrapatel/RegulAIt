-- Migration 0072 (ADR-0056) — THE AI GOVERNANCE COPILOT.
--
-- THE TABLE THAT IS NOT HERE
--
--   There is nothing below that the copilot can mutate in the control plane.
--   No `copilot_applied_changes`, no `copilot_policy_writes`, no column naming
--   a grant, a role, a rule or an entitlement to change. The copilot writes
--   exactly two tables — a record of what it was ASKED and what it RETRIEVED,
--   and a record of what it PROPOSED — and neither is a governance object.
--
--   ADR-0056 §4: "The copilot has NO MUTATING TOOLS." That is enforced here,
--   structurally: a proposal carries a diff and points at an ordinary
--   `approvals` row. Applying it is a normal governed action performed by the
--   APPROVER under their own identity. An agent that could tighten a policy
--   from natural language would be an ungoverned control-plane actor — exactly
--   the thing this whole product exists to prevent — and no amount of prompting
--   would make that safe, so the schema does not offer it a way.
--
-- THE HONESTY COLUMN
--
--   `copilot_queries.scope_project_ids` records the EXACT project-id set the
--   retrieval was narrowed to, at query construction, from the INVOKING USER's
--   own memberships. "Could the copilot have seen team B's rows when Alice
--   asked?" is answerable from the ledger, forever, without re-running
--   anything. NULL means org-wide, and is only ever written for an admin.
--
--   `generation` is the second honesty column. 'grounded' means NO MODEL WAS
--   INVOLVED: the answer was composed from counts the gateway selected, so it
--   cannot contain a hallucinated figure. 'model' means a narration was layered
--   on top by a governed dispatch — metered, audited, guardrailed like any
--   other. The two are distinguishable in the ledger because a reader must be
--   able to tell which they are looking at.
--
--   `guardrail_action` exists because the audit log is now an INJECTION
--   SURFACE. Retrieved `reason` strings are attacker-influenceable text; a
--   guardrail hit on them is recorded here rather than being invisible.
--
-- WHY `user_id` IS NOT NULLABLE. An identity-less copilot query is a
-- contradiction: there would be no entitlement set to inherit, and "inherits
-- the invoking user's entitlements, never exceeds them" is the entire security
-- model. The bootstrap token cannot ask the copilot anything.

CREATE TABLE "copilot_queries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "question" text NOT NULL,
  -- the STRUCTURED tool call the NL step produced. Recorded so "why did it run
  -- that query" is answerable without a model.
  "plan" jsonb NOT NULL,
  -- counts + bounded samples, already scoped
  "evidence" jsonb NOT NULL,
  -- the GROUNDED answer: composed from counts, never from model recall
  "answer" text NOT NULL,
  "generation" text DEFAULT 'grounded' NOT NULL,
  -- FK-free: the record of what was answered outlives the agent row
  "narrator_agent_id" uuid,
  -- the EXACT ids the retrieval was permitted to touch. NULL = org-wide (admin).
  "scope_project_ids" jsonb,
  "project_id" uuid,
  -- ADR-0042: set when a guardrail acted on retrieved evidence or on the answer
  "guardrail_action" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "copilot_queries_generation_check" CHECK ("generation" IN ('grounded','model'))
);

CREATE INDEX "copilot_queries_user_idx" ON "copilot_queries" ("user_id", "created_at");

-- THE ONLY ROUTE FROM THE COPILOT TO A CHANGE — and it is not a change.
CREATE TABLE "copilot_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "query_id" uuid NOT NULL REFERENCES "copilot_queries"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "rationale" text NOT NULL,
  -- the concrete, reviewable change — RECORDED, never applied by this module
  "diff" jsonb NOT NULL,
  -- the query result that justifies it, COPIED at proposal time so a later
  -- ledger change cannot silently restate the justification
  "evidence" jsonb NOT NULL,
  -- the link to the ONE queue: the copilot does not get a second inbox
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "proposed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "copilot_proposals_query_idx" ON "copilot_proposals" ("query_id");
