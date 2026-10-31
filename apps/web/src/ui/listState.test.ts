/**
 * ADR-0226 — the list control's state: page-size memory, the column picker's required columns and order, the sort
 * a header click asks for, the request URLs and the "where you are" wording.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_CHUNK,
  exportUrl,
  loadColumnPrefs,
  loadPageSize,
  loadedText,
  moveColumn,
  nextSort,
  normalisePage,
  pageUrl,
  prefsOf,
  rangeText,
  resolveColumns,
  saveColumnPrefs,
  savePageSize,
  toggleColumn,
  type ColumnMeta,
} from "./listState";

const store = new Map<string, string>();
const g = globalThis as unknown as { window?: unknown };
beforeEach(() => {
  store.clear();
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
});
afterEach(() => {
  delete g.window;
});

describe("page size memory", () => {
  it("starts at 10 and remembers the choice per list under regulait.list.<listId>.size", () => {
    expect(loadPageSize("runs")).toBe("10");
    savePageSize("runs", "all");
    savePageSize("users", "50");
    expect(store.get("regulait.list.runs.size")).toBe("all");
    expect(loadPageSize("runs")).toBe("all");
    expect(loadPageSize("users")).toBe("50");
    expect(loadPageSize("incidents")).toBe("10");
  });

  it("ignores a value it did not write, and keeps working when storage throws", () => {
    store.set("regulait.list.runs.size", "9999");
    expect(loadPageSize("runs")).toBe("10");
    g.window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    };
    expect(loadPageSize("runs")).toBe("10");
    expect(() => savePageSize("runs", "50")).not.toThrow();
    expect(loadColumnPrefs("runs")).toBeNull();
    expect(() => saveColumnPrefs("runs", { order: [], hidden: [] })).not.toThrow();
    delete g.window;
    expect(loadPageSize("runs")).toBe("10");
  });
});

const COLS: ColumnMeta[] = [
  { key: "name", main: true },
  { key: "status", main: true, required: "Status is always shown" },
  { key: "spend", main: true },
  { key: "cap" },
  { key: "id" },
  { key: "close", action: true },
];

describe("column picker", () => {
  it("shows the main columns first; the rest start hidden; an action column is never pickable", () => {
    const l = resolveColumns(COLS, null);
    expect(l.order).toEqual(["name", "status", "spend", "cap", "id"]);
    expect(l.visible).toEqual(["name", "status", "spend"]);
  });

  it("a required column cannot be hidden, by a toggle or by a stored choice", () => {
    const l = resolveColumns(COLS, null);
    expect(toggleColumn(COLS, l, "status")).toEqual(l);
    expect(toggleColumn(COLS, l, "close")).toEqual(l);
    const forced = resolveColumns(COLS, { order: ["status", "name", "spend", "cap", "id"], hidden: ["status", "name"] });
    expect(forced.visible).toEqual(["status", "spend", "cap", "id"]);
  });

  it("shows and hides an optional column, moves columns, and the choice round-trips through storage", () => {
    let l = resolveColumns(COLS, null);
    l = toggleColumn(COLS, l, "cap");
    l = toggleColumn(COLS, l, "spend");
    l = moveColumn(l, "cap", -1);
    l = moveColumn(l, "cap", -1);
    expect(l.order).toEqual(["name", "cap", "status", "spend", "id"]);
    expect(l.visible).toEqual(["name", "cap", "status"]);
    expect(moveColumn(l, "name", -1)).toEqual(l);
    expect(moveColumn(l, "id", 1)).toEqual(l);
    saveColumnPrefs("runs", prefsOf(l));
    expect(JSON.parse(store.get("regulait.list.runs.columns")!)).toEqual({ order: ["name", "cap", "status", "spend", "id"], hidden: ["spend", "id"] });
    expect(resolveColumns(COLS, loadColumnPrefs("runs"))).toEqual(l);
    saveColumnPrefs("runs", null);
    expect(store.has("regulait.list.runs.columns")).toBe(false);
  });

  it("a column added after the choice was saved joins at the end, shown only if it is a main one; a removed one drops out", () => {
    const l = resolveColumns([...COLS, { key: "fresh", main: true }, { key: "extra" }], { order: ["gone", "spend", "name"], hidden: ["name"] });
    expect(l.order).toEqual(["spend", "name", "status", "cap", "id", "fresh", "extra"]);
    expect(l.visible).toEqual(["spend", "status", "fresh"]);
  });

  it("a stored value that is not a choice is ignored", () => {
    store.set("regulait.list.runs.columns", "{not json");
    expect(loadColumnPrefs("runs")).toBeNull();
    store.set("regulait.list.runs.columns", JSON.stringify({ order: ["name", 3], hidden: "x" }));
    expect(loadColumnPrefs("runs")).toEqual({ order: ["name"], hidden: [] });
  });
});

describe("sort state", () => {
  it("a new column starts ascending; the same column flips", () => {
    const s0 = { key: "created", dir: "desc" as const };
    const s1 = nextSort(s0, "name");
    expect(s1).toEqual({ key: "name", dir: "asc" });
    expect(nextSort(s1, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort(nextSort(s1, "name"), "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort(s0, "created")).toEqual({ key: "created", dir: "asc" });
  });

  it("the page and export URLs carry the sort, the filters and the columns in screen order", () => {
    expect(pageUrl("/v1/runs", { limit: 10, sort: { key: "name", dir: "asc" }, filters: { status: "running", q: undefined }, count: "estimate" })).toBe(
      "/v1/runs?status=running&limit=10&sort=name&dir=asc&count=estimate",
    );
    expect(pageUrl("/v1/runs", { limit: ALL_CHUNK, sort: { key: "created", dir: "desc" }, filters: {}, count: "exact", cursor: "abc" })).toBe(
      "/v1/runs?limit=500&sort=created&dir=desc&count=exact&cursor=abc",
    );
    expect(pageUrl("/v1/runs", { limit: 50, sort: { key: "name", dir: "desc" }, filters: {}, count: "exact", offset: 100 })).toContain("&offset=100");
    expect(exportUrl("/v1/users/export.xlsx", { key: "email", dir: "desc" }, { role: "admin", status: "" }, ["status", "email", "name"])).toBe(
      "/v1/users/export.xlsx?role=admin&sort=email&dir=desc&columns=status%2Cemail%2Cname",
    );
  });
});

describe("where you are", () => {
  it("says the range and the total, never a guess", () => {
    expect(rangeText(10, 10, 1284, false, true)).toBe("11–20 of 1,284");
    expect(rangeText(10, 10, 1000, true, true)).toBe("11–20 of 1,000+");
    expect(rangeText(10, 10, null, false, true)).toBe("11–20");
    expect(rangeText(20, 4, null, false, false)).toBe("21–24 of 24");
    expect(rangeText(0, 0, 0, false, false)).toBe("");
    expect(loadedText(1000, 1284, false)).toBe("Loaded 1,000 of 1,284");
    expect(loadedText(500, 1000, true)).toBe("Loaded 500 of 1,000+");
    expect(loadedText(37, null, false)).toBe("Loaded 37");
  });

  it("reads the contract response, and an older gateway's shape with no total", () => {
    expect(normalisePage({ items: [1], nextCursor: "c", nextOffset: null, total: 9, totalIsEstimate: false }, "runs")).toMatchObject({ items: [1], nextCursor: "c", total: 9 });
    expect(normalisePage({ runs: [1, 2] }, "runs")).toMatchObject({ items: [1, 2], nextCursor: null, nextOffset: null, total: null, totalIsEstimate: false });
    expect(normalisePage(null, "runs").items).toEqual([]);
  });
});
