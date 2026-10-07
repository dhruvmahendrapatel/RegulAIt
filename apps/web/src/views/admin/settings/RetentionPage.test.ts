/**
 * PR #181 review (P2): PUT /v1/org/settings is a partial update. The retention
 * form sends only the fields this admin edited, so it cannot revert another
 * admin's concurrent change to the field it left alone.
 */
import { describe, expect, it } from "vitest";
import { retentionChanges } from "./RetentionPage";

const loaded = { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 30 };

describe("retentionChanges", () => {
  it("sends only the edited field", () => {
    expect(retentionChanges(loaded, "3600", "31", loaded)).toEqual({ body: { conversationRetentionDays: 31 }, extends: true });
    expect(retentionChanges(loaded, "1800", "30", loaded)).toEqual({ body: { semanticCacheTtlSeconds: 1800 }, extends: false });
  });

  it("sends both when both were edited and nothing when nothing was", () => {
    expect(retentionChanges(loaded, "7200", "7", loaded)).toEqual({ body: { semanticCacheTtlSeconds: 7200, conversationRetentionDays: 7 }, extends: true });
    expect(retentionChanges(loaded, "3600", "30", loaded)).toEqual({ body: {}, extends: false });
  });

  it("still refuses an invalid value", () => {
    expect(retentionChanges(loaded, "3600", "0", loaded)).toHaveProperty("error");
    expect(retentionChanges(loaded, "1.5", "30", loaded)).toHaveProperty("error");
  });

  it("classifies a relaxation against the value stored now, not the loaded snapshot (PR #181 review)", () => {
    // loaded 90; another admin set 30; this admin enters 60 → raises 30→60
    const stale = { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 90 };
    const now = { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 30 };
    expect(retentionChanges(stale, "3600", "60", now)).toEqual({ body: { conversationRetentionDays: 60 }, extends: true });
    // and the reverse: a value that tightens what is stored now needs no confirmation
    expect(retentionChanges(now, "3600", "60", stale)).toEqual({ body: { conversationRetentionDays: 60 }, extends: false });
  });

  it("asks for confirmation when the current values could not be read", () => {
    expect(retentionChanges(loaded, "1800", "30", null)).toEqual({ body: { semanticCacheTtlSeconds: 1800 }, extends: true });
  });

  it("compares the parsed number, not the text: \"030\" is the stored 30 (PR #181 review round 4)", () => {
    expect(retentionChanges(loaded, "3600", "030", loaded)).toEqual({ body: {}, extends: false });
    expect(retentionChanges(loaded, "03600", "30", loaded)).toEqual({ body: {}, extends: false });
    expect(retentionChanges(loaded, "3600", "031", loaded)).toEqual({ body: { conversationRetentionDays: 31 }, extends: true });
  });
});
