import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import {
  COMMUNITY_BLOCKED,
  actionsSummary,
  catalogueReducer,
  cleanQuery,
  curatedAction,
  initialCatalogueState,
  normaliseCatalogue,
  readStateOf,
  reasonProblem,
  statusLabel,
  type CatalogueEvent,
  type CatalogueState,
  type CuratedPiece,
  type FlowTarget,
} from "./connectorCatalogueModel";

const SHEETS: FlowTarget = { key: "google-sheets", displayName: "Google Sheets", intent: "enable" };
const run = (events: CatalogueEvent[], from: CatalogueState = initialCatalogueState) => events.reduce(catalogueReducer, from);
const stepUpRefused = new ApiError(403, { error: "step_up_required", actionKind: "settings_relax", methods: ["totp"], action: { kind: "settings_relax", body: {} } });

const piece = (over: Partial<CuratedPiece> = {}): CuratedPiece => ({
  key: "google-sheets",
  providerKind: "piece_google_sheets",
  displayName: "Google Sheets",
  upstream: { npm: "@activepieces/piece-google-sheets", version: "0.1.0", path: "packages/pieces/community/google-sheets" },
  status: "not_enabled",
  enabledAt: null,
  enabledByUserId: null,
  actions: [
    { name: "read_rows", displayName: "Read rows", operation: "read" },
    { name: "append_row", displayName: "Append row", operation: "write" },
  ],
  ...over,
});

describe("catalogueReducer: search and paging", () => {
  it("filters by the trimmed input only once typing settles, and a new search starts at the first page", () => {
    let s = run([{ type: "page", offset: 100 }, { type: "typed", input: "  sheets " }]);
    expect(s).toMatchObject({ input: "  sheets ", q: "", offset: 100 });
    s = catalogueReducer(s, { type: "searchSettled" });
    expect(s).toMatchObject({ q: "sheets", offset: 0 });
    // the same search settling again keeps the page the reader moved to
    s = run([{ type: "page", offset: 50 }, { type: "searchSettled" }], s);
    expect(s.offset).toBe(50);
  });

  it("bounds the query to what the server accepts and never pages before the start", () => {
    expect(cleanQuery("x".repeat(200))).toHaveLength(80);
    expect(catalogueReducer(initialCatalogueState, { type: "page", offset: -50 }).offset).toBe(0);
  });
});

describe("catalogueReducer: the enable/disable flow", () => {
  it("idle -> confirming -> (reason required) -> submitting -> stepping up -> done", () => {
    let s = run([{ type: "open", target: SHEETS }]);
    expect(s.flow).toEqual({ phase: "confirming", target: SHEETS, reason: "", touched: false });
    // an empty or too-short reason is not sent: the flow stays and says why
    s = catalogueReducer(s, { type: "submit" });
    expect(s.flow).toMatchObject({ phase: "confirming", touched: true });
    s = run([{ type: "reasonEdited", reason: "ok" }, { type: "submit" }], s);
    expect(s.flow.phase).toBe("confirming");
    s = run([{ type: "reasonEdited", reason: "  Finance needs the sheets sync  " }, { type: "submit" }], s);
    expect(s.flow).toEqual({ phase: "submitting", target: SHEETS, reason: "Finance needs the sheets sync" });
    s = catalogueReducer(s, { type: "stepUpRequested" });
    expect(s.flow.phase).toBe("steppingUp");
    s = catalogueReducer(s, { type: "succeeded" });
    expect(s.flow).toEqual({ phase: "done", target: SHEETS, message: "Google Sheets enabled" });
    expect(catalogueReducer(s, { type: "dismiss" }).flow).toEqual({ phase: "idle" });
  });

  it("a declined step-up is its own state; trying again returns to the confirmation with the reason kept", () => {
    let s = run([{ type: "open", target: SHEETS }, { type: "reasonEdited", reason: "Needed for reporting" }, { type: "submit" }, { type: "stepUpRequested" }]);
    s = catalogueReducer(s, { type: "failed", error: stepUpRefused });
    expect(s.flow).toEqual({ phase: "stepUpDeclined", target: SHEETS, reason: "Needed for reporting" });
    s = catalogueReducer(s, { type: "submit" });
    expect(s.flow).toEqual({ phase: "confirming", target: SHEETS, reason: "Needed for reporting", touched: true });
  });

  it("a refusal names what happened in words, keeps its code, and nothing is resent on its own", () => {
    const s = run([
      { type: "open", target: SHEETS },
      { type: "reasonEdited", reason: "Needed for reporting" },
      { type: "submit" },
      { type: "failed", error: new ApiError(409, { error: "piece_air_gapped", detail: "x" }) },
    ]);
    expect(s.flow).toMatchObject({ phase: "failed", code: "piece_air_gapped", reason: "Needed for reporting" });
    expect((s.flow as { error: string }).error).toContain("air-gapped");
    const generic = run([{ type: "open", target: SHEETS }, { type: "reasonEdited", reason: "abc" }, { type: "submit" }, { type: "failed", error: new Error("network down") }]);
    expect(generic.flow).toMatchObject({ phase: "failed", code: null, error: "network down" });
  });

  it("one change at a time: while one is in flight, nothing opens, cancels or replaces it", () => {
    const busy = run([{ type: "open", target: SHEETS }, { type: "reasonEdited", reason: "abc" }, { type: "submit" }]);
    expect(catalogueReducer(busy, { type: "open", target: { ...SHEETS, key: "slack" } })).toBe(busy);
    expect(catalogueReducer(busy, { type: "cancel" })).toBe(busy);
    expect(catalogueReducer(busy, { type: "dismiss" })).toBe(busy);
    // an outcome outside a submission is ignored
    expect(catalogueReducer(initialCatalogueState, { type: "succeeded" })).toBe(initialCatalogueState);
    expect(catalogueReducer(initialCatalogueState, { type: "stepUpRequested" })).toBe(initialCatalogueState);
  });

  it("says why a reason cannot be sent", () => {
    expect(reasonProblem("")).toMatch(/Give a reason/);
    expect(reasonProblem(" ab ")).toMatch(/at least 3/);
    expect(reasonProblem("x".repeat(501))).toMatch(/500/);
    expect(reasonProblem("abc")).toBeNull();
  });
});

describe("why an action is unavailable", () => {
  const idle = { phase: "idle" } as const;
  it("names the action from the status, and every reason it is blocked", () => {
    expect(curatedAction(piece(), { isAdmin: true, runnable: true, flow: idle })).toEqual({ intent: "enable", label: "Enable", blocked: null });
    expect(curatedAction(piece({ status: "enabled" }), { isAdmin: true, runnable: false, flow: idle })).toEqual({ intent: "disable", label: "Disable", blocked: null });
    expect(curatedAction(piece(), { isAdmin: false, runnable: true, flow: idle }).blocked).toMatch(/administrator/);
    expect(curatedAction(piece(), { isAdmin: true, runnable: false, flow: idle }).blocked).toMatch(/air-gapped/);
    const busy = { phase: "submitting", target: SHEETS, reason: "abc" } as const;
    expect(curatedAction(piece(), { isAdmin: true, runnable: true, flow: busy }).blocked).toMatch(/being saved/);
    expect(COMMUNITY_BLOCKED).toMatch(/No governed adapter/);
  });

  it("labels statuses and actions in words", () => {
    expect(statusLabel("not_enabled")).toBe("Not enabled");
    expect(statusLabel("available_not_enabled")).toBe("Available, not enabled");
    expect(actionsSummary(piece().actions)).toBe("2 actions: 1 read, 1 write");
    expect(actionsSummary([{ name: "a", displayName: "A", operation: "read" }])).toBe("1 action: 1 read, 0 write");
  });
});

describe("the read's state", () => {
  it("is loading, then an error (never an empty list), then the rows with why the community list is empty", () => {
    expect(readStateOf({ isLoading: true, error: null }, "")).toEqual({ kind: "loading" });
    const err = new Error("boom");
    expect(readStateOf({ isLoading: false, error: err }, "")).toEqual({ kind: "error", error: err });
    const data = normaliseCatalogue({ curated: [], available: { total: 0, items: [] } });
    expect(readStateOf({ data, isLoading: false, error: null }, "nothing")).toMatchObject({ kind: "ready", communityEmpty: "no_match" });
    expect(readStateOf({ data, isLoading: false, error: null }, "")).toMatchObject({ kind: "ready", communityEmpty: "none" });
  });

  it("reads an odd body as empty, never a crash, and only an explicit false means not runnable", () => {
    expect(normaliseCatalogue({})).toEqual({
      deployMode: "hosted",
      runnable: true,
      curated: [],
      available: { total: 0, limit: 50, offset: 0, source: null, items: [] },
    });
    expect(normaliseCatalogue(null).runnable).toBe(true);
    expect(normaliseCatalogue({ runnable: false }).runnable).toBe(false);
    expect(normaliseCatalogue({ curated: [{ key: "k" }] }).curated[0]!.actions).toEqual([]);
  });
});
