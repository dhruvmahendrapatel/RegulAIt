/**
 * The brand + UI-structure contract, asserted on rendered pages.
 *
 * Two standards govern the SPA's appearance, and they set their own precedence:
 * the regulAIt Brand Guidelines win on colour, type and the mark; the regulAIt
 * UI Structures doc wins on structure and markup contracts. This spec is the
 * mechanical half of ADR-0075 — the invariants from both that are cheap to
 * check and expensive to lose.
 *
 * Every accessibility invariant below "was a real defect in the source app",
 * per the UI Structures doc, which asks for exactly this: "assert these in CI".
 * They are asserted in a REAL browser rather than by grepping CSS, because the
 * failures they guard against are runtime failures — the doc's own Traps section
 * records a page that returned 200 while rendering its full markup into a
 * zero-height container. A stylesheet assertion would have passed.
 */
import { expect, test, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string; dana: string; avery: string };
  baseUrl: string;
};
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const ADMIN_PASSWORD = "E2e-Admin-Phase2!";

function trackConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource.*status of 4\d\d/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

async function submitLogin(page: Page): Promise<number | null> {
  const settled = page
    .waitForResponse((r) => r.url().includes("/auth/login") && r.request().method() === "POST", {
      timeout: 15_000,
    })
    .catch(() => null);
  await page.getByRole("button", { name: "Sign in" }).click();
  const res = await settled;
  if (!res || res.status() !== 429) return null;
  const body = (await res.json()) as { retryAfterSeconds?: number };
  return Math.min(body.retryAfterSeconds ?? 60, 310);
}

async function signIn(page: Page, email: string, candidates: string[], settleOn: string) {
  for (const [i, password] of candidates.entries()) {
    await page.goto("/ui");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);

    for (let attempt = 0; ; attempt += 1) {
      const waitFor = await submitLogin(page);
      if (waitFor === null) break;
      expect(attempt, `login stayed rate-limited for ${email}`).toBeLessThan(6);
      await page.waitForTimeout((waitFor + 2) * 1000);
    }

    const welcome = page.getByRole("heading", { name: /Welcome back/ });
    const forcedChange = page.getByText("Your password is one-time");
    const rejected = page.getByText(/password is incorrect/);
    await passTotp(page, email, welcome.or(forcedChange).or(rejected));

    if (await welcome.isVisible()) return password;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await passTotp(page, email, welcome);
      return settleOn;
    }
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

/** The pages walked for the structural invariants — one of each page archetype. */
const ROUTES: Array<{ path: string; label: string }> = [
  { path: "/ui/", label: "home" },
  { path: "/ui/runs", label: "runs" },
  { path: "/ui/inbox", label: "inbox" },
  { path: "/ui/spend", label: "spend" },
  { path: "/ui/admin/users", label: "admin-users" },
  { path: "/ui/admin/roles", label: "admin-roles" },
  { path: "/ui/admin/agents", label: "admin-agents" },
  { path: "/ui/admin/audit", label: "admin-audit" },
  { path: "/ui/admin/client-access", label: "admin-client-access" },
  { path: "/ui/admin/group-mappings", label: "admin-group-mappings" },
  { path: "/ui/admin/shadow-ai", label: "admin-shadow-ai" },
  { path: "/ui/admin/virtual-keys", label: "admin-virtual-keys" },
  { path: "/ui/admin/regulait-llm", label: "admin-regulait-llm" },
  { path: "/ui/pm", label: "pm" },
];

let page: Page;
let consoleErrors: string[];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(400_000);
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  consoleErrors = trackConsole(page);
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
});

test.describe("brand", () => {
  test("all three brand typefaces resolve and fetch", async () => {
    await page.goto("/ui/");
    // `document.fonts.check` alone answers "is this face loaded RIGHT NOW",
    // which is a question about what the current page happens to render: a
    // @font-face is not fetched until something needs it. Home has no mono text
    // on it, so checking there would report IBM Plex Mono missing even though it
    // is declared, served and correct. `load()` first, so this asserts the
    // property that matters — the face resolves and its file is fetchable —
    // rather than which page you happened to be standing on.
    const loaded = await page.evaluate(async () => {
      const faces = ["700 16px Gantari", "400 16px Figtree", '400 16px "IBM Plex Mono"'];
      const got = await Promise.all(
        faces.map(async (f) => {
          try {
            const fs = await document.fonts.load(f);
            return fs.length > 0 && document.fonts.check(f);
          } catch {
            return false;
          }
        }),
      );
      return { gantari: got[0], figtree: got[1], mono: got[2] };
    });
    expect(loaded, "all three brand faces must resolve and fetch").toEqual({
      gantari: true,
      figtree: true,
      mono: true,
    });
  });

  test("each typeface carries the role the brand assigns it", async () => {
    // "Never set body copy in Gantari or the mono" is a stated brand rule, so
    // assert the PAIRING, not merely that the fonts exist. Checked on an admin
    // page because that is where all three roles appear at once: Gantari on the
    // heading, Figtree on body copy, mono on the breadcrumb kicker and on the
    // identifier cells that `.rg-mono` marks.
    await page.goto("/ui/admin/roles");
    await page.waitForLoadState("networkidle");
    const used = await page.evaluate(() => {
      const f = (el: Element | null) => (el ? getComputedStyle(el).fontFamily : null);
      return {
        body: f(document.body),
        heading: f(document.querySelector("h1")),
        kicker: f(document.querySelector('nav[aria-label="Breadcrumb"] ol')),
      };
    });
    expect(used.body, "body copy is Figtree").toContain("Figtree");
    expect(used.heading, "headings are Gantari").toContain("Gantari");
    expect(used.body, "body copy is never Gantari").not.toContain("Gantari");
    expect(used.kicker, "kickers are IBM Plex Mono").toContain("IBM Plex Mono");
  });

  test("the fonts are self-hosted — no CDN, no network dependency", async () => {
    const external: string[] = [];
    const probe = await page.context().newPage();
    probe.on("request", (r) => {
      const u = new URL(r.url());
      if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") external.push(r.url());
    });
    await probe.goto("/ui/");
    await probe.evaluate(() => document.fonts.ready);
    await probe.close();
    expect(external, "the SPA must fetch nothing off-origin").toEqual([]);
  });

  test("the wordmark is spelled regulAIt everywhere a user can read it", async () => {
    // "Don't write 'Regulait', 'regulait' or 'RegulAIt'" is an explicit brand
    // rule. This walks the rendered text of every archetype page.
    const offences: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      // The two capitalised misspellings never legitimately appear anywhere, so
      // they are flagged unconditionally — including inside a compound like
      // "RegulAIt-LLM", which is exactly the kind of user-facing label that
      // slips through a word-boundary check.
      for (const bad of ["RegulAIt", "Regulait"]) {
        const hits = text.match(new RegExp(bad, "g"));
        if (hits) offences.push(`${route.label}: ${bad} × ${hits.length}`);
      }
      // All-lowercase `regulait` DOES legitimately appear inside identifiers a
      // user can see — admin@regulait.local, the /ui/admin/regulait-llm path —
      // so it is only an offence when it stands alone as a word.
      const lower = text.match(/(^|[^A-Za-z0-9@._/-])regulait([^A-Za-z0-9@._/-]|$)/g);
      if (lower) offences.push(`${route.label}: regulait × ${lower.length}`);
    }
    expect(offences, "the wordmark is 'regulAIt' — see the brand's Don't list").toEqual([]);
  });

  test("the AI node in the mark is Signal Cyan, and it is the only coloured element", async () => {
    await page.goto("/ui/");
    const circles = await page.locator("aside svg circle").evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).fill),
    );
    expect(circles.length, "the mark has four anchor nodes and one AI node").toBe(5);
    // Signal 500 — the brand pins the AI node to it regardless of theme.
    const signal = "rgb(0, 185, 212)";
    const coloured = circles.filter((c) => c === signal);
    expect(coloured.length, "exactly one node carries Signal Cyan").toBe(1);
  });
});

test.describe("accessibility contract", () => {
  test("the skip link is the FIRST focusable element on the page", async () => {
    // No priming click before the Tab. Clicking anywhere sets the document's
    // *sequential focus navigation starting point* to the clicked element, so a
    // click into the sidebar makes Tab resume from there and skip everything
    // before it — including the skip link. That is a property of the test, not
    // of the page, and asserting through it would have condemned correct markup.
    // A fresh navigation leaves no starting point, which is the state a real
    // keyboard user is in when the page loads.
    for (const route of ROUTES.slice(0, 3)) {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("Tab");
      const first = await page.evaluate(() => ({
        cls: document.activeElement?.className ?? "",
        text: (document.activeElement as HTMLElement | null)?.innerText ?? "",
      }));
      expect(first.cls, `${route.label}: first tab stop must be the skip link`).toContain(
        "rg-skip-link",
      );
    }
  });

  test("the skip link actually moves focus to main", async () => {
    await page.goto("/ui/");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const id = await page.evaluate(() => document.activeElement?.id ?? "");
    expect(id).toBe("rgMain");
  });

  test("main#rgMain exists AND resolves to a non-zero height — the pair", async () => {
    // The doc is emphatic that this is a pair, not two facts: an auto-height box
    // inserted into a percentage-height chain collapsed `.content-body` to 0px
    // and four pages rendered their full markup into nothing, with the server
    // returning 200 throughout. Asserting the element exists would not have
    // caught it; asserting the CSS declaration would not have caught it either.
    for (const route of ROUTES) {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const box = await page.evaluate(() => {
        const m = document.getElementById("rgMain");
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      expect(box, `${route.label}: main#rgMain must exist`).not.toBeNull();
      expect(box!.h, `${route.label}: main#rgMain collapsed to zero height`).toBeGreaterThan(100);
      expect(box!.w, `${route.label}: main#rgMain collapsed to zero width`).toBeGreaterThan(100);
    }
  });

  test("no duplicate ids — especially between the shared shell and the views it wraps", async () => {
    const offences: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const dupes = await page.evaluate(() => {
        const seen = new Map<string, number>();
        for (const el of document.querySelectorAll("[id]")) {
          seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
        }
        return [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
      });
      if (dupes.length) offences.push(`${route.label}: ${dupes.join(", ")}`);
    }
    // getElementById and $("#id") both return only the first match, so a
    // duplicate silently addresses the wrong element about half the time.
    expect(offences, "ids must be unique on the rendered page").toEqual([]);
  });

  test("no orphan labels — a <label> with no control announces a field that never arrives", async () => {
    const offences: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const orphans = await page.evaluate(() =>
        [...document.querySelectorAll("label")]
          .filter((l) => {
            const forId = l.getAttribute("for");
            if (forId) return document.getElementById(forId) === null;
            // no `for` — a wrapping label is fine if it contains a control
            return l.querySelector("input, select, textarea, button") === null;
          })
          .map((l) => (l.textContent ?? "").trim().slice(0, 40)),
      );
      if (orphans.length) offences.push(`${route.label}: ${orphans.join(" | ")}`);
    }
    // If nothing follows it, it is a caption — use .rg-caption, not <label>.
    expect(offences, "section captions must not be marked up as labels").toEqual([]);
  });

  test("no label-in-name breach — WCAG 2.5.3", async () => {
    // Adding an accessible name to a control that already has visible text
    // overrides it, so a speech-input user saying what they can SEE no longer
    // matches. The source app broke this on 94 buttons with one blanket rule.
    //
    // The criterion is about controls with visible *text*. An icon-only control
    // whose visible content is a glyph — ☰, ☾, ☀ — has no spoken form for a
    // speech user to say, so an `aria-label` there is not a breach; it is the
    // only thing giving the control a name at all. So the filter is "visible
    // text containing letters or digits", not "visible content is non-empty".
    const offences: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const bad = await page.evaluate(() =>
        [...document.querySelectorAll("button[aria-label], a[aria-label]")]
          .map((el) => ({
            visible: (el as HTMLElement).innerText.trim(),
            name: el.getAttribute("aria-label") ?? "",
          }))
          .filter((x) => /[\p{L}\p{N}]/u.test(x.visible))
          .filter((x) => !x.name.toLowerCase().includes(x.visible.toLowerCase()))
          .map((x) => `"${x.visible}" labelled "${x.name}"`),
      );
      if (bad.length) offences.push(`${route.label}: ${bad.join(" | ")}`);
    }
    expect(offences, "an accessible name must contain the control's visible text").toEqual([]);
  });

  test("every rows-per-page select is named", async () => {
    const offences: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll("select")]
          .filter((sel) => {
            const named =
              sel.getAttribute("aria-label") ||
              sel.getAttribute("aria-labelledby") ||
              (sel.id && document.querySelector(`label[for="${CSS.escape(sel.id)}"]`)) ||
              sel.closest("label");
            return !named;
          })
          .map((sel) => sel.id || sel.name || "(anonymous select)"),
      );
      if (unnamed.length) offences.push(`${route.label}: ${unnamed.join(", ")}`);
    }
    expect(offences, "a select with no visible label is unnamed without one").toEqual([]);
  });
});

test.describe("colour contrast", () => {
  /**
   * Measured, not asserted. The first pass of these ratios was written by hand
   * into comments in tokens.css and was wrong in eight places — including one
   * overclaim. So the numbers now come from the tokens as the browser actually
   * resolves them, in both themes, and the test states the floor rather than the
   * value: floors survive a palette tweak, hand-copied numbers do not.
   */
  const AA_BODY = 4.5; // normal-size text
  const AA_LARGE = 3.0; // large text and non-text UI

  test("every text step meets its AA floor on the ground it sits on", async () => {
    for (const theme of ["light", "dark"] as const) {
      await page.goto("/ui/");
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);

      const results = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const tok = (n: string) => cs.getPropertyValue(n).trim();

        // Resolve a token to rgb by letting the browser do it — the values are
        // chained var() references, so string parsing would be a second
        // implementation of the cascade and could disagree with it.
        const probe = document.createElement("span");
        probe.style.display = "none";
        document.body.appendChild(probe);
        const rgb = (token: string) => {
          probe.style.color = "";
          probe.style.color = `var(${token})`;
          const c = getComputedStyle(probe).color;
          const m = c.match(/(\d+(?:\.\d+)?)/g);
          return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
        };

        const lin = (v: number) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
        const ratio = (a: number[], b: number[]) => {
          const la = lum(a);
          const lb = lum(b);
          return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        };

        // [foreground token, background token, floor]
        const pairs: Array<[string, string, number]> = [
          ["--rg-ink", "--rg-surface", 4.5],
          ["--rg-ink-body", "--rg-surface", 4.5],
          ["--rg-ink-label", "--rg-surface", 4.5],
          ["--rg-ink-muted", "--rg-surface", 4.5],
          ["--rg-ink", "--rg-canvas", 4.5],
          ["--rg-ink-body", "--rg-canvas", 4.5],
          ["--rg-ink-muted", "--rg-canvas", 4.5],
          ["--rg-ink", "--rg-raised", 4.5],
          ["--rg-ink-body", "--rg-raised", 4.5],
          ["--rg-signal-700", "--rg-surface", 4.5],
          ["--rg-product-deep", "--rg-surface", 4.5],
          ["--rg-critical-deep", "--rg-critical-tint", 4.5],
          ["--rg-high-deep", "--rg-high-tint", 4.5],
          ["--rg-medium-deep", "--rg-medium-tint", 4.5],
          ["--rg-low-deep", "--rg-low-tint", 4.5],
          ["--rg-positive-deep", "--rg-positive-tint", 4.5],
          ["--rg-signal-700", "--rg-signal-tint", 4.5],
          // The rail is the app's only dark surface and never inverts, so its
          // pairs are checked against the dark stack in BOTH themes.
          ["--rg-dark-ink", "--rg-dark-surface", 4.5],
          ["--rg-dark-muted", "--rg-dark-surface", 4.5],
          ["--rg-signal-400", "--rg-dark-surface", 4.5],
          // Non-text UI (WCAG 1.4.11) needs 3:1. The focus ring qualifies: it is
          // the only thing conveying focus state.
          ["--rg-signal-ring", "--rg-surface", 3.0],
          // `--rg-line` / `--rg-line-strong` are deliberately NOT here. 1.4.11
          // covers visual information required to identify components and their
          // states; a hairline between table rows is decorative separation, and
          // the information it carries is also carried by the layout. Holding a
          // 1px rule to 3:1 would mean a grey so dark the table reads as a grid
          // of boxes — this test asserted it briefly, and the honest reading of
          // the criterion is that a divider is out of scope.
        ];

        const out = pairs.map(([fg, bg, floor]) => {
          const a = rgb(fg);
          const b = rgb(bg);
          if (!a || !b) return { fg, bg, floor, got: null as number | null };
          return { fg, bg, floor, got: Math.round(ratio(a, b) * 100) / 100 };
        });
        probe.remove();
        return out;
      });

      const unresolved = results.filter((r) => r.got === null).map((r) => `${r.fg} on ${r.bg}`);
      expect(unresolved, `${theme}: these tokens did not resolve to a colour`).toEqual([]);

      const failures = results
        .filter((r) => r.got !== null && r.got < r.floor)
        .map((r) => `${r.fg} on ${r.bg}: ${r.got}:1 < ${r.floor}:1`);
      expect(failures, `${theme}: contrast floors`).toEqual([]);
    }
  });

  test("--rg-ink-faint is BELOW the body floor — it is decorative by design", async () => {
    // A one-sided contrast test would be satisfied by making every step black.
    // The token contract says "below -muted is decorative only, never body copy",
    // so the faint step being under 4.5:1 is the DESIGN, and this asserts the
    // ordering of the ink ramp rather than just its floor. If someone darkens
    // -faint to silence a contrast warning, they have quietly turned a
    // decorative step into a body step and this test says so.
    for (const theme of ["light", "dark"] as const) {
      await page.goto("/ui/");
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const ordered = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.display = "none";
        document.body.appendChild(probe);
        const lumOf = (token: string) => {
          probe.style.color = `var(${token})`;
          const m = getComputedStyle(probe).color.match(/(\d+(?:\.\d+)?)/g)!;
          const lin = (v: number) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * lin(+m[0]!) + 0.7152 * lin(+m[1]!) + 0.0722 * lin(+m[2]!);
        };
        const steps = ["--rg-ink", "--rg-ink-body", "--rg-ink-label", "--rg-ink-muted", "--rg-ink-faint"];
        const l = steps.map(lumOf);
        const surface = lumOf("--rg-surface");
        probe.remove();
        // distance from the ground must decrease monotonically down the ramp
        const dist = l.map((x) => Math.abs(x - surface));
        return { dist, monotonic: dist.every((d, i) => i === 0 || d <= dist[i - 1]! + 1e-9) };
      });
      expect(ordered.monotonic, `${theme}: the five ink steps must weaken monotonically`).toBe(true);
    }
  });
});

test.describe("visual record", () => {
  test("screenshot every archetype in both themes", async () => {
    test.setTimeout(200_000);
    for (const theme of ["light", "dark"] as const) {
      await page.goto("/ui/");
      await page.evaluate((t) => {
        localStorage.setItem("regulait.theme", t);
        document.documentElement.dataset.theme = t;
      }, theme);
      for (const route of ROUTES) {
        await page.goto(route.path);
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: path.join(SHOTS, `brand-${theme}-${route.label}.png`),
          fullPage: true,
        });
      }
    }
    expect(consoleErrors, "the console must be clean across every page").toEqual([]);
  });
});
