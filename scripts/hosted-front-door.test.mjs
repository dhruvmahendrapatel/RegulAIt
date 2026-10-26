// ADR-0202 lane H: the hosted demo's HTTPS front door. The hostname comes from the box's own .env
// (REGULAIT_PUBLIC_HOST), is checked against REGULAIT_PUBLIC_URL before Caddy is pointed at it, and an
// invalid setting leaves the stack untouched instead of falling back to the address-derived name.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOSTED_CONFIG = path.join(ROOT, "infra/scripts/hosted-config.sh");
const BOOT_RESYNC = path.join(ROOT, "infra/scripts/boot-resync.sh");

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hosted-front-door-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function wantHost(envText) {
  const file = path.join(dir, ".env");
  writeFileSync(file, envText);
  const r = spawnSync("bash", [HOSTED_CONFIG, "want-host", file], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("hosted-config.sh want-host", () => {
  it("prints nothing when REGULAIT_PUBLIC_HOST is unset (the address-derived name stays)", () => {
    expect(wantHost("REGULAIT_PUBLIC_URL=https://1-2-3-4.sslip.io\n")).toEqual({ status: 0, out: "", err: "" });
    expect(wantHost("REGULAIT_PUBLIC_HOST=\n")).toEqual({ status: 0, out: "", err: "" });
  });

  it("prints the host when it and REGULAIT_PUBLIC_URL agree", () => {
    expect(wantHost("REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://demo.example.com\n").out).toBe("demo.example.com");
    // quotes, a trailing slash, `export` and CRLF line endings are tolerated
    const r = wantHost('export REGULAIT_PUBLIC_HOST="demo.example.com"\r\nREGULAIT_PUBLIC_URL=\'https://demo.example.com/\'\r\n');
    expect(r).toEqual({ status: 0, out: "demo.example.com", err: "" });
  });

  it("the last assignment wins, as it does for compose's .env", () => {
    const r = wantHost("REGULAIT_PUBLIC_HOST=old.example.com\nREGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://demo.example.com\n");
    expect(r.out).toBe("demo.example.com");
  });

  it.each([
    ["Demo.example.com", "uppercase"],
    ["demo", "a single label"],
    ["1.2.3.4", "an IPv4 literal"],
    ["localhost", "localhost"],
    ["demo.localhost", "a .localhost name"],
    ["set-regulait-tls-host.invalid", "the .invalid placeholder"],
    ["demo.example.com:443", "a port"],
    ["https://demo.example.com", "a scheme"],
    ["demo.example.com/ui", "a path"],
    ["-demo.example.com", "a label starting with a hyphen"],
    ["demo..example.com", "an empty label"],
    ["demo.example.com.", "a trailing dot"],
    [`${"a".repeat(64)}.example.com`, "a label over 63 characters"],
  ])("refuses %s (%s) with exit 2", (host) => {
    const r = wantHost(`REGULAIT_PUBLIC_HOST=${host}\nREGULAIT_PUBLIC_URL=https://${host}\n`);
    expect(r.status).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/REGULAIT_PUBLIC_HOST/);
  });

  it.each([
    ["", "unset"],
    ["http://demo.example.com", "plain http"],
    ["https://other.example.com", "another host"],
    ["https://demo.example.com:8443", "a port"],
    ["https://demo.example.com/app", "a base path"],
  ])("refuses REGULAIT_PUBLIC_URL=%s (%s): one origin, spelled once", (url) => {
    const r = wantHost(`REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=${url}\n`);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/REGULAIT_PUBLIC_URL must be https:\/\/demo\.example\.com/);
  });

  it("REGULAIT_KC_HOSTNAME, when set, must be the same name under /idp", () => {
    const base = "REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://demo.example.com\n";
    expect(wantHost(`${base}REGULAIT_KC_HOSTNAME=https://demo.example.com/idp\n`).out).toBe("demo.example.com");
    for (const kc of ["https://id.example.com", "http://demo.example.com/idp", "https://demo.example.com", "http://localhost:8080"]) {
      const r = wantHost(`${base}REGULAIT_KC_HOSTNAME=${kc}\n`);
      expect(r.status, kc).toBe(2);
      expect(r.err).toMatch(/REGULAIT_KC_HOSTNAME must be https:\/\/demo\.example\.com\/idp/);
    }
  });

  it("never executes the .env (it is parsed, not sourced)", () => {
    const marker = path.join(dir, "pwned");
    const r = wantHost(`touch ${marker}\nREGULAIT_PUBLIC_HOST=$(touch ${marker})\nREGULAIT_PUBLIC_URL=https://demo.example.com\n`);
    expect(r.status).toBe(2);
    expect(spawnSync("test", ["-e", marker]).status).toBe(1);
  });
});

describe("boot-resync.sh in hosted mode", () => {
  const SSLIP_OVERRIDE = "services:\n  gateway:\n    restart: unless-stopped\n  caddy:\n    environment:\n      REGULAIT_TLS_HOST: 1-2-3-4.sslip.io\n";

  function resync(envText) {
    writeFileSync(path.join(dir, "docker-compose.override.yml"), SSLIP_OVERRIDE);
    writeFileSync(path.join(dir, ".env"), envText);
    const calls = path.join(dir, "compose-calls");
    const stub = path.join(dir, "compose-stub.sh");
    writeFileSync(stub, `#!/bin/bash\necho "$*" >> ${calls}\n`, { mode: 0o755 });
    const r = spawnSync("bash", [BOOT_RESYNC, "--no-install"], {
      encoding: "utf8",
      env: { ...process.env, APP_DIR: dir, REGULAIT_RESYNC_LOG: path.join(dir, "resync.log"), REGULAIT_RESYNC_COMPOSE: stub },
    });
    let composeCalls = "";
    try {
      composeCalls = readFileSync(calls, "utf8");
    } catch {
      composeCalls = "";
    }
    return { status: r.status, out: r.stdout, override: readFileSync(path.join(dir, "docker-compose.override.yml"), "utf8"), composeCalls };
  }

  it("points Caddy at REGULAIT_PUBLIC_HOST without asking IMDS, keeps a backup and re-applies the stack", () => {
    const r = resync("REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://demo.example.com\n");
    expect(r.status).toBe(0);
    expect(r.override).toContain("REGULAIT_TLS_HOST: demo.example.com");
    expect(r.override).not.toContain("sslip.io");
    expect(r.composeCalls.trim()).toBe("--profile tls up -d");
    expect(r.out).toMatch(/hostname 1-2-3-4\.sslip\.io -> demo\.example\.com/);
    const backups = execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").filter((f) => f.startsWith("docker-compose.override.yml.bak."));
    expect(backups).toHaveLength(1);
  });

  it("is a no-op on the second run", () => {
    const env = "REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://demo.example.com\n";
    resync(env);
    writeFileSync(path.join(dir, "docker-compose.override.yml"), SSLIP_OVERRIDE.replace("1-2-3-4.sslip.io", "demo.example.com"));
    rmSync(path.join(dir, "compose-calls"), { force: true });
    const stub = path.join(dir, "compose-stub.sh");
    const r = spawnSync("bash", [BOOT_RESYNC, "--no-install"], {
      encoding: "utf8",
      env: { ...process.env, APP_DIR: dir, REGULAIT_RESYNC_LOG: path.join(dir, "resync.log"), REGULAIT_RESYNC_COMPOSE: stub },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already pointed at demo\.example\.com/);
    expect(spawnSync("test", ["-e", path.join(dir, "compose-calls")]).status).toBe(1);
  });

  it("leaves the stack untouched when the hosted settings disagree (never falls back to the address name)", () => {
    const r = resync("REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://1-2-3-4.sslip.io\n");
    expect(r.status).toBe(0);
    expect(r.override).toBe(SSLIP_OVERRIDE);
    expect(r.composeCalls).toBe("");
    expect(r.out).toMatch(/hosted settings .* are invalid/);
  });
});

describe("compose and Caddy wiring", () => {
  const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const caddyfile = readFileSync(path.join(ROOT, "infra/caddy/Caddyfile"), "utf8");
  // the routes and headers moved to a snippet file shared with the tunnel front (ADR-0203 lane T)
  const routes = readFileSync(path.join(ROOT, "infra/caddy/routes.Caddyfile"), "utf8");
  const caddyService = compose.slice(compose.indexOf("\n  caddy:\n"), compose.indexOf("\nnetworks:"));

  it("the TLS front is opt-in: profile `hosted` (and `tls`), never the default stack", () => {
    expect(caddyService).toMatch(/\n    profiles: \["tls", "hosted"\]\n/);
  });

  it("the served name is REGULAIT_PUBLIC_HOST first, then REGULAIT_TLS_HOST, then a never-resolving placeholder", () => {
    expect(caddyService).toContain("REGULAIT_TLS_HOST: ${REGULAIT_PUBLIC_HOST:-${REGULAIT_TLS_HOST:-set-regulait-tls-host.invalid}}");
  });

  it("the gateway port stays on host loopback", () => {
    expect(compose).toContain('- "127.0.0.1:3000:3000"');
    expect(compose).not.toMatch(/^\s*- "3000:3000"/m);
  });

  it("Keycloak trusts X-Forwarded-* only from the TLS front's fixed address", () => {
    const caddyIp = /ipv4_address: (\S+)/.exec(caddyService)?.[1];
    expect(caddyIp).toBe("172.28.0.2");
    expect(compose).toContain(`KC_PROXY_TRUSTED_ADDRESSES: \${REGULAIT_KC_TRUSTED_PROXIES:-${caddyIp}}`);
    expect(compose).toContain(`REGULAIT_TRUSTED_PROXIES: \${REGULAIT_TRUSTED_PROXIES:-${caddyIp}}`);
    // the laptop default is unchanged: Keycloak at the root path on localhost:8080
    expect(compose).toContain("KC_HTTP_RELATIVE_PATH: ${REGULAIT_KC_RELATIVE_PATH:-/}");
  });

  it("only Keycloak's public surface is proxied; the rest of /idp is refused", () => {
    expect(caddyfile).toMatch(/\nimport routes\.Caddyfile\n/);
    expect(caddyfile).toMatch(/\n\timport regulait_routes \{remote_host\} https\n/);
    expect(routes).toMatch(/@idp_public path \/idp\/realms\/\* \/idp\/resources\/\*\n/);
    expect(routes).toMatch(/handle \/idp\* \{\n\t\trespond 404\n\t\}/);
    // the Keycloak route sits before the catch-all gateway handle
    expect(routes.indexOf("handle @idp_public")).toBeLessThan(routes.indexOf("reverse_proxy {$REGULAIT_TLS_UPSTREAM"));
  });

  it("HSTS stays owned by the gateway, not the proxy (ADR-0029 amendment)", () => {
    expect(caddyfile).not.toMatch(/^\s*Strict-Transport-Security/m);
    expect(routes).not.toMatch(/^\s*Strict-Transport-Security/m);
  });
});
