// GENERATED from the regulAIt Authorized EF Core DataContext.
// Regenerate with scripts/gen-authorized-schema.py; do not hand-edit.
// Postgres schema: eam

import { boolean, index, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const eamSchema = pgSchema("eam");

export const eamBusinessProcess = eamSchema.table("eam_business_process", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  businessProcess: varchar("business_process", { length: 200 }).notNull(),
  fireFighter: varchar("fire_fighter", { length: 300 }).notNull(),
  functionalArea: varchar("functional_area", { length: 200 }).notNull(),
}, (t) => [
  index("ix_eam_business_process_application_id").on(t.applicationId),
]);

export const fireFighter = eamSchema.table("fire_fighter", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id"),
  bname: varchar("bname", { length: 300 }),
}, (t) => [
  index("ix_fire_fighter_application_id").on(t.applicationId),
]);

export const fireFighterAssigned = eamSchema.table("fire_fighter_assigned", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  applicationId: integer("application_id").notNull(),
  businessUserId: integer("business_user_id").notNull(),
  createdById: integer("created_by_id").notNull(),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  endDate: timestamp("end_date", { withTimezone: false, mode: "date" }),
  fireFighterId: varchar("fire_fighter_id", { length: 200 }).notNull(),
  requestDetailId: integer("request_detail_id").notNull(),
  startDate: timestamp("start_date", { withTimezone: false, mode: "date" }),
  statusId: integer("status_id").notNull(),
}, (t) => [
  index("ix_fire_fighter_assigned_application_id").on(t.applicationId),
  index("ix_fire_fighter_assigned_business_user_id").on(t.businessUserId),
  index("ix_fire_fighter_assigned_request_detail_id").on(t.requestDetailId),
]);

export const fireFighterOwner = eamSchema.table("fire_fighter_owner", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  businessProcessId: integer("business_process_id").notNull(),
  controllerId: integer("controller_id"),
  ownerId: integer("owner_id"),
});

export const fireFighterSession = eamSchema.table("fire_fighter_session", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  actions: text("actions"),
  additionalActivity: text("additional_activity"),
  closedOn: timestamp("closed_on", { withTimezone: false, mode: "date" }),
  createdOn: timestamp("created_on", { withTimezone: false, mode: "date" }),
  duration: text("duration").notNull(),
  fireFighterAssignedId: integer("fire_fighter_assigned_id").notNull(),
  isLogged: boolean("is_logged").notNull(),
  language: varchar("language", { length: 20 }),
  reasonCodes: integer("reason_codes"),
  sessionKey: text("session_key"),
}, (t) => [
  index("ix_fire_fighter_session_fire_fighter_assigned_id").on(t.fireFighterAssignedId),
]);

export const fireFighterSessionLog = eamSchema.table("fire_fighter_session_logs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  account: varchar("account", { length: 450 }),
  application: varchar("application", { length: 450 }),
  compText: varchar("comp_text", { length: 450 }),
  component: varchar("component", { length: 450 }),
  cuaFunc: varchar("cua_func", { length: 450 }),
  cuaProg: varchar("cua_prog", { length: 450 }),
  devClass: varchar("dev_class", { length: 450 }),
  devText: varchar("dev_text", { length: 450 }),
  dynpronr: varchar("dynpronr", { length: 450 }),
  endDate: varchar("end_date", { length: 450 }),
  endTime: varchar("end_time", { length: 450 }),
  endTimeStamp: varchar("end_time_stamp", { length: 450 }),
  entryId: varchar("entry_id", { length: 450 }),
  fireFighterSessionId: integer("fire_fighter_session_id").notNull(),
  mandt: varchar("mandt", { length: 450 }),
  report: varchar("report", { length: 450 }),
  startDate: varchar("start_date", { length: 450 }),
  startTime: varchar("start_time", { length: 450 }),
  startTimeStamp: text("start_time_stamp"),
  subApplication: varchar("sub_application", { length: 450 }),
  tcode: varchar("tcode", { length: 450 }),
  terminalId: varchar("terminal_id", { length: 450 }),
});
