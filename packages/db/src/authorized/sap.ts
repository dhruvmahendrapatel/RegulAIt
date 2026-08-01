// GENERATED from the regulAIt Authorized EF Core DataContext.
// Regenerate with scripts/gen-authorized-schema.py; do not hand-edit.
// Postgres schema: sap

import { boolean, index, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const sapSchema = pgSchema("sap");

export const agr1016Role = sapSchema.table("agr1016_roles", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agrName: varchar("agr_name", { length: 30 }),
  applicationId: integer("application_id").notNull(),
  counter: integer("counter").notNull(),
  generated: varchar("generated", { length: 1 }).notNull(),
  isSingleProfile: boolean("is_single_profile").notNull(),
  profile: varchar("profile", { length: 30 }),
  pstate: varchar("pstate", { length: 1 }).notNull(),
  variant: varchar("variant", { length: 4 }).notNull(),
}, (t) => [
  index("ix_agr1016_roles_application_id").on(t.applicationId),
]);

export const agr1251 = sapSchema.table("agr1251", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agrName: varchar("agr_name", { length: 150 }).notNull(),
  applicationId: integer("application_id").notNull(),
  auth: varchar("auth", { length: 50 }),
  copied: varchar("copied", { length: 50 }),
  counter: integer("counter"),
  deleted: varchar("deleted", { length: 15 }),
  field: varchar("field", { length: 50 }),
  high: varchar("high", { length: 50 }),
  low: varchar("low", { length: 50 }),
  modified: varchar("modified", { length: 50 }),
  neu: varchar("neu", { length: 50 }),
  node: varchar("node", { length: 50 }),
  object: varchar("object", { length: 50 }),
  variant: varchar("variant", { length: 50 }),
}, (t) => [
  index("ix_agr1251_application_id").on(t.applicationId),
]);

export const agr1252 = sapSchema.table("agr1252", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agrName: varchar("agr_name", { length: 150 }).notNull(),
  applicationId: integer("application_id").notNull(),
  counter: integer("counter"),
  high: varchar("high", { length: 50 }),
  low: varchar("low", { length: 50 }),
  object: varchar("object", { length: 50 }),
  varbl: varchar("varbl", { length: 50 }),
}, (t) => [
  index("ix_agr1252_application_id").on(t.applicationId),
]);

export const agrAgr = sapSchema.table("agr_agrs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agrDefineId: integer("agr_define_id").notNull(),
  agrName: text("agr_name"),
  applicationId: integer("application_id").notNull(),
  attributes: text("attributes"),
  childAgr: text("child_agr"),
  childAgrDefineId: integer("child_agr_define_id").notNull(),
  mandt: text("mandt"),
}, (t) => [
  index("ix_agr_agrs_agr_define_id").on(t.agrDefineId),
  index("ix_agr_agrs_application_id").on(t.applicationId),
]);

export const agrBuffi = sapSchema.table("agr_buffi", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agrDefineId: integer("agr_define_id"),
  agrName: varchar("agr_name", { length: 200 }),
  applicationId: integer("application_id").notNull(),
  linkType: varchar("link_type", { length: 200 }),
  objectId: varchar("object_id", { length: 200 }),
  url: text("url"),
}, (t) => [
  index("ix_agr_buffi_agr_define_id").on(t.agrDefineId),
  index("ix_agr_buffi_application_id").on(t.applicationId),
]);

export const agrDefine = sapSchema.table("agr_define", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agrName: varchar("agr_name", { length: 100 }),
  applicationId: integer("application_id"),
  attributes: varchar("attributes", { length: 100 }),
  changeDat: varchar("change_dat", { length: 100 }),
  changeTim: varchar("change_tim", { length: 100 }),
  changeTmp: varchar("change_tmp", { length: 100 }),
  changeUsr: varchar("change_usr", { length: 100 }),
  createDat: varchar("create_dat", { length: 100 }),
  createTim: varchar("create_tim", { length: 100 }),
  createTmp: varchar("create_tmp", { length: 100 }),
  createUsr: varchar("create_usr", { length: 100 }),
  mandt: varchar("mandt", { length: 50 }),
  parentAgr: varchar("parent_agr", { length: 100 }),
});

export const agrUser = sapSchema.table("agr_users", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agr1016Id: integer("agr1016_id"),
  agrDefineId: integer("agr_define_id").notNull(),
  agrName: varchar("agr_name", { length: 30 }),
  applicationId: integer("application_id").notNull(),
  businessUserId: integer("business_user_id"),
  changeDat: varchar("change_dat", { length: 30 }),
  changeTim: text("change_tim"),
  changeTst: text("change_tst"),
  colFlag: varchar("col_flag", { length: 1 }),
  exclude: varchar("exclude", { length: 1 }),
  fromDat: varchar("from_dat", { length: 30 }),
  mandt: varchar("mandt", { length: 50 }),
  orgFlag: varchar("org_flag", { length: 1 }),
  toDat: varchar("to_dat", { length: 30 }),
  uname: varchar("uname", { length: 12 }),
}, (t) => [
  index("ix_agr_users_agr1016_id").on(t.agr1016Id),
  index("ix_agr_users_agr_define_id").on(t.agrDefineId),
  index("ix_agr_users_application_id").on(t.applicationId),
  index("ix_agr_users_business_user_id").on(t.businessUserId),
]);

export const fioriAnalysisItem = sapSchema.table("fiori_analysis_item", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  additionalBusinessRoleDescription: text("additional_business_role_description"),
  additionalBusinessRoleName: text("additional_business_role_name"),
  additionalOdataServices: text("additional_odata_services"),
  additionalOdataServicesVersions: text("additional_odata_services_versions"),
  appLauncherTitleSubtitle: text("app_launcher_title_subtitle"),
  appName: text("app_name"),
  applicationComponent: text("application_component"),
  applicationId: integer("application_id"),
  applicationType: text("application_type"),
  backendMinSp: text("backend_min_sp"),
  backendProductVersionStack: text("backend_product_version_stack"),
  backendSoftwareComponentVersions: text("backend_software_component_versions"),
  bexQueryName: text("bex_query_name"),
  bspapplicationUrl: text("bspapplication_url"),
  bspname: text("bspname"),
  businessCatalogDescription: text("business_catalog_description"),
  businessCatalogName: text("business_catalog_name"),
  businessGroupDescription: text("business_group_description"),
  businessGroupName: text("business_group_name"),
  database: text("database"),
  deviceTypes: text("device_types"),
  extensibilityViaSapui5Adaptation: text("extensibility_via_sapui5_adaptation"),
  fioriId: text("fiori_id"),
  frontendMinSp: text("frontend_min_sp"),
  frontendProductVersion: text("frontend_product_version"),
  frontendProductVersionStack: text("frontend_product_version_stack"),
  frontendSoftwareComponent: text("frontend_software_component"),
  gtmappDescription: text("gtmapp_description"),
  hanaminSp: text("hanamin_sp"),
  hanaproductVersion: text("hanaproduct_version"),
  hanaproductVersionStack: text("hanaproduct_version_stack"),
  hanasoftwareComponentVersions: text("hanasoftware_component_versions"),
  industry: text("industry"),
  leadingBusinessRoleDescription: text("leading_business_role_description"),
  leadingBusinessRoleName: text("leading_business_role_name"),
  leadingTransactionCodes: text("leading_transaction_codes"),
  lighthouse: text("lighthouse"),
  lineOfBusiness: text("line_of_business"),
  link: text("link"),
  lowValue: varchar("low_value", { length: 100 }),
  noteCollection: text("note_collection"),
  odataV4ServiceGroup: text("odata_v4_service_group"),
  page: text("page"),
  pageTitle: text("page_title"),
  primaryOdataServiceName: text("primary_odata_service_name"),
  primaryOdataServiceVersion: text("primary_odata_service_version"),
  productCategory: text("product_category"),
  productVersionNameBackend: text("product_version_name_backend"),
  roleName: text("role_name"),
  sapui5ComponentId: text("sapui5_component_id"),
  scopeItem: text("scope_item"),
  semanticObjectAction: text("semantic_object_action"),
  space: text("space"),
  spaceTitle: text("space_title"),
  technicalCatalogDescription: text("technical_catalog_description"),
  technicalCatalogName: text("technical_catalog_name"),
  technicalRole: varchar("technical_role", { length: 100 }),
  uitechnology: text("uitechnology"),
  wdaconfiguration: text("wdaconfiguration"),
}, (t) => [
  index("ix_fiori_analysis_item_application_id").on(t.applicationId),
]);

export const fioriAnalysisItemStatus = sapSchema.table("fiori_analysis_item_status", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  jobId: varchar("job_id", { length: 50 }),
  status: varchar("status", { length: 50 }),
});

export const fioriList = sapSchema.table("fiori_list", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  additionalBusinessRoleDescription: text("additional_business_role_description"),
  additionalBusinessRoleName: text("additional_business_role_name"),
  additionalOdataServices: text("additional_odata_services"),
  additionalOdataServicesVersions: text("additional_odata_services_versions"),
  appLauncherTitleSubtitle: text("app_launcher_title_subtitle"),
  appName: text("app_name"),
  applicationComponent: text("application_component"),
  applicationType: text("application_type"),
  backendMinSp: text("backend_min_sp"),
  backendProductVersionStack: text("backend_product_version_stack"),
  backendSoftwareComponentVersions: text("backend_software_component_versions"),
  bexQueryName: text("bex_query_name"),
  bspapplicationUrl: text("bspapplication_url"),
  bspname: text("bspname"),
  businessCatalogDescription: text("business_catalog_description"),
  businessCatalogName: text("business_catalog_name"),
  businessGroupDescription: text("business_group_description"),
  businessGroupName: text("business_group_name"),
  database: text("database"),
  deviceTypes: text("device_types"),
  extensibilityViaSapui5Adaptation: text("extensibility_via_sapui5_adaptation"),
  fioriId: text("fiori_id"),
  frontendMinSp: text("frontend_min_sp"),
  frontendProductVersion: text("frontend_product_version"),
  frontendProductVersionStack: text("frontend_product_version_stack"),
  frontendSoftwareComponent: text("frontend_software_component"),
  gtmappDescription: text("gtmapp_description"),
  hanaminSp: text("hanamin_sp"),
  hanaproductVersion: text("hanaproduct_version"),
  hanaproductVersionStack: text("hanaproduct_version_stack"),
  hanasoftwareComponentVersions: text("hanasoftware_component_versions"),
  industry: text("industry"),
  leadingBusinessRoleDescription: text("leading_business_role_description"),
  leadingBusinessRoleName: text("leading_business_role_name"),
  leadingTransactionCodes: text("leading_transaction_codes"),
  lighthouse: text("lighthouse"),
  lineOfBusiness: text("line_of_business"),
  link: text("link"),
  noteCollection: text("note_collection"),
  odataV4ServiceGroup: text("odata_v4_service_group"),
  page: text("page"),
  pageTitle: text("page_title"),
  primaryOdataServiceName: text("primary_odata_service_name"),
  primaryOdataServiceVersion: text("primary_odata_service_version"),
  productCategory: text("product_category"),
  productVersionNameBackend: text("product_version_name_backend"),
  roleName: text("role_name"),
  sapui5ComponentId: text("sapui5_component_id"),
  scopeItem: text("scope_item"),
  semanticObjectAction: text("semantic_object_action"),
  space: text("space"),
  spaceTitle: text("space_title"),
  technicalCatalogDescription: text("technical_catalog_description"),
  technicalCatalogName: text("technical_catalog_name"),
  uitechnology: text("uitechnology"),
  wdaconfiguration: text("wdaconfiguration"),
});

export const fioriMapping = sapSchema.table("fiori_mapping", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  field1: varchar("field1", { length: 100 }),
  field2: varchar("field2", { length: 100 }),
  isSplit: boolean("is_split").notNull(),
});

export const fioriReportFilter = sapSchema.table("fiori_report_filter", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id"),
  columns: text("columns"),
  jsonQuery: text("json_query"),
  name: varchar("name", { length: 100 }),
  sqlQuery: text("sql_query"),
});

export const fioriTypeValue = sapSchema.table("fiori_type_values", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agrBuffiId: integer("agr_buffi_id"),
  applicationId: integer("application_id").notNull(),
  applicationType: varchar("application_type", { length: 50 }),
  launchPadRole: varchar("launch_pad_role", { length: 500 }),
  semanticAction: varchar("semantic_action", { length: 500 }),
  semanticObject: varchar("semantic_object", { length: 500 }),
  transaction: varchar("transaction", { length: 500 }),
  ui5Component: varchar("ui5_component", { length: 500 }),
  url: text("url"),
  wdaapplication: varchar("wdaapplication", { length: 500 }),
  wdaconfiguration: varchar("wdaconfiguration", { length: 500 }),
}, (t) => [
  index("ix_fiori_type_values_agr_buffi_id").on(t.agrBuffiId),
  index("ix_fiori_type_values_application_id").on(t.applicationId),
]);

export const sapStatRec = sapSchema.table("sap_stat_recs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  account: text("account"),
  applicationId: integer("application_id").notNull(),
  dynpronr: text("dynpronr"),
  endDate: text("end_date"),
  endTime: text("end_time"),
  endTimeStamp: text("end_time_stamp"),
  report: text("report"),
  startDate: text("start_date"),
  startTime: text("start_time"),
  startTimeStamp: text("start_time_stamp"),
  tcode: text("tcode"),
  terminalId: text("terminal_id"),
}, (t) => [
  index("ix_sap_stat_recs_application_id").on(t.applicationId),
]);

export const sapTransactionUsage = sapSchema.table("sap_transaction_usage", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  account: text("account"),
  applicationId: integer("application_id").notNull(),
  dynp: text("dynp"),
  endDate: text("end_date"),
  endTime: text("end_time"),
  fcode: text("fcode"),
  report: text("report"),
  tcode: text("tcode"),
  terminalId: text("terminal_id"),
}, (t) => [
  index("ix_sap_transaction_usage_application_id").on(t.applicationId),
]);

export const sharedFioriReportFilter = sapSchema.table("shared_fiori_report_filter", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  businessUserId: integer("business_user_id").notNull(),
  fioriReportFilterId: integer("fiori_report_filter_id").notNull(),
}, (t) => [
  index("ix_shared_fiori_report_filter_business_user_id").on(t.businessUserId),
  index("ix_shared_fiori_report_filter_fiori_report_filter_id").on(t.fioriReportFilterId),
]);

export const transValue = sapSchema.table("trans_value", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  bis: varchar("bis", { length: 100 }),
  field: varchar("field", { length: 50 }),
  objct: varchar("objct", { length: 100 }),
  von: varchar("von", { length: 100 }),
}, (t) => [
  index("ix_trans_value_application_id").on(t.applicationId),
]);

export const trcomparisonReport = sapSchema.table("trcomparison_report", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  data: text("data").notNull(),
  roleAuthorizationRequestId: integer("role_authorization_request_id").notNull(),
});

export const trcomparisonRequest = sapSchema.table("trcomparison_request", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  criteria: text("criteria").notNull(),
  interval: varchar("interval", { length: 45 }),
  jobId: varchar("job_id", { length: 45 }),
  modifiedById: integer("modified_by_id"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  name: varchar("name", { length: 45 }).notNull(),
  status: varchar("status", { length: 45 }),
  type: varchar("type", { length: 45 }),
});

export const tstct = sapSchema.table("tstct", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  tcode: varchar("tcode", { length: 50 }),
  ttext: text("ttext"),
}, (t) => [
  index("ix_tstct_application_id").on(t.applicationId),
]);

export const ui2PbCchip = sapSchema.table("ui2_pb_cchip", {
  uid: integer("uid").primaryKey().generatedByDefaultAsIdentity(),
  agrBuffiId: integer("agr_buffi_id"),
  applicationId: integer("application_id").notNull(),
  baseChipId: varchar("base_chip_id", { length: 500 }),
  configuration: text("configuration"),
  displayTitleText: varchar("display_title_text", { length: 200 }),
  id: varchar("id", { length: 200 }),
  isChipM: boolean("is_chip_m"),
  navigationSemanticAction: varchar("navigation_semantic_action", { length: 500 }),
  navigationSemanticObject: varchar("navigation_semantic_object", { length: 500 }),
  navigationTargetUrl: text("navigation_target_url"),
  parentId: varchar("parent_id", { length: 500 }),
  referenceIdChipId: varchar("reference_id_chip_id", { length: 200 }),
  updated: varchar("updated", { length: 200 }),
}, (t) => [
  index("ix_ui2_pb_cchip_agr_buffi_id").on(t.agrBuffiId),
  index("ix_ui2_pb_cchip_application_id").on(t.applicationId),
]);

export const userAddr = sapSchema.table("user_addr", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  bname: varchar("bname", { length: 50 }),
  firstName: varchar("name_first", { length: 50 }),
  lastName: varchar("name_last", { length: 50 }),
}, (t) => [
  index("ix_user_addr_application_id").on(t.applicationId),
]);

export const usoBhash = sapSchema.table("uso_bhash", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  name: varchar("name", { length: 150 }),
  objName: varchar("obj_name", { length: 50 }),
  object: varchar("object", { length: 50 }),
  pgmid: varchar("pgmid", { length: 50 }),
  service: varchar("service", { length: 150 }),
  serviceType: varchar("service_type", { length: 50 }),
  transValueId: integer("trans_value_id").notNull(),
  type: varchar("type", { length: 50 }),
}, (t) => [
  index("ix_uso_bhash_trans_value_id").on(t.transValueId),
]);

export const usr02 = sapSchema.table("usr02", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  aname: varchar("aname", { length: 50 }),
  applicationId: integer("application_id").notNull(),
  bname: varchar("bname", { length: 50 }),
  class: varchar("class", { length: 50 }),
  erdat: timestamp("erdat", { withTimezone: false, mode: "date" }),
  gltgb: timestamp("gltgb", { withTimezone: false, mode: "date" }),
  gltgv: timestamp("gltgv", { withTimezone: false, mode: "date" }),
  locnt: varchar("locnt", { length: 50 }),
  ltime: varchar("ltime", { length: 50 }),
  trdat: timestamp("trdat", { withTimezone: false, mode: "date" }),
  uflag: varchar("uflag", { length: 50 }),
  ustyp: varchar("ustyp", { length: 50 }),
}, (t) => [
  index("ix_usr02_application_id").on(t.applicationId),
]);

export const usr06 = sapSchema.table("usr06", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  bname: varchar("bname", { length: 50 }),
  licType: varchar("lic_type", { length: 50 }),
}, (t) => [
  index("ix_usr06_application_id").on(t.applicationId),
]);

export const ust04UserProfile = sapSchema.table("ust04_user_profile", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  bname: varchar("bname", { length: 50 }),
  businessUserId: integer("business_user_id").notNull(),
  isSingleProfile: boolean("is_single_profile").notNull(),
  profile: varchar("profile", { length: 50 }),
}, (t) => [
  index("ix_ust04_user_profile_application_id").on(t.applicationId),
  index("ix_ust04_user_profile_business_user_id").on(t.businessUserId),
]);

export const ust10CCompositeProfile = sapSchema.table("ust10_c_composite_profile", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  aktps: varchar("aktps", { length: 1 }).notNull(),
  applicationId: integer("application_id").notNull(),
  isIterative: boolean("is_iterative").notNull(),
  profn: varchar("profn", { length: 12 }),
  subProf: varchar("sub_prof", { length: 12 }),
  ust10SprofnId: integer("ust10_sprofn_id").notNull(),
}, (t) => [
  index("ix_ust10_c_composite_profile_application_id").on(t.applicationId),
]);

export const ust10SSingleProfile = sapSchema.table("ust10_s_single_profile", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  aktps: varchar("aktps", { length: 1 }).notNull(),
  applicationId: integer("application_id").notNull(),
  auth: varchar("auth", { length: 100 }),
  modifiedBy: integer("modified_by"),
  modifiedOn: timestamp("modified_on", { withTimezone: false, mode: "date" }),
  objct: varchar("objct", { length: 100 }),
  profn: varchar("profn", { length: 100 }),
  profnId: integer("profn_id").notNull(),
}, (t) => [
  index("ix_ust10_s_single_profile_application_id").on(t.applicationId),
]);

export const ust12TranValue = sapSchema.table("ust12_tran_value", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  aktps: varchar("aktps", { length: 1 }).notNull(),
  applicationId: integer("application_id").notNull(),
  auth: varchar("auth", { length: 100 }),
  bis: varchar("bis", { length: 40 }),
  field: varchar("field", { length: 100 }),
  objct: varchar("objct", { length: 100 }),
  von: varchar("von", { length: 100 }),
}, (t) => [
  index("ix_ust12_tran_value_application_id").on(t.applicationId),
]);

export const ustTstc = sapSchema.table("ust_tstc", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  tcode: varchar("tcode", { length: 200 }),
  transValueId: integer("trans_value_id").notNull(),
  type: varchar("type", { length: 100 }),
}, (t) => [
  index("ix_ust_tstc_trans_value_id").on(t.transValueId),
]);

export const wdyApplicationt = sapSchema.table("wdy_applicationt", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationName: varchar("application_name", { length: 50 }),
  description: text("description"),
  langu: varchar("langu", { length: 50 }),
  transValueId: integer("trans_value_id").notNull(),
}, (t) => [
  index("ix_wdy_applicationt_trans_value_id").on(t.transValueId),
]);
