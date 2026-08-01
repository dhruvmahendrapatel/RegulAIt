// GENERATED from the regulAIt Authorized EF Core DataContext.
// Regenerate with scripts/gen-authorized-schema.py; do not hand-edit.
// Postgres schema: risk

import { boolean, index, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const riskSchema = pgSchema("risk");

export const businessProcess = riskSchema.table("business_process", {
  bpid: integer("bpid").primaryKey().generatedByDefaultAsIdentity(),
  bp: varchar("bp", { length: 100 }),
  description: text("description"),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedById: integer("modified_by_id"),
});

export const functionTable = riskSchema.table("function", {
  functionId: integer("function_id").primaryKey().generatedByDefaultAsIdentity(),
  bpid: integer("bpid"),
  description: text("description"),
  function1: varchar("function", { length: 100 }),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedById: integer("modified_by_id"),
}, (t) => [
  index("ix_function_bpid").on(t.bpid),
]);

export const functionAction = riskSchema.table("function_action", {
  functionActionId: integer("function_action_id").primaryKey().generatedByDefaultAsIdentity(),
  action: text("action"),
  active: boolean("active").notNull(),
  applicationId: integer("application_id"),
  functionId: integer("function_id"),
}, (t) => [
  index("ix_function_action_application_id").on(t.applicationId),
  index("ix_function_action_function_id").on(t.functionId),
]);

export const functionPermission = riskSchema.table("function_permission", {
  functionPermissionId: integer("function_permission_id").primaryKey().generatedByDefaultAsIdentity(),
  active: boolean("active").notNull(),
  applicationId: integer("application_id"),
  authObject: text("auth_object"),
  condition: varchar("condition", { length: 4 }),
  field: text("field"),
  fromValue: text("from_value"),
  functionAction: text("function_action"),
  functionId: integer("function_id"),
  toValue: text("to_value"),
}, (t) => [
  index("ix_function_permission_application_id").on(t.applicationId),
  index("ix_function_permission_function_id").on(t.functionId),
]);

export const permissionRiskAnalysis = riskSchema.table("permission_risk_analysis", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  functionAction: text("function_action").notNull(),
  functionId: integer("function_id").notNull(),
  objectItems: text("object_items"),
  ruleSetId: integer("rule_set_id"),
});

export const permissionRiskAnalysisItem = riskSchema.table("permission_risk_analysis_items", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  auth: varchar("auth", { length: 100 }),
  permissionRiskAnalysisId: integer("permission_risk_analysis_id").notNull(),
  transValueItems: text("trans_value_items"),
}, (t) => [
  index("ix_permission_risk_analysis_items_permission_risk_analysis_id").on(t.permissionRiskAnalysisId),
]);

export const riskAnalysis = riskSchema.table("risk_analysis", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  critical: integer("critical").notNull(),
  high: integer("high").notNull(),
  low: integer("low").notNull(),
  medium: integer("medium").notNull(),
  parameters: text("parameters"),
  path: varchar("path", { length: 200 }),
  retentionDays: integer("retention_days"),
  status: varchar("status", { length: 30 }),
});

export const riskAnalysisJobDetail = riskSchema.table("risk_analysis_job_details", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  jobId: varchar("job_id", { length: 50 }),
  riskAnalysisId: integer("risk_analysis_id").notNull(),
}, (t) => [
  index("ix_risk_analysis_job_details_risk_analysis_id").on(t.riskAnalysisId),
]);

export const riskAnalysisResult = riskSchema.table("risk_analysis_result", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  accessRiskType: varchar("access_risk_type", { length: 20 }),
  action1: varchar("action1", { length: 100 }),
  action2: varchar("action2", { length: 100 }),
  actionDescription1: text("action_description1"),
  actionDescription2: text("action_description2"),
  actionType1: text("action_type1"),
  actionType2: text("action_type2"),
  applicationId1: integer("application_id1"),
  applicationId2: integer("application_id2"),
  businessRole1: varchar("business_role1", { length: 100 }),
  businessRole2: varchar("business_role2", { length: 100 }),
  function1: varchar("function1", { length: 100 }),
  function2: varchar("function2", { length: 100 }),
  functionAction1: varchar("function_action1", { length: 100 }),
  functionAction2: varchar("function_action2", { length: 100 }),
  functionActionId1: integer("function_action_id1"),
  functionActionId2: integer("function_action_id2"),
  functionDescription1: text("function_description1"),
  functionDescription2: text("function_description2"),
  functionId1: integer("function_id1"),
  functionId2: integer("function_id2"),
  jobId: varchar("job_id", { length: 50 }),
  mitigationControlId: varchar("mitigation_control_id", { length: 250 }),
  mitigationDescription: varchar("mitigation_description", { length: 250 }),
  permissionRisk1: text("permission_risk1"),
  permissionRisk2: text("permission_risk2"),
  permissionRiskTable1: text("permission_risk_table1"),
  permissionRiskTable2: text("permission_risk_table2"),
  riskAnalysisId: integer("risk_analysis_id").notNull(),
  riskDescription: varchar("risk_description", { length: 200 }),
  riskId: varchar("risk_id", { length: 50 }),
  riskLevel: varchar("risk_level", { length: 20 }),
  riskLongDescription: varchar("risk_long_description", { length: 300 }),
  ruleSet: varchar("rule_set", { length: 50 }),
  scope: varchar("scope", { length: 20 }),
  technicalRole1: varchar("technical_role1", { length: 100 }),
  technicalRole2: varchar("technical_role2", { length: 100 }),
  username: varchar("username", { length: 50 }),
}, (t) => [
  index("ix_risk_analysis_result_risk_analysis_id").on(t.riskAnalysisId),
]);

export const riskDescription = riskSchema.table("risk_description", {
  riskId: varchar("risk_id", { length: 30 }).primaryKey(),
  description: text("description"),
  longDescription: text("long_description"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  riskLevelId: integer("risk_level_id"),
}, (t) => [
  index("ix_risk_description_risk_level_id").on(t.riskLevelId),
]);

export const riskFunctionRelationship = riskSchema.table("risk_function_relationship", {
  riskFunctionRelationshipId: integer("risk_function_relationship_id").primaryKey().generatedByDefaultAsIdentity(),
  active: boolean("active").notNull(),
  applicationId1: integer("application_id1"),
  applicationId2: integer("application_id2"),
  functionId1: integer("function_id1"),
  functionId2: integer("function_id2"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  riskId: varchar("risk_id", { length: 30 }),
  ruleSetId: integer("rule_set_id"),
  scope: varchar("scope", { length: 50 }),
}, (t) => [
  index("ix_risk_function_relationship_application_id1").on(t.applicationId1),
  index("ix_risk_function_relationship_application_id2").on(t.applicationId2),
  index("ix_risk_function_relationship_function_id1").on(t.functionId1),
  index("ix_risk_function_relationship_function_id2").on(t.functionId2),
  index("ix_risk_function_relationship_risk_id").on(t.riskId),
  index("ix_risk_function_relationship_rule_set_id").on(t.ruleSetId),
]);

export const riskLevel = riskSchema.table("risk_level", {
  riskLevelId: integer("risk_level_id").primaryKey().generatedByDefaultAsIdentity(),
  accessRiskType: text("access_risk_type"),
  active: boolean("active").notNull(),
  bpid: integer("bpid"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  riskLevel1: varchar("risk_level", { length: 10 }),
}, (t) => [
  index("ix_risk_level_bpid").on(t.bpid),
]);

export const riskOwner = riskSchema.table("risk_owner", {
  riskOwnerId: integer("risk_owner_id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  riskId: varchar("risk_id", { length: 30 }),
}, (t) => [
  index("ix_risk_owner_business_user_id").on(t.businessUserId),
  index("ix_risk_owner_risk_id").on(t.riskId),
]);

export const riskRuleSetRelationShip = riskSchema.table("risk_rule_set_relation_ship", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  riskId: varchar("risk_id", { length: 30 }),
  ruleSetId: integer("rule_set_id"),
}, (t) => [
  index("ix_risk_rule_set_relation_ship_risk_id").on(t.riskId),
  index("ix_risk_rule_set_relation_ship_rule_set_id").on(t.ruleSetId),
]);

export const ruleSet = riskSchema.table("rule_set", {
  ruleSetId: integer("rule_set_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationIds: varchar("application_ids", { length: 30 }),
  description: text("description"),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedById: integer("modified_by_id"),
  ruleSet1: varchar("rule_set", { length: 100 }),
});
