import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chatopsConnections,
  connectorCredentials,
  connectors,
  createDb,
  eq,
  inArray,
  runMigrations,
  type Db,
} from "@regulait/db";
import { connectorProviderKindSchema } from "@regulait/shared";
import { CONNECTOR_PROVIDER_KINDS } from "@regulait/connector-provider";
import { buildApp } from "./app.js";

/**
 * ADR-0121 — OUTLOOK IS A SEND-ONLY CHATOPS PROVIDER, AND THE STORAGE AGREES.
 *
 * The defect this file is written against: the TypeScript enum accepted
 * `"outlook"` while migration 0069's CHECK constraint still read
 * `IN ('slack','teams')`, so registering an Outlook workspace raised a CHECK
 * violation the route surfaced as a 500. The type said yes and the database
 * said no, and no test noticed because no test had ever registered one.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *
 *  1. Registering outlook with NO signing secret returns 201, and the stored
 *     ROW (M-026 — verified by SELECT, not by the status code) has
 *     `provider = 'outlook'` and `signing_secret_ciphertext IS NULL`.
 *  2. PAIRED POSITIVE (M-033): slack registered in the same suite stores a
 *     NON-NULL ciphertext. Without this, criterion 1 would pass equally
 *     against a route that stored null for every provider.
 *  3. outlook + a signing secret is REFUSED with `signing_secret_not_applicable`
 *     and writes NO row — asserted by row count, not by the status alone.
 *  4. slack WITHOUT a signing secret is REFUSED with `signing_secret_required`
 *     and writes no row. This is the other half of criterion 3: a route that
 *     simply made the field optional for everyone would pass 3 and fail here.
 *  5. An inbound callback to the outlook connection returns 401 carrying
 *     `inbound_unsupported_by_design` — the CODE is asserted, because a bare
 *     "not 200" would also be satisfied by the 500 this ordering exists to
 *     prevent.
 *  6. PAIRED POSITIVE: an inbound callback to the SLACK connection with a bad
 *     signature returns 401 `bad_signature`. This proves WALL 0 refuses by
 *     provider rather than swallowing every inbound into one branch, and that
 *     the slack path still reaches signature verification at all.
 *  7. `GET /v1/chatops/connections` reports `signingSecretSet` true for slack
 *     and false for outlook IN THE SAME RESPONSE — one payload, both halves,
 *     so it cannot be satisfied by a constant.
 *  8. STRUCTURAL: shared's `connectorProviderKindSchema` — a hand-maintained
 *     MIRROR of connector-provider's `CONNECTOR_PROVIDER_KINDS`, kept separate
 *     so shared need not depend on the adapter package — enumerates exactly
 *     the canonical set. This is the second half of the same defect: the
 *     adapter shipped an `outlook` case that nothing could reach, because the
 *     create-connector schema had never heard of it. A comment saying "mirrors
 *     X" is not a guarantee; this assertion is.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0121-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);

const OUTLOOK_CONNECTION = `adr0121-outlook-${RUN}`;
const SLACK_CONNECTION = `adr0121-slack-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let outlookConnectorId = "";
let slackConnectorId = "";

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: AUTH, payload: payload as object });

/** the stored row, which is what criteria 1 and 2 are actually about */
const rowFor = async (name: string) =>
  (await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, name)))[0];

const connectionCount = async () => (await db.select().from(chatopsConnections)).length;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  // Outlook's own connector. `providerKind` must match the ChatOps provider —
  // ChatOps posts through the existing connector adapter and its credential.
  const oc = await post("/v1/connectors", {
    name: `adr0121-outlook-connector-${RUN}`,
    kind: "chat",
    providerKind: "outlook",
  });
  expect(oc.statusCode).toBe(201);
  outlookConnectorId = oc.json().id;
  const ocCred = await post(`/v1/connectors/${outlookConnectorId}/credential`, {
    token: JSON.stringify({
      appId: `adr0121-app-${RUN}`,
      appPassword: `adr0121-secret-${RUN}`,
      tenantId: `adr0121-tenant-${RUN}`,
      senderUpn: `approvals@example.com`,
    }),
  });
  expect([200, 201]).toContain(ocCred.statusCode);

  const sc = await post("/v1/connectors", {
    name: `adr0121-slack-connector-${RUN}`,
    kind: "chat",
    providerKind: "slack",
  });
  expect(sc.statusCode).toBe(201);
  slackConnectorId = sc.json().id;
  const scCred = await post(`/v1/connectors/${slackConnectorId}/credential`, {
    token: `xoxb-adr0121-${RUN}`,
  });
  expect([200, 201]).toContain(scCred.statusCode);
});

afterAll(async () => {
  await db
    .delete(chatopsConnections)
    .where(inArray(chatopsConnections.name, [OUTLOOK_CONNECTION, SLACK_CONNECTION]));
  const ids = [outlookConnectorId, slackConnectorId].filter(Boolean);
  if (ids.length > 0) {
    await db.delete(connectorCredentials).where(inArray(connectorCredentials.connectorId, ids));
    await db.delete(connectors).where(inArray(connectors.id, ids));
  }
  app.server.closeAllConnections();
  await app.close();
});

describe("registering a send-only provider", () => {
  it("1+2: outlook registers holding NO secret, while slack in the same suite holds one", async () => {
    const outlook = await post("/v1/chatops/connections", {
      name: OUTLOOK_CONNECTION,
      provider: "outlook",
      connectorId: outlookConnectorId,
      defaultChannel: "approvers@example.com",
    });
    // the exact call that used to be a 500 on the CHECK constraint
    expect(outlook.statusCode).toBe(201);

    const slack = await post("/v1/chatops/connections", {
      name: SLACK_CONNECTION,
      provider: "slack",
      connectorId: slackConnectorId,
      signingSecret: `adr0121-signing-${RUN}`,
      defaultChannel: "C-ADR0121",
    });
    expect(slack.statusCode).toBe(201);

    // VERIFIED BY THE ROW, not by the status code
    const oRow = await rowFor(OUTLOOK_CONNECTION);
    expect(oRow?.provider).toBe("outlook");
    expect(oRow?.signingSecretCiphertext).toBeNull();

    // the paired positive: null is a DECISION about outlook, not the route's
    // behaviour for everything
    const sRow = await rowFor(SLACK_CONNECTION);
    expect(sRow?.provider).toBe("slack");
    expect(sRow?.signingSecretCiphertext).not.toBeNull();
    expect(sRow?.signingSecretCiphertext?.length).toBeGreaterThan(0);
  });

  it("3: a signing secret on outlook is refused by name, and writes nothing", async () => {
    const before = await connectionCount();
    const res = await post("/v1/chatops/connections", {
      name: `${OUTLOOK_CONNECTION}-with-secret`,
      provider: "outlook",
      connectorId: outlookConnectorId,
      signingSecret: `adr0121-unused-${RUN}`,
      defaultChannel: "approvers@example.com",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("signing_secret_not_applicable");
    // the refusal is also a non-write
    expect(await connectionCount()).toBe(before);
  });

  it("4: slack WITHOUT a signing secret is refused — the field did not just become optional", async () => {
    const before = await connectionCount();
    const res = await post("/v1/chatops/connections", {
      name: `${SLACK_CONNECTION}-no-secret`,
      provider: "slack",
      connectorId: slackConnectorId,
      defaultChannel: "C-ADR0121",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("signing_secret_required");
    expect(await connectionCount()).toBe(before);
  });
});

describe("the inbound path that does not exist", () => {
  it("5: an inbound callback to outlook is refused BY NAME, not by crashing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/chatops/${OUTLOOK_CONNECTION}/interactions`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ approvalId: "whatever", action: "approve" }),
    });
    expect(res.statusCode).toBe(401);
    // the CODE, specifically: a 500 from decrypting a null secret would also
    // have satisfied "not 200", and that 500 is the whole reason WALL 0 is
    // ordered ahead of the decrypt.
    expect(res.json().code).toBe("inbound_unsupported_by_design");
  });

  it("6: the slack connection still reaches signature verification", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/chatops/${SLACK_CONNECTION}/interactions`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
      payload: "payload=%7B%7D",
    });
    expect(res.statusCode).toBe(401);
    // a DIFFERENT refusal from criterion 5 — so WALL 0 refuses by provider
    // rather than refusing every inbound alike
    expect(res.json().code).toBe("bad_signature");
  });
});

describe("what the admin surface says about it", () => {
  it("7: reports the secret as set for slack and unset for outlook, in one response", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/chatops/connections", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const rows: Array<{ name: string; provider: string; signingSecretSet: boolean }> =
      res.json().connections;
    const outlook = rows.find((r) => r.name === OUTLOOK_CONNECTION);
    const slack = rows.find((r) => r.name === SLACK_CONNECTION);
    expect(outlook?.signingSecretSet).toBe(false);
    expect(slack?.signingSecretSet).toBe(true);
  });
});

describe("the mirrors that drift silently", () => {
  it("8: shared's connector-kind schema enumerates exactly the adapter union", () => {
    // This test lives in the gateway because it is the only package that
    // depends on BOTH — which is precisely why the drift was invisible: no
    // single package could see the two lists at once.
    expect([...connectorProviderKindSchema.options].sort()).toEqual(
      [...CONNECTOR_PROVIDER_KINDS].sort(),
    );
    // a named positive, so a future refactor that empties both lists in step
    // cannot satisfy the equality above
    expect(connectorProviderKindSchema.options).toContain("outlook");
  });
});
