#!/usr/bin/env node
/**
 * THE PINNED-CONTAINER VERIFICATION M-043 DEMANDS.
 *
 * Two proxy adapters shipped from this repository without one. The Envoy one
 * failed OPEN on deny — a refusal admitted by a deployment that believed it was
 * governed — and the Kong one could not run at all. Both were reviewed. Review
 * found neither. A single run would have found both in seconds, and that is the
 * entire argument for this file existing.
 *
 * WHAT IT ASSERTS, and why each one is not the obvious thing:
 *
 *   - ALLOW reaches the upstream. Table stakes, and the control for the rest:
 *     without it, "zero upstream calls" is satisfied by a broken route.
 *   - DENY, APPROVAL_REQUIRED, and a DEAD PDP each leave the upstream count
 *     UNCHANGED. Checking the client's status code is not enough — a 403
 *     rendered after the upstream already ran looks identical from the client
 *     side, and that is precisely the shape of the bug that shipped.
 *   - A FORGED `x-regulait-subject` is REFUSED. The first version of this
 *     adapter preferred that header over the authenticated consumer, so anyone
 *     who could reach the route could be authorized as anyone. The test sends
 *     a header naming a DIFFERENT, MORE-ENTITLED user — once per case spelling,
 *     twice in one request (AER-026: duplicate headers), and from the entitled
 *     consumer too — and requires every one to be refused with its own reason
 *     and zero upstream calls.
 *   - THE IDENTITIES THE PLUGIN MUST REFUSE BEFORE ASKING (AER-026): a consumer
 *     with no `custom_id`, one whose `custom_id` is an email rather than a user
 *     id, one mapped to a UUID nobody has, and one mapped to a DEACTIVATED user
 *     whose grant survives. Plus a subject header on a request with no
 *     credential, on a plain route (key-auth refuses first) and on a route
 *     whose key-auth has an `anonymous` fallback mapped to the entitled user —
 *     the shape in which "no credential" still produces a consumer.
 *   - THE LEDGER KEEPS THE KONG CONSUMER beside the resolved subject (AER-026),
 *     read back from the PDP's own audit rows.
 *
 * Requires: docker, a built gateway, and a Postgres. Run by
 * .github/workflows/integrations.yml, which pins the Kong image.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const KONG_IMAGE = process.env.KONG_IMAGE ?? "kong:3.6";
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 3210);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 8099);
const KONG_PROXY_PORT = 8000;
const BOOT = "kong-e2e-bootstrap";
const DATA_KEY = "a".repeat(64);
const DB = process.env.KONG_E2E_DB ?? "regulait_kong_e2e";
const PG = process.env.E2E_PG ?? "postgres://regulait:regulait@localhost:5432";

const failures = [];
/**
 * AER-033's residual hygiene. The harness left three things behind: its host
 * temp directory, the scratch PDP key and the scratch database. None of them is
 * a plaintext credential any more (the key arrives through a vault reference),
 * but a run that leaves a live key and a fixed-name database behind cannot be
 * run twice concurrently and leaves a credential nobody is watching. These are
 * hoisted so `finally` can clean up whatever a failed run managed to create.
 */
let scratchDir = null;
let scratchKeyId = null;
let scratchBase = null;
let scratchBoot = null;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });

/**
 * BOTH STREAMS, COMBINED. `execFileSync` with `stdio: "pipe"` returns stdout
 * ONLY — and `docker logs` writes the container's stderr to stderr, which is
 * where every Kong startup error goes. The first diagnostic pass reported
 * "(no stdout)" for a container that had plenty to say, and the missing output
 * was discarded by the helper meant to surface it. Merging the streams in the
 * shell is the fix; reading `e.stderr` on throw only covers the failure path.
 */
const shBoth = (line) => {
  try {
    return execSync(`${line} 2>&1`, { encoding: "utf8" });
  } catch (e) {
    return String(e.stdout ?? "") + String(e.stderr ?? "") || `(command failed: ${line})`;
  }
};

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

const api = async (method, url, body, headers = {}) => {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};

const upstreamCount = async () =>
  (await api("GET", `http://127.0.0.1:${UPSTREAM_PORT}/__count`)).json.count;
const upstreamLast = async () =>
  (await api("GET", `http://127.0.0.1:${UPSTREAM_PORT}/__last`)).json.last;
const upstreamReset = () => api("GET", `http://127.0.0.1:${UPSTREAM_PORT}/__reset`);

/**
 * A REQUEST WRITTEN BY HAND, for the cases `fetch` cannot express. The Fetch
 * spec folds two values of one header into one comma-joined line, and Node's
 * client normalises header-name case, so neither can send what an attacker
 * can: the same protocol header twice, in two spellings, on two lines. The
 * socket can. `Connection: close` so Kong ends the exchange and the whole
 * response is what arrives before the close.
 */
const rawRequest = (port, pathname, headerLines) =>
  new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let buf = "";
    sock.on("connect", () => {
      sock.write(
        `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n` +
          headerLines.map((l) => `${l}\r\n`).join("") +
          "\r\n",
      );
    });
    sock.on("data", (d) => (buf += d));
    sock.on("error", reject);
    sock.on("close", () => {
      const head = buf.split("\r\n\r\n")[0] ?? "";
      const [statusLine, ...lines] = head.split("\r\n");
      const headers = {};
      for (const line of lines) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status: Number((statusLine ?? "").split(" ")[1]), headers });
    });
  });

let upstream, gateway, kongStarted = false;

async function main() {
  // ---- 1. the counting upstream -----------------------------------------
  upstream = spawn("node", [path.join(here, "upstream.mjs")], {
    env: { ...process.env, UPSTREAM_PORT: String(UPSTREAM_PORT) },
    stdio: "inherit",
  });
  await waitFor(async () => (await upstreamCount()) === 0, 15_000, "the counting upstream");

  // ---- 2. a fresh gateway ------------------------------------------------
  execFileSync("psql", [`${PG}/postgres`, "-v", "ON_ERROR_STOP=1", "-c",
    `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`], { stdio: "pipe" });
  execFileSync("psql", [`${PG}/postgres`, "-v", "ON_ERROR_STOP=1", "-c",
    `CREATE DATABASE ${DB}`], { stdio: "pipe" });

  const env = {
    ...process.env,
    DATABASE_URL: `${PG}/${DB}`,
    REGULAIT_BOOTSTRAP_TOKEN: BOOT,
    REGULAIT_DATA_KEY: DATA_KEY,
    PORT: String(GATEWAY_PORT),
  };
  execFileSync("node", [path.join(repoRoot, "apps/gateway/dist/seed.js")], {
    env, stdio: "pipe", maxBuffer: 16 * 1024 * 1024,
  });
  gateway = spawn("node", [path.join(repoRoot, "apps/gateway/dist/main.js")], { env, stdio: "inherit" });
  const base = `http://127.0.0.1:${GATEWAY_PORT}`;
  const boot = { authorization: `Bearer ${BOOT}` };
  await waitFor(async () => (await api("GET", `${base}/health`)).status === 200, 30_000, "the gateway");

  // ---- 3. two users: one entitled, one not -------------------------------
  const users = (await api("GET", `${base}/v1/users`, undefined, boot)).json.users;
  const servers = (await api("GET", `${base}/v1/servers`, undefined, boot)).json.servers ?? [];
  if (!servers.length) throw new Error("the seed registered no MCP server — nothing to govern");
  const server = servers[0];
  const tools = (await api("GET", `${base}/v1/servers/${server.id}/tools`, undefined, boot)).json.tools ?? [];
  if (!tools.length) throw new Error("the seeded server has no tools — nothing to govern");
  const tool = tools[0];
  // AER-028: a real seeded project, so the `project_id` the plugin sends is a
  // uuid the PDP can resolve rather than a literal that would be refused.
  const projects = (await api("GET", `${base}/v1/projects`, undefined, boot)).json.projects ?? [];
  if (!projects.length) throw new Error("the seed created no project — the context assertion needs one");
  const project = projects[0];

  const entitled = users.find((u) => u.email === "dana@regulait.local") ?? users[0];
  const stranger = users.find((u) => u.id !== entitled.id);
  if (!stranger) throw new Error("the seed has only one user — the spoof case needs two");

  // give the entitled user exactly this tool, and make sure the stranger has nothing
  await api("POST", `${base}/v1/grants/tools`,
    { userId: entitled.id, serverId: server.id, toolName: tool.name }, boot);

  // A PURPOSE-SCOPED PDP CREDENTIAL (AER-027), not an administrator key.
  //
  // This used to mint an admin API key, because `/v1/authz/check` was
  // admin-gated and nothing else could reach it — so the harness modelled, and
  // the docs recommended, putting a control-plane administrator token inside a
  // data-plane proxy. A 'pdp' virtual key reaches that one route and nothing
  // else: it cannot dispatch, cannot read a ledger and cannot mint another key.
  //
  // The harness uses it because a verification that exercises a MORE privileged
  // credential than the product recommends is verifying the wrong deployment.
  const admin = users.find((u) => u.email === "admin@regulait.local");
  const key = (
    await api("POST", `${base}/v1/virtual-keys`, { name: "kong-e2e-pdp", userId: admin.id, purpose: "pdp" }, boot)
  ).json;
  const pdpKey = key.token ?? key.key;
  if (!pdpKey) throw new Error(`could not mint a PDP key: ${JSON.stringify(key).slice(0, 200)}`);
  // remembered so `finally` can revoke it even when an assertion below throws
  scratchKeyId = key.id ?? null;
  scratchBase = base;
  scratchBoot = boot;

  // AER-034 — a THIRD subject, entitled to the tool AND caught by an approval
  // rule, so the `approval_required` branch can be asserted end to end. It needs
  // its own user because the entitled consumer's `allow` is the control for
  // every other case: putting a rule on THEM would turn assertion (b) into a
  // different test.
  const pending = (
    await api("POST", `${base}/v1/users`, { email: `kong-pending-${Date.now()}@kong.example`, displayName: "Kong pending" }, boot)
  ).json;
  if (!pending?.id) throw new Error(`could not create the approval-required subject: ${JSON.stringify(pending).slice(0, 200)}`);
  await api("POST", `${base}/v1/grants/tools`, { userId: pending.id, serverId: server.id, toolName: tool.name }, boot);
  const rule = await api(
    "POST",
    `${base}/v1/rules/approvals`,
    {
      scope: "user",
      userId: pending.id,
      serverScope: "server",
      serverId: server.id,
      toolName: tool.name,
      approverUserId: admin.id,
    },
    boot,
  );
  if (rule.status !== 201) {
    throw new Error(`could not create the approval rule: ${rule.status} ${JSON.stringify(rule.json).slice(0, 200)}`);
  }

  // AER-026 — a DEACTIVATED subject whose grant survives. ADR-0022's
  // deactivate-is-not-delete keeps every grant, which is exactly why the PDP
  // has to refuse on the account's state rather than on its entitlements: an
  // offboarded user with a Kong consumer still mapped to them is the realistic
  // shape of this, and "sign-in is blocked" is not "the tools are blocked".
  const disabled = (
    await api("POST", `${base}/v1/users`, { email: `kong-disabled-${Date.now()}@kong.example`, displayName: "Kong disabled" }, boot)
  ).json;
  if (!disabled?.id) throw new Error(`could not create the deactivated subject: ${JSON.stringify(disabled).slice(0, 200)}`);
  await api("POST", `${base}/v1/grants/tools`, { userId: disabled.id, serverId: server.id, toolName: tool.name }, boot);
  const deactivated = await api("POST", `${base}/v1/users/${disabled.id}/deactivate`, { reason: "kong harness" }, boot);
  if (deactivated.status !== 200) {
    throw new Error(`could not deactivate the subject: ${deactivated.status} ${JSON.stringify(deactivated.json).slice(0, 200)}`);
  }

  // AER-030 — A SECOND ROUTE BOUND TO A DISTINCT SERVER AND TOOL, with the
  // entitlements CROSSED: the entitled consumer is allowed on route A and
  // refused on route B, a second consumer the other way round. Every earlier
  // route in this file bound the same server/tool, so a plugin that ignored
  // its per-route config and asked one question for all of them would have
  // passed every assertion — the per-route binding is the whole reason the
  // plugin replaced the pre-function (handler.lua, reason 3), and it had never
  // been tested.
  //
  // Tool B is a READ tool on the OTHER seeded server that the PDP already
  // refuses the entitled user; found by asking the PDP rather than by assuming
  // the seed's order, because the seed's roles make several tools hers.
  const serverB = servers.find((s) => s.id !== server.id);
  if (!serverB) throw new Error("the seed registered one server — the two-route case needs two");
  const toolsB = ((await api("GET", `${base}/v1/servers/${serverB.id}/tools`, undefined, boot)).json.tools ?? [])
    .filter((t) => t.kind === "read");
  let toolB = null;
  for (const t of toolsB) {
    const probe = await api("POST", `${base}/v1/authz/check`,
      { userId: entitled.id, serverId: serverB.id, toolName: t.name }, boot);
    if (probe.json.decision === "deny") {
      toolB = t;
      break;
    }
  }
  if (!toolB) throw new Error(`no read tool on ${serverB.name} refuses the entitled user — the crossed case needs one`);
  const other = (
    await api("POST", `${base}/v1/users`, { email: `kong-other-${Date.now()}@kong.example`, displayName: "Kong other" }, boot)
  ).json;
  if (!other?.id) throw new Error(`could not create the second route's subject: ${JSON.stringify(other).slice(0, 200)}`);
  await api("POST", `${base}/v1/grants/tools`, { userId: other.id, serverId: serverB.id, toolName: toolB.name }, boot);

  // Kong's OWN ids for its consumers, declared rather than left to Kong's
  // deterministic generation, so assertion (n) can check the exact identity
  // the ledger recorded rather than only a username.
  const kongIds = {
    entitled: randomUUID(),
    stranger: randomUUID(),
    pending: randomUUID(),
    other: randomUUID(),
    unmapped: randomUUID(),
    ambiguous: randomUUID(),
    deleted: randomUUID(),
    disabled: randomUUID(),
    anonymous: randomUUID(),
  };

  // ---- 4. Kong, DB-less, with the plugin mounted -------------------------
  // The declarative config is GENERATED because `custom_id` must carry a real
  // RegulAIt user UUID that only exists after seeding. A checked-in kong.yml
  // could never express that, which is itself part of why the first adapter
  // reached for an environment variable.
  const dir = mkdtempSync(path.join(tmpdir(), "kong-e2e-"));
  scratchDir = dir;
  // `mkdtemp` creates the directory 0700 and owned by THIS user; Kong runs as
  // the `kong` user inside the container and cannot traverse it. That is the
  // whole of the first real container failure — "Permission denied" parsing the
  // declarative config, nothing to do with its contents or the plugin.
  chmodSync(dir, 0o755);
  const declarative = `_format_version: "3.0"
services:
  - name: governed
    url: http://host.docker.internal:${UPSTREAM_PORT}
    routes:
      - name: governed-route
        paths: ["/governed"]
        strip_path: true
      # AER-034 — two more governed routes, differing ONLY in where their plugin
      # instance points its PDP. A plugin's config is per route, which is what
      # makes "the same upstream, a broken decision point" expressible at all.
      - name: pdp-500-route
        paths: ["/pdp-500"]
        strip_path: true
      - name: pdp-junk-route
        paths: ["/pdp-junk"]
        strip_path: true
      # AER-036 — a route whose DECLARED session origin contradicts the
      # credential its auth plugin actually presents. key-auth means the origin
      # is observably 'api_key'; the config below declares 'oidc'. That is the
      # exact shape this harness used to SHIP (key-auth plus session_origin:
      # "sso"), so it is now a route whose only job is to be refused.
      - name: origin-lie-route
        paths: ["/origin-lie"]
        strip_path: true
      # AER-026 — a route whose key-auth falls back to an ANONYMOUS consumer
      # when authentication fails, and that consumer is mapped to the entitled
      # user. This is the shape in which "a subject header with no credential"
      # still reaches the plugin with a consumer set: the plugin must notice
      # that nobody presented anything and refuse, never decide as that user.
      - name: anonymous-route
        paths: ["/anonymous"]
        strip_path: true
      # AER-030 — the second governed route, bound to a DIFFERENT server and
      # tool than governed-route. Same upstream, same PDP, same auth plugin:
      # the only thing that differs is the plugin instance's config, which is
      # what makes "each route asks about what IT fronts" testable at all.
      - name: second-route
        paths: ["/second"]
        strip_path: true
consumers:
  - username: entitled
    id: "${kongIds.entitled}"
    custom_id: "${entitled.id}"
    keyauth_credentials:
      - key: entitled-key
  # AER-030 — entitled to tool B on server B and to nothing on server A
  - username: other
    id: "${kongIds.other}"
    custom_id: "${other.id}"
    keyauth_credentials:
      - key: other-key
  - username: stranger
    id: "${kongIds.stranger}"
    custom_id: "${stranger.id}"
    keyauth_credentials:
      - key: stranger-key
  - username: pending
    id: "${kongIds.pending}"
    custom_id: "${pending.id}"
    keyauth_credentials:
      - key: pending-key
  # AER-026 — the identities the plugin must refuse BEFORE asking anyone.
  # No custom_id at all: nothing to decide about.
  - username: unmapped
    id: "${kongIds.unmapped}"
    keyauth_credentials:
      - key: unmapped-key
  # A custom_id that is a human identity rather than the user's primary key.
  # It is not a mapping to ONE user, and the PDP would refuse the question as
  # malformed — which the plugin must report as a mapping error, not an outage.
  - username: ambiguous
    id: "${kongIds.ambiguous}"
    custom_id: "${entitled.email}"
    keyauth_credentials:
      - key: ambiguous-key
  # A well-formed user id that names nobody — the shape of a deleted identity
  # in a product with no hard delete (ADR-0022): a consumer left pointing at an
  # account that is gone, or that never existed here.
  - username: deleted
    id: "${kongIds.deleted}"
    custom_id: "${randomUUID()}"
    keyauth_credentials:
      - key: deleted-key
  # A deactivated user, grant intact.
  - username: disabled
    id: "${kongIds.disabled}"
    custom_id: "${disabled.id}"
    keyauth_credentials:
      - key: disabled-key
  # The anonymous fallback for anonymous-route: no credentials, and mapped to
  # the ENTITLED user — the worst configuration an operator could ship.
  - username: anonymous
    id: "${kongIds.anonymous}"
    custom_id: "${entitled.id}"
plugins:
  - name: key-auth
    route: governed-route
    config:
      key_names: ["apikey"]
  - name: regulait-authz
    route: governed-route
    config:
      pdp_url: "http://host.docker.internal:${GATEWAY_PORT}"
      # A VAULT REFERENCE, NOT THE SECRET. The declarative file has to be
      # readable by the \`kong\` user inside the container, and the first version
      # achieved that by chmod 0644 — with a plaintext UNRESTRICTED ADMIN TOKEN
      # inside it. On a CI runner that is ephemeral; on a developer's machine it
      # is a durable control-plane credential sitting world-readable in /tmp.
      # The key now arrives as an environment variable the container resolves at
      # read time, which is also exactly the pattern this repo tells operators
      # to use (\`referenceable = true\` on the field is what permits it), so the
      # harness exercises the recommended secret handling instead of a shortcut
      # no customer should copy.
      pdp_key: "{vault://env/regulait-pdp-key}"
      server_id: "${server.id}"
      tool_name: "${tool.name}"
      # AER-028's context, on the route that fronts the tool. Sent so assertion
      # (f) below can prove the adapter really carries it rather than the README
      # claiming it does.
      project_id: "${project.id}"
      # AER-036 — NO declared origin here, on purpose. This route runs key-auth,
      # so the origin is DERIVED from the credential Kong actually authenticated
      # with ('api_key'), and assertion (i) checks the exact value that reached
      # the ledger. The previous version of this file declared 'sso' on this very
      # route, which is what made the finding demonstrable from the shipped
      # example rather than only in theory.
      timeout_ms: 2000
  # The two broken-PDP routes. key-auth on each, because the plugin refuses an
  # unauthenticated request before it ever calls a PDP — without auth these would
  # assert the wrong branch.
  - name: key-auth
    route: pdp-500-route
    config:
      key_names: ["apikey"]
  - name: regulait-authz
    route: pdp-500-route
    config:
      # the plugin appends /v1/authz/check, so this resolves to the upstream's
      # non-counting stub path that answers 500
      pdp_url: "http://host.docker.internal:${UPSTREAM_PORT}/__pdp500"
      pdp_key: "{vault://env/regulait-pdp-key}"
      server_id: "${server.id}"
      tool_name: "${tool.name}"
      timeout_ms: 2000
  - name: key-auth
    route: pdp-junk-route
    config:
      key_names: ["apikey"]
  - name: regulait-authz
    route: pdp-junk-route
    config:
      # 200 with a body cjson cannot decode — an unreadable answer must refuse,
      # never be treated as an allow
      pdp_url: "http://host.docker.internal:${UPSTREAM_PORT}/__pdpjunk"
      pdp_key: "{vault://env/regulait-pdp-key}"
      server_id: "${server.id}"
      tool_name: "${tool.name}"
      timeout_ms: 2000
  - name: key-auth
    route: origin-lie-route
    config:
      key_names: ["apikey"]
  - name: regulait-authz
    route: origin-lie-route
    config:
      # A WORKING PDP. The refusal under test must come from the contradiction
      # and not from a broken decision point, so this points at the real gateway
      # exactly as the governed route does.
      pdp_url: "http://host.docker.internal:${GATEWAY_PORT}"
      pdp_key: "{vault://env/regulait-pdp-key}"
      server_id: "${server.id}"
      tool_name: "${tool.name}"
      # key-auth is on this route, so the credential says 'api_key'. Declaring
      # 'oidc' is the lie, and the plugin must refuse rather than send either
      # value: the declared one is false, and silently substituting the derived
      # one would override a policy intent nobody revisited.
      asserted_session_origin: "oidc"
      timeout_ms: 2000
  - name: key-auth
    route: anonymous-route
    config:
      key_names: ["apikey"]
      anonymous: "${kongIds.anonymous}"
  - name: regulait-authz
    route: anonymous-route
    config:
      # A WORKING PDP, so the refusal under test can only be the plugin's own.
      pdp_url: "http://host.docker.internal:${GATEWAY_PORT}"
      pdp_key: "{vault://env/regulait-pdp-key}"
      server_id: "${server.id}"
      tool_name: "${tool.name}"
      timeout_ms: 2000
  - name: key-auth
    route: second-route
    config:
      key_names: ["apikey"]
  - name: regulait-authz
    route: second-route
    config:
      pdp_url: "http://host.docker.internal:${GATEWAY_PORT}"
      pdp_key: "{vault://env/regulait-pdp-key}"
      # THE DISTINCT BINDING (AER-030)
      server_id: "${serverB.id}"
      tool_name: "${toolB.name}"
      project_id: "${project.id}"
      timeout_ms: 2000
`;
  writeFileSync(path.join(dir, "kong.yml"), declarative);
  chmodSync(path.join(dir, "kong.yml"), 0o644);

  // Best-effort: on the FIRST run there is no such container and `docker rm -f`
  // exits non-zero, which would fail the harness before it started. Found by
  // running this locally as far as the daemon boundary.
  try {
    sh("docker", ["rm", "-f", "regulait-kong-e2e"], { stdio: "pipe" });
  } catch {
    /* nothing to remove */
  }
  sh("docker", [
    "run", "-d", "--name", "regulait-kong-e2e",
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${dir}:/kong/declarative`,
    "-v", `${path.join(repoRoot, "integrations/kong/kong")}:/opt/regulait/kong`,
    // The secret, out of band of the config file. Visible to `docker inspect`
    // for whoever can already talk to the daemon — strictly better than a
    // world-readable file, and it is what the vault reference above resolves.
    "-e", `REGULAIT_PDP_KEY=${pdpKey}`,
    "-e", "KONG_DATABASE=off",
    // WITHOUT THESE, A FATAL STARTUP ERROR IS INVISIBLE. Kong writes its error
    // log to a file inside the container by default, so `docker logs` came back
    // EMPTY on the first run and the only signal was a 60s timeout — a harness
    // that cannot say why it failed is barely better than no harness.
    "-e", "KONG_PROXY_ERROR_LOG=/dev/stderr",
    "-e", "KONG_ADMIN_ERROR_LOG=/dev/stderr",
    "-e", "KONG_PROXY_ACCESS_LOG=/dev/stdout",
    "-e", "KONG_LOG_LEVEL=info",
    "-e", "KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.yml",
    "-e", "KONG_PLUGINS=bundled,regulait-authz",
    "-e", "KONG_LUA_PACKAGE_PATH=/opt/regulait/?.lua;;",
    "-e", `KONG_PROXY_LISTEN=0.0.0.0:${KONG_PROXY_PORT}`,
    "-p", `${KONG_PROXY_PORT}:${KONG_PROXY_PORT}`,
    KONG_IMAGE,
  ]);
  kongStarted = true;

  const proxy = `http://127.0.0.1:${KONG_PROXY_PORT}/governed/anything`;

  // A CONTAINER THAT DIED IS NOT A CONTAINER THAT IS SLOW. Distinguishing the
  // two is the difference between a 3-second answer and a 60-second timeout
  // that says nothing: poll the container's STATE, and fail the moment it has
  // exited rather than waiting out the clock on something already dead.
  const state = () => {
    try {
      return sh("docker", ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", "regulait-kong-e2e"]).trim();
    } catch {
      return "gone 1";
    }
  };
  const dumpKong = (why) => {
    console.error(`--- kong container (${why}): ${state()} ---`);
    console.error(shBoth("docker logs regulait-kong-e2e").slice(-8000) || "(container produced no output at all)");
    // Kong validates the declarative config at boot; if that is what rejected
    // it, this prints the actual complaint instead of leaving it to inference.
    console.error("--- kong config parse ---");
    console.error(
      shBoth(`docker run --rm -v ${dir}:/kong/declarative ${KONG_IMAGE} kong config parse /kong/declarative/kong.yml`),
    );
    console.error("--- the generated declarative config ---");
    // The file no longer contains the secret (it holds a vault reference), but
    // the redaction stays: a dump that depends on the file never regaining one
    // is a dump that leaks the day it does.
    console.error(shBoth(`cat ${path.join(dir, "kong.yml")}`).replace(/pdp_key: "[^"]*"/, 'pdp_key: "<redacted>"'));
  };

  // Its own loop rather than waitFor(): waitFor swallows exceptions and retries,
  // which is right for "not up yet" and exactly wrong for "already dead" — the
  // early exit has to be a return, not a throw, or it is silently retried until
  // the timeout it was added to avoid.
  {
    const deadline = Date.now() + 90_000;
    let reason = "timeout";
    let up = false;
    for (;;) {
      const st = state();
      if (!st.startsWith("running")) {
        reason = `container is '${st}'`;
        break;
      }
      if ((await fetch(proxy).catch(() => null)) !== null) {
        up = true;
        break;
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) {
      dumpKong(reason);
      throw new Error(`Kong did not come up: ${reason}`);
    }
  }

  console.log("\nassertions:");

  // (a) NO CREDENTIAL -> key-auth refuses, and nothing is proxied.
  await upstreamReset();
  let r = await fetch(proxy);
  check("an unauthenticated request never reaches the upstream",
    r.status === 401 && (await upstreamCount()) === 0, `status ${r.status}`);
  // AER-026 — and a subject header changes nothing about that: with no
  // credential there is no consumer, so the plugin never sees this request
  // and key-auth's refusal stands.
  r = await fetch(proxy, { headers: { "x-regulait-subject": entitled.id } });
  check("a subject header on a request with NO credential is still refused by key-auth",
    r.status === 401 && (await upstreamCount()) === 0, `status ${r.status}`);

  // (b) ALLOW -> the upstream IS reached. The control for every case below.
  await upstreamReset();
  r = await fetch(proxy, { headers: { apikey: "entitled-key" } });
  check("an entitled consumer reaches the upstream",
    r.status === 200 && (await upstreamCount()) === 1, `status ${r.status}, count ${await upstreamCount()}`);
  // and what reached it carried none of our protocol headers — the upstream is
  // the only place that claim can be checked
  {
    const last = await upstreamLast();
    const leaked = Object.keys(last?.headers ?? {}).filter((h) => h.startsWith("x-regulait-"));
    check("the proxied request carries no x-regulait-* header",
      last !== null && leaked.length === 0, `leaked=${JSON.stringify(leaked)}`);
  }

  // (c) DENY -> 403 AND zero upstream calls. This is the assertion the Envoy
  //     adapter would have failed while looking correct from the client side.
  await upstreamReset();
  r = await fetch(proxy, { headers: { apikey: "stranger-key" } });
  check("a denied consumer is refused AND the upstream is never called",
    r.status === 403 && (await upstreamCount()) === 0,
    `status ${r.status}, upstream count ${await upstreamCount()}`);

  // (d) FORGED SUBJECT -> a header naming the entitled user is REFUSED, with
  //     its own reason, whoever sends it. The stranger must not borrow an
  //     entitlement; the entitled consumer must not get through either,
  //     because "ignored" cannot be told from "honoured" in an access log and
  //     a forgery attempt is something an operator should see.
  await upstreamReset();
  for (const h of ["x-regulait-subject", "X-Regulait-Subject", "X-REGULAIT-SUBJECT"]) {
    r = await fetch(proxy, { headers: { apikey: "stranger-key", [h]: entitled.id } });
    check(`a forged ${h} does not borrow another user's entitlement`,
      r.status === 403 && r.headers.get("x-regulait-reason") === "forged_protocol_header" &&
        (await upstreamCount()) === 0,
      `status ${r.status}, reason ${r.headers.get("x-regulait-reason")}, upstream count ${await upstreamCount()}`);
  }
  r = await fetch(proxy, { headers: { apikey: "entitled-key", "x-regulait-subject": entitled.id } });
  check("a forged subject header is refused even from the consumer it names",
    r.status === 403 && r.headers.get("x-regulait-reason") === "forged_protocol_header" &&
      (await upstreamCount()) === 0,
    `status ${r.status}, reason ${r.headers.get("x-regulait-reason")}, upstream count ${await upstreamCount()}`);

  // (d2) DUPLICATE SUBJECT HEADERS (AER-026) — the same header twice, in two
  //      spellings, on two lines, which `fetch` cannot send. Whichever line a
  //      naive reader took, the request must be refused outright.
  await upstreamReset();
  for (const key of ["stranger-key", "entitled-key"]) {
    const raw = await rawRequest(KONG_PROXY_PORT, "/governed/anything", [
      `apikey: ${key}`,
      `x-regulait-subject: ${entitled.id}`,
      `X-Regulait-Subject: ${stranger.id}`,
    ]);
    check(`duplicate subject headers from ${key} are refused and never proxied`,
      raw.status === 403 && raw.headers["x-regulait-reason"] === "forged_protocol_header" &&
        (await upstreamCount()) === 0,
      `status ${raw.status}, reason ${raw.headers["x-regulait-reason"]}, upstream count ${await upstreamCount()}`);
  }

  // (k) THE IDENTITIES REFUSED BEFORE ANYONE IS ASKED (AER-026). Each is a
  //     consumer key-auth accepts, so the plugin — not the auth plugin — is
  //     what refuses, and each names its refusal so an operator is sent to the
  //     consumer mapping rather than to a policy.
  for (const [key, reason, what] of [
    ["unmapped-key", "consumer_not_mapped", "a consumer with no custom_id"],
    ["ambiguous-key", "consumer_not_mapped", "a consumer whose custom_id is an email, not a user id"],
  ]) {
    await upstreamReset();
    r = await fetch(proxy, { headers: { apikey: key } });
    check(`${what} is refused as '${reason}' and never proxied`,
      r.status === 403 && r.headers.get("x-regulait-reason") === reason && (await upstreamCount()) === 0,
      `status ${r.status}, reason ${r.headers.get("x-regulait-reason")}, upstream count ${await upstreamCount()}`);
  }
  // the two the PDP has to answer: a well-formed id nobody has, and a
  // deactivated account whose grant is still in place
  for (const [key, reason, what] of [
    ["deleted-key", "unknown_subject", "a consumer mapped to a user id nobody has"],
    ["disabled-key", "subject_disabled", "a consumer mapped to a DEACTIVATED user with a live grant"],
  ]) {
    await upstreamReset();
    r = await fetch(proxy, { headers: { apikey: key } });
    check(`${what} is refused as '${reason}' and never proxied`,
      r.status === 403 && r.headers.get("x-regulait-decision") === "deny" &&
        r.headers.get("x-regulait-reason") === reason && (await upstreamCount()) === 0,
      `status ${r.status}, reason ${r.headers.get("x-regulait-reason")}, upstream count ${await upstreamCount()}`);
  }
  // NON-VACUITY for the deactivated case: reactivate the account and the
  // same consumer, key and grant are allowed — so the refusal above was the
  // deactivation and not a missing entitlement.
  {
    const re = await api("POST", `${base}/v1/users/${disabled.id}/reactivate`, {}, boot);
    await upstreamReset();
    r = await fetch(proxy, { headers: { apikey: "disabled-key" } });
    check("control: the same consumer is allowed once the account is reactivated",
      re.status === 200 && r.status === 200 && (await upstreamCount()) === 1,
      `reactivate ${re.status}, status ${r.status}, count ${await upstreamCount()}`);
  }

  // (m) A SUBJECT HEADER WITH NO CREDENTIAL, on the route whose key-auth falls
  //     back to an anonymous consumer mapped to the ENTITLED user. Kong sets a
  //     consumer here with no credential behind it; the plugin must refuse as
  //     unauthenticated rather than decide as the user that consumer names.
  {
    const anon = `http://127.0.0.1:${KONG_PROXY_PORT}/anonymous/anything`;
    await upstreamReset();
    r = await fetch(anon);
    check("no credential + an anonymous consumer mapped to a real user is refused as unauthenticated",
      r.status === 403 && r.headers.get("x-regulait-reason") === "unauthenticated" && (await upstreamCount()) === 0,
      `status ${r.status}, reason ${r.headers.get("x-regulait-reason")}, upstream count ${await upstreamCount()}`);
    r = await fetch(anon, { headers: { "x-regulait-subject": entitled.id } });
    check("and a subject header on that request is refused too, before anything else",
      r.status === 403 && (await upstreamCount()) === 0,
      `status ${r.status}, upstream count ${await upstreamCount()}`);
    // the route itself works for a real credential, so the two refusals above
    // are the plugin's and not a broken route
    await upstreamReset();
    r = await fetch(anon, { headers: { apikey: "entitled-key" } });
    check("control: the anonymous-fallback route proxies a REAL credential",
      r.status === 200 && (await upstreamCount()) === 1,
      `status ${r.status}, count ${await upstreamCount()}`);
  }

  // (o) TWO ROUTES, TWO BINDINGS, CROSSED ENTITLEMENTS (AER-030). Route A
  //     fronts tool A, route B fronts tool B on another server; `entitled` may
  //     use A only, `other` may use B only. Four requests, two allowed and two
  //     refused, and the refusals can only come from each route asking about
  //     ITS OWN binding — a plugin asking one question for every route would
  //     answer the same way on both.
  const second = `http://127.0.0.1:${KONG_PROXY_PORT}/second/anything`;
  await upstreamReset();
  r = await fetch(second, { headers: { apikey: "other-key" } });
  check("route B: the consumer entitled to tool B reaches the upstream",
    r.status === 200 && (await upstreamCount()) === 1, `status ${r.status}, count ${await upstreamCount()}`);
  await upstreamReset();
  r = await fetch(proxy, { headers: { apikey: "other-key" } });
  check("route A: the same consumer is refused — route A asks about tool A, which it lacks",
    r.status === 403 && (await upstreamCount()) === 0, `status ${r.status}, count ${await upstreamCount()}`);
  await upstreamReset();
  r = await fetch(second, { headers: { apikey: "entitled-key" } });
  check("route B: the consumer entitled to tool A is refused — route B asks about tool B",
    r.status === 403 && r.headers.get("x-regulait-decision") === "deny" && (await upstreamCount()) === 0,
    `status ${r.status}, decision ${r.headers.get("x-regulait-decision")}, count ${await upstreamCount()}`);
  // (the fourth leg, entitled on route A, is assertion (b) above)

  // (p) FORGED SERVER / TOOL / DECISION HEADERS (AER-030) — each sent by the
  //     consumer the claim would have helped, each refused with its own reason
  //     before any question is asked, and nothing proxied. The binding comes
  //     from the route's config and the decision from the PDP; a request
  //     cannot name either.
  for (const [key, url, forged, what] of [
    ["other-key", proxy, { "x-regulait-server-id": serverB.id, "x-regulait-tool": toolB.name },
      "a consumer refused on route A claims route A fronts the tool it IS entitled to"],
    ["entitled-key", second, { "x-regulait-server-id": server.id, "x-regulait-tool": tool.name },
      "a consumer refused on route B claims route B fronts tool A"],
    ["stranger-key", proxy, { "x-regulait-decision": "allow" },
      "a denied consumer asserts the decision"],
    ["stranger-key", proxy, { "x-regulait-decision": "allow", "x-regulait-reason": "forged" },
      "a denied consumer asserts the decision and its reason"],
    ["entitled-key", proxy, { "x-regulait-decision": "allow" },
      "an entitled consumer asserting the decision is refused all the same"],
  ]) {
    await upstreamReset();
    r = await fetch(url, { headers: { apikey: key, ...forged } });
    check(`${what}: refused as forged_protocol_header, never proxied`,
      r.status === 403 && r.headers.get("x-regulait-reason") === "forged_protocol_header" &&
        (await upstreamCount()) === 0,
      `status ${r.status}, reason ${r.headers.get("x-regulait-reason")}, count ${await upstreamCount()}`);
  }

  // (f) APPROVAL_REQUIRED — a DENY that is not a policy refusal (AER-034).
  //     The README claimed this was asserted and it was not. It is the one
  //     outcome a proxy filter cannot express (two outcomes, no third), so it
  //     maps to a 403 — and it must ALSO carry the header that keeps it
  //     distinguishable from "never", because that distinction is the entire
  //     reason the approvals queue exists. Zero upstream calls, like every
  //     other refusal.
  await upstreamReset();
  r = await fetch(proxy, { headers: { apikey: "pending-key" } });
  check("an approval_required is refused, named in a header, and never proxied",
    r.status === 403 &&
      r.headers.get("x-regulait-decision") === "approval_required" &&
      (await upstreamCount()) === 0,
    `status ${r.status}, decision ${r.headers.get("x-regulait-decision")}, count ${await upstreamCount()}`);

  // (g) A PDP THAT ANSWERS NON-200 (AER-034). A different branch from the
  //     unreachable case below — `res.status ~= 200` rather than `not res` —
  //     and the README claimed both. An answer the adapter will not act on must
  //     fail CLOSED.
  await upstreamReset();
  r = await fetch(`http://127.0.0.1:${KONG_PROXY_PORT}/pdp-500`, { headers: { apikey: "entitled-key" } });
  check("a PDP that answers non-200 fails CLOSED and proxies nothing",
    r.status >= 400 && (await upstreamCount()) === 0,
    `status ${r.status}, count ${await upstreamCount()}`);

  // (h) A PDP THAT ANSWERS UNPARSEABLY. The nastiest of the three: a 200 with a
  //     body the plugin cannot read is the shape most likely to be mistaken for
  //     success by a `if status == 200 then proceed` adapter.
  await upstreamReset();
  r = await fetch(`http://127.0.0.1:${KONG_PROXY_PORT}/pdp-junk`, { headers: { apikey: "entitled-key" } });
  check("a PDP whose answer cannot be parsed fails CLOSED and proxies nothing",
    r.status >= 400 && (await upstreamCount()) === 0,
    `status ${r.status}, count ${await upstreamCount()}`);

  // (i) THE QUESTION THE ADAPTER ASKS (AER-028). The README claimed the callout
  //     carried context and the plugin sent three fields. The PDP records what
  //     each decision was actually computed on, so the ledger is the place to
  //     check it — asserting on the plugin's source would only restate the code.
  {
    const rows = (await api("GET", `${base}/v1/audit?limit=200`, undefined, boot)).json.entries ?? [];
    const callouts = rows.filter((r) => (r.detail ?? {}).contextApplied !== undefined);
    const detail = callouts.length ? (callouts[0].detail ?? {}) : null;
    const applied = detail ? (detail.contextApplied ?? []) : null;
    check("the adapter sends the decision context it claims to",
      applied !== null && applied.includes("projectId") && applied.includes("principal"),
      `contextApplied=${JSON.stringify(applied)} over ${callouts.length} callout row(s) in the newest 200`);
    // and it does NOT claim to send arguments, which it cannot map correctly —
    // an adapter that reported `args` without one would be the worse failure
    check("the adapter does not claim to send tool arguments it cannot map",
      applied !== null && !applied.includes("args"),
      `contextApplied=${JSON.stringify(applied)}`);

    // AER-036 — THE EXACT VALUE AND ITS PROVENANCE, not the word "principal".
    //
    // The previous version of this assertion checked only that `contextApplied`
    // contained `principal`, which was satisfied by a route declaring `sso` on
    // key-auth traffic. The governed route now declares NO origin, so the only
    // way `api_key` reaches the ledger is if the plugin derived it from the
    // credential Kong authenticated with.
    check("the recorded session origin is the one DERIVED from the credential",
      (detail?.assertedPrincipal ?? {}).sessionOrigin === "api_key",
      `assertedPrincipal=${JSON.stringify(detail?.assertedPrincipal ?? null)}`);
    // and the PDP marks it as a CLAIM rather than as something it observed —
    // this route believes its caller about the subject too, and the difference
    // between the two is that this one is now stated
    check("the PDP records the origin as an ASSERTION, not as evidence",
      applied !== null && applied.includes("principal.asserted"),
      `contextApplied=${JSON.stringify(applied)}`);

    // (n) AER-026 — THE KONG CONSUMER, BESIDE THE SUBJECT IT RESOLVED TO. The
    //     row's `userId` is what the mapping produced; `proxyConsumer` is what
    //     it was produced FROM. The exact Kong id, not only the username,
    //     because the username is what an operator would re-use by mistake.
    const entitledRows = rows.filter(
      (row) => row.userId === entitled.id && (row.detail ?? {}).proxyConsumer !== undefined,
    );
    const pc = entitledRows.length ? entitledRows[0].detail.proxyConsumer : null;
    check("the ledger row carries the Kong consumer identity beside the resolved subject",
      pc !== null && pc.id === kongIds.entitled && pc.username === "entitled",
      `proxyConsumer=${JSON.stringify(pc)} on ${entitledRows.length} row(s) for the entitled subject`);
    // and the DEACTIVATED subject's refusal is on the ledger under ITS consumer
    const disabledRows = rows.filter((row) => row.userId === disabled.id && row.ruleId === "subject_disabled");
    const dpc = disabledRows.length ? (disabledRows[0].detail ?? {}).proxyConsumer ?? null : null;
    check("a deactivated subject's refusal is filed under the consumer that presented it",
      dpc !== null && dpc.id === kongIds.disabled && dpc.username === "disabled",
      `proxyConsumer=${JSON.stringify(dpc)} on ${disabledRows.length} subject_disabled row(s)`);

    // (o, continued) AER-030 — THE LEDGER SHOWS EACH ROUTE ASKED ABOUT ITS OWN
    //     BINDING. `other`'s rows must include an allow on (server B, tool B)
    //     and a deny on (server A, tool A); `entitled` must have a deny on
    //     (server B, tool B). A plugin asking one question for both routes
    //     could not produce that set.
    const byConsumer = (name) => rows.filter((row) => ((row.detail ?? {}).proxyConsumer ?? {}).username === name);
    const otherRows = byConsumer("other");
    const otherAllowB = otherRows.some(
      (row) => row.effect === "allow" && row.serverId === serverB.id && row.toolName === toolB.name,
    );
    const otherDenyA = otherRows.some(
      (row) => row.effect === "deny" && row.serverId === server.id && row.toolName === tool.name,
    );
    const entitledDenyB = byConsumer("entitled").some(
      (row) => row.effect === "deny" && row.serverId === serverB.id && row.toolName === toolB.name,
    );
    check("the ledger shows route B asked about server B / tool B and route A about server A / tool A",
      otherAllowB && otherDenyA && entitledDenyB,
      `other: allow(B)=${otherAllowB} deny(A)=${otherDenyA}; entitled: deny(B)=${entitledDenyB} over ${otherRows.length} row(s) for 'other'`);
  }

  // (i2) AER-036 — A DECLARED ORIGIN THAT CONTRADICTS THE CREDENTIAL IS REFUSED.
  //      This is the finding's own demonstration turned into a test: key-auth on
  //      the route, `oidc` in the config. Sending either value would be wrong, so
  //      the request must be refused — and, as with every other refusal here, the
  //      upstream must not be reached, because a 403 rendered after the upstream
  //      already ran is indistinguishable from a refusal on the client side.
  await upstreamReset();
  r = await fetch(`http://127.0.0.1:${KONG_PROXY_PORT}/origin-lie`, { headers: { apikey: "entitled-key" } });
  check("a declared session origin that contradicts the credential is REFUSED",
    r.status === 403 && (await upstreamCount()) === 0,
    `status ${r.status}, count ${await upstreamCount()}`);
  // and it says WHICH refusal, so an operator is sent to the plugin config
  // rather than to a policy screen or a network
  check("and it names the contradiction rather than reading as a policy denial",
    r.headers.get("x-regulait-reason") === "session_origin_contradicts_credential",
    `reason=${r.headers.get("x-regulait-reason")}`);
  // NON-VACUITY: the entitled subject really is allowed on an equivalent route,
  // so this refusal is the contradiction and not a failed entitlement
  await upstreamReset();
  r = await fetch(`http://127.0.0.1:${KONG_PROXY_PORT}/governed`, { headers: { apikey: "entitled-key" } });
  check("control: the same subject and credential ARE allowed where nothing is contradicted",
    r.status === 200 && (await upstreamCount()) === 1,
    `status ${r.status}, count ${await upstreamCount()}`);

  // (j) PDP DOWN -> fail closed, and still nothing proxied. An outage that
  //     silently becomes an open door is the worst shape this can take.
  //
  //     LAST ON PURPOSE, and lettered out of sequence to say so: it KILLS the
  //     gateway, so every assertion that needs a live PDP — including (i), which
  //     reads the PDP's own ledger — has to have run already.
  await upstreamReset();
  gateway.kill("SIGKILL");
  await new Promise((r2) => setTimeout(r2, 1500));
  r = await fetch(proxy, { headers: { apikey: "entitled-key" } });
  check("an unreachable PDP fails CLOSED and proxies nothing",
    r.status >= 400 && (await upstreamCount()) === 0,
    `status ${r.status}, upstream count ${await upstreamCount()}`);
}

try {
  await main();
} catch (e) {
  console.error("\nharness error:", e instanceof Error ? e.message : e);
  failures.push("harness");
} finally {
  if (kongStarted) {
    try {
      console.log("\n--- kong logs (tail) ---\n" + shBoth("docker logs --tail 40 regulait-kong-e2e"));
    } catch {
      /* best effort */
    }
    try {
      sh("docker", ["rm", "-f", "regulait-kong-e2e"], { stdio: "pipe" });
    } catch {
      /* best effort */
    }
  }
  // AER-033 residual: revoke the scratch credential before anything else, so a
  // failure in the steps after it still leaves no live key behind.
  if (scratchKeyId && scratchBase && scratchBoot) {
    try {
      await api("DELETE", `${scratchBase}/v1/virtual-keys/${scratchKeyId}`, undefined, scratchBoot);
    } catch {
      /* best effort — the gateway may already be dead from assertion (e) */
    }
  }
  gateway?.kill("SIGKILL");
  upstream?.kill("SIGKILL");
  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  try {
    sh("psql", [`${PG}/postgres`, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`], {
      stdio: "pipe",
    });
  } catch {
    /* best effort — a leftover scratch database is recreated by the next run */
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall assertions passed — the deny path is exercised, not argued about");
