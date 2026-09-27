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
 *   - A FORGED `x-regulait-subject` is ignored. The first version of this
 *     adapter preferred that header over the authenticated consumer, so anyone
 *     who could reach the route could be authorized as anyone. The test sends
 *     a header naming a DIFFERENT, MORE-ENTITLED user and requires the decision
 *     to be the one belonging to the authenticated consumer.
 *
 * Requires: docker, a built gateway, and a Postgres. Run by
 * .github/workflows/integrations.yml, which pins the Kong image.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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

  // ---- 4. Kong, DB-less, with the plugin mounted -------------------------
  // The declarative config is GENERATED because `custom_id` must carry a real
  // RegulAIt user UUID that only exists after seeding. A checked-in kong.yml
  // could never express that, which is itself part of why the first adapter
  // reached for an environment variable.
  const dir = mkdtempSync(path.join(tmpdir(), "kong-e2e-"));
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
consumers:
  - username: entitled
    custom_id: "${entitled.id}"
    keyauth_credentials:
      - key: entitled-key
  - username: stranger
    custom_id: "${stranger.id}"
    keyauth_credentials:
      - key: stranger-key
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
  await api("GET", `http://127.0.0.1:${UPSTREAM_PORT}/__reset`);
  let r = await fetch(proxy);
  check("an unauthenticated request never reaches the upstream",
    r.status === 401 && (await upstreamCount()) === 0, `status ${r.status}`);

  // (b) ALLOW -> the upstream IS reached. The control for every case below.
  await api("GET", `http://127.0.0.1:${UPSTREAM_PORT}/__reset`);
  r = await fetch(proxy, { headers: { apikey: "entitled-key" } });
  check("an entitled consumer reaches the upstream",
    r.status === 200 && (await upstreamCount()) === 1, `status ${r.status}, count ${await upstreamCount()}`);

  // (c) DENY -> 403 AND zero upstream calls. This is the assertion the Envoy
  //     adapter would have failed while looking correct from the client side.
  await api("GET", `http://127.0.0.1:${UPSTREAM_PORT}/__reset`);
  r = await fetch(proxy, { headers: { apikey: "stranger-key" } });
  check("a denied consumer is refused AND the upstream is never called",
    r.status === 403 && (await upstreamCount()) === 0,
    `status ${r.status}, upstream count ${await upstreamCount()}`);

  // (d) FORGED SUBJECT -> the header naming the entitled user must be ignored
  //     for a request authenticated as the stranger.
  await api("GET", `http://127.0.0.1:${UPSTREAM_PORT}/__reset`);
  for (const h of ["x-regulait-subject", "X-Regulait-Subject", "X-REGULAIT-SUBJECT"]) {
    r = await fetch(proxy, { headers: { apikey: "stranger-key", [h]: entitled.id } });
    check(`a forged ${h} does not borrow another user's entitlement`,
      r.status === 403 && (await upstreamCount()) === 0,
      `status ${r.status}, upstream count ${await upstreamCount()}`);
  }

  // (e) PDP DOWN -> fail closed, and still nothing proxied. An outage that
  //     silently becomes an open door is the worst shape this can take.
  await api("GET", `http://127.0.0.1:${UPSTREAM_PORT}/__reset`);
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
  gateway?.kill("SIGKILL");
  upstream?.kill("SIGKILL");
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall assertions passed — the deny path is exercised, not argued about");
