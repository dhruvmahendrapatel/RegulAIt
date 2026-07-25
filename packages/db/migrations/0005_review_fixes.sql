DELETE FROM "revocations" a USING "revocations" b
WHERE a.id > b.id AND a.user_id = b.user_id AND a.server_id = b.server_id
  AND a.tool_name IS NOT DISTINCT FROM b.tool_name;
--> statement-breakpoint
CREATE UNIQUE INDEX "revocations_user_server_tool_uq" ON "revocations" ("user_id","server_id","tool_name") NULLS NOT DISTINCT;
