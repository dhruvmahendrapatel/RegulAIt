// GENERATED from the regulAIt Authorized EF Core DataContext.
// Regenerate with scripts/gen-authorized-schema.py; do not hand-edit.
// Postgres schema: nav

import { index, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const navSchema = pgSchema("nav");

export const navAdGroup = navSchema.table("nav_ad_group", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  name: varchar("name", { length: 255 }).notNull(),
  nid: varchar("nid", { length: 250 }).notNull(),
  sid: varchar("sid", { length: 250 }).notNull(),
}, (t) => [
  index("ix_nav_ad_group_application_id").on(t.applicationId),
]);

export const navMitigationControl = navSchema.table("nav_mitigation_control", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  conflictDescription: varchar("conflict_description", { length: 250 }),
  controlId: varchar("control_id", { length: 250 }),
  description: text("description"),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
  user: varchar("user", { length: 250 }),
});

export const navPermission = navSchema.table("nav_permissions", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  deletePermission: varchar("delete_permission", { length: 20 }),
  executePermission: varchar("execute_permission", { length: 20 }),
  insertPermission: varchar("insert_permission", { length: 20 }),
  modifyPermission: varchar("modify_permission", { length: 20 }),
  objectId: integer("object_id"),
  objectName: varchar("object_name", { length: 100 }),
  objectType: varchar("object_type", { length: 50 }),
  readPermission: varchar("read_permission", { length: 20 }),
  roleId: varchar("role_id", { length: 50 }),
  roleName: varchar("role_name", { length: 50 }),
  securityFilter: varchar("security_filter", { length: 50 }),
}, (t) => [
  index("ix_nav_permissions_application_id").on(t.applicationId),
]);

export const navRiskAnalysis = navSchema.table("nav_risk_analysis", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  name: varchar("name", { length: 250 }),
  parameters: text("parameters"),
  path: varchar("path", { length: 200 }),
  retentionDays: integer("retention_days"),
  status: varchar("status", { length: 30 }),
});

export const navRiskAnalysisJobDetail = navSchema.table("nav_risk_analysis_job_detail", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  jobId: varchar("job_id", { length: 50 }),
  logonName: varchar("logon_name", { length: 250 }),
  riskAnalysisId: integer("risk_analysis_id").notNull(),
}, (t) => [
  index("ix_nav_risk_analysis_job_detail_risk_analysis_id").on(t.riskAnalysisId),
]);

export const navRiskAnalysisResult = navSchema.table("nav_risk_analysis_result", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  adGroup1: varchar("ad_group1", { length: 200 }),
  adGroup2: varchar("ad_group2", { length: 200 }),
  applicationId: integer("application_id").notNull(),
  conflictDescription: varchar("conflict_description", { length: 250 }),
  jobId: text("job_id"),
  logonName: varchar("logon_name", { length: 200 }),
  mitigationControlId: varchar("mitigation_control_id", { length: 150 }),
  mitigationDescription: varchar("mitigation_description", { length: 300 }),
  mitigationEndDate: timestamp("mitigation_end_date", { withTimezone: false, mode: "date" }),
  mitigationStartDate: timestamp("mitigation_start_date", { withTimezone: false, mode: "date" }),
  object1: varchar("object1", { length: 200 }),
  object2: varchar("object2", { length: 200 }),
  reportGroup: varchar("report_group", { length: 200 }),
  risk: varchar("risk", { length: 50 }),
  riskAnalysisId: integer("risk_analysis_id"),
  roleId1: varchar("role_id1", { length: 200 }),
  roleId2: varchar("role_id2", { length: 200 }),
}, (t) => [
  index("ix_nav_risk_analysis_result_risk_analysis_id").on(t.riskAnalysisId),
]);

export const navRole = navSchema.table("nav_role", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  name: varchar("name", { length: 50 }).notNull(),
  roleId: varchar("role_id", { length: 50 }).notNull(),
}, (t) => [
  index("ix_nav_role_application_id").on(t.applicationId),
]);

export const navRoleConflict = navSchema.table("nav_role_conflict", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  conflictDescription: text("conflict_description").notNull(),
  object1: varchar("object1", { length: 60 }).notNull(),
  object2: varchar("object2", { length: 60 }).notNull(),
  risk: varchar("risk", { length: 20 }).notNull(),
}, (t) => [
  index("ix_nav_role_conflict_application_id").on(t.applicationId),
]);

export const navRoleGroup = navSchema.table("nav_role_group", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  companyName: varchar("company_name", { length: 50 }),
  loginId: varchar("login_id", { length: 70 }),
  loginSid: varchar("login_sid", { length: 70 }),
  roleId: varchar("role_id", { length: 50 }),
  roleName: varchar("role_name", { length: 50 }),
}, (t) => [
  index("ix_nav_role_group_application_id").on(t.applicationId),
]);

export const navUserRiskAnalysis = navSchema.table("nav_user_risk_analysis", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  jobId: text("job_id"),
  jobLogs: text("job_logs"),
  logonName: varchar("logon_name", { length: 150 }),
  parameters: text("parameters"),
  status: varchar("status", { length: 50 }),
}, (t) => [
  index("ix_nav_user_risk_analysis_application_id").on(t.applicationId),
]);

export const navUserRiskAnalysisArchive = navSchema.table("nav_user_risk_analysis_archive", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  archiveName: varchar("archive_name", { length: 150 }),
  archivedOn: timestamp("archived_on", { withTimezone: false, mode: "date" }),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  jobId: text("job_id"),
  jobLogs: text("job_logs"),
  logonName: varchar("logon_name", { length: 150 }),
  parameters: text("parameters"),
  status: varchar("status", { length: 50 }),
}, (t) => [
  index("ix_nav_user_risk_analysis_archive_application_id").on(t.applicationId),
]);

export const navUserRiskAnalysisResult = navSchema.table("nav_user_risk_analysis_result", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  adGroup1: varchar("ad_group1", { length: 200 }),
  adGroup2: varchar("ad_group2", { length: 200 }),
  applicationId: integer("application_id").notNull(),
  conflictDescription: varchar("conflict_description", { length: 250 }),
  logonName: varchar("logon_name", { length: 200 }),
  mitigationControlId: varchar("mitigation_control_id", { length: 150 }),
  mitigationDescription: varchar("mitigation_description", { length: 300 }),
  mitigationEndDate: timestamp("mitigation_end_date", { withTimezone: false, mode: "date" }),
  mitigationStartDate: timestamp("mitigation_start_date", { withTimezone: false, mode: "date" }),
  object1: varchar("object1", { length: 200 }),
  object2: varchar("object2", { length: 200 }),
  reportGroup: varchar("report_group", { length: 200 }),
  risk: varchar("risk", { length: 50 }),
  roleId1: varchar("role_id1", { length: 200 }),
  roleId2: varchar("role_id2", { length: 200 }),
  userRiskAnalysisId: integer("user_risk_analysis_id"),
}, (t) => [
  index("ix_nav_user_risk_analysis_result_user_risk_analysis_id").on(t.userRiskAnalysisId),
]);

export const navUserRiskAnalysisResultArchive = navSchema.table("nav_user_risk_analysis_result_archive", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  adGroup1: varchar("ad_group1", { length: 200 }),
  adGroup2: varchar("ad_group2", { length: 200 }),
  applicationId: integer("application_id").notNull(),
  conflictDescription: varchar("conflict_description", { length: 250 }),
  logonName: varchar("logon_name", { length: 200 }),
  mitigationControlId: varchar("mitigation_control_id", { length: 150 }),
  mitigationDescription: varchar("mitigation_description", { length: 300 }),
  mitigationEndDate: timestamp("mitigation_end_date", { withTimezone: false, mode: "date" }),
  mitigationStartDate: timestamp("mitigation_start_date", { withTimezone: false, mode: "date" }),
  object1: varchar("object1", { length: 200 }),
  object2: varchar("object2", { length: 200 }),
  reportGroup: varchar("report_group", { length: 200 }),
  risk: varchar("risk", { length: 50 }),
  roleId1: varchar("role_id1", { length: 200 }),
  roleId2: varchar("role_id2", { length: 200 }),
  userRiskAnalysisId: integer("user_risk_analysis_id"),
}, (t) => [
  index("ix_nav_user_risk_analysis_result_archive_user_risk_analysis_id").on(t.userRiskAnalysisId),
]);

export const navUserRole = navSchema.table("nav_user_role", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  adgroup: varchar("adgroup", { length: 60 }),
  applicationId: integer("application_id"),
  description: text("description"),
  displayName: varchar("display_name", { length: 60 }),
  domain: varchar("domain", { length: 60 }),
  enabled: varchar("enabled", { length: 50 }),
  loginName: varchar("login_name", { length: 60 }),
  name: varchar("name", { length: 60 }),
  navRoles: varchar("nav_roles", { length: 60 }),
  reportGroup: varchar("report_group", { length: 50 }),
}, (t) => [
  index("ix_nav_user_role_application_id").on(t.applicationId),
]);
