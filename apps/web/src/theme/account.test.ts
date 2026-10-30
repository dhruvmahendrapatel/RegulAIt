/**
 * ADR-0218: a palette or mode picked in phase 1 (this browser only) moves to the account the first time an account
 * with nothing saved signs in here, instead of being replaced by the organisation default; and only that once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// the web unit tests run in node: a minimal Storage for this browser's copy
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const put = vi.fn(async (_path: string, body: unknown) => ({ appearance: body }));
const painted: string[] = [];
vi.mock("./palette", async (orig) => ({
  ...(await orig<typeof import("./palette")>()),
  setPalette: async (id: string) => void painted.push(`palette:${id}`),
}));
vi.mock("./mode", () => ({ setThemeMode: (m: string) => void painted.push(`mode:${m}`) }));
vi.mock("../api/client", () => ({ api: { put: (p: string, b: unknown) => put(p, b) } }));

import type { AccountAppearance } from "../api/types";
import { adoptAccountAppearance } from "./account";

const account = (over: Partial<AccountAppearance> = {}): AccountAppearance => ({
  palette: null,
  mode: null,
  effectivePalette: "aurora",
  org: { defaultPalette: "aurora", locked: false },
  saved: true,
  ...over,
});

describe("carrying a phase-1 browser choice to the account", () => {
  beforeEach(() => {
    localStorage.clear();
    put.mockClear();
    painted.length = 0;
  });

  it("saves the browser's palette and mode when the account has none", () => {
    localStorage.setItem("regulait.palette", "orchid");
    localStorage.setItem("regulait.theme", "dark");
    adoptAccountAppearance(account());
    expect(put).toHaveBeenCalledWith("/auth/appearance", { palette: "orchid", mode: "dark" });
  });

  it("does it once per browser: later the stored copy is only the account's cache", () => {
    localStorage.setItem("regulait.palette", "orchid");
    adoptAccountAppearance(account());
    put.mockClear();
    localStorage.setItem("regulait.palette", "harbor");
    adoptAccountAppearance(account());
    expect(put).not.toHaveBeenCalled();
  });

  it("never carries a palette the organisation's lock rules out, but always High contrast", () => {
    localStorage.setItem("regulait.palette", "orchid");
    adoptAccountAppearance(account({ org: { defaultPalette: "harbor", locked: true }, effectivePalette: "harbor" }));
    expect(put).not.toHaveBeenCalled();
    localStorage.clear();
    localStorage.setItem("regulait.palette", "contrast");
    adoptAccountAppearance(account({ org: { defaultPalette: "harbor", locked: true }, effectivePalette: "harbor" }));
    expect(put).toHaveBeenCalledWith("/auth/appearance", { palette: "contrast" });
  });

  it("keeps what the account already has", () => {
    localStorage.setItem("regulait.palette", "orchid");
    localStorage.setItem("regulait.theme", "dark");
    adoptAccountAppearance(account({ palette: "graphite", mode: "light", effectivePalette: "graphite" }));
    expect(put).not.toHaveBeenCalled();
    expect(painted).toEqual(["palette:graphite", "mode:light"]);
  });
});
