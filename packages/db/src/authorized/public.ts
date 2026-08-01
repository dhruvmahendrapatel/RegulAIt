// GENERATED from the regulAIt Authorized EF Core DataContext.
// Regenerate with scripts/gen-authorized-schema.py; do not hand-edit.
// Postgres schema: public

import { boolean, index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const action = pgTable("action", {
  actionId: integer("actionid").primaryKey(),
  description: varchar("description", { length: 100 }),
  name: varchar("name", { length: 50 }),
});

export const activity = pgTable("activities", {
  activityId: integer("activityid").primaryKey().generatedByDefaultAsIdentity(),
  name: text("name"),
  ownerId: integer("ownerid"),
  subprocessId: integer("subprocessid"),
}, (t) => [
  index("ix_activities_sub_process_id").on(t.subprocessId),
]);

export const applicationApiTemplate = pgTable("application_api_template", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  body: text("body"),
  name: varchar("name", { length: 200 }).notNull(),
  options: varchar("options", { length: 200 }).notNull(),
  parameters: text("parameters"),
  relativeUrl: text("relative_url").notNull(),
  type: varchar("type", { length: 200 }).notNull(),
}, (t) => [
  index("ix_application_api_template_application_id").on(t.applicationId),
]);

export const applicationEmailTemplate = pgTable("application_email_template", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  body: text("body"),
  name: varchar("name", { length: 200 }).notNull(),
  options: varchar("options", { length: 200 }).notNull(),
  subject: text("subject").notNull(),
}, (t) => [
  index("ix_application_email_template_application_id").on(t.applicationId),
]);

export const applicationGroup = pgTable("application_group", {
  applicationGroupId: integer("application_group_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  description: text("description"),
  id: varchar("id", { length: 100 }),
  modifiedBy: text("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  type: varchar("type", { length: 50 }),
  value: varchar("value", { length: 200 }),
}, (t) => [
  index("ix_application_group_application_id").on(t.applicationId),
]);

export const applicationMapping = pgTable("application_mapping", {
  applicationMappingId: integer("application_mapping_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  isMappingEditable: boolean("is_mapping_editable").notNull(),
  jsonQuery: text("json_query"),
  schedulerId: integer("scheduler_id"),
  sqlQuery: text("sql_query"),
  type: varchar("type", { length: 50 }),
}, (t) => [
  index("ix_application_mapping_application_id").on(t.applicationId),
]);

export const applicationMappingAttribute = pgTable("application_mapping_attributes", {
  applicationMappingAttributeId: integer("application_mapping_attribute_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationMappingId: integer("application_mapping_id"),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  field1: varchar("field1", { length: 200 }),
  field2: varchar("field2", { length: 200 }),
  isChange: boolean("is_change").notNull(),
  isChangeRequired: boolean("is_change_required").notNull(),
  isCreate: boolean("is_create").notNull(),
  isCreateRequired: boolean("is_create_required").notNull(),
  isFieldEditable: boolean("is_field_editable").notNull(),
  isPrimary: boolean("is_primary").notNull(),
  isRemove: boolean("is_remove").notNull(),
  modifiedById: integer("modified_by_id"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  rule: text("rule"),
}, (t) => [
  index("ix_application_mapping_attributes_application_mapping_id").on(t.applicationMappingId),
]);

export const applicationSetting = pgTable("application_setting", {
  applicationSettingId: integer("application_setting_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  applicationTypeId: integer("application_type_id"),
  commonId: integer("common_id").notNull(),
  description: text("description"),
  heading: varchar("heading", { length: 100 }),
  name: varchar("name", { length: 100 }),
  options: text("options"),
  type: varchar("type", { length: 10 }),
  value: text("value"),
}, (t) => [
  index("ix_application_setting_application_id").on(t.applicationId),
  index("ix_application_setting_application_type_id").on(t.applicationTypeId),
]);

export const applicationType = pgTable("application_types", {
  applicationTypeId: integer("application_type_id").primaryKey().generatedByDefaultAsIdentity(),
  description: text("description"),
  fields: text("fields"),
  image: varchar("image", { length: 200 }),
  name: varchar("name", { length: 50 }),
});

export const applicationUsersInbound = pgTable("application_users_inbound", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  businessUserId: integer("business_user_id").notNull(),
  lastModifiedOn: timestamp("last_modified_on", { withTimezone: false, mode: "date" }).notNull(),
  modifiedFields: jsonb("modified_fields").notNull(),
  logs: jsonb("logs").notNull(),
  status: varchar("status", { length: 20 }),
});

export const applicationUsersOutbound = pgTable("application_users_outbound", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  businessUserId: integer("business_user_id").notNull(),
  lastModifiedOn: timestamp("last_modified_on", { withTimezone: false, mode: "date" }),
  modifiedFields: jsonb("modified_fields").notNull(),
  status: varchar("status", { length: 20 }),
}, (t) => [
  index("IX_application_users_outbound_business_user_id").on(t.businessUserId),
]);

export const application = pgTable("applications", {
  applicationId: integer("application_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationTypeId: integer("application_type_id"),
  configuration: text("configuration"),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  fields: text("fields"),
  isApplicationEnabled: boolean("is_application_enabled").notNull(),
  isFioriSyncEnabled: boolean("is_fiori_sync_enabled").notNull(),
  isRoleGroupSyncable: boolean("is_role_group_syncable").notNull(),
  isUserAssignment: boolean("is_user_assignment").notNull(),
  isUserOutBoundSyncable: boolean("is_user_outbound_syncable").notNull(),
  isSourceSystem: boolean("is_source_system").notNull(),
  isUserSyncable: boolean("is_user_syncable").notNull(),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  manufacturer: varchar("manufacturer", { length: 50 }),
  modifiedById: integer("modified_by_id"),
  name: varchar("name", { length: 50 }),
  timeZone1: varchar("time_zone1", { length: 250 }),
  timeZone2: varchar("time_zone2", { length: 250 }),
  version: varchar("version", { length: 50 }),
}, (t) => [
  index("ix_applications_application_type_id").on(t.applicationTypeId),
]);

export const auditLog = pgTable("auditlog", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  action: varchar("action", { length: 10 }),
  clientIp: varchar("clientip", { length: 24 }),
  level: text("level"),
  log: text("log"),
  logEvent: varchar("logevent", { length: 20 }),
  referenceId: text("referenceid"),
  referenceName: varchar("referencename", { length: 50 }),
  referencePage: varchar("referencepage", { length: 50 }),
  timeStamp: timestamp("timestamp", { withTimezone: false, mode: "date" }),
  userId: integer("userid"),
});

export const authenticationConfig = pgTable("authentication_config", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  authenticationType: integer("authentication_type"),
  config: text("config"),
});

export const businessUserAdditional = pgTable("business_user_additional", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  favouriteUserId: integer("favourite_user_id"),
  label: varchar("label", { length: 100 }),
  labelUserId: integer("label_user_id"),
});

export const businessUserEffectiveChange = pgTable("business_user_effective_change", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  businessProcessReason: varchar("business_process_reason", { length: 100 }),
  businessProcessType: varchar("business_process_type", { length: 50 }),
  effectiveDate: timestamp("effective_date", { withTimezone: false, mode: "date" }),
  isEffectiveChangeCompleted: boolean("is_effective_change_completed").notNull(),
  isNotificationSent: boolean("is_notification_sent").notNull(),
  workdayId: varchar("workday_id", { length: 50 }),
  worker: jsonb("worker").notNull(),
}, (t) => [
  index("IX_business_user_effective_change_ApplicationId").on(t.applicationId),
]);

export const businessUserEffectiveChangeSetting = pgTable("business_user_effective_change_settings", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  applyChangeOnEffectiveDate: varchar("apply_change_on_effective_date", { length: 50 }),
  attributes: varchar("attributes", { length: 500 }),
  businessProcessReason: varchar("business_process_reason", { length: 150 }),
  businessProcessType: varchar("business_process_type", { length: 100 }),
  emailTemplateId: integer("email_template_id"),
}, (t) => [
  index("IX_business_user_effective_change_settings_application_id").on(t.applicationId),
]);

export const businessUser = pgTable("business_users", {
  businessUserId: integer("business_user_id").primaryKey().generatedByDefaultAsIdentity(),
  accountNo: varchar("account_no", { length: 200 }),
  addRole: text("add_role"),
  address: varchar("address", { length: 200 }),
  adobjectSid: varchar("adobject_sid", { length: 200 }),
  alias: varchar("alias", { length: 200 }),
  cell: varchar("cell", { length: 200 }),
  city: varchar("city", { length: 200 }),
  clientId: integer("client_id"),
  code: varchar("code", { length: 200 }),
  company: varchar("company", { length: 200 }),
  copyReference: varchar("copy_reference", { length: 500 }),
  costCenter: varchar("cost_center", { length: 200 }),
  country: varchar("country", { length: 200 }),
  countryCode: varchar("country_code", { length: 200 }),
  createdBy: varchar("created_by", { length: 200 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  creator: varchar("creator", { length: 200 }),
  creatorDate: timestamp("creator_date", { withTimezone: false, mode: "date" }),
  custom1: text("custom1"),
  custom2: text("custom2"),
  custom3: text("custom3"),
  custom4: text("custom4"),
  custom5: text("custom5"),
  custom6: text("custom6"),
  department: varchar("department", { length: 200 }),
  displayName: varchar("display_name", { length: 200 }),
  email: varchar("email", { length: 200 }),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  fax: varchar("fax", { length: 200 }),
  faxExtension: varchar("fax_extension", { length: 200 }),
  businessProcessReason: varchar("business_process_reason", { length: 500 }),
  distinguishedName: varchar("distinguished_name", { length: 500 }),
  reason: varchar("reason", { length: 500 }),
  firstDayOfLeave: timestamp("first_day_of_leave", { withTimezone: false, mode: "date" }),
  contractEndDate: timestamp("contract_end_date", { withTimezone: false, mode: "date" }),
  contractStartDate: timestamp("contract_start_date", { withTimezone: false, mode: "date" }),
  firstName: varchar("first_name", { length: 200 }),
  groupName: varchar("group_name", { length: 200 }),
  hireDate: timestamp("hire_date", { withTimezone: false, mode: "date" }),
  image: varchar("image", { length: 200 }),
  isCellRegistered: boolean("is_cell_registered"),
  jiraType: varchar("jira_type", { length: 200 }),
  jobCode: varchar("job_code", { length: 200 }),
  key: text("key"),
  lastDayOfLeave: timestamp("last_day_of_leave", { withTimezone: false, mode: "date" }),
  lastLogin: timestamp("last_login", { withTimezone: false, mode: "date" }),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  lastName: varchar("last_name", { length: 200 }),
  lastSync: timestamp("last_sync", { withTimezone: false, mode: "date" }),
  line: varchar("line", { length: 200 }),
  managerId: integer("manager_id"),
  middlename: varchar("middlename", { length: 200 }),
  modifiedBy: varchar("modified_by", { length: 200 }),
  officeLocation: varchar("office_location", { length: 300 }),
  password: text("password"),
  phone: varchar("phone", { length: 200 }),
  plant: varchar("plant", { length: 200 }),
  position: varchar("position", { length: 200 }),
  removeRole: text("remove_role"),
  resetApplications: text("reset_applications"),
  riskAnalysisColumns: text("risk_analysis_columns"),
  secondaryEmail: varchar("secondary_email", { length: 200 }),
  securityPolicy: varchar("security_policy", { length: 200 }),
  segment: varchar("segment", { length: 200 }),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
  state: varchar("state", { length: 200 }),
  statusId: integer("status_id"),
  streetAddress: varchar("street_address", { length: 200 }),
  subUserType: varchar("sub_user_type", { length: 200 }),
  targetApplicationId: integer("target_application_id"),
  telephone: varchar("telephone", { length: 200 }),
  telephoneExtension: varchar("telephone_extension", { length: 200 }),
  terminationDate: timestamp("termination_date", { withTimezone: false, mode: "date" }),
  ticketNo: text("ticket_no"),
  timeZone: varchar("time_zone", { length: 200 }),
  title: varchar("title", { length: 200 }),
  userId: varchar("user_id", { length: 500 }),
  userPrincipalName: varchar("user_principal_name", { length: 200 }),
  userType: varchar("user_type", { length: 200 }),
  username: varchar("username", { length: 200 }),
  validFrom: timestamp("valid_from", { withTimezone: false, mode: "date" }),
  validTo: timestamp("valid_to", { withTimezone: false, mode: "date" }),
  workBuildingNo: varchar("work_building_no", { length: 200 }),
  workFloorNo: varchar("work_floor_no", { length: 200 }),
  workFunction: varchar("work_function", { length: 200 }),
  workRoom: varchar("work_room", { length: 200 }),
  zipCode: varchar("zip_code", { length: 200 }),
}, (t) => [
  index("ix_business_users_status_id").on(t.statusId),
]);

export const businessUsersFutureHire = pgTable("business_users_future_hire", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  businessUserId: integer("business_user_id").notNull(),
  hireDate: timestamp("hire_date", { withTimezone: false, mode: "date" }).notNull(),
}, (t) => [
  index("IX_business_users_future_hire_application_id").on(t.applicationId),
  index("IX_business_users_future_hire_business_user_id").on(t.businessUserId),
]);

export const conditionRole = pgTable("condition_roles", {
  conditionRoleId: integer("condition_role_id").primaryKey().generatedByDefaultAsIdentity(),
  conditionId: integer("condition_id"),
  roleId: integer("role_id"),
}, (t) => [
  index("ix_condition_roles_condition_id").on(t.conditionId),
  index("ix_condition_roles_role_id").on(t.roleId),
]);

export const condition = pgTable("conditions", {
  conditionId: integer("condition_id").primaryKey().generatedByDefaultAsIdentity(),
  jsonQuery: text("json_query"),
  name: varchar("name", { length: 50 }),
  sqlQuery: text("sql_query"),
});

export const contextType = pgTable("context_types", {
  contextTypeId: integer("context_type_id").primaryKey().generatedByDefaultAsIdentity(),
  color: varchar("color", { length: 50 }),
  name: varchar("name", { length: 300 }),
});

export const country = pgTable("country", {
  countryId: integer("country_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  conditionId: integer("condition_id"),
  countryName: varchar("country_name", { length: 50 }),
  dateFormat: varchar("date_format", { length: 50 }),
  decimalNotation: varchar("decimal_notation", { length: 20 }),
  language: varchar("language", { length: 20 }),
  timeFormat: varchar("time_format", { length: 50 }),
  timeZone: varchar("time_zone", { length: 20 }),
}, (t) => [
  index("ix_country_application_id").on(t.applicationId),
  index("ix_country_condition_id").on(t.conditionId),
]);

export const delegateAssigned = pgTable("delegate_assigned", {
  delegateAssignedId: integer("delegate_assigned_id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  delegateBusinessUserId: integer("delegate_business_user_id"),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  isDeleted: boolean("is_deleted").notNull(),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  requestType: integer("request_type").notNull(),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
}, (t) => [
  index("ix_delegate_assigned_business_user_id").on(t.businessUserId),
  index("ix_delegate_assigned_delegate_business_user_id").on(t.delegateBusinessUserId),
]);

export const domain = pgTable("domains", {
  domainId: integer("domain_id").primaryKey().generatedByDefaultAsIdentity(),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  name: varchar("name", { length: 50 }),
});

export const emailDistributionGroup = pgTable("email_distribution_group", {
  emailDistributionGroupId: integer("email_distribution_group_id").primaryKey().generatedByDefaultAsIdentity(),
  jsonQuery: text("json_query"),
  name: varchar("name", { length: 100 }),
  sqlQuery: text("sql_query"),
});

export const emailSetting = pgTable("email_settings", {
  emailSettingId: integer("email_setting_id").primaryKey().generatedByDefaultAsIdentity(),
  byPassSslCertificate: boolean("by_pass_ssl_certificate").notNull(),
  email: varchar("email", { length: 50 }),
  emailSection: text("email_section"),
  isDefaultCredentials: boolean("is_default_credentials").notNull(),
  isSslEnabled: boolean("is_ssl_enabled").notNull(),
  password: text("password"),
  port: integer("port"),
  smtp: varchar("smtp", { length: 50 }),
  username: varchar("username", { length: 100 }),
});

export const emailTemplate = pgTable("email_template", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  body: text("body"),
  conditionId: integer("condition_id"),
  emailTemplateTypeId: integer("email_template_type_id"),
  isActive: boolean("is_active").notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  sendEmailToPrimaryAddress: boolean("send_email_to_primary_address").notNull(),
  subject: text("subject"),
}, (t) => [
  index("ix_email_template_email_template_type_id").on(t.emailTemplateTypeId),
]);

export const emailTemplateType = pgTable("email_template_type", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  defaultHtml: text("default_html"),
  defaultSubject: text("default_subject"),
  input: text("input"),
  isEnabled: boolean("is_enabled").notNull(),
  name: varchar("name", { length: 300 }),
  object: text("object"),
  sendEmailToPrimaryAddress: boolean("send_email_to_primary_address").notNull(),
  type: varchar("type", { length: 200 }),
});

export const email = pgTable("emails", {
  emailId: integer("email_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  businessUserId: integer("business_user_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  emailAddresses: text("email_addresses"),
  emailNotificationId: integer("email_notification_id"),
  emailTemplateTypeId: integer("email_template_type_id"),
  inUse: boolean("in_use").notNull(),
  isActive: boolean("is_active").notNull(),
  message: text("message"),
  requestId: integer("request_id"),
  response: text("response"),
  sentOn: timestamp("sent_on", { withTimezone: false, mode: "date" }),
  statusId: integer("status_id"),
  subject: varchar("subject", { length: 200 }),
}, (t) => [
  index("ix_emails_email_template_type_id").on(t.emailTemplateTypeId),
  index("ix_emails_request_id").on(t.requestId),
  index("ix_emails_status_id").on(t.statusId),
]);

export const grclog = pgTable("grclogs", {
  grclogId: integer("grclog_id").primaryKey().generatedByDefaultAsIdentity(),
  action: varchar("action", { length: 50 }),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  id: varchar("id", { length: 50 }),
  message: text("message"),
  messageNo: varchar("message_no", { length: 50 }),
  messageType: varchar("message_type", { length: 50 }),
  request: text("request"),
  requestNo: varchar("request_no", { length: 50 }),
  response: text("response"),
  status: varchar("status", { length: 50 }),
  url: text("url"),
});

export const importTable = pgTable("import", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  createdBy: varchar("created_by", { length: 100 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  fileName: varchar("file_name", { length: 200 }),
  jobId: varchar("job_id", { length: 20 }),
  name: varchar("name", { length: 50 }),
  parameters: text("parameters"),
  status: varchar("status", { length: 30 }),
  templateId: integer("template_id"),
  templateName: varchar("template_name", { length: 50 }),
});

export const internalGroup = pgTable("internal_groups", {
  internalGroupId: integer("internal_group_id").primaryKey().generatedByDefaultAsIdentity(),
  createdBy: integer("created_by"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  name: varchar("name", { length: 200 }),
});

export const internalLinkRoleGroup = pgTable("internal_link_role_groups", {
  internalLinkRoleGroupId: integer("internal_link_role_group_id").primaryKey().generatedByDefaultAsIdentity(),
  internalGroupId: integer("internal_group_id").notNull(),
  internalRoleId: integer("internal_role_id").notNull(),
}, (t) => [
  index("ix_internal_link_role_groups_internal_group_id").on(t.internalGroupId),
  index("ix_internal_link_role_groups_internal_role_id").on(t.internalRoleId),
]);

export const internalLinkRolePermission = pgTable("internal_link_role_permissions", {
  internalLinkRolePermissionId: integer("internal_link_role_permission_id").primaryKey().generatedByDefaultAsIdentity(),
  internalPermissionId: integer("internal_permission_id").notNull(),
  internalRoleId: integer("internal_role_id").notNull(),
}, (t) => [
  index("ix_internal_link_role_permissions_internal_permission_id").on(t.internalPermissionId),
  index("ix_internal_link_role_permissions_internal_role_id").on(t.internalRoleId),
]);

export const internalLinkUserRoleGroup = pgTable("internal_link_user_role_groups", {
  internalLinkUserRoleGroupId: integer("internal_link_user_role_group_id").primaryKey().generatedByDefaultAsIdentity(),
  internalGroupId: integer("internal_group_id"),
  internalRoleId: integer("internal_role_id"),
  jsonQuery: text("json_query"),
  sqlQuery: text("sql_query"),
}, (t) => [
  index("ix_internal_link_user_role_groups_internal_group_id").on(t.internalGroupId),
  index("ix_internal_link_user_role_groups_internal_role_id").on(t.internalRoleId),
]);

export const internalPage = pgTable("internal_pages", {
  internalPageId: integer("internal_page_id").primaryKey(),
  description: text("description"),
  name: varchar("name", { length: 200 }),
  pageUrl: text("page_url"),
});

export const internalPermission = pgTable("internal_permissions", {
  internalPermissionId: integer("internal_permission_id").primaryKey(),
  description: text("description"),
  internalPageId: integer("internal_page_id"),
  name: varchar("name", { length: 200 }),
  shortName: varchar("short_name", { length: 50 }),
}, (t) => [
  index("ix_internal_permissions_internal_page_id").on(t.internalPageId),
]);

export const internalRole = pgTable("internal_roles", {
  internalRoleId: integer("internal_role_id").primaryKey().generatedByDefaultAsIdentity(),
  createdBy: integer("created_by"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  name: varchar("name", { length: 200 }),
});

export const jobLock = pgTable("job_locks", {
  lockKey: varchar("lock_key", { length: 255 }).primaryKey(),
  expiryTime: timestamp("expiry_time", { withTimezone: false, mode: "date" }),
  lockValue: varchar("lock_value", { length: 255 }),
});

export const mitigationControl = pgTable("mitigation_control", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  controlId: varchar("control_id", { length: 50 }),
  description: text("description"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  name: varchar("name", { length: 100 }),
});

export const mitigationControlAccessRisk = pgTable("mitigation_control_access_risks", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  mitigationControlId: integer("mitigation_control_id"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  riskId: varchar("risk_id", { length: 30 }),
}, (t) => [
  index("ix_mitigation_control_access_risks_mitigation_control_id").on(t.mitigationControlId),
  index("ix_mitigation_control_access_risks_risk_id").on(t.riskId),
]);

export const mitigationControlAttachment = pgTable("mitigation_control_attachments", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  attachmentType: varchar("attachment_type", { length: 100 }),
  filePath: varchar("file_path", { length: 300 }),
  fileSize: varchar("file_size", { length: 30 }),
  fileType: varchar("file_type", { length: 100 }),
  linkAddress: text("link_address"),
  mitigationControlId: integer("mitigation_control_id"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  title: varchar("title", { length: 200 }),
}, (t) => [
  index("ix_mitigation_control_attachments_mitigation_control_id").on(t.mitigationControlId),
]);

export const mitigationControlOwner = pgTable("mitigation_control_owners", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id").notNull(),
  mitigationControlId: integer("mitigation_control_id").notNull(),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  type: varchar("type", { length: 50 }).notNull(),
}, (t) => [
  index("ix_mitigation_control_owners_business_user_id").on(t.businessUserId),
  index("ix_mitigation_control_owners_mitigation_control_id").on(t.mitigationControlId),
]);

export const mitigationControlTechnicalRole = pgTable("mitigation_control_technical_roles", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  mitigationControlId: integer("mitigation_control_id"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  role: varchar("role", { length: 250 }),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
}, (t) => [
  index("ix_mitigation_control_technical_roles_application_id").on(t.applicationId),
  index("ix_mitigation_control_technical_roles_mitigation_control_id").on(t.mitigationControlId),
]);

export const mitigationControlUser = pgTable("mitigation_control_users", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  businessUserId: integer("business_user_id"),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  mitigationControlId: integer("mitigation_control_id"),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
}, (t) => [
  index("ix_mitigation_control_users_application_id").on(t.applicationId),
  index("ix_mitigation_control_users_business_user_id").on(t.businessUserId),
  index("ix_mitigation_control_users_mitigation_control_id").on(t.mitigationControlId),
]);

export const monitoringGraph = pgTable("monitoring_graph", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  createdById: integer("created_by_id").notNull(),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }).notNull(),
  criteria: text("criteria"),
  description: varchar("description", { length: 200 }).notNull(),
  graphType: varchar("graph_type", { length: 15 }).notNull(),
  riskAnalysisId: integer("risk_analysis_id"),
  section: varchar("section", { length: 20 }).notNull(),
  title: varchar("title", { length: 100 }).notNull(),
  type: integer("type").notNull(),
});

export const parameterValue = pgTable("parameter_values", {
  parameterValuesId: integer("parameter_values_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  conditionId: integer("condition_id"),
  parameterId: integer("parameter_id"),
  value: varchar("parameter_value", { length: 500 }),
}, (t) => [
  index("ix_parameter_values_application_id").on(t.applicationId),
  index("ix_parameter_values_condition_id").on(t.conditionId),
  index("ix_parameter_values_parameter_id").on(t.parameterId),
]);

export const parameter = pgTable("parameters", {
  parameterId: integer("parameter_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  name: varchar("name", { length: 20 }),
}, (t) => [
  index("ix_parameters_application_id").on(t.applicationId),
]);

export const passwordPolicy = pgTable("password_policies", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationTypeId: integer("application_type_id"),
  expireDays: integer("expire_days"),
  notExpire: boolean("not_expire"),
  policy: text("policy"),
}, (t) => [
  index("ix_password_policies_application_type_id").on(t.applicationTypeId),
]);

export const pendingApplication = pgTable("pending_application", {
  pendingApplicationId: integer("pending_application_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  businessUserId: integer("business_user_id"),
  jsonValue: text("json_value"),
  requestId: integer("request_id"),
  status: varchar("status", { length: 50 }),
});

export const pendingRequest = pgTable("pending_request", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  businessUserId: integer("business_user_id"),
  data: text("data"),
  requestId: integer("request_id"),
  status: varchar("status", { length: 20 }),
  type: varchar("type", { length: 50 }),
}, (t) => [
  index("ix_pending_request_application_id").on(t.applicationId),
  index("ix_pending_request_business_user_id").on(t.businessUserId),
  index("ix_pending_request_request_id").on(t.requestId),
]);

export const process = pgTable("processes", {
  processId: integer("process_id").primaryKey().generatedByDefaultAsIdentity(),
  domainId: integer("domain_id"),
  name: text("name"),
  ownerId: integer("owner_id"),
}, (t) => [
  index("ix_processes_domain_id").on(t.domainId),
]);

export const reportCustomFilter = pgTable("report_custom_filter", {
  reportCustomFilterId: integer("report_custom_filter_id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  columns: text("columns"),
  isDefault: boolean("is_default").notNull(),
  jsonQuery: text("json_query"),
  name: varchar("name", { length: 100 }),
  reportTypeId: integer("report_type_id"),
  sqlQuery: text("sql_query"),
});

export const reportFilter = pgTable("report_filter", {
  reportFilterId: integer("report_filter_id").primaryKey().generatedByDefaultAsIdentity(),
  allColumns: text("all_columns"),
  reportTypeId: integer("report_type_id"),
});

export const requestDetail = pgTable("request_details", {
  requestDetailId: integer("request_detail_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  businessUserId: integer("business_user_id"),
  comments: text("comments"),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  fireFighterId: varchar("fire_fighter_id", { length: 300 }),
  hours: integer("hours"),
  isConditionDefault: boolean("is_condition_default").notNull(),
  isDefault: boolean("is_default").notNull(),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  objectName: text("object_name"),
  objectValue: text("object_value"),
  requestId: integer("request_id"),
  roleId: integer("role_id"),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
  statusChangeDate: timestamp("status_change_date", { withTimezone: false, mode: "date" }),
  statusId: integer("status_id"),
  tagActionId: integer("tag_action_id"),
}, (t) => [
  index("ix_request_details_application_id").on(t.applicationId),
  index("ix_request_details_business_user_id").on(t.businessUserId),
  index("ix_request_details_request_id").on(t.requestId),
  index("ix_request_details_role_id").on(t.roleId),
]);

export const requestGroupApprover = pgTable("request_group_approvers", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  comments: text("comments"),
  delegateAssignedId: integer("delegate_assigned_id"),
  forwardedUserId: integer("forwarded_user_id"),
  isAssigned: boolean("is_assigned").notNull(),
  isNotificationSent: boolean("is_notification_sent").notNull(),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  reminderDate: timestamp("reminder_date", { withTimezone: false, mode: "date" }),
  requestDetailId: integer("request_detail_id"),
  statusChangeDate: timestamp("status_change_date", { withTimezone: false, mode: "date" }),
  statusId: integer("status_id").notNull(),
  workFlowGroupId: integer("work_flow_group_id").notNull(),
}, (t) => [
  index("ix_request_group_approvers_business_user_id").on(t.businessUserId),
  index("ix_request_group_approvers_delegate_assigned_id").on(t.delegateAssignedId),
  index("ix_request_group_approvers_forwarded_user_id").on(t.forwardedUserId),
  index("ix_request_group_approvers_request_detail_id").on(t.requestDetailId),
  index("ix_request_group_approvers_status_id").on(t.statusId),
  index("ix_request_group_approvers_work_flow_group_id").on(t.workFlowGroupId),
]);

export const requestIssueApprover = pgTable("request_issue_approvers", {
  requestIssueApproverId: integer("request_issue_approver_id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  comments: text("comments"),
  delegateAssignedId: integer("delegate_assigned_id"),
  forwardedUserId: integer("forwarded_user_id"),
  isAssigned: boolean("is_assigned"),
  isNotificationSent: boolean("is_notification_sent").notNull(),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  previousWorkFlowGroupId: integer("previous_work_flow_group_id"),
  reminderDate: timestamp("reminder_date", { withTimezone: false, mode: "date" }),
  requestDetailId: integer("request_detail_id"),
  statusId: integer("status_id"),
  workFlowGroupId: integer("work_flow_group_id").notNull(),
}, (t) => [
  index("ix_request_issue_approvers_assigned_to_user_id").on(t.businessUserId),
  index("ix_request_issue_approvers_delegate_assigned_id").on(t.delegateAssignedId),
  index("ix_request_issue_approvers_forwarded_user_id").on(t.forwardedUserId),
  index("ix_request_issue_approvers_previous_work_flow_group_id").on(t.previousWorkFlowGroupId),
  index("ix_request_issue_approvers_request_detail_id").on(t.requestDetailId),
  index("ix_request_issue_approvers_work_flow_group_id").on(t.workFlowGroupId),
]);

export const requestLog = pgTable("request_logs", {
  requestLogId: integer("request_log_id").primaryKey().generatedByDefaultAsIdentity(),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  requestId: integer("request_id"),
  status: varchar("status", { length: 50 }),
  title: text("title"),
  type: text("type"),
}, (t) => [
  index("ix_request_logs_request_id").on(t.requestId),
]);

export const requestTag = pgTable("request_tags", {
  requestTagId: integer("request_tag_id").primaryKey().generatedByDefaultAsIdentity(),
  isConditionDefault: boolean("is_condition_default").notNull(),
  requestDetailId: integer("request_detail_id"),
  tagId: integer("tag_id"),
  tagRemoved: varchar("tag_removed", { length: 30 }),
  type: varchar("type", { length: 50 }),
}, (t) => [
  index("ix_request_tags_request_detail_id").on(t.requestDetailId),
  index("ix_request_tags_tag_id").on(t.tagId),
]);

export const requestType = pgTable("request_type", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  name: varchar("name", { length: 250 }),
});

export const request = pgTable("requests", {
  requestId: integer("request_id").primaryKey().generatedByDefaultAsIdentity(),
  actionId: integer("action_id"),
  approvalStatusId: integer("approval_status_id"),
  auditRole: text("audit_role"),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  grcno: varchar("grcno", { length: 50 }),
  grcobjectId: text("grcobject_id"),
  grcstatus: varchar("grcstatus", { length: 50 }),
  inUse: boolean("in_use").notNull(),
  includeRemovedBr: boolean("include_removed_br").notNull(),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  reason: text("reason"),
  requestNo: varchar("request_no", { length: 50 }).notNull(),
  requestType: integer("request_type"),
  requestedForId: integer("requested_for_id"),
  requestorId: integer("requestor_id"),
  retryCount: integer("retry_count").notNull(),
  riskAnalysisForWorkFlowGroupId: integer("risk_analysis_for_work_flow_group_id"),
  riskAnalysisId: integer("risk_analysis_id"),
  roleId: integer("role_id"),
  roleName: varchar("role_name", { length: 250 }),
  statusId: integer("status_id"),
  ticketNo: varchar("ticket_no", { length: 50 }),
  userAssignmentLogs: text("user_assignment_logs"),
  workflowSequence: text("workflow_sequence"),
}, (t) => [
  index("ix_requests_approval_status_id").on(t.approvalStatusId),
  index("ix_requests_requested_for_id").on(t.requestedForId),
  index("ix_requests_requestor_id").on(t.requestorId),
  index("ix_requests_risk_analysis_id").on(t.riskAnalysisId),
  index("ix_requests_role_id").on(t.roleId),
]);

export const riskDetail = pgTable("risk_details", {
  riskDetailId: integer("risk_detail_id").primaryKey().generatedByDefaultAsIdentity(),
  riskId: integer("risk_id"),
  role: text("role"),
  roleComposite: text("role_composite"),
  trole: text("trole"),
  troleComposite: text("trole_composite"),
}, (t) => [
  index("ix_risk_details_risk_id").on(t.riskId),
]);

export const risk = pgTable("risks", {
  riskId: integer("risk_id").primaryKey().generatedByDefaultAsIdentity(),
  action: text("action"),
  createdBy: varchar("created_by", { length: 50 }),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  id: varchar("id", { length: 50 }),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  level: varchar("level", { length: 50 }),
  levelDescription: varchar("level_description", { length: 50 }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  requestId: integer("request_id"),
  risk1: varchar("risk", { length: 100 }),
  ruleId: varchar("rule_id", { length: 50 }),
  system: varchar("system", { length: 50 }),
  username: varchar("username", { length: 100 }),
}, (t) => [
  index("ix_risks_request_id").on(t.requestId),
]);

export const roleActivity = pgTable("role_activities", {
  roleActivityId: integer("role_activity_id").primaryKey().generatedByDefaultAsIdentity(),
  activityId: integer("activity_id"),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  roleId: integer("role_id"),
}, (t) => [
  index("ix_role_activities_activity_id").on(t.activityId),
  index("ix_role_activities_role_id").on(t.roleId),
]);

export const roleApi = pgTable("role_api", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationApiTemplateId: integer("application_api_template_id").notNull(),
  applicationId: integer("application_id").notNull(),
  roleId: integer("role_id").notNull(),
}, (t) => [
  index("ix_role_api_api_template_id").on(t.applicationApiTemplateId),
  index("ix_role_api_application_id").on(t.applicationId),
  index("ix_role_api_role_id").on(t.roleId),
]);

export const roleAssigned = pgTable("role_assigned", {
  roleAssignedId: integer("role_assigned_id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  isConditionDefault: boolean("is_condition_default").notNull(),
  isDefault: boolean("is_default").notNull(),
  requestDetailId: integer("request_detail_id"),
  roleId: integer("role_id"),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
}, (t) => [
  index("ix_role_assigned_business_user_id").on(t.businessUserId),
  index("ix_role_assigned_request_detail_id").on(t.requestDetailId),
  index("ix_role_assigned_role_id").on(t.roleId),
]);

export const roleAssignedTag = pgTable("role_assigned_tags", {
  roleAssignedTagId: integer("role_assigned_tag_id").primaryKey().generatedByDefaultAsIdentity(),
  isConditionDefault: boolean("is_condition_default").notNull(),
  roleAssignedId: integer("role_assigned_id"),
  tagId: integer("tag_id"),
  type: varchar("type", { length: 50 }),
}, (t) => [
  index("ix_role_assigned_tags_role_assigned_id").on(t.roleAssignedId),
  index("ix_role_assigned_tags_tag_id").on(t.tagId),
]);

export const roleChildAssigned = pgTable("role_child_assigned", {
  roleChildAssignedId: integer("role_child_assigned_id").primaryKey().generatedByDefaultAsIdentity(),
  roleAssignedId: integer("role_assigned_id"),
  roleChildId: integer("role_child_id"),
}, (t) => [
  index("ix_role_child_assigned_role_assigned_id").on(t.roleAssignedId),
  index("ix_role_child_assigned_role_child_id").on(t.roleChildId),
]);

export const roleChildTagContext = pgTable("role_child_tag_context", {
  roleChildTagContextId: integer("role_child_tag_context_id").primaryKey().generatedByDefaultAsIdentity(),
  roleChildId: integer("role_child_id"),
  tagId: integer("tag_id"),
}, (t) => [
  index("ix_role_child_tag_context_role_child_id").on(t.roleChildId),
  index("ix_role_child_tag_context_tag_id").on(t.tagId),
]);

export const roleChild = pgTable("role_childs", {
  roleChildId: integer("role_child_id").primaryKey().generatedByDefaultAsIdentity(),
  active: boolean("active").notNull(),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  name: varchar("name", { length: 50 }),
  roleMasterId: integer("role_master_id"),
}, (t) => [
  index("ix_role_childs_role_master_id").on(t.roleMasterId),
]);

export const roleCompositeType = pgTable("role_composite_types", {
  roleCompositeTypeId: integer("role_composite_type_id").primaryKey().generatedByDefaultAsIdentity(),
  name: varchar("name", { length: 50 }),
});

export const roleComposite = pgTable("role_composites", {
  roleCompositeId: integer("role_composite_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  name: varchar("name", { length: 50 }),
  roleCompositeTypeId: integer("role_composite_type_id"),
}, (t) => [
  index("ix_role_composites_application_id").on(t.applicationId),
  index("ix_role_composites_role_composite_type_id").on(t.roleCompositeTypeId),
]);

export const roleConflict = pgTable("role_conflicts", {
  roleConflictId: integer("role_conflict_id").primaryKey().generatedByDefaultAsIdentity(),
  conflictedRoleId: integer("conflicted_role_id"),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  name: text("name"),
  risk: varchar("risk", { length: 50 }),
  roleId: integer("role_id"),
  severity: varchar("severity", { length: 50 }),
}, (t) => [
  index("ix_role_conflicts_conflicted_role_id").on(t.conflictedRoleId),
  index("ix_role_conflicts_role_id").on(t.roleId),
]);

export const roleDefaultAssigned = pgTable("role_default_assigned", {
  roleDefaultAssignedId: integer("role_default_assigned_id").primaryKey().generatedByDefaultAsIdentity(),
  roleAssignedId: integer("role_assigned_id"),
  roleDefaultId: integer("role_default_id"),
}, (t) => [
  index("ix_role_default_assigned_business_user_id").on(t.roleAssignedId),
  index("ix_role_default_assigned_role_default_id").on(t.roleDefaultId),
]);

export const roleDefault = pgTable("role_defaults", {
  roleDefaultId: integer("role_default_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  name: varchar("name", { length: 50 }),
  roleId: integer("role_id"),
}, (t) => [
  index("ix_role_defaults_application_id").on(t.applicationId),
  index("ix_role_defaults_role_id").on(t.roleId),
]);

export const roleEmail = pgTable("role_email", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationEmailTemplateId: integer("application_email_template_id").notNull(),
  applicationId: integer("application_id").notNull(),
  emailIds: text("email_ids"),
  roleId: integer("role_id").notNull(),
}, (t) => [
  index("ix_role_email_application_id").on(t.applicationId),
  index("ix_role_email_email_template_id").on(t.applicationEmailTemplateId),
  index("ix_role_email_role_id").on(t.roleId),
]);

export const roleGroup = pgTable("role_group", {
  roleGroupId: integer("role_group_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationGroupId: integer("application_group_id"),
  applicationId: integer("application_id"),
  roleId: integer("role_id"),
}, (t) => [
  index("ix_role_group_application_group_id").on(t.applicationGroupId),
  index("ix_role_group_application_id").on(t.applicationId),
  index("ix_role_group_role_id").on(t.roleId),
]);

export const roleLicense = pgTable("role_license", {
  roleLicenseId: integer("role_license_id").primaryKey().generatedByDefaultAsIdentity(),
  roleId: integer("role_id").notNull(),
  sapLicenseId: integer("sap_license_id").notNull(),
}, (t) => [
  index("ix_role_license_role_id").on(t.roleId),
  index("ix_role_license_sap_license_id").on(t.sapLicenseId),
]);

export const roleMasterRole = pgTable("role_master_roles", {
  roleMasterRoleId: integer("role_master_role_id").primaryKey().generatedByDefaultAsIdentity(),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  roleId: integer("role_id"),
  roleMasterId: integer("role_master_id"),
}, (t) => [
  index("ix_role_master_roles_role_id").on(t.roleId),
  index("ix_role_master_roles_role_master_id").on(t.roleMasterId),
]);

export const roleMaster = pgTable("role_masters", {
  roleMasterId: integer("role_master_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  name: varchar("name", { length: 50 }),
}, (t) => [
  index("ix_role_masters_application_id").on(t.applicationId),
]);

export const role = pgTable("roles", {
  roleId: integer("role_id").primaryKey().generatedByDefaultAsIdentity(),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  isDefault: boolean("is_default").notNull(),
  isDeleted: boolean("is_deleted").notNull(),
  isRoleAttestable: boolean("is_role_attestable").notNull(),
  isRoleRequestable: boolean("is_role_requestable").notNull(),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedById: integer("modified_by_id"),
  name: text("name"),
  ownerId: integer("owner_id"),
  riskAnalysisId: integer("risk_analysis_id"),
}, (t) => [
  index("ix_roles_risk_analysis_id").on(t.riskAnalysisId),
]);

export const sapLicense = pgTable("sap_license", {
  sapLicenseId: integer("sap_license_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  licenseDescription: varchar("license_description", { length: 500 }).notNull(),
  licenseId: varchar("license_id", { length: 10 }).notNull(),
  licenseName: varchar("license_name", { length: 500 }).notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const scheduler = pgTable("scheduler", {
  schedulerId: integer("scheduler_id").primaryKey().generatedByDefaultAsIdentity(),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  criteria: text("criteria"),
  cron: varchar("cron", { length: 300 }),
  dependencySchedulerId: integer("dependency_scheduler_id"),
  distributionGroupId: integer("distribution_group_id"),
  emailAddress: text("email_address"),
  emailNotificationId: integer("email_notification_id"),
  groupName: varchar("group_name", { length: 100 }),
  isImmediately: boolean("is_immediately").notNull(),
  jobType: varchar("job_type", { length: 100 }),
  label: varchar("label", { length: 300 }),
  lastExecution: timestamp("last_execution", { withTimezone: false, mode: "date" }),
  modifiedById: integer("modified_by_id"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  notificationLevels: varchar("notification_levels", { length: 20 }),
  retentionDays: integer("retention_days"),
  schedulerTypeId: integer("scheduler_type_id"),
  statusId: integer("status_id"),
  uniqueName: varchar("unique_name", { length: 450 }),
}, (t) => [
  index("ix_scheduler_scheduler_type_id").on(t.schedulerTypeId),
]);

export const schedulerType = pgTable("scheduler_type", {
  id: integer("id").primaryKey(),
  className: varchar("class_name", { length: 200 }),
  name: varchar("name", { length: 100 }),
});

export const settingType = pgTable("setting_types", {
  settingTypeId: integer("setting_type_id").primaryKey(),
  description: text("description"),
  name: varchar("name", { length: 200 }),
});

export const setting = pgTable("settings", {
  settingId: integer("setting_id").primaryKey(),
  delimiter: varchar("delimiter", { length: 1 }),
  description: text("description"),
  element: varchar("element", { length: 100 }),
  isCollection: boolean("is_collection").notNull(),
  max: integer("max"),
  name: varchar("name", { length: 200 }),
  options: text("options"),
  orderBy: integer("order_by"),
  settingTypeId: integer("setting_type_id"),
  type: varchar("type", { length: 10 }),
  value: text("value"),
}, (t) => [
  index("ix_settings_setting_type_id").on(t.settingTypeId),
]);

export const signalRnotification = pgTable("signal_rnotifications", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  message: text("message"),
  recepient: integer("recepient").notNull(),
  sender: integer("sender").notNull(),
  sentOn: timestamp("sent_on", { withTimezone: false, mode: "date" }).notNull(),
});

export const state = pgTable("state", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  country: text("country"),
  states: text("states"),
  stateCode: text("state_code"),
  city: text("city"),
  timezone: text("timezone"),
});

export const status = pgTable("status", {
  statusId: integer("status_id").primaryKey(),
  description: varchar("description", { length: 100 }),
  name: varchar("name", { length: 50 }),
});

export const subProcess = pgTable("sub_processes", {
  subProcessId: integer("sub_process_id").primaryKey().generatedByDefaultAsIdentity(),
  name: text("name"),
  processId: integer("process_id"),
}, (t) => [
  index("ix_sub_processes_process_id").on(t.processId),
]);

export const syncAuditLog = pgTable("sync_audit_log", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  isDefaultRole: boolean("is_default_role").notNull(),
  log: text("log"),
  roleId: integer("role_id"),
  status: varchar("status", { length: 30 }),
  tagId: integer("tag_id"),
});

export const tagCondition = pgTable("tag_condition", {
  id: integer("id").notNull(),
  conditionId: integer("condition_id").notNull(),
  tagId: integer("tag_id").notNull(),
  type: varchar("type", { length: 20 }).notNull(),
}, (t) => [
  index("IX_tag_condition_condition_id").on(t.conditionId),
  index("IX_tag_condition_tag_id").on(t.tagId),
]);

export const tag = pgTable("tags", {
  tagId: integer("tag_id").primaryKey().generatedByDefaultAsIdentity(),
  active: boolean("active").notNull(),
  contextTypeId: integer("context_type_id"),
  description: text("description"),
  name: varchar("name", { length: 300 }),
}, (t) => [
  index("ix_tags_context_type_id").on(t.contextTypeId),
]);

export const timeZone = pgTable("time_zone", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ianaTimezoneName: varchar("iana_timezone_name", { length: 50 }).notNull(),
  windowsTimezoneName: varchar("windows_timezone_name", { length: 50 }).notNull(),
});

export const transactionCode = pgTable("transaction_codes", {
  transactionCodeId: integer("transaction_code_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  code: varchar("code", { length: 50 }),
  createdBy: varchar("created_by", { length: 50 }),
  createdById: integer("created_by_id"),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  description: text("description"),
  lastModified: timestamp("last_modified", { withTimezone: false, mode: "date" }),
  modifiedBy: varchar("modified_by", { length: 50 }),
  role: text("role"),
  roleId: integer("role_id"),
  text: varchar("text", { length: 100 }),
  type: integer("type"),
}, (t) => [
  index("ix_transaction_codes_application_id").on(t.applicationId),
  index("ix_transaction_codes_role_id").on(t.roleId),
]);

export const triggerJob = pgTable("trigger_job", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  jobId: varchar("job_id", { length: 100 }),
  schedulerId: integer("scheduler_id"),
}, (t) => [
  index("ix_trigger_job_scheduler_id").on(t.schedulerId),
]);

export const userApplicationAccess = pgTable("user_application_access", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  isUserExists: boolean("is_user_exists"),
  userApplicationId: integer("user_application_id"),
});

export const userApplicationAssignment = pgTable("user_application_assignments", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  fromDate: timestamp("from_date", { withTimezone: false, mode: "date" }),
  name: varchar("name", { length: 255 }),
  roleId: integer("role_id"),
  status: varchar("status", { length: 255 }),
  toDate: timestamp("to_date", { withTimezone: false, mode: "date" }),
  userApplicationAccessId: integer("user_application_access_id"),
  value: varchar("value", { length: 255 }),
}, (t) => [
  index("ix_user_access_roles_user_access_info_id").on(t.userApplicationAccessId),
]);

export const userApplication = pgTable("user_applications", {
  businessUserId: integer("business_user_id").notNull(),
  jobId: varchar("job_id", { length: 50 }),
  status: varchar("status", { length: 50 }),
}, (t) => [
  index("IX_user_application_details_business_user_id").on(t.businessUserId),
]);

export const userGroup = pgTable("user_group", {
  userGroupId: integer("user_group_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  name: varchar("name", { length: 50 }),
}, (t) => [
  index("ix_user_group_application_id").on(t.applicationId),
]);

export const userGroupMapping = pgTable("user_group_mapping", {
  userGroupMappingId: integer("user_group_mapping_id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  conditionId: integer("condition_id"),
  roleId: integer("role_id"),
  userGroupId: integer("user_group_id"),
}, (t) => [
  index("ix_user_group_mapping_application_id").on(t.applicationId),
  index("ix_user_group_mapping_condition_id").on(t.conditionId),
  index("ix_user_group_mapping_role_id").on(t.roleId),
  index("ix_user_group_mapping_user_group_id").on(t.userGroupId),
]);

export const userToRoleAnalysis = pgTable("user_to_role_analysis", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  isAssigned: boolean("is_assigned").notNull(),
  isConditionDefault: boolean("is_condition_default").notNull(),
  isDefault: boolean("is_default").notNull(),
  name: varchar("name", { length: 200 }),
  otherRoleItems: text("other_role_items"),
  roleChildItems: text("role_child_items"),
  roleDefaultItems: text("role_default_items"),
  roleGroupItems: text("role_group_items"),
  roleId: integer("role_id"),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
  status: varchar("status", { length: 50 }),
}, (t) => [
  index("ix_user_to_role_analysis_business_user_id").on(t.businessUserId),
]);

export const userToRoleAnalysisStatus = pgTable("user_to_role_analysis_status", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  criteria: text("criteria"),
  jobId: varchar("job_id", { length: 50 }),
  status: varchar("status", { length: 50 }),
});

export const workFlowGroup = pgTable("work_flow_group", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  anyOneCanApprove: boolean("any_one_can_approve").notNull(),
  approvalIssue: integer("approval_issue"),
  autoApprovalDays: integer("auto_approval_days"),
  autoApprovalStatus: integer("auto_approval_status"),
  canApproveWithoutMitigation: boolean("can_approve_without_mitigation").notNull(),
  canApproverReRunSod: boolean("can_approver_re_run_sod").notNull(),
  color: varchar("color", { length: 10 }).notNull(),
  description: text("description"),
  escalationDays: integer("escalation_days"),
  escalationLevel: varchar("escalation_level", { length: 10 }),
  hasOrder: integer("has_order").notNull(),
  isDeleted: boolean("is_deleted").notNull(),
  isEnable: boolean("is_enable").notNull(),
  isExceptionEnable: boolean("is_exception_enable").notNull(),
  isForward: boolean("is_forward").notNull(),
  isGroupSkipEnabled: boolean("is_group_skip_enabled").notNull(),
  isHold: boolean("is_hold").notNull(),
  isMitigationEligible: boolean("is_mitigation_eligible").notNull(),
  isSodAnalysisEnabled: boolean("is_sod_analysis_enabled").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  reminder: integer("reminder"),
  shortName: varchar("short_name", { length: 3 }).notNull(),
  workFlowTypeId: integer("work_flow_type_id").notNull(),
}, (t) => [
  index("ix_work_flow_group_work_flow_type_id").on(t.workFlowTypeId),
]);

export const workFlowGroupSet = pgTable("work_flow_group_sets", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  approverJson: text("approver_json"),
  approverQuery: text("approver_query"),
  targetJson: text("target_json"),
  targetQuery: text("target_query"),
  workFlowGroupId: integer("work_flow_group_id"),
}, (t) => [
  index("ix_work_flow_group_sets_work_flow_group_id").on(t.workFlowGroupId),
]);

export const workFlowType = pgTable("work_flow_type", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  isDeleted: boolean("is_deleted").notNull(),
  name: varchar("name", { length: 256 }),
  requestType: varchar("request_type", { length: 20 }),
});
