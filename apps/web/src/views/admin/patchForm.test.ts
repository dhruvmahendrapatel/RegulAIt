import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { draftFromRecord, patchBody, type PatchDraft } from "./patchForm";
import {
  EXTERNAL_SCORER_FIELDS,
  INITIATIVE_FIELDS,
  PASSKEY_FIELDS,
  REPORT_CADENCES,
  RESOLUTION_MODES,
  SCOPE_RULE_FIELDS,
  SCORER_KINDS,
  VENDOR_CATEGORIES,
  reportScheduleFields,
  vendorEditBlocked,
  vendorFields,
} from "./editForms";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sharedFile = (rel: string) => new URL(`../../../../../packages/shared/src/${rel}`, import.meta.url).pathname;
const edit = (d: PatchDraft, patch: Partial<{ text: Record<string, string>; set: Record<string, string[]>; clear: Record<string, boolean> }>): PatchDraft => ({
  text: { ...d.text, ...patch.text },
  set: { ...d.set, ...patch.set },
  clear: { ...d.clear, ...patch.clear },
});

describe("only edited fields are sent", () => {
  const initiative = { id: "i1", name: "Platform", costCenter: "CC-1" };
  it("an untouched record has nothing to send", () => {
    expect(patchBody(INITIATIVE_FIELDS, initiative, draftFromRecord(INITIATIVE_FIELDS, initiative))).toEqual({ ok: false, problem: "Nothing has changed." });
  });
  it("one edited field is the whole body; an emptied nullable field sends null", () => {
    const d = draftFromRecord(INITIATIVE_FIELDS, initiative);
    expect(patchBody(INITIATIVE_FIELDS, initiative, edit(d, { text: { name: "Platform 2" } }))).toEqual({ ok: true, body: { name: "Platform 2" } });
    expect(patchBody(INITIATIVE_FIELDS, initiative, edit(d, { text: { costCenter: "  " } }))).toEqual({ ok: true, body: { costCenter: null } });
  });
  it("a required field cannot be emptied, and lengths are the schema's", () => {
    const d = draftFromRecord(INITIATIVE_FIELDS, initiative);
    expect(patchBody(INITIATIVE_FIELDS, initiative, edit(d, { text: { name: "" } })).ok).toBe(false);
    expect(patchBody(INITIATIVE_FIELDS, initiative, edit(d, { text: { name: "x".repeat(201) } })).ok).toBe(false);
    expect(patchBody(PASSKEY_FIELDS, { label: "Laptop" }, { text: { label: "x".repeat(101) }, set: {}, clear: {} }).ok).toBe(false);
  });
});

describe("scope rules: tri-state and nullable enums", () => {
  const rule = { id: "r", anthropicCompatEnabled: null, openaiCompatEnabled: true, resolutionMode: "map_by_model", note: null };
  it("inherit is null; a changed value is the boolean or the mode", () => {
    const d = draftFromRecord(SCOPE_RULE_FIELDS, rule);
    expect(d.text.anthropicCompatEnabled).toBe("");
    expect(patchBody(SCOPE_RULE_FIELDS, rule, edit(d, { text: { anthropicCompatEnabled: "false" } }))).toEqual({ ok: true, body: { anthropicCompatEnabled: false } });
    expect(patchBody(SCOPE_RULE_FIELDS, rule, edit(d, { text: { openaiCompatEnabled: "" } }))).toEqual({ ok: true, body: { openaiCompatEnabled: null } });
    expect(patchBody(SCOPE_RULE_FIELDS, rule, edit(d, { text: { resolutionMode: "" } }))).toEqual({ ok: true, body: { resolutionMode: null } });
  });
  it("the resolution modes are the shared ones", () => {
    const src = readFileSync(sharedFile("index.ts"), "utf8");
    const m = /export const resolutionModeSchema = z\.enum\(\[(.+)\]\);/.exec(src);
    expect(m?.[1]?.split(",").map((x) => x.trim().replace(/"/g, ""))).toEqual(RESOLUTION_MODES.map((r) => r.value).filter(Boolean));
  });
});

describe("report schedules", () => {
  const fields = reportScheduleFields([{ value: "u1", label: "a@x" }, { value: "u2", label: "b@x" }]);
  const schedule = { id: "s", cadence: "monthly", enabled: true, recipientUserIds: null };
  it("an empty recipient list stays null; picking one sends the list; order does not count as a change", () => {
    const d = draftFromRecord(fields, schedule);
    expect(patchBody(fields, schedule, edit(d, { set: { recipientUserIds: ["u2"] } }))).toEqual({ ok: true, body: { recipientUserIds: ["u2"] } });
    const withTwo = { ...schedule, recipientUserIds: ["u2", "u1"] };
    expect(patchBody(fields, withTwo, draftFromRecord(fields, withTwo)).ok).toBe(false);
    expect(patchBody(fields, withTwo, edit(draftFromRecord(fields, withTwo), { set: { recipientUserIds: [] } }))).toEqual({ ok: true, body: { recipientUserIds: null } });
    expect(patchBody(fields, schedule, edit(d, { text: { enabled: "false", cadence: "weekly" } }))).toEqual({ ok: true, body: { cadence: "weekly", enabled: false } });
  });
  it("stored recipients the options do not list are never dropped: editing only the cadence sends only the cadence", () => {
    const stored = { ...schedule, recipientUserIds: ["u1", "u9"] };
    const empty = reportScheduleFields([]);
    expect(patchBody(empty, stored, edit(draftFromRecord(empty, stored), { text: { cadence: "weekly" } }))).toEqual({ ok: true, body: { cadence: "weekly" } });
    // picking another known user keeps the unlisted stored one
    expect(patchBody(fields, stored, edit(draftFromRecord(fields, stored), { set: { recipientUserIds: ["u1", "u9", "u2"] } }))).toEqual({
      ok: true,
      body: { recipientUserIds: ["u1", "u2", "u9"] },
    });
  });
  it("while the options are loading, nothing can be saved", () => {
    const loading = reportScheduleFields([], true);
    const r = patchBody(loading, schedule, edit(draftFromRecord(loading, schedule), { text: { cadence: "weekly" } }));
    expect(r.ok).toBe(false);
  });
  it("the cadences are the shared ones", async () => {
    const s: any = await import(/* @vite-ignore */ sharedFile("reporting.ts"));
    expect(REPORT_CADENCES.map((c) => c.value)).toEqual([...s.REPORT_CADENCES]);
  });
});

describe("external scorers", () => {
  const scorer = { id: "x", name: "fid", baseUrl: "https://s.example/score", scorerKinds: ["groundedness_judge"], allowPlaintextHttp: false };
  it("a blank key keeps the stored one; the clear box sends null; a typed key is sent", () => {
    const d = draftFromRecord(EXTERNAL_SCORER_FIELDS, scorer);
    expect(patchBody(EXTERNAL_SCORER_FIELDS, scorer, d).ok).toBe(false);
    expect(patchBody(EXTERNAL_SCORER_FIELDS, scorer, edit(d, { clear: { apiKey: true } }))).toEqual({ ok: true, body: { apiKey: null } });
    expect(patchBody(EXTERNAL_SCORER_FIELDS, scorer, edit(d, { text: { apiKey: "sk-1" } }))).toEqual({ ok: true, body: { apiKey: "sk-1" } });
  });
  it("at least one claimed kind; the kinds are the shared judge-backed ones", async () => {
    const d = draftFromRecord(EXTERNAL_SCORER_FIELDS, scorer);
    expect(patchBody(EXTERNAL_SCORER_FIELDS, scorer, edit(d, { set: { scorerKinds: [] } })).ok).toBe(false);
    const s: any = await import(/* @vite-ignore */ sharedFile("external-scorer.ts"));
    expect(SCORER_KINDS.map((k) => k.value).sort()).toEqual([...s.externalScorerKindSchema.options].sort());
  });
});

describe("vendors", () => {
  const vendor = { id: "v", name: "Acme", status: "proposed", description: "d", category: "integration", linkedCustomProviderIds: [], linkedAgentProviders: ["openai"] };
  const fields = vendorFields([{ value: "p1", label: "Local LLM" }]);
  it("the provider list is trimmed and de-duplicated; unchanged lists are not sent", () => {
    const d = draftFromRecord(fields, vendor);
    expect(d.text.linkedAgentProviders).toBe("openai");
    expect(patchBody(fields, vendor, edit(d, { text: { linkedAgentProviders: " openai, anthropic ,openai" } }))).toEqual({ ok: true, body: { linkedAgentProviders: ["openai", "anthropic"] } });
    expect(patchBody(fields, vendor, edit(d, { set: { linkedCustomProviderIds: ["p1"] } }))).toEqual({ ok: true, body: { linkedCustomProviderIds: ["p1"] } });
  });
  it("linked providers missing from an empty option list are kept, and not sent unless changed", () => {
    const linked = { ...vendor, linkedCustomProviderIds: ["p7"] };
    const none = vendorFields([]);
    expect(patchBody(none, linked, edit(draftFromRecord(none, linked), { text: { category: "data_processor" } }))).toEqual({ ok: true, body: { category: "data_processor" } });
    expect(patchBody(vendorFields([], true), linked, edit(draftFromRecord(none, linked), { text: { category: "data_processor" } })).ok).toBe(false);
  });
  it("only an in-flight vendor is editable; the categories are the shared ones", async () => {
    expect(vendorEditBlocked("proposed")).toBeNull();
    expect(vendorEditBlocked("under_assessment")).toBeNull();
    expect(vendorEditBlocked("approved")).toContain("decided record");
    const s: any = await import(/* @vite-ignore */ sharedFile("vendors.ts"));
    expect(VENDOR_CATEGORIES.map((c) => c.value)).toEqual([...s.AI_VENDOR_CATEGORIES]);
  });
});
