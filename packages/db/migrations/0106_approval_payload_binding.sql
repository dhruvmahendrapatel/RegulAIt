-- ADR-0104 — APPROVAL PAYLOAD BINDING: bind a consent to the arguments it was
-- granted for, and record the arguments that actually ran.
--
-- THE GAP. An `approvals` row said "user X may call tool T on server S". It
-- carried no arguments at all, the approved-approval lookup keyed only on
-- user/server/tool/status, and the tool-call audit row recorded no payload
-- either. Two consequences, both real:
--
--   * THE APPROVER DECIDED BLIND. Nothing in the queue row told them what the
--     call would actually do — `write_note` with a benign note and `write_note`
--     with an exfiltration payload were the same row.
--   * THE CONSENT WAS SPENDABLE ON A DIFFERENT CALL. Sign for one payload,
--     execute another. Single-use consumption bounded the exposure to one swap
--     per approval cycle; it did not remove it.
--
-- WHAT THE COLUMNS ARE FOR.
--
--   `approvals.arguments_digest`   the consent FINGERPRINT — sha256 hex over
--                                  the versioned canonical JSON of
--                                  `{projectId, arguments}` (see
--                                  packages/shared/src/approval-binding.ts).
--                                  Computed on the RAW arguments, before the
--                                  ADR-0099 scrub, so redaction can never move
--                                  what the consent is for.
--   `approvals.arguments_preview`  the SCRUBBED, approver-facing rendering of
--                                  the same arguments, produced by ADR-0099's
--                                  `scrubAuditDetail` — the one redactor in
--                                  this repo, not a second one. This is the
--                                  half that lets a human decide with their
--                                  eyes open.
--   `approval_rules.approval_scope` the SEMANTICS of the consent this rule
--                                  produces: 'action' (default) binds it to
--                                  the payload; 'tool' is the deliberate,
--                                  operator-chosen escape hatch for a call
--                                  whose arguments genuinely do not change what
--                                  it means to approve it.
--
-- BOTH `approvals` COLUMNS ARE NULLABLE, AND THAT IS LOAD-BEARING. Rows that
-- exist when this migration runs were queued before any digest was computed;
-- they legitimately have none. Inventing one — from the tool name, from an
-- empty bag, from anything — would be manufacturing a consent record that
-- nobody gave, which is worse than admitting the row predates the feature.
-- A NULL digest is READ as "this consent is not bound to a payload", and under
-- the default 'action' scope it therefore does not satisfy a call: the call
-- re-queues, and the re-queued row is born with a digest. Fail-closed and
-- self-healing. This IS a behaviour change on upgrade day, deliberately: see
-- ADR-0104's "Honest limits".
--
-- `approval_scope` IS NOT NULL DEFAULT 'action', SO EVERY EXISTING RULE BECOMES
-- ACTION-SCOPED. That is the point. Pillar 1 is default-deny and this codebase's
-- rule idiom is strictest-wins; a backfill to 'tool' would have quietly kept the
-- gap open for exactly the population that already has it. An operator who
-- wants the loose reading must now say so, per rule, on the record.
--
-- NO DATA IS REWRITTEN AND NOTHING IS DROPPED. Three ADD COLUMNs, one CHECK and
-- one index. The digest index is on (user, server, tool, status, digest)
-- because that is the shape of the lookup the matcher performs; the existing
-- `approvals_user_server_tool_idx` stays, since the tool-scoped path and every
-- other consumer of the queue still key without a digest.

ALTER TABLE "approvals"
  ADD COLUMN IF NOT EXISTS "arguments_digest" text;
--> statement-breakpoint
ALTER TABLE "approvals"
  ADD COLUMN IF NOT EXISTS "arguments_preview" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_payload_binding_idx"
  ON "approvals" ("user_id", "server_id", "tool_name", "status", "arguments_digest");
--> statement-breakpoint
ALTER TABLE "approval_rules"
  ADD COLUMN IF NOT EXISTS "approval_scope" text NOT NULL DEFAULT 'action';
--> statement-breakpoint
ALTER TABLE "approval_rules"
  DROP CONSTRAINT IF EXISTS "approval_rules_approval_scope_check";
--> statement-breakpoint
ALTER TABLE "approval_rules"
  ADD CONSTRAINT "approval_rules_approval_scope_check"
  CHECK ("approval_scope" IN ('action', 'tool'));
