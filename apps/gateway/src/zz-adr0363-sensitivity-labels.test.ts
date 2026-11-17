import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import {
  auditLog,
  complianceProfiles,
  createDb,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sensitivityLabelDefinitions,
  sensitivityLabelRules,
  sensitivityLabelSettings,
  type Db,
} from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { LABEL_REDACTED_MARKER, upsertLabelDefinitions } from "./sensitivity-labels.js";

/**
 * ADR-0363 slice 1 end to end: a file carrying a Purview label reaches a governed dispatch.
 *   - the strict default blocks a labelled file before any provider work, and audits ids only;
 *   - a mapping allows, redacts (the model sees a marker) or blocks;
 *   - a label from a tenant we never synced is unmapped (blocks);
 *   - an encrypted file blocks; an unlabelled file passes untouched with no audit row;
 *   - a label mapped to a compliance profile pulls that profile's PII mode into the call;
 *   - the admin routes map labels and audit relaxations.
 * Everything here is prefixed e44- (shared database, fileParallelism off).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "e44-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const TENANT = "e4400000-0000-4000-8000-000000000001";
const FOREIGN = "e4400000-0000-4000-8000-0000000000ff";
const HC = "e4400000-0000-4000-8000-0000000000a1";
const GEN = "e4400000-0000-4000-8000-0000000000a2";
const CONF = "e4400000-0000-4000-8000-0000000000a3";
const PHI = "e4400000-0000-4000-8000-0000000000a4";

const docx = (labelId: string, siteId = TENANT) =>
  Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "docMetadata/LabelInfo.xml": strToU8(
        `<?xml version="1.0"?><clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{${labelId}}" enabled="1" method="Standard" siteId="{${siteId}}" removed="0"/></clbl:labelList>`,
      ),
    }),
  ).toString("base64");
const PLAIN_PDF = Buffer.from("%PDF-1.4\n%nothing labelled here\n%%EOF").toString("base64");
const ENCRYPTED = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]).toString("base64");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;
let agentId: string;
let user: { id: string; auth: Record<string, string> };
let restoreGates: () => Promise<void> = async () => {};
let priorPii: string | undefined;
const defId: Record<string, string> = {};

const invoke = (marker: string, attachments: Array<{ name: string; mediaType: string; dataBase64: string }>) =>
  app.inject({
    method: "POST",
    headers: user.auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "chat", dispatch: true, input: marker, attachments: attachments.map((a) => ({ kind: "document", ...a })) },
  });

const wireFor = (marker: string) =>
  mock.dispatches
    .filter((d) => Array.isArray(d.messages) && d.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text.startsWith(marker))))
    .at(-1);

const lastLabelAudit = async () =>
  (await db.select().from(auditLog).where(eq(auditLog.objectId, agentId)).orderBy(desc(auditLog.at)).limit(5)).find(
    (r) => (r.detail as { phase?: string }).phase === "sensitivity_label",
  );

const mapLabel = (labelId: string, body: Record<string, unknown>) =>
  app.inject({ method: "PUT", headers: AUTH, url: `/v1/sensitivity-labels/${defId[labelId]}/rule`, payload: body });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;
  // the org PII floor is lowered for this suite so the cascade test can show a label RAISING it; restored after
  const [org] = await db.select({ pii: orgSettings.defaultPiiMode }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorPii = org?.pii;
  await db.update(orgSettings).set({ defaultPiiMode: "log" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: `e44-agent-${randomUUID().slice(0, 8)}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id;
  const email = `e44-${randomUUID().slice(0, 8)}@example.com`;
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: "e44" } });
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  user = { id: u.json().id, auth: { authorization: `Bearer ${key.json().token}` } };
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: user.id, agentId } });

  // the discovery scan's commit path, as the idp_entra run would call it
  await upsertLabelDefinitions(db, {
    tenantId: TENANT,
    sourceId: null,
    definitions: [
      { provider: "microsoft_purview", labelId: HC, name: "e44 Highly Confidential", parentLabelId: null, rank: 9, active: true },
      { provider: "microsoft_purview", labelId: GEN, name: "e44 General", parentLabelId: null, rank: 1, active: true },
      { provider: "microsoft_purview", labelId: CONF, name: "e44 Confidential", parentLabelId: null, rank: 5, active: true },
      { provider: "microsoft_purview", labelId: PHI, name: "e44 PHI", parentLabelId: HC, rank: 8, active: true },
    ],
  });
  for (const d of await db.select().from(sensitivityLabelDefinitions).where(eq(sensitivityLabelDefinitions.tenantId, TENANT))) defId[d.labelId] = d.id;
});

afterAll(async () => {
  await db.delete(sensitivityLabelDefinitions).where(eq(sensitivityLabelDefinitions.tenantId, TENANT));
  await db.delete(sensitivityLabelSettings);
  await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, "e44-phi"));
  if (priorPii) await db.update(orgSettings).set({ defaultPiiMode: priorPii as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await restoreGates();
  await app.close();
});

describe("ADR-0363 slice 1: sensitivity labels at the gateway", () => {
  it("strict default: an unmapped labelled file is refused 403 before the provider, audited with ids only", async () => {
    const marker = "e44-unmapped-marker";
    const res = await invoke(marker, [{ name: "plan.docx", mediaType: DOCX, dataBase64: docx(HC) }]);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("sensitivity_label_blocked");
    expect(wireFor(marker)).toBeUndefined();
    const row = await lastLabelAudit();
    expect(row).toMatchObject({ effect: "deny", ruleId: "sensitivity-label-blocked" });
    const files = (row!.detail as { sensitivityLabels: { files: Array<{ reasons: unknown[] }> } }).sensitivityLabels.files;
    expect(files[0]!.reasons).toEqual([{ kind: "unmapped", provider: "microsoft_purview", labelId: HC, untrustedTenant: false }]);
    expect(JSON.stringify(row!.detail)).not.toContain("LabelInfo");
  });

  it("an unlabelled file passes untouched and writes no label audit row", async () => {
    const before = await lastLabelAudit();
    const marker = "e44-plain-marker";
    const res = await invoke(marker, [{ name: "notes.pdf", mediaType: "application/pdf", dataBase64: PLAIN_PDF }]);
    expect(res.statusCode).toBe(200);
    expect(wireFor(marker)).toBeDefined();
    expect((await lastLabelAudit())?.id).toBe(before?.id);
  });

  it("a mapping allows General, blocks Highly Confidential, and redacts Confidential to a marker", async () => {
    expect((await mapLabel(GEN, { action: "allow", sensitivity: "internal" })).statusCode).toBe(200);
    expect((await mapLabel(HC, { action: "block", sensitivity: "restricted" })).statusCode).toBe(200);
    expect((await mapLabel(CONF, { action: "redact", sensitivity: "confidential" })).statusCode).toBe(200);

    const allowed = await invoke("e44-general-marker", [{ name: "g.docx", mediaType: DOCX, dataBase64: docx(GEN) }]);
    expect(allowed.statusCode).toBe(200);
    const gWire = wireFor("e44-general-marker")!;
    expect((gWire.messages!.at(-1)!.content as Array<{ type: string }>).some((b) => b.type === "document")).toBe(true);

    const blocked = await invoke("e44-hc-marker", [{ name: "hc.docx", mediaType: DOCX, dataBase64: docx(HC) }]);
    expect(blocked.statusCode).toBe(403);

    const redacted = await invoke("e44-conf-marker", [{ name: "c.docx", mediaType: DOCX, dataBase64: docx(CONF) }]);
    expect(redacted.statusCode).toBe(200);
    const blocks = wireFor("e44-conf-marker")!.messages!.at(-1)!.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === "document")).toBe(false);
    expect(blocks.some((b) => b.type === "text" && b.text === LABEL_REDACTED_MARKER)).toBe(true);
    expect(await lastLabelAudit()).toMatchObject({ effect: "allow", ruleId: "sensitivity-label-read" });
  });

  it("a General label from a tenant we never synced is unmapped and blocks", async () => {
    const res = await invoke("e44-foreign-marker", [{ name: "f.docx", mediaType: DOCX, dataBase64: docx(GEN, FOREIGN) }]);
    expect(res.statusCode).toBe(403);
  });

  it("an encrypted (protected) file blocks under the strict default", async () => {
    const res = await invoke("e44-enc-marker", [{ name: "secret.docx", mediaType: DOCX, dataBase64: ENCRYPTED }]);
    expect(res.statusCode).toBe(403);
    const row = await lastLabelAudit();
    expect((row!.detail as { sensitivityLabels: { files: Array<{ read: string }> } }).sensitivityLabels.files[0]!.read).toBe("protected");
  });

  it("a label mapped to a compliance profile pulls that profile's PII mode into the call", async () => {
    const [profile] = await db.insert(complianceProfiles).values({ tag: "e44-phi", piiMode: "block" }).returning();
    expect((await mapLabel(PHI, { action: "allow", sensitivity: "restricted", complianceProfileId: profile!.id })).statusCode).toBe(200);
    const input = "e44-phi-marker contact jane.doe@example.com";
    // with the org floor at log, PII passes without a label ...
    const plain = await invoke(input, [{ name: "n.pdf", mediaType: "application/pdf", dataBase64: PLAIN_PDF }]);
    expect(plain.statusCode).toBe(200);
    // ... and the PHI-labelled file raises this call to the profile's block
    const labelled = await invoke(input, [{ name: "phi.docx", mediaType: DOCX, dataBase64: docx(PHI) }]);
    expect(labelled.statusCode).toBe(403);
    expect(labelled.json().error).toBe("pii_blocked");
  });

  it("admin list shows definitions with their rules; relaxing a fallback is audited as a relaxation", async () => {
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/sensitivity-labels" });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.settings).toMatchObject({ unmappedAction: "block", strictDefault: true });
    expect(body.trustedTenantIds).toContain(TENANT);
    expect(body.labels.find((l: { labelId: string }) => l.labelId === HC).rule).toMatchObject({ action: "block", sensitivity: "restricted" });

    const relax = await app.inject({ method: "PUT", headers: AUTH, url: "/v1/sensitivity-labels/settings", payload: { protectedAction: "redact" } });
    expect(relax.statusCode).toBe(200);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "sensitivity-label-settings-relaxed")).orderBy(desc(auditLog.at)).limit(1);
    expect(row).toBeDefined();

    const bad = await app.inject({ method: "PUT", headers: AUTH, url: `/v1/sensitivity-labels/${randomUUID()}/rule`, payload: { action: "allow", sensitivity: "public" } });
    expect(bad.statusCode).toBe(404);
    const nonAdmin = await app.inject({ method: "GET", headers: user.auth, url: "/v1/sensitivity-labels" });
    expect(nonAdmin.statusCode).toBe(403);
  });

  it("a re-sync marks labels the provider no longer lists inactive, never deleting a mapped one", async () => {
    const out = await upsertLabelDefinitions(db, {
      tenantId: TENANT,
      sourceId: null,
      definitions: [{ provider: "microsoft_purview", labelId: GEN, name: "e44 General", parentLabelId: null, rank: 1, active: true }],
    });
    expect(out.deactivated).toBe(3);
    const [hc] = await db.select().from(sensitivityLabelDefinitions).where(eq(sensitivityLabelDefinitions.id, defId[HC]!));
    expect(hc!.active).toBe(false);
    expect((await db.select().from(sensitivityLabelRules).where(eq(sensitivityLabelRules.definitionId, defId[HC]!))).length).toBe(1);
  });
});
