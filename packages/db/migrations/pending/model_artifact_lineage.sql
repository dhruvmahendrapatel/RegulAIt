-- Lane L7 (P14 + P16): lineage from a derived model file back to its parent file(s).
CREATE TABLE "model_artifact_lineage" (
	"child_artifact_id" uuid NOT NULL,
	"parent_artifact_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"method" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_artifact_lineage_child_artifact_id_parent_artifact_id_pk" PRIMARY KEY("child_artifact_id","parent_artifact_id"),
	CONSTRAINT "model_artifact_lineage_no_self_check" CHECK ("model_artifact_lineage"."child_artifact_id" <> "model_artifact_lineage"."parent_artifact_id"),
	CONSTRAINT "model_artifact_lineage_relation_check" CHECK ("model_artifact_lineage"."relation" IN ('repackaged', 'converted', 'fine_tuned', 'merged', 'quantized')),
	CONSTRAINT "model_artifact_lineage_method_check" CHECK ("model_artifact_lineage"."method" IS NULL OR length("model_artifact_lineage"."method") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "model_artifact_lineage" ADD CONSTRAINT "model_artifact_lineage_child_artifact_id_model_artifacts_id_fk" FOREIGN KEY ("child_artifact_id") REFERENCES "public"."model_artifacts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_artifact_lineage" ADD CONSTRAINT "model_artifact_lineage_parent_artifact_id_model_artifacts_id_fk" FOREIGN KEY ("parent_artifact_id") REFERENCES "public"."model_artifacts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_artifact_lineage" ADD CONSTRAINT "model_artifact_lineage_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "model_artifact_lineage_parent_idx" ON "model_artifact_lineage" USING btree ("parent_artifact_id");
