/**
 * ADR-0189 B6: the AI BOM and Decision BOM evidence UI against a mocked
 * gateway that answers with the LIVE route shapes (`apps/gateway/src/bom-routes.ts`,
 * contract-b4 after round 2).
 *
 * What these pin:
 *  - a refused snapshot (409 `bom_signing_unavailable`, 503
 *    `receipt_signing_key_invalid`) says nothing was stored, and no snapshot
 *    appears; a taken one names its version and digest;
 *  - a download is saved only when its bytes match the digest the gateway
 *    sent; a missing export key is said as such;
 *  - drift with no snapshot still shows the subject's gaps (R25 item 4);
 *  - a Decision BOM that is not final yet shows its reason, never an empty BOM;
 *  - the posture page says "Decision BOM: unavailable" with no usable receipt
 *    key, and a setting change sends exactly what the dialog showed.
 * Axe (light and dark) on each journey.
 */
import { createHash } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000b6`;
const T = "2026-10-11T12:00:00.000Z";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const AGENT = U(1);
const SNAP1 = U(10);
const SNAP2 = U(11);
const AUDIT = U(20);
const BUNDLE = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
const BODY1 = sha("snapshot-1");

const caps = { access: "admin", exportRoles: "admins_only", auditorGrant: null, canExport: true, exportUnavailableReason: null, canVerify: true, canViewDrift: true, exportRequiresStepUp: false, rateLimitPerMinute: 30 };
const snapshot = (id: string, version: number, body: string) => ({ id, version, serialNumber: `urn:uuid:${U(30 + version)}`, trigger: version === 1 ? "model_card_approval" : "on_demand", bodySha256: body, keyId: "receipt-2026", createdAt: T, formats: ["cyclonedx-1.7"] });

/** a frozen Decision BOM, version `version` of 2; `document` is the parse of `body`, and the digest is over `body` */
function decisionRead(version = 2): Json {
  const completeness = Object.fromEntries(
    ["decision", "receipt", "principal", "actors", "action", "policy", "model", "approval", "outcome", "cost", "trace", "proof"].map((s) =>
      s === "actors" ? [s, { status: "not_recorded", reason: "pre_identity" }] : s === "trace" ? [s, { status: "not_applicable" }] : [s, { status: "recorded" }],
    ),
  );
  const doc = { v: "regulait.decision-bom.v1", id: U(50 + version), auditId: AUDIT, version, supersedes: version === 1 ? null : U(51), finality: "anchored", completeness, basis: { auditSeq: 42, anchorId: U(60), receiptSeq: 5, aiBomSnapshotId: null } };
  const body = JSON.stringify(doc);
  const summary = (v: number) => ({ id: U(50 + v), version: v, supersedes: v === 1 ? null : U(51), finality: "anchored", bodySha256: v === version ? sha(body) : "a".repeat(64), keyId: "receipt-2026", createdAt: T });
  return {
    auditId: AUDIT,
    bom: { ...summary(version), body, signature: "A".repeat(86), aiBomSnapshotId: null, reportedFinality: "anchored" },
    document: doc,
    versions: [summary(1), summary(2)],
    renderings: [],
    bundle: { schema: "regulait.export-bundle/3", subject: "decision-bom", href: `/v1/decisions/${AUDIT}/bom/bundle?version=${version}` },
    capabilities: caps,
  };
}
/** a stored-source Decision BOM verify report: anchored, receipt v2 */
function decisionVerify(): Json {
  const required = ["body_version", "body_schema", "body_signature", "receipt_signature", "receipt_payload_hash", "receipt_facts_binding", "sections_projection", "chain_links", "decision_content_binding", "anchor_record", "anchor_imprint", "tsa_token", "finality"];
  return {
    trust: "deployment_registry", source: "decision_bom", bodyVersion: "regulait.decision-bom.v1",
    identity: { subject: "decision-bom", auditId: AUDIT, bomId: U(52), version: 2, recordedFinality: "anchored", reportedFinality: "anchored", receiptPayloadVersion: "v2" },
    outcome: "valid",
    checks: [
      ...required.map((check) => (check === "decision_content_binding" ? { check, status: "unverifiable", reason: "preimage_not_exported", ref: null } : { check, status: "valid", reason: null, ref: null })),
      ...["bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan"].map((check) => ({ check, status: "unverifiable", reason: "not_a_bundle", ref: null })),
    ],
    sections: ["decision", "receipt", "principal", "actors", "action", "policy", "model", "approval", "outcome", "cost", "trace", "proof"].map((section) => ({
      section, status: "valid", completeness: section === "actors" ? "not_recorded" : section === "trace" ? "not_applicable" : "recorded", notRecordedReason: section === "actors" ? "pre_identity" : null,
    })),
    cannotProve: ["nothing_omitted_after_anchor", "facts_true", "signing_time_beyond_anchor", "destination_tamper_resistant", "decision_row_content"],
    manifest: null, verifiedAt: T, capabilities: caps,
  };
}

interface Scenario {
  snapshots: Json[];
  /** answers to POST …/snapshots, in order */
  create: Array<{ status: number; body: Json }>;
  /** answers to GET /v1/ai-bom/snapshots/:id, in order */
  download: Array<"ok" | { status: number; body: Json }>;
  decision: Array<{ status: number; body: Json }>;
  settings: Record<string, unknown>;
  receiptKey: Json;
  calls: Array<{ method: string; path: string; body: Json }>;
}

const AUTH = { userId: U(99), isAdmin: true, via: "session", user: { id: U(99), email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };

async function mockApi(page: Page, over: Partial<Scenario> = {}): Promise<Scenario> {
  const st: Scenario = {
    snapshots: [snapshot(SNAP1, 1, BODY1)],
    create: [],
    download: [],
    decision: [],
    settings: {
      decisionFactsCapture: "on", decisionBomFinality: "anchored", bomExportRoles: "admins_only", bomPersonIdentifiers: "id_only", aiBomSnapshotTriggers: "sign_off_events",
      aiBomSnapshotWithoutKey: "refuse", cyclonedxExportVersions: ["1.7"], bomExportRateLimitPerMinute: 30, decisionBomFiniteLockFinality: "refuse",
    },
    receiptKey: { state: "missing", keyId: null, publicKeyFingerprint: null, publicKeys: "/v1/receipts/keys", note: "No receipt signing key, so sign-offs are refused (409 bom_signing_unavailable)." },
    calls: [],
    ...over,
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    st.calls.push({ method, path: p + url.search, body });
    if (p === "/auth/me" || p === "/v1/me") return json(route, AUTH);
    if (p === "/v1/users") return json(route, { users: [{ id: U(99), displayName: "Ada Admin", email: "ada@example.test", isAdmin: true, disabledAt: null }] });
    if (p === "/v1/agents") return json(route, { agents: [{ id: AGENT, name: "Clause triage", provider: "mock", tier: 1, model: "mock-balanced", enabled: true, costPerMTokIn: null, costPerMTokOut: null, lifecycleStatus: "active", stewardUserId: U(99), stewardName: "Ada Admin", reviewCadenceMonths: 12 }] });
    // ---- B3
    if (p === `/v1/ai-bom/agent/${AGENT}/snapshots` && method === "GET") return json(route, { subject: { kind: "agent", id: AGENT }, released: true, snapshots: st.snapshots });
    if (p === `/v1/ai-bom/agent/${AGENT}/snapshots` && method === "POST") {
      const next = st.create.shift() ?? { status: 500, body: { error: "internal" } };
      if (next.status === 201) st.snapshots.push(snapshot(next.body.id, next.body.version, next.body.bodySha256));
      return json(route, next.body, next.status);
    }
    if (p === `/v1/ai-bom/agent/${AGENT}/drift`) {
      return json(route, { gaps: [{ auditId: U(40), at: T, kind: "skipped_no_key", trigger: "prompt_promotion", triggeringObjectId: U(41), code: "bom_signing_unavailable" }], gapsTruncated: false, error: "ai_bom_no_snapshot", detail: "none" }, 409);
    }
    // ---- B4
    if (p === `/v1/ai-bom/snapshots/${SNAP1}`) {
      const next = st.download.shift() ?? "ok";
      if (next !== "ok") return json(route, next.body, next.status);
      return route.fulfill({
        status: 200,
        body: BUNDLE,
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="regulait-ai-bom-${SNAP1}-v1.tar.gz"`,
          "x-regulait-bundle-schema": "regulait.export-bundle/3",
          "x-regulait-bundle-subject": "ai-bom",
          "x-regulait-bundle-sha256": sha(BUNDLE),
          "x-regulait-bundle-manifest-sha256": "c".repeat(64),
          "x-regulait-export-signing-key-id": "export-2026",
          "x-regulait-export-signing-key-fingerprint": `sha256:${"d".repeat(64)}`,
          "x-regulait-bom-body-sha256": BODY1,
        },
      });
    }
    if (p === "/v1/boms/verify" && body?.source === "decision_bom") return json(route, decisionVerify());
    if (p === "/v1/boms/verify") {
      return json(route, {
        trust: "deployment_registry", source: "ai_bom_snapshot", bodyVersion: "regulait.ai-bom.v1",
        identity: { subject: "ai-bom", snapshotId: SNAP1, subjectKind: "agent", subjectId: AGENT, version: 1, serialNumber: `urn:uuid:${U(31)}` },
        outcome: "valid",
        checks: [
          ...["body_version", "body_schema", "body_signature", "serial_number"].map((check) => ({ check, status: "valid", reason: null, ref: null })),
          { check: "rendering_hashes", status: "valid", reason: null, ref: "cyclonedx-1.7" },
          ...["bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan"].map((check) => ({ check, status: "unverifiable", reason: "not_a_bundle", ref: null })),
        ],
        sections: [], cannotProve: ["facts_true", "signing_time_beyond_anchor"], manifest: null, verifiedAt: T, capabilities: caps,
      });
    }
    if (p === `/v1/decisions/${AUDIT}/bom`) {
      const next = st.decision.shift() ?? { status: 500, body: { error: "internal" } };
      return json(route, next.body, next.status);
    }
    if (p === "/v1/audit") {
      return json(route, { entries: [{ id: AUDIT, at: T, userId: U(99), objectType: "mcp_tool", toolName: "read_ledger", effect: "allow", ruleId: "grant-allow", deployMode: null, reason: "granted" }], hasMore: false, nextCursor: null });
    }
    if (p === "/v1/audit/retention") return json(route, { retainedDays: 365, prunable: 0 });
    if (p === "/v1/receipts/status") return json(route, { state: "no_key", lastSeq: 0, lagRows: 0 });
    if (p === "/v1/audit/anchors") return json(route, { anchors: [] });
    // ---- posture
    if (p === "/v1/org/posture") {
      return json(route, {
        hardened: true, summary: { enforcementSatisfied: 0, enforcementTotal: 0, optimisationSatisfied: 0, optimisationTotal: 0, blockedByEnvironment: [] }, controls: [],
        execution: { mode: "normal", reason: null, setAt: null, restricted: false, note: "Executing normally." }, receiptSigningKey: st.receiptKey,
      });
    }
    if (p === "/v1/org/settings" && method === "GET") return json(route, { settings: st.settings });
    if (p === "/v1/org/settings" && method === "PUT") {
      Object.assign(st.settings, body);
      return json(route, { settings: st.settings });
    }
    return json(route, {});
  });
  return st;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
      await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1_000))]);
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0189 B6: AI BOM on the agents page", () => {
  test("a refused snapshot stores nothing; a taken one is named; drift shows gaps; download and verify", async ({ page }) => {
    const st = await mockApi(page, {
      create: [
        { status: 409, body: { error: "bom_signing_unavailable", missingKey: "receipt", detail: "No receipt signing key is available." } },
        { status: 503, body: { error: "receipt_signing_key_invalid", detail: "The receipt signing key conflicts with its recorded public key." } },
        { status: 201, body: { id: SNAP2, version: 2, serialNumber: `urn:uuid:${U(32)}`, bodySha256: "e".repeat(64) } },
      ],
      download: [{ status: 409, body: { error: "bom_signing_unavailable", missingKey: "export" } }, "ok"],
    });
    await page.goto("/ui/admin/agents");
    await page.getByRole("button", { name: "AI BOM for Clause triage" }).click();
    const panel = page.getByTestId("ai-bom-panel");
    await expect(panel.getByRole("button", { name: "Open snapshot version 1" })).toBeVisible();
    await expect(panel.getByText("Model card approval")).toBeVisible();

    // no key: refused in the dialog, nothing stored, no new row
    await panel.getByRole("button", { name: "Take snapshot" }).click();
    const dialog = page.getByRole("dialog", { name: "Take a signed AI BOM snapshot?" });
    await expect(dialog).toBeVisible();
    await expectAxeClean(page, "take-snapshot confirmation");
    await dialog.getByRole("button", { name: "Take snapshot" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("No receipt signing key is configured, so nothing was signed or stored. Enforcement posture shows the key's state.");
    await expect(panel.getByRole("button", { name: "Open snapshot version 2" })).toHaveCount(0);
    // an unusable key is its own refusal
    await dialog.getByRole("button", { name: "Take snapshot" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("The configured receipt signing key cannot be used, so nothing was signed or stored. Enforcement posture shows why.");
    // a key: version 2, named with its digest
    await dialog.getByRole("button", { name: "Take snapshot" }).click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByText(`Snapshot version 2 signed and stored (body SHA-256 ${"e".repeat(16)}…).`)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Open snapshot version 2" })).toBeVisible();
    expect(st.calls.filter((c) => c.method === "POST" && c.path.endsWith("/snapshots"))).toHaveLength(3);

    // drift with no snapshot still lists the gaps
    await panel.getByRole("button", { name: "Check drift" }).click();
    const drift = page.getByTestId("bom-drift");
    await expect(drift.getByText("Not evidence")).toBeVisible();
    await expect(drift.getByTestId("bom-gaps")).toContainText("Skipped: no signing key");
    await expect(drift.getByTestId("bom-gaps")).toContainText("Prompt promotion");

    // open version 1: verify, then download (refused, then saved)
    await panel.getByRole("button", { name: "Open snapshot version 1" }).click();
    const detail = page.getByTestId("bom-snapshot-detail");
    await detail.getByRole("button", { name: "Verify stored snapshot" }).click();
    const result = detail.getByTestId("bom-verify-result");
    await expect(result).toContainText("Valid");
    await expect(result).toContainText("not checkable by design");
    await expect(result).toContainText("That the facts were true: only that they were recorded and signed.");
    await detail.getByRole("button", { name: "Download bundle" }).click();
    await expect(detail.getByRole("alert")).toHaveText("No export signing key is configured, so no bundle was built and nothing was exported.");
    const download = page.waitForEvent("download");
    await detail.getByRole("button", { name: "Download bundle" }).click();
    expect((await download).suggestedFilename()).toBe(`regulait-ai-bom-${SNAP1}-v1.tar.gz`);
    await expect(detail.getByText(/^Saved regulait-ai-bom-/)).toBeVisible();
    expect(st.calls.filter((c) => c.path.startsWith(`/v1/ai-bom/snapshots/${SNAP1}`)).map((c) => c.path)).toEqual([
      `/v1/ai-bom/snapshots/${SNAP1}?format=native`,
      `/v1/ai-bom/snapshots/${SNAP1}?format=native`,
    ]);
    await expectAxeClean(page, "agent AI BOM");
  });
});

test.describe("ADR-0189 B6: Decision BOM from an audit row", () => {
  test("not final yet and an unusable key are shown as refusals, never as a BOM", async ({ page }) => {
    const st = await mockApi(page, {
      decision: [
        { status: 409, body: { error: "bom_anchor_pending", reason: "timestamp_pending", retryAfterSeconds: 120 } },
        { status: 503, body: { error: "receipt_signing_key_invalid", detail: "unusable" } },
      ],
    });
    await page.goto("/ui/admin/audit");
    await page.getByRole("button", { name: `Decision BOM for audit row ${AUDIT}` }).click();
    const panel = page.getByTestId("decision-bom-panel");
    await expect(panel.getByRole("alert").first()).toContainText(
      "This decision's BOM is not final yet: its trusted timestamp has not been granted yet. Nothing was frozen. Try again in about 120 seconds.",
    );
    await expect(panel.getByRole("button", { name: "Download bundle" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Retry" }).click();
    await expect(panel.getByRole("alert").first()).toContainText("The configured receipt signing key cannot be used, so nothing was signed or stored.");
    expect(st.calls.filter((c) => c.path.startsWith(`/v1/decisions/${AUDIT}/bom`))).toHaveLength(2);
    await expectAxeClean(page, "Decision BOM refused");
  });

  test("a final Decision BOM: versions, completeness as recorded, and a verify result; axe-clean", async ({ page }) => {
    const st = await mockApi(page, { decision: [{ status: 200, body: decisionRead(2) }, { status: 200, body: decisionRead(1) }] });
    await page.goto("/ui/admin/audit");
    await page.getByRole("button", { name: `Decision BOM for audit row ${AUDIT}` }).click();
    const panel = page.getByTestId("decision-bom-panel");
    await expect(panel.getByText("Version 2 of 2", { exact: false })).toBeVisible();
    const actors = panel.getByRole("row").filter({ hasText: "Actor chain" });
    await expect(actors).toContainText("not recorded");
    await expect(actors).toContainText("Predates workload identity");
    await expect(panel.getByRole("row").filter({ hasText: "Trace" })).toContainText("not applicable");
    await panel.getByRole("button", { name: "Verify this version" }).click();
    const result = panel.getByTestId("bom-verify-result");
    await expect(result.getByRole("status")).toContainText("Valid");
    await expect(result).toContainText("That the audit row's content is the decision described");
    expect(st.calls.filter((c) => c.path === "/v1/boms/verify").map((c) => c.body)).toEqual([{ source: "decision_bom", auditId: AUDIT, version: 2 }]);
    await expectAxeClean(page, "Decision BOM, final, verified");
    // the version select reads the named version
    await panel.getByLabel("Version").selectOption("1");
    await expect(panel.getByText("Version 1 of 2", { exact: false })).toBeVisible();
    expect(st.calls.filter((c) => c.path.startsWith(`/v1/decisions/${AUDIT}/bom`)).map((c) => c.path)).toEqual([`/v1/decisions/${AUDIT}/bom`, `/v1/decisions/${AUDIT}/bom?version=1`]);
  });
});

test.describe("ADR-0189 B6: BOM posture", () => {
  test("no receipt key reads as Decision BOM unavailable; a setting change sends exactly what was confirmed", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/enforcement-posture");
    const card = page.getByTestId("bom-posture");
    await expect(card.getByText("Decision BOM: unavailable (no signing key)")).toBeVisible();
    await expect(card.getByTestId("receipt-key-posture")).toContainText("missing");
    const row = card.getByTestId("bom-setting-decisionFactsCapture");
    await expect(row.getByText("strict", { exact: true })).toBeVisible();
    await row.getByLabel("Decision BOM facts").selectOption("off");
    await row.getByRole("button", { name: "Review change" }).click();
    const dialog = page.getByRole("dialog", { name: "Change decision bom facts?" });
    await expect(dialog).toContainText("on → off");
    await expect(dialog).toContainText("Off: decisions made while off have no recorded facts");
    // loosening the stored value: the dialog says a step-up follows
    await expect(dialog).toContainText("you will be asked to confirm it's you");
    await expectAxeClean(page, "BOM setting confirmation");
    await dialog.getByRole("button", { name: "Save setting" }).click();
    await expect(dialog).toBeHidden();
    expect(st.calls.filter((c) => c.method === "PUT" && c.path === "/v1/org/settings").map((c) => c.body)).toEqual([{ decisionFactsCapture: "off" }]);
    await expect(card.getByText("Decision BOM: not captured", { exact: true })).toBeVisible();
    await expect(card.getByTestId("bom-setting-decisionFactsCapture").getByText("relaxed (audited)")).toBeVisible();
    await expectAxeClean(page, "BOM posture");
  });
});
