import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, workflowInstances, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * SLICE-8 ADVERSARIAL PROBE — compliance cascade, infra ops and BYOC, at the
 * seams the existing suites do not pin.
 *
 * What is deliberately NOT re-tested here (already pinned, by attack, elsewhere):
 *  - a tag on a project forces required workflow stages at instance creation,
 *    and the classification alone forces a workflow even with no matching rule
 *    -> mcp-proxy.test.ts ("classification forces required workflow stages with
 *    no manual per-control setup");
 *  - reclassification (including to a WEAKER profile) is diff-then-approve,
 *    never silent -> mcp-proxy.test.ts ("reclassification is diff-then-approve")
 *    and the strictly-additive reapply / surfaced-manual relaxation semantics
 *    -> reclassification-reapply.test.ts;
 *  - conflicting profiles SURFACE rather than silently compose ->
 *    compliance-cost.test.ts ("conflicts are SURFACED like the existing cascade
 *    conflicts"), reclassification-reapply.test.ts ("a conflicting required
 *    template is surfaced manual"), mcp-proxy.test.ts ("a member team's
 *    conflicting defaults are surfaced at member-add");
 *  - drift detection marks findings and remediation rides the ONE approvals
 *    queue; auto-remediation happens ONLY where an explicit policy permits it
 *    (low severity), criticals always gated -> infra.test.ts ("scan — detection,
 *    auto-remediation, and the always-gated critical" / "governed remediation —
 *    approve and deny both audited");
 *  - cert-rotation failure is loud (rotation_failed, never a pretend success;
 *    stale approvals refused) -> infra-cert-lifecycle.test.ts; backup-verify
 *    failure is loud on the scheduler health surface (backup-verify-failed
 *    audit + consecutive-failure counting) -> scheduler-health.test.ts and
 *    infra-backup-verify.test.ts;
 *  - ADR-0062 air_gapped refuses egress for built-in providers IN CODE, and
 *    the provider is never dialled -> mode-scoped-egress.test.ts ("THE ATTACK —
 *    a built-in model dispatch is refused and the PROVIDER IS NEVER CALLED"),
 *    with the posture lattice (org can tighten, can never loosen) in
 *    deploy-posture.test.ts;
 *  - a dry-run deploy can never satisfy a production gate -> deploy-live.test.ts
 *    ("the production-gate contract survives: a dry-run result still carries
 *    dryRun:true for prod targets") and deploy-wiring.test.ts ("a live-client
 *    failure lands in blocked_on_deploy — never a success, never dryRun:false");
 *  - data-key custody at boot (mismatched key refuses to start, fingerprint
 *    never leaks the key) -> data-key-custody.test.ts.
 *
 * The residual seams probed here:
 *  1. The PM inbound-webhook path CANNOT mint a workflow instance. The cascade's
 *     required-stages enforcement lives at the ONE instance-creating choke
 *     point (POST /v1/workflows/instances -> requiredTemplateIdsFor). By code
 *     enumeration, `db.insert(workflowInstances)` has exactly one call site
 *     (workflows.ts); this probe holds that as BEHAVIOUR: a fully
 *     authenticated, MATCHED inbound webhook event is processed end-to-end and
 *     the workflow_instances table does not grow, while the direct POST (the
 *     control) does grow it. If someone later teaches the webhook to start
 *     instances without routing through the same required-template union, the
 *     delta here goes non-zero and this fails.
 *  2. The ADR-0041 signed-update-bundle VERIFIER, fail-closed, probed by
 *     attack with a real Ed25519 keypair: tampered file, smuggled unlisted
 *     file, modified manifest (signature break), unknown signing key, and
 *     downgrade are each REFUSED (exit 1), with the untampered control
 *     verifying (exit 0). No prior test covered these scripts.
 *  3. The installer's REGULAIT_DATA_KEY strength gate (scripts/install.sh),
 *     probed by direct --check invocation: the published dev-default key and a
 *     low-entropy key are refused before anything is rendered; a strong random
 *     key passes the gate (control).
 *
 * Shares one DB (fileParallelism off); everything is prefixed s8-. No
 * org-level singleton is written, so there is nothing to restore. Script
 * probes run in their own mkdtemp sandboxes, removed in afterAll.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BOOT = "s8-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let approverId: string;
let officerId: string;
let agentId: string;
let classifiedProjectId: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0]!.replace("-", " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "s8" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function instanceCount() {
  return (await db.select().from(workflowInstances)).length;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b2".repeat(32) });

  const user = await makeUser("s8-user@example.com");
  userId = user.id;
  userAuth = user.auth;
  approverId = (await makeUser("s8-approver@example.com")).id;
  officerId = (await makeUser("s8-officer@example.com")).id;

  const a = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/agents",
    payload: { name: "s8-worker", provider: "mock", tier: 1, modes: ["execute"], model: "s8-mock" },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/agents",
    payload: { userId, agentId },
  });

  // a compliance profile whose tag REQUIRES a template with a sign-off stage —
  // the cascade the control below must be seen applying
  const tpl = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: {
      name: "s8-sensitive",
      definition: {
        workflow: "s8-sensitive",
        stages: [
          { id: "s8-intake", type: "trigger" },
          { id: "s8-compliance-signoff", type: "human_approval", approvers: [officerId] },
        ],
      },
    },
  });
  expect(tpl.statusCode).toBe(201);
  const prof = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: "s8-regulated", requiredTemplateIds: [tpl.json().id] },
  });
  expect(prof.statusCode).toBe(201);
  const proj = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/projects",
    payload: { name: "s8-classified", classifications: ["s8-regulated"] },
  });
  expect(proj.statusCode).toBe(201);
  classifiedProjectId = proj.json().id;
  await app.inject({
    method: "POST", headers: AUTH, url: `/v1/projects/${classifiedProjectId}/members`,
    payload: { userId, role: "contributor" },
  });
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

// ===========================================================================
// (1) the PM inbound path is not a second, ungoverned instance factory
// ===========================================================================

describe("PM webhook inbound path vs the cascade's one choke point", () => {
  it("a matched, authenticated inbound event is fully processed and mints NO workflow instance; the direct POST does", async () => {
    // real connection with a real webhook secret (same idiom as
    // pm-drift-resolution.test.ts)
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/pm/connections",
      payload: { name: "s8-pm", provider: "mock", project: "S8-DEMO", token: "mock-token" },
    });
    expect(conn.statusCode).toBe(201);
    const secret = conn.json().webhookSecret as string;

    // a linked run so the inbound event MATCHES and drives the deepest
    // processing path (state update + drift adjudication), not the
    // matched:false early return
    const run = await app.inject({
      method: "POST", headers: userAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "s8-linked",
          escalationApproverUserId: approverId,
          nodes: [{ id: "n1", title: "s8 watched work", ownerAgentId: agentId, mode: "execute" }],
        },
      },
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().id as string;
    const sync = await app.inject({
      method: "POST", headers: userAuth, url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "s8-pm" },
    });
    expect(sync.statusCode).toBe(201);
    const externalId = sync.json().created.find((c: { nodeId: string }) => c.nodeId === "n1")
      .externalId as string;
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: userAuth, url: `/v1/runs/${runId}/events`, payload });
    await ev({ kind: "start" });
    await ev({ kind: "node_started", nodeId: "n1" });

    const before = await instanceCount();

    // the matched event, end to end through the webhook route
    const hit = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/s8-pm",
      headers: { "x-regulait-webhook-secret": secret },
      payload: { externalId, event: "updated", state: "Done" },
    });
    expect(hit.statusCode).toBe(202);
    expect(hit.json().matched).toBe(true);

    // an unmatched event too — the other processing branch
    const miss = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/s8-pm",
      headers: { "x-regulait-webhook-secret": secret },
      payload: { externalId: "S8-GHOST-1", event: "updated", state: "Done" },
    });
    expect(miss.statusCode).toBe(202);
    expect(miss.json().matched).toBe(false);

    // DELTA (M-008): the inbound path minted nothing
    expect(await instanceCount(), "the PM inbound path must never mint a workflow instance").toBe(before);

    // CONTROL (non-vacuity): the ONE choke point does mint, and the cascade's
    // required stage is present in what it minted
    const direct = await app.inject({
      method: "POST", headers: userAuth, url: "/v1/workflows/instances",
      payload: {
        projectId: classifiedProjectId,
        change: { description: "s8", paths: ["s8.ts"], changeType: "s8-unmatched", environment: "staging" },
      },
    });
    expect(direct.statusCode).toBe(201);
    expect(await instanceCount()).toBe(before + 1);
    const view = await app.inject({
      method: "GET", headers: userAuth, url: `/v1/workflows/instances/${direct.json().id}`,
    });
    const stageIds = view.json().instance.definition.stages.map((s: { id: string }) => s.id);
    expect(stageIds).toContain("s8-compliance-signoff");
  });
});

// ===========================================================================
// (2) ADR-0041 — the update-bundle verifier fails closed, by attack
// ===========================================================================

describe("signed update bundles: the verifier refuses everything but the genuine article", () => {
  const VERIFY = path.join(REPO_ROOT, "scripts/verify-update-bundle.sh");
  const BUILD = path.join(REPO_ROOT, "scripts/build-update-bundle.sh");
  let sandbox: string;
  let keyring: string;
  let bundle: string;

  /** run a script; return { status, output } whether it exits 0 or not */
  function run(cmd: string, args: string[]): { status: number; output: string } {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, output: out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  const verify = (bundlePath: string, extra: string[] = []) =>
    run("bash", [VERIFY, bundlePath, "--keyring", keyring, "--installed-version", "0.1.0", ...extra]);

  /** unpack the good bundle, let `mutate` tamper with the tree, repack */
  function tamperedBundle(name: string, mutate: (root: string) => void): string {
    const work = path.join(sandbox, name);
    mkdirSync(work);
    execFileSync("tar", ["-xzf", bundle, "-C", work]);
    mutate(path.join(work, "regulait-update-0.2.0"));
    const out = path.join(sandbox, `${name}.tar.gz`);
    execFileSync("tar", ["-czf", out, "-C", work, "regulait-update-0.2.0"]);
    return out;
  }

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "s8-bundle-"));
    keyring = path.join(sandbox, "keys");
    mkdirSync(keyring);
    const priv = path.join(sandbox, "rel.pem");
    execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", priv]);
    execFileSync("openssl", ["pkey", "-in", priv, "-pubout", "-out", path.join(keyring, "s8-key.pub")]);
    const src = path.join(sandbox, "src");
    mkdirSync(path.join(src, "subdir"), { recursive: true });
    writeFileSync(path.join(src, "file-a.txt"), "hello update\n");
    writeFileSync(path.join(src, "subdir", "file-b.txt"), "second file\n");
    bundle = path.join(sandbox, "bundle.tar.gz");
    const r = run("bash", [
      BUILD, "--version", "0.2.0", "--key", priv, "--key-id", "s8-key",
      "--source", src, "--include", "file-a.txt", "--include", "subdir", "--out", bundle,
    ]);
    expect(r.status, r.output).toBe(0);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("CONTROL: the untampered bundle VERIFIES (the refusals below are not a verifier that refuses everything)", () => {
    const r = verify(bundle);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain("[VERIFIED]");
  });

  it("a tampered payload file is REFUSED, naming the file", () => {
    const t = tamperedBundle("tamper", (root) => {
      appendFileSync(path.join(root, "payload", "file-a.txt"), "evil\n");
    });
    const r = verify(t);
    expect(r.status).toBe(1);
    expect(r.output).toContain("[modified] file-a.txt");
    expect(r.output).toContain("do not match their signed digest");
  });

  it("a smuggled file the manifest does not list is REFUSED", () => {
    const t = tamperedBundle("extra", (root) => {
      writeFileSync(path.join(root, "payload", "extra.sh"), "#!/bin/sh\n");
    });
    const r = verify(t);
    expect(r.status).toBe(1);
    expect(r.output).toContain("[unlisted] extra.sh");
  });

  it("a modified manifest breaks the signature and is REFUSED — even a 'newer' version claim buys nothing", () => {
    const t = tamperedBundle("badsig", (root) => {
      const manifest = path.join(root, "manifest.json");
      const body = execFileSync("cat", [manifest], { encoding: "utf8" });
      writeFileSync(manifest, body.replace('"version": "0.2.0"', '"version": "9.9.9"'));
    });
    const r = verify(t);
    expect(r.status).toBe(1);
    expect(r.output).toContain("SIGNATURE DOES NOT VERIFY");
  });

  it("a bundle signed by a key this deployment does not pin is REFUSED even though its signature is internally valid", () => {
    const emptyKeyring = path.join(sandbox, "empty-keys");
    mkdirSync(emptyKeyring, { recursive: true });
    const r = run("bash", [VERIFY, bundle, "--keyring", emptyKeyring, "--installed-version", "0.1.0"]);
    expect(r.status).toBe(1);
    expect(r.output).toContain("UNKNOWN SIGNING KEY");
  });

  it("a correctly signed OLDER bundle is a DOWNGRADE and is REFUSED", () => {
    const r = verify(bundle, ["--installed-version", "0.3.0"]);
    expect(r.status).toBe(1);
    expect(r.output).toContain("DOWNGRADE REFUSED");
  });

  it("a stripped signature is REFUSED — a manifest without its signature is just a tarball", () => {
    const t = tamperedBundle("nosig", (root) => {
      rmSync(path.join(root, "manifest.json.sig"));
    });
    const r = verify(t);
    expect(r.status).toBe(1);
    expect(r.output).toContain("manifest.json.sig is missing");
  });
});

// ===========================================================================
// (3) the installer's data-key strength gate, by direct --check invocation
// ===========================================================================

describe("scripts/install.sh --check refuses a weak REGULAIT_DATA_KEY", () => {
  const INSTALL = path.join(REPO_ROOT, "scripts/install.sh");
  let sandbox: string;

  function runCheck(dataKey: string): { status: number; output: string } {
    try {
      const out = execFileSync(
        "bash",
        [INSTALL, "--check", "--mode", "byoc", "--domain", "s8-probe.example",
         "--dir", path.join(sandbox, "plan"), "--data-key", dataKey],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, output: out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "s8-install-"));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("the published dev-default key is refused by name, before anything renders", () => {
    const r = runCheck("a".repeat(64));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("REGULAIT_DATA_KEY is unusable");
    expect(r.output).toContain("DEV DEFAULT key");
    expect(r.output).not.toContain("rendered:");
  });

  it("a structurally valid but low-entropy key (2 distinct hex chars) is refused", () => {
    const r = runCheck("ab".repeat(32));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("REGULAIT_DATA_KEY is unusable");
    expect(r.output).toContain("distinct hex characters");
    expect(r.output).not.toContain("rendered:");
  });

  it("a short key is refused with the 64-hex requirement stated", () => {
    const r = runCheck("deadbeef");
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("not exactly 64 hex characters");
  });

  it("CONTROL: a strong random key passes the strength gate", () => {
    const strong = execFileSync("openssl", ["rand", "-hex", "32"], { encoding: "utf8" }).trim();
    const r = runCheck(strong);
    // The key gate is what this probe pins. --check may still fail later on a
    // box without docker; the invariant is that the KEY was accepted and the
    // refusal message never appeared.
    expect(r.output).toContain("supplied key accepted");
    expect(r.output).not.toContain("REGULAIT_DATA_KEY is unusable");
  });
});
