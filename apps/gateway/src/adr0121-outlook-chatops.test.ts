import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  auditLog,
  chatopsConnections,
  connectorCredentials,
  connectors,
  createDb,
  desc,
  eq,
  inArray,
  runMigrations,
  type Db,
} from "@regulait/db";
import { CHATOPS_PROVIDERS, connectorProviderKindSchema, verifyChatSignature } from "@regulait/shared";
import {
  CONNECTOR_PROVIDER_KINDS,
  CREDENTIAL_HOST_CONNECTOR_KINDS,
  OUTLOOK_DEFAULT_GRAPH_BASE_URL,
  connectorCredentialHosts,
  connectorDefaultBaseUrl,
  outlookCredentialSchema,
  teamsCredentialSchema,
} from "@regulait/connector-provider";
import { buildApp } from "./app.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { CHATOPS_OUTBOUND_PROVIDERS } from "./chatops.js";
import { COMPILED_DEFAULT_RULE_ID, decideCompiledDefault } from "./compiled-egress.js";
import type { EgressAllowEntry } from "./egress-guard.js";

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
 *  1. AMENDED BY ADR-0179 (AER-015), then by ADR-0183 batch 2.6: outlook was
 *     refused with 422 `outbound_provider_unavailable` while no outbound sender
 *     existed; the sender now exists, so registering outlook SUCCEEDS again,
 *     storing `provider = 'outlook'` and `signing_secret_ciphertext IS NULL`,
 *     and criteria 5 and 7 run against that row. (The courier itself is
 *     adr0183-outlook-courier.test.ts.)
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
 *
 * AER-015 — THE PRODUCT COULD NOT CREATE WHAT THE API ACCEPTED, AND STRICT
 * EGRESS COULD NOT NAME WHERE IT WENT. The admin page's providerKind list
 * omitted teams and outlook, and `connectorDefaultBaseUrl` had no 'outlook'
 * case, so a strict posture refused an outlook connector created without a
 * baseUrl as "cannot say where it goes" (`compiled_default_unknown`).
 *
 *  9. UI-vs-EGRESS PARITY: the kinds the Connectors page offers (read from the
 *     page source — the web package depends on no workspace package, so its
 *     list is a hand-maintained mirror) are EXACTLY the adapter union, and for
 *     every one of them the strict egress guard can NAME the destination an
 *     invoke with no baseUrl reaches (a compiled vendor host, "no host of its
 *     own", or a credential-named host) — never `compiled_default_unknown`.
 *     An unknown kind in the same assertion IS refused, so the loop cannot
 *     pass vacuously.
 * 10. STRICT EGRESS, NO baseUrl: under the strict posture an outlook connector
 *     created without a baseUrl is ADMITTED once its named hosts are listed —
 *     the token exchange reaches a counting fake Entra host (admitted ≠
 *     delivered: the fake answers 500, the adapter fails AFTER admission).
 * 11. PAIRED NEGATIVE: with the Graph host NOT listed the same invoke is
 *     refused BY THE LIST (`compiled_default_not_allowlisted`, naming
 *     graph.microsoft.com) — not as unnameable — and before any socket opens.
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
/** criteria 10/11: the no-baseUrl outlook connector invoked under strict */
let strictConnectorId = "";

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: AUTH, payload: payload as object });

/** the stored row, which is what criteria 1 and 2 are actually about */
const rowFor = async (name: string) =>
  (await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, name)))[0];

const connectionCount = async () => (await db.select().from(chatopsConnections)).length;

let restoreSb1Posture: (() => Promise<void>) | undefined;
const priorPublicUrl = process.env.REGULAIT_PUBLIC_URL;
beforeAll(async () => {
  // ADR-0121 amendment: outlook registers only with a deployment public URL
  process.env.REGULAIT_PUBLIC_URL = "https://regulait.example.test";
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181: the org PII floor ships at block. This file pins behaviour unrelated to
  // PII handling, so it sets the floor off explicitly; restored in afterAll.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false });
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
  if (priorPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = priorPublicUrl;
  await restoreSb1Posture?.();
  await db
    .delete(chatopsConnections)
    .where(inArray(chatopsConnections.name, [OUTLOOK_CONNECTION, SLACK_CONNECTION]));
  const ids = [outlookConnectorId, slackConnectorId, strictConnectorId].filter(Boolean);
  if (ids.length > 0) {
    await db.delete(connectorCredentials).where(inArray(connectorCredentials.connectorId, ids));
    await db.delete(connectors).where(inArray(connectors.id, ids));
  }
  app.server.closeAllConnections();
  await app.close();
});

describe("registering a send-only provider", () => {
  it("1+2 (ADR-0183 2.6): outlook registers again, holding NO secret, while slack holds one", async () => {
    const before = await connectionCount();
    const outlook = await post("/v1/chatops/connections", {
      name: OUTLOOK_CONNECTION,
      provider: "outlook",
      connectorId: outlookConnectorId,
      defaultChannel: "approvers@example.com",
    });
    // ADR-0179 refused this with 422 while no outbound sender existed;
    // ADR-0183 2.6 built the sender, and the refusal lifted by itself (it reads
    // CHATOPS_OUTBOUND_PROVIDERS)
    expect(outlook.statusCode, outlook.body).toBe(201);
    expect(await connectionCount()).toBe(before + 1);

    const slack = await post("/v1/chatops/connections", {
      name: SLACK_CONNECTION,
      provider: "slack",
      connectorId: slackConnectorId,
      signingSecret: `adr0121-signing-${RUN}`,
      defaultChannel: "C-ADR0121",
    });
    expect(slack.statusCode, slack.body).toBe(201);

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

  it("3: outlook with a signing secret is refused too, and writes nothing", async () => {
    const before = await connectionCount();
    const res = await post("/v1/chatops/connections", {
      name: `${OUTLOOK_CONNECTION}-with-secret`,
      provider: "outlook",
      connectorId: outlookConnectorId,
      signingSecret: `adr0121-unused-${RUN}`,
      defaultChannel: "approvers@example.com",
    });
    // ADR-0121: a signing secret means the operator believes there is an
    // inbound path to secure; the refusal names the decision instead
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
    const rows: Array<{ name: string; provider: string; signingSecretSet: boolean; outboundSupported: boolean }> =
      res.json().connections;
    const outlook = rows.find((r) => r.name === OUTLOOK_CONNECTION);
    const slack = rows.find((r) => r.name === SLACK_CONNECTION);
    expect(outlook?.signingSecretSet).toBe(false);
    expect(slack?.signingSecretSet).toBe(true);
    // ADR-0183 2.6: outlook can carry a card now, like slack
    expect(outlook?.outboundSupported).toBe(true);
    expect(slack?.outboundSupported).toBe(true);
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

// ---------------------------------------------------------------------------
// AER-015 — UI-vs-egress parity (criterion 9)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
/** The admin page that offers providerKind, read AS SOURCE the way
 * external-effects.test.ts reads its executors: the web package depends on no
 * workspace package, so its list is a hand-maintained mirror and this file is
 * the assertion behind it. */
const CONNECTORS_PAGE = path.resolve(here, "../../web/src/views/admin/integrations/ConnectorsPage.tsx");

/** The ChatOps admin page — same convention: its provider list is a mirror. */
const CHATOPS_PAGE = path.resolve(here, "../../web/src/views/admin/governance/ChatOpsPage.tsx");

const readPage = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pageName = (source: ts.SourceFile) => path.basename(source.fileName);

/** the ONE variable declaration named `name` in a page, with its initializer */
function pageConst(source: ts.SourceFile, name: string): ts.Expression {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1) throw new Error(`${pageName(source)}: expected ONE ${name} declaration, found ${found.length}`);
  return found[0]!;
}

/** a string-array literal, refusing anything this read cannot see through */
function stringArray(source: ts.SourceFile, label: string, node: ts.Expression): string[] {
  if (!ts.isArrayLiteralExpression(node)) throw new Error(`${pageName(source)} ${label}: not an array literal ('${node.getText(source)}')`);
  return node.elements.map((e) => {
    if (!ts.isStringLiteral(e)) throw new Error(`${pageName(source)} ${label}: non-literal entry '${e.getText(source)}'`);
    return e.text;
  });
}
const pageArray = (source: ts.SourceFile, name: string) => stringArray(source, name, pageConst(source, name));

/**
 * The reviewer's nit on criterion 9: pinning the literal is not pinning what
 * renders. The <Select> whose `value` is `valueExpr` must render its options
 * from `LIST.map(...)` and carry no hard-coded <option> beside it — so swapping
 * the map for typed-out options (that drop outlook) fails here.
 */
function assertSelectRendersList(source: ts.SourceFile, valueExpr: string, list: string): void {
  const selects: ts.JsxElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "Select") {
      const value = node.openingElement.attributes.properties.find(
        (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(source) === "value",
      );
      const init = value?.initializer;
      if (init && ts.isJsxExpression(init) && init.expression?.getText(source) === valueExpr) selects.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (selects.length !== 1) throw new Error(`${pageName(source)}: expected ONE <Select value={${valueExpr}}>, found ${selects.length}`);
  const children = selects[0]!.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
  const maps = children.filter(
    (c) =>
      ts.isJsxExpression(c) &&
      !!c.expression &&
      ts.isCallExpression(c.expression) &&
      ts.isPropertyAccessExpression(c.expression.expression) &&
      c.expression.expression.name.text === "map" &&
      c.expression.expression.expression.getText(source) === list,
  );
  expect(maps.length, `${pageName(source)}: <Select value={${valueExpr}}> must render {${list}.map(...)}`).toBe(1);
  expect(
    children.length,
    `${pageName(source)}: <Select value={${valueExpr}}> renders something beside {${list}.map(...)}: ${children.map((c) => c.getText(source)).join(" | ")}`,
  ).toBe(1);
}

/** the non-empty entries of the page's PROVIDER_KINDS literal ("" is governance-only) */
function connectorsPageKinds(): string[] {
  return pageArray(readPage(CONNECTORS_PAGE), "PROVIDER_KINDS").filter((k) => k !== "");
}

/** parseable credentials for the kinds whose destination the CREDENTIAL names */
const SAMPLE_CREDENTIAL: Record<string, string> = {
  teams: JSON.stringify({ appId: "app", appPassword: "pw" }),
  outlook: JSON.stringify({ appId: "app", appPassword: "pw", tenantId: "tenant", senderUpn: "approvals@example.com" }),
  snowflake: JSON.stringify({ account: "acme-x1", user: "u", privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----" }),
};
const entry = (host: string): EgressAllowEntry => ({ host, allowPrivateRanges: false, allowPlaintextHttp: false });
const hostOf = (url: string) => new URL(url).hostname;

describe("AER-015 — what the page offers is what strict egress can name", () => {
  it("9: the page offers exactly the adapter union, and the strict guard names every kind's destination", () => {
    const uiKinds = connectorsPageKinds();
    // … and that list is what the Execution adapter select actually renders
    assertSelectRendersList(readPage(CONNECTORS_PAGE), "f.providerKind", "PROVIDER_KINDS");
    // the named positives — the two the page used to omit
    expect(uiKinds).toContain("teams");
    expect(uiKinds).toContain("outlook");
    // vice versa: nothing the registry (and so the egress guard) knows is
    // missing from the page, and the page offers nothing the registry has
    // never heard of
    expect([...uiKinds].sort()).toEqual([...CONNECTOR_PROVIDER_KINDS].sort());

    for (const kind of uiKinds) {
      if (CREDENTIAL_HOST_CONNECTOR_KINDS.has(kind)) {
        // ADR-0167: the invoke path names the typed host plus the vendor's
        // compiled ones, and strict adjudicates every compiled one BY NAME
        const hosts = connectorCredentialHosts(kind, SAMPLE_CREDENTIAL[kind]!);
        expect(hosts.typed !== null || hosts.compiled.length > 0, `${kind}: names no destination`).toBe(true);
        if (hosts.typed) expect(hostOf(hosts.typed), kind).not.toBe("");
        for (const url of hosts.compiled) {
          const d = decideCompiledDefault({
            posture: "strict",
            surface: "connector",
            kind,
            defaultBaseUrl: url,
            allowList: [entry(hostOf(url))],
          });
          expect(d.ok, `${kind}: ${url}`).toBe(true);
          expect(d.ok && d.host).toBe(hostOf(url));
        }
      } else {
        // ADR-0062: a compiled vendor host (adjudicated by name) or null ("no
        // host of its own") — never `undefined`, which strict refuses outright
        const defaultBaseUrl = connectorDefaultBaseUrl(kind);
        expect(defaultBaseUrl, `${kind}: strict cannot say where this adapter goes`).not.toBeUndefined();
        const d = decideCompiledDefault({
          posture: "strict",
          surface: "connector",
          kind,
          defaultBaseUrl,
          allowList: defaultBaseUrl ? [entry(hostOf(defaultBaseUrl))] : [],
        });
        expect(d.ok, kind).toBe(true);
      }
    }
    // outlook names Graph in BOTH registries the invoke path consults
    expect(connectorDefaultBaseUrl("outlook")).toBe(OUTLOOK_DEFAULT_GRAPH_BASE_URL);
    expect(connectorCredentialHosts("outlook", SAMPLE_CREDENTIAL.outlook!).compiled).toContain(
      OUTLOOK_DEFAULT_GRAPH_BASE_URL,
    );

    // the control that keeps the loop honest: a kind nobody can name IS refused
    const unknown = decideCompiledDefault({
      posture: "strict",
      surface: "connector",
      kind: "a-kind-shipped-tomorrow",
      defaultBaseUrl: connectorDefaultBaseUrl("a-kind-shipped-tomorrow"),
      allowList: [],
    });
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.code).toBe("compiled_default_unknown");
  });

  it("9b: the ChatOps page offers every ChatOps provider, labels it from the outbound list, and withholds the secret where the API refuses one", () => {
    const page = readPage(CHATOPS_PAGE);
    // the defect: outlook was accepted by POST /v1/chatops/connections and the
    // select offered only slack and a stale "teams (inbound only)"
    const offered = pageArray(page, "CHATOPS_PROVIDERS");
    expect(offered).toContain("outlook");
    expect([...offered].sort()).toEqual([...CHATOPS_PROVIDERS].sort());
    expect(new Set(offered).size).toBe(offered.length);
    assertSelectRendersList(page, "provider", "CHATOPS_PROVIDERS");

    // the label's "the courier cannot post to it yet" reads this mirror — so it
    // must BE the gateway's outbound list, or teams' old stale label comes back
    expect([...pageArray(page, "CHATOPS_OUTBOUND_PROVIDERS")].sort()).toEqual([...CHATOPS_OUTBOUND_PROVIDERS].sort());

    // send-only = the providers the shared verifier refuses BY DESIGN; the
    // page omits their signing secret because the route 400s one
    const sendOnly = CHATOPS_PROVIDERS.filter((provider) => {
      const verdict = verifyChatSignature({ provider, signingSecret: "x".repeat(16), rawBody: "{}", headers: {} });
      return !verdict.ok && verdict.code === "inbound_unsupported_by_design";
    });
    expect(sendOnly).toContain("outlook");
    expect([...pageArray(page, "CHATOPS_SEND_ONLY_PROVIDERS")].sort()).toEqual([...sendOnly].sort());
  });

  it("9c: the credential card's JSON hint names exactly the keys each adapter's schema takes", () => {
    const page = readPage(CONNECTORS_PAGE);
    const fields = pageConst(page, "JSON_CREDENTIAL_FIELDS");
    if (!ts.isObjectLiteralExpression(fields)) throw new Error("ConnectorsPage JSON_CREDENTIAL_FIELDS: not an object literal");
    const schemas: Record<string, typeof teamsCredentialSchema | typeof outlookCredentialSchema> = {
      teams: teamsCredentialSchema,
      outlook: outlookCredentialSchema,
    };
    const seen: string[] = [];
    for (const prop of fields.properties) {
      if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) || !ts.isObjectLiteralExpression(prop.initializer)) {
        throw new Error(`ConnectorsPage JSON_CREDENTIAL_FIELDS: cannot read '${prop.getText(page)}'`);
      }
      const kind = prop.name.text;
      seen.push(kind);
      const schema = schemas[kind];
      expect(schema, `JSON_CREDENTIAL_FIELDS names '${kind}', which has no JSON credential schema here`).toBeDefined();
      const part = (key: string) => {
        const p = (prop.initializer as ts.ObjectLiteralExpression).properties.find(
          (q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText(page) === key,
        );
        if (!p) throw new Error(`ConnectorsPage JSON_CREDENTIAL_FIELDS.${kind}: no '${key}'`);
        return stringArray(page, `JSON_CREDENTIAL_FIELDS.${kind}.${key}`, p.initializer);
      };
      const shape = schema!.shape as Record<string, { isOptional(): boolean }>;
      const required = Object.keys(shape).filter((k) => !shape[k]!.isOptional());
      const optional = Object.keys(shape).filter((k) => shape[k]!.isOptional());
      expect([...part("required")].sort(), `${kind}: required keys`).toEqual([...required].sort());
      expect([...part("optional")].sort(), `${kind}: optional keys`).toEqual([...optional].sort());
    }
    // the two JSON-credential adapters the page offers both carry the hint
    expect([...seen].sort()).toEqual(Object.keys(schemas).sort());
    expect(outlookCredentialSchema.shape.senderUpn.isOptional()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AER-015 — the strict posture with NO baseUrl on the row (criteria 10, 11)
// ---------------------------------------------------------------------------

/** deliberately neither 127.0.0.1 nor 127.0.0.3: sibling suites allow-list
 * those, and the whole suite shares one database (M-048) */
const FAKE_LOGIN_HOST = "127.0.0.4";

describe("AER-015 — strict egress admits an outlook connector created without a baseUrl", () => {
  let loginServer: http.Server;
  let loginBase = "";
  /** every request the fake Entra login host received */
  const loginHits: string[] = [];
  let loginAllowId = "";
  let graphAllowId = "";
  let requesterAuth: { authorization: string };

  const setPolicy = (egressCompiledDefaultPolicy: "inherit" | "strict") =>
    app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { egressCompiledDefaultPolicy } });

  const allow = async (host: string, local: boolean) => {
    const res = await post("/v1/egress-allow-hosts", {
      host,
      allowPrivateRanges: local,
      allowPlaintextHttp: local,
      note: `adr0121 ${RUN}: ${local ? "local fake Entra login host" : "the compiled Graph host"}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  const invoke = () =>
    app.inject({
      method: "POST",
      url: `/v1/connectors/${strictConnectorId}/invoke`,
      headers: requesterAuth,
      payload: {
        operation: "write",
        object: "approver@example.com",
        payload: { op: "sendMail", subject: "Approval needed", body: { contentType: "Text", content: "hi" } },
      },
    });

  beforeAll(async () => {
    loginServer = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        loginHits.push(req.url ?? "");
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("INTERNAL-SECRET-PAGE");
      });
    });
    await new Promise<void>((r) => loginServer.listen(0, FAKE_LOGIN_HOST, r));
    const addr = loginServer.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    loginBase = `http://${FAKE_LOGIN_HOST}:${addr.port}`;

    const u = await post("/v1/users", { email: `adr0121-strict-${RUN}@example.com`, displayName: "adr0121 requester" });
    expect(u.statusCode).toBe(201);
    const k = await post(`/v1/users/${u.json().id}/keys`, { name: "adr0121" });
    requesterAuth = { authorization: `Bearer ${k.json().token}` };

    // THE ROW: no baseUrl — the exact shape strict used to refuse as unnameable
    const c = await post("/v1/connectors", {
      name: `adr0121-strict-outlook-${RUN}`,
      kind: "chat",
      providerKind: "outlook",
      pricePerCallUsd: 0.01,
    });
    expect(c.statusCode, c.body).toBe(201);
    strictConnectorId = c.json().id;
    const cred = await post(`/v1/connectors/${strictConnectorId}/credential`, {
      token: JSON.stringify({
        appId: `app-${RUN}`,
        appPassword: "SECRET-APP-PASSWORD",
        tenantId: `tenant-${RUN}`,
        senderUpn: "approvals@example.com",
        loginBaseUrl: loginBase,
      }),
    });
    expect([200, 201]).toContain(cred.statusCode);
    const g = await post("/v1/grants/connectors", { userId: u.json().id, connectorId: strictConnectorId, mode: "readwrite" });
    expect(g.statusCode, g.body).toBeLessThan(300);

    // strict, with BOTH hosts this invoke names listed: the typed login host
    // and the compiled Graph host
    expect((await setPolicy("strict")).statusCode).toBe(200);
    loginAllowId = await allow(FAKE_LOGIN_HOST, true);
    graphAllowId = await allow(hostOf(OUTLOOK_DEFAULT_GRAPH_BASE_URL), false);
  });

  afterAll(async () => {
    // RESTORE the shared posture and allow-list: the org singleton and the
    // table outlive this file
    await setPolicy("strict"); // ADR-0181: hand on the shipped default
    for (const id of [loginAllowId, graphAllowId].filter(Boolean)) {
      await app.inject({ method: "DELETE", url: `/v1/egress-allow-hosts/${id}`, headers: AUTH });
    }
    await new Promise<void>((r) => loginServer.close(() => r()));
  });

  it("10: the invoke path is ADMITTED — the token exchange reaches the (fake) Entra host", async () => {
    const before = loginHits.length;
    const res = await invoke();
    // admitted past the egress gate: not an egress refusal of any kind …
    expect(res.statusCode, res.body).not.toBe(403);
    expect(res.json().error).not.toBe("egress_blocked");
    // … and the proof is the token exchange arriving at the fake login host
    expect(loginHits.length).toBe(before + 1);
    expect(loginHits[before]).toContain("/oauth2/v2.0/token");
    // admitted is not delivered: the fake answers 500, so the adapter fails
    // AFTER admission as a provider failure, and the upstream page stays withheld
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("connector_invoke_failed");
    expect(String(res.json().detail)).not.toContain("INTERNAL-SECRET-PAGE");
  });

  it("11: with the Graph host NOT listed it is refused BY THE LIST, naming the host — never as unnameable", async () => {
    const del = await app.inject({ method: "DELETE", url: `/v1/egress-allow-hosts/${graphAllowId}`, headers: AUTH });
    expect([200, 204]).toContain(del.statusCode);
    graphAllowId = "";
    const before = loginHits.length;
    const res = await invoke();
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    // the pre-fix refusal was `compiled_default_unknown` (strict could not say
    // where outlook went); now the host is named and the list decides
    expect(res.json().code).toBe("compiled_default_not_allowlisted");
    expect(String(res.json().detail)).toContain(hostOf(OUTLOOK_DEFAULT_GRAPH_BASE_URL));
    // refused BEFORE any socket opened
    expect(loginHits.length).toBe(before);
    // and the refusal is a record naming the connector kind
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, COMPILED_DEFAULT_RULE_ID))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.objectId).toBe(strictConnectorId);
    expect((row!.detail as { code?: string }).code).toBe("compiled_default_not_allowlisted");
  });
});
