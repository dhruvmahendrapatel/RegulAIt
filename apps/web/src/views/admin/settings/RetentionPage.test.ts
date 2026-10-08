/**
 * PR #181 review (P2): PUT /v1/org/settings is a partial update. The retention
 * form sends only the fields this admin edited, so it cannot revert another
 * admin's concurrent change to the field it left alone.
 */
import { describe, expect, it } from "vitest";
import { retentionChanges, retentionRelaxed } from "./RetentionPage";
import { reconfirmNeeded } from "../adminKit";

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

  it("accepts the whole-number spellings a number input accepts: \"30.0\" and \"3e1\" are 30 (PR #181 review, comment 4212952370)", () => {
    // the same number as stored is unchanged, not a validation error
    expect(retentionChanges(loaded, "3600", "30.0", loaded)).toEqual({ body: {}, extends: false });
    expect(retentionChanges(loaded, "3.6e3", "3e1", loaded)).toEqual({ body: {}, extends: false });
    // a different whole number in either spelling is sent as that integer
    expect(retentionChanges(loaded, "3600", "31.0", loaded)).toEqual({ body: { conversationRetentionDays: 31 }, extends: true });
    expect(retentionChanges(loaded, "1.8e3", "30", loaded)).toEqual({ body: { semanticCacheTtlSeconds: 1800 }, extends: false });
  });

  it("still refuses non-integers, empty, out-of-bounds and text a number input never produces", () => {
    for (const days of ["30.5", "3.05e1", "", "0", "0.0", "2556", "2.556e3", "-1", "0x1e", " 30", "Infinity", "NaN", "1e400"]) {
      expect(retentionChanges(loaded, "3600", days, loaded), JSON.stringify(days)).toHaveProperty("error");
    }
    for (const ttl of ["3600.5", "", "2592001", "2.592001e6"]) {
      expect(retentionChanges(loaded, ttl, "30", loaded), JSON.stringify(ttl)).toHaveProperty("error");
    }
    // the upper bounds themselves are allowed in any spelling
    expect(retentionChanges(loaded, "2.592e6", "2555.0", loaded)).toEqual({ body: { semanticCacheTtlSeconds: 2592000, conversationRetentionDays: 2555 }, extends: true });
  });

  it("drops a field whose value already equals what is stored now (PR #181 review round 5)", () => {
    const now = { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 20 };
    expect(retentionChanges(loaded, "3600", "20", now)).toEqual({ body: {}, extends: false });
    expect(retentionChanges(loaded, "7200", "20", now)).toEqual({ body: { semanticCacheTtlSeconds: 7200 }, extends: true });
  });

  it("asks again only when the confirmed change now relaxes something the dialog did not show", () => {
    const shown = retentionRelaxed({ conversationRetentionDays: 31 }, loaded);
    expect(shown).toEqual(["conversationRetentionDays:31"]);
    // same relaxation after the re-read: send without asking again
    expect(reconfirmNeeded(shown, { adds: true, added: retentionRelaxed({ conversationRetentionDays: 31 }, { conversationRetentionDays: 25 }) })).toBe(false);
    // the cache lifetime now relaxes too (another admin lowered it meanwhile): ask again
    expect(reconfirmNeeded(shown, { adds: true, added: retentionRelaxed({ semanticCacheTtlSeconds: 3600, conversationRetentionDays: 31 }, { semanticCacheTtlSeconds: 60, conversationRetentionDays: 30 }) })).toBe(true);
  });
});
