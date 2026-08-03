-- Migration 0062 (ADR-0050) — the DATA-LINEAGE / PROVENANCE GRAPH.
--
-- WHAT THIS GRAPH CLAIMS, AND WHAT IT REFUSES TO CLAIM
--
--   It answers: "which inputs were SUPPLIED to this dispatch, and what did it
--   produce?" — chained across runs through the context store's versioned
--   items.
--
--   It does NOT answer: "which of those inputs actually INFLUENCED the output".
--   That is intra-model attribution and it is not observable from outside a
--   model. A dispatch receives a system prompt, a message list and tool
--   results, and returns text; nothing at the gateway boundary can say which
--   sentence of which document moved which clause of the answer. The single
--   most tempting overstatement available to a lineage feature is to imply
--   otherwise, and an auditor who believed it would draw false conclusions.
--   So: this is SUPPLIED-INPUTS provenance, and the API returns that sentence
--   with every answer rather than leaving it in a comment.
--
-- WHY IT BUILDS ON PILLAR 4 RATHER THAN BESIDE IT
--
--   `project_context_items` (migration 0019) already versions every shared
--   context item and records who contributed it. ADR-0050 §1 is explicit that
--   the §9.2 provenance tag *becomes* a lineage node rather than being copied
--   into a parallel record: a `context_item` node here carries the item's KEY
--   and REVISION, and the ledgers stay the source of truth. This table is a
--   DERIVED READ-MODEL — if it were ever lost it could be rebuilt from
--   `project_context_items` + `usage_events` + `audit_log`.
--
-- THE TWO STRUCTURAL DECISIONS
--
--  1. `natural_key`, UNIQUE per project. Two captures describing the same real
--     thing MUST land on the same node or the graph silently forks and every
--     traversal under-reports while looking healthy. The key is DERIVED
--     (`context_item:api-spec:v3`, `run_node:<uuid>:<node>`) rather than
--     random, and the derivation lives in @regulait/shared so the writer and
--     the tests cannot disagree about what "the same thing" means.
--
--  2. `project_id` on BOTH tables. It is the ENTITLEMENT BOUNDARY. Every query
--     narrows to the caller's visible projects at query construction, and an
--     edge whose far endpoint sits in a project the caller cannot see is
--     dropped WITH its endpoint — because for lineage the mere existence of a
--     node is the sensitive fact ("this run touched *something* in the legal
--     team's project" leaks even without the something). Denormalising the
--     project onto the edge is what lets that narrowing happen in SQL instead
--     of after the join.
--
-- ORIENTATION — every edge points in the DIRECTION OF DATA FLOW (`from` =
-- upstream). `derived_from` is therefore STORED predecessor → successor
-- (v1 → v2) despite how its name reads: an edge stored in the direction its
-- name reads would invert a third of the graph and make a backward walk stop
-- silently at every version boundary.

-- --------------------------------------------------------------------------
-- Nodes
-- --------------------------------------------------------------------------

CREATE TABLE "lineage_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- THE ENTITLEMENT BOUNDARY (see header)
  "project_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "subtype" text NOT NULL,
  -- the DEDUPE IDENTITY. Derived, never random.
  "natural_key" text NOT NULL,
  -- the underlying row, when the thing has one (a run id, an artifact id)
  "ref_id" uuid,
  -- the context KEY / tool name / connector operation
  "ref_key" text,
  -- the SPECIFIC version consumed. Lineage always points at a version, never
  -- at "the current value of the key" — that is the whole reason pillar 4's
  -- provenance versions in the first place.
  "version" integer,
  "label" text NOT NULL,
  -- GOVERNANCE §8.4: metadata by DEFAULT. `content` stays NULL unless
  -- content-level lineage was explicitly opted into, and `content_recorded`
  -- says which of the two a reader is looking at rather than leaving them to
  -- infer it from a NULL.
  "content_recorded" boolean DEFAULT false NOT NULL,
  "content" text,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "lineage_nodes_kind_check" CHECK ("kind" IN ('source','run','output')),
  CONSTRAINT "lineage_nodes_subtype_check" CHECK ("subtype" IN (
    'context_item','workflow_artifact','connector_result','mcp_result','document',
    'run_node','agent_dispatch','dispatch_output','pull_request','pm_work_item'
  )),
  -- the flag and the column imply each other in BOTH directions, so a node can
  -- neither claim recorded content it does not hold nor hold content it does
  -- not declare
  CONSTRAINT "lineage_nodes_content_check" CHECK (
    ("content_recorded" = true AND "content" IS NOT NULL)
    OR ("content_recorded" = false AND "content" IS NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "lineage_nodes" ADD CONSTRAINT "lineage_nodes_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "lineage_nodes_project_natural_key_uq"
  ON "lineage_nodes" USING btree ("project_id","natural_key");
--> statement-breakpoint
CREATE INDEX "lineage_nodes_project_kind_idx"
  ON "lineage_nodes" USING btree ("project_id","kind");
--> statement-breakpoint
CREATE INDEX "lineage_nodes_ref_idx" ON "lineage_nodes" USING btree ("ref_id");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Edges
-- --------------------------------------------------------------------------

CREATE TABLE "lineage_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- denormalised so the entitlement narrowing is a SQL predicate rather than a
  -- post-join filter. This is the project of the edge's DOWNSTREAM end (the
  -- run/output side), which is the side that "did" something.
  "project_id" uuid NOT NULL,
  "from_node_id" uuid NOT NULL,
  "to_node_id" uuid NOT NULL,
  "kind" text NOT NULL,
  -- the orchestration run + task-graph node this capture belongs to, when one
  -- does. FK-free like the ledgers: a lineage record is a governance record
  -- that must survive the deletion of the run row it describes.
  "run_id" uuid,
  "node_id" text,
  "detail" jsonb,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "lineage_edges_kind_check"
    CHECK ("kind" IN ('flowed_into','produced','derived_from')),
  -- a self-loop carries no information and would only exist as the product of
  -- a bug; refusing it in the DDL means the traversal's cycle guard is a
  -- safety net rather than the only thing standing between a bug and a hang
  CONSTRAINT "lineage_edges_no_self_loop_check" CHECK ("from_node_id" <> "to_node_id")
);
--> statement-breakpoint

ALTER TABLE "lineage_edges" ADD CONSTRAINT "lineage_edges_from_node_id_fk"
  FOREIGN KEY ("from_node_id") REFERENCES "public"."lineage_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lineage_edges" ADD CONSTRAINT "lineage_edges_to_node_id_fk"
  FOREIGN KEY ("to_node_id") REFERENCES "public"."lineage_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lineage_edges" ADD CONSTRAINT "lineage_edges_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- IDEMPOTENT CAPTURE: re-dispatching a node, or re-running a capture, must not
-- multiply the same relationship. One edge per (from, to, kind), always.
CREATE UNIQUE INDEX "lineage_edges_from_to_kind_uq"
  ON "lineage_edges" USING btree ("from_node_id","to_node_id","kind");
--> statement-breakpoint
CREATE INDEX "lineage_edges_from_idx" ON "lineage_edges" USING btree ("from_node_id");
--> statement-breakpoint
CREATE INDEX "lineage_edges_to_idx" ON "lineage_edges" USING btree ("to_node_id");
--> statement-breakpoint
CREATE INDEX "lineage_edges_run_idx" ON "lineage_edges" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "lineage_edges_project_idx" ON "lineage_edges" USING btree ("project_id");
