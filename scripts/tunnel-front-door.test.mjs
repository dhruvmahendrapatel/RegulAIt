// ADR-0203 lane T: the laptop-hosted demo behind a Cloudflare Tunnel. `hosted-config.sh tunnel-check`
// must fail closed on every unsafe setting (and never print the token), and the compose and Caddy
// wiring must keep the tunnel opt-in, portless, and on the same routes and trusted address as the
// TLS front. No real tunnel runs here: that needs a Cloudflare account (docs/deployment/TUNNEL.md).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOSTED_CONFIG = path.join(ROOT, "infra/scripts/hosted-config.sh");
// an obviously fake value; never a real credential
const TOKEN = "test-tunnel-token-not-a-real-credential-0123456789";
const OK_ENV = `REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://demo.example.com\nREGULAIT_CF_TUNNEL_TOKEN=${TOKEN}\n`;
const SSO_ENV = `${OK_ENV}REGULAIT_KC_HOSTNAME=https://demo.example.com/idp\nREGULAIT_KC_RELATIVE_PATH=/idp\n`;

// the variables tunnel-check reads, removed from the inherited environment so a developer's shell
// cannot change the result; a test adds back only what it sets
const READ_VARS = [
  "COMPOSE_PROFILES",
  "REGULAIT_PUBLIC_HOST",
  "REGULAIT_PUBLIC_URL",
  "REGULAIT_CF_TUNNEL_TOKEN",
  "REGULAIT_KC_HOSTNAME",
  "REGULAIT_KC_RELATIVE_PATH",
  "REGULAIT_TRUSTED_PROXIES",
  "REGULAIT_KC_TRUSTED_PROXIES",
];

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tunnel-front-door-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tunnelCheck(envText, { args = [], env = {} } = {}) {
  const file = path.join(dir, ".env");
  writeFileSync(file, envText);
  const base = { ...process.env };
  for (const name of READ_VARS) delete base[name];
  const r = spawnSync("bash", [HOSTED_CONFIG, "tunnel-check", file, ...args], { encoding: "utf8", env: { ...base, ...env } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("hosted-config.sh tunnel-check", () => {
  it("passes a complete, consistent configuration and prints one line", () => {
    expect(tunnelCheck(OK_ENV)).toEqual({ status: 0, out: "tunnel config ok: https://demo.example.com", err: "" });
    expect(tunnelCheck(SSO_ENV, { args: ["--sso"] }).out).toBe("tunnel config ok: https://demo.example.com (with sign-in under /idp)");
    // the front's own address is the one accepted explicit trust value
    expect(tunnelCheck(`${OK_ENV}REGULAIT_TRUSTED_PROXIES=172.28.0.2\nREGULAIT_KC_TRUSTED_PROXIES=172.28.0.2\n`).status).toBe(0);
  });

  it("fails closed when REGULAIT_PUBLIC_HOST is unset: there is no fallback name behind a tunnel", () => {
    const r = tunnelCheck(`REGULAIT_PUBLIC_URL=https://demo.example.com\nREGULAIT_CF_TUNNEL_TOKEN=${TOKEN}\n`);
    expect(r.status).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/REGULAIT_PUBLIC_HOST is not set/);
  });

  it.each(["Demo.example.com", "localhost", "1.2.3.4", "demo.example.com:443", "https://demo.example.com", "demo.invalid"])(
    "refuses REGULAIT_PUBLIC_HOST=%s",
    (host) => {
      const r = tunnelCheck(`REGULAIT_PUBLIC_HOST=${host}\nREGULAIT_PUBLIC_URL=https://${host}\nREGULAIT_CF_TUNNEL_TOKEN=${TOKEN}\n`);
      expect(r.status).toBe(2);
      expect(r.err).toMatch(/REGULAIT_PUBLIC_HOST=.* is not a lowercase DNS name/);
    },
  );

  it.each([
    ["", "unset"],
    ["http://demo.example.com", "plain http"],
    ["https://other.example.com", "another host"],
    ["https://demo.example.com:8443", "a port"],
    ["https://demo.example.com/app", "a base path"],
  ])("refuses REGULAIT_PUBLIC_URL=%s (%s): exactly https://<REGULAIT_PUBLIC_HOST>", (url) => {
    const r = tunnelCheck(`REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=${url}\nREGULAIT_CF_TUNNEL_TOKEN=${TOKEN}\n`);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/REGULAIT_PUBLIC_URL must be https:\/\/demo\.example\.com/);
  });

  it("accepts a trailing slash on REGULAIT_PUBLIC_URL, as want-host does", () => {
    expect(tunnelCheck(OK_ENV.replace("https://demo.example.com\n", "https://demo.example.com/\n")).status).toBe(0);
  });

  it("refuses a missing token, or one with whitespace, without ever printing it", () => {
    const missing = tunnelCheck("REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://demo.example.com\n");
    expect(missing.status).toBe(2);
    expect(missing.err).toMatch(/REGULAIT_CF_TUNNEL_TOKEN is not set/);

    // someone pasted the dashboard's whole install command instead of the token alone
    const pasted = tunnelCheck(OK_ENV.replace(`=${TOKEN}`, `="sudo cloudflared service install ${TOKEN}"`));
    expect(pasted.status).toBe(2);
    expect(pasted.err).toMatch(/REGULAIT_CF_TUNNEL_TOKEN contains whitespace/);

    for (const r of [missing, pasted, tunnelCheck(OK_ENV), tunnelCheck(`${OK_ENV}REGULAIT_PUBLIC_URL=http://x\n`)]) {
      expect(r.out).not.toContain(TOKEN);
      expect(r.err).not.toContain(TOKEN);
    }
  });

  it("with the sso profile, Keycloak must be on the same name under /idp", () => {
    for (const args of [{ args: ["--sso"] }, { env: { COMPOSE_PROFILES: "tunnel,sso" } }]) {
      const r = tunnelCheck(OK_ENV, args);
      expect(r.status).toBe(2);
      expect(r.err).toMatch(/REGULAIT_KC_HOSTNAME must be https:\/\/demo\.example\.com\/idp \(got "<unset>"\)/);
      expect(r.err).toMatch(/REGULAIT_KC_RELATIVE_PATH must be \/idp/);
    }
    for (const kc of ["https://id.example.com/idp", "http://demo.example.com/idp", "https://demo.example.com", "http://localhost:8080"]) {
      const r = tunnelCheck(SSO_ENV.replace("https://demo.example.com/idp", kc), { args: ["--sso"] });
      expect(r.status, kc).toBe(2);
      expect(r.err).toMatch(/REGULAIT_KC_HOSTNAME must be/);
    }
    // a Keycloak hostname set without the sso profile is still checked
    expect(tunnelCheck(`${OK_ENV}REGULAIT_KC_HOSTNAME=https://id.example.com\n`).status).toBe(2);
  });

  it.each([
    ["REGULAIT_TRUSTED_PROXIES", "172.28.0.0/16"],
    ["REGULAIT_TRUSTED_PROXIES", "all"],
    ["REGULAIT_TRUSTED_PROXIES", "172.28.0.2,192.168.255.251"],
    ["REGULAIT_KC_TRUSTED_PROXIES", "192.168.255.251"],
  ])("refuses %s=%s: only the front's address may speak for the client", (name, value) => {
    const r = tunnelCheck(`${OK_ENV}${name}=${value}\n`);
    expect(r.status).toBe(2);
    expect(r.err).toContain(`${name} must be unset or exactly 172.28.0.2`);
  });

  it("refuses to run beside the TLS front (one public door)", () => {
    for (const profiles of ["tunnel,hosted", "tls,tunnel", "sso, hosted ,tunnel"]) {
      const r = tunnelCheck(SSO_ENV, { env: { COMPOSE_PROFILES: profiles } });
      expect(r.status, profiles).toBe(2);
      expect(r.err).toMatch(/COMPOSE_PROFILES names hosted or tls/);
    }
  });

  it("resolves like compose: the calling environment wins over .env, even when set to empty", () => {
    expect(tunnelCheck(OK_ENV, { env: { REGULAIT_PUBLIC_URL: "https://other.example.com" } }).status).toBe(2);
    expect(tunnelCheck(OK_ENV, { env: { REGULAIT_CF_TUNNEL_TOKEN: "" } }).err).toMatch(/REGULAIT_CF_TUNNEL_TOKEN is not set/);
    // the documented laptop setup: the token only in the shell session, never in a file
    const fromShell = tunnelCheck("REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=https://demo.example.com\n", {
      env: { REGULAIT_CF_TUNNEL_TOKEN: TOKEN },
    });
    expect(fromShell.status).toBe(0);
  });

  it("reports every problem at once", () => {
    const r = tunnelCheck("REGULAIT_PUBLIC_HOST=demo.example.com\nREGULAIT_PUBLIC_URL=http://demo.example.com\nREGULAIT_TRUSTED_PROXIES=all\n");
    expect(r.status).toBe(2);
    expect(r.err.split("\n")).toHaveLength(3);
  });

  it("never executes the .env (it is parsed, not sourced)", () => {
    const marker = path.join(dir, "pwned");
    const r = tunnelCheck(`touch ${marker}\nREGULAIT_PUBLIC_HOST=$(touch ${marker})\nREGULAIT_CF_TUNNEL_TOKEN=$(touch ${marker})\n`);
    expect(r.status).toBe(2);
    expect(spawnSync("test", ["-e", marker]).status).toBe(1);
  });

  it("rejects a malformed invocation with the usage text", () => {
    const file = path.join(dir, ".env");
    writeFileSync(file, OK_ENV);
    const r = spawnSync("bash", [HOSTED_CONFIG, "tunnel-check", file, "--bogus"], { encoding: "utf8" });
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/tunnel-check <env-file> \[--sso\]/);
  });
});

describe("compose and Caddy wiring for the tunnel front", () => {
  const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const tunnelCaddyfile = readFileSync(path.join(ROOT, "infra/caddy/tunnel.Caddyfile"), "utf8");
  const routes = readFileSync(path.join(ROOT, "infra/caddy/routes.Caddyfile"), "utf8");
  const block = (name) => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = compose.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n|\n[a-z]/);
    return rest.slice(0, next + 1);
  };
  const tlsFront = block("caddy");
  const tunnelFront = block("caddy-tunnel");
  const cloudflared = block("cloudflared");

  it("both services are opt-in under the `tunnel` profile only", () => {
    expect(tunnelFront).toMatch(/\n    profiles: \["tunnel"\]\n/);
    expect(cloudflared).toMatch(/\n    profiles: \["tunnel"\]\n/);
  });

  it("publishes no port: the tunnel is outbound only", () => {
    expect(tunnelFront).not.toMatch(/\n    ports:/);
    expect(cloudflared).not.toMatch(/\n    ports:/);
  });

  it("cloudflared is pinned by digest and reads its token from the environment, never a file or argv", () => {
    expect(cloudflared).toMatch(/\n    image: cloudflare\/cloudflared:\d{4}\.\d+\.\d+@sha256:[0-9a-f]{64}\n/);
    expect(cloudflared).toContain("TUNNEL_TOKEN: ${REGULAIT_CF_TUNNEL_TOKEN:-}");
    expect(cloudflared).toContain('command: ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:20241", "run"]');
    expect(cloudflared).not.toMatch(/--token|env_file|secrets:/);
  });

  it("cloudflared sits on the `tunnel` network only, so it cannot reach the gateway, Keycloak or the database", () => {
    const nets = cloudflared.slice(cloudflared.indexOf("\n    networks:"));
    expect(nets).toMatch(/\n      tunnel:\n        ipv4_address: 192\.168\.255\.251\n/);
    expect(nets).not.toMatch(/regulait|engines/);
  });

  it("the tunnel front holds the TLS front's address, so the gateway and Keycloak trust lists are unchanged", () => {
    const tlsIp = /ipv4_address: (\S+)/.exec(tlsFront)?.[1];
    expect(tlsIp).toBe("172.28.0.2");
    expect(tunnelFront).toMatch(new RegExp(`\\n      regulait:\\n(?:        #.*\\n)*        ipv4_address: ${tlsIp.replaceAll(".", "\\.")}\\n`));
    expect(compose).toContain(`REGULAIT_TRUSTED_PROXIES: \${REGULAIT_TRUSTED_PROXIES:-${tlsIp}}`);
    expect(compose).toContain(`KC_PROXY_TRUSTED_ADDRESSES: \${REGULAIT_KC_TRUSTED_PROXIES:-${tlsIp}}`);
  });

  it("Caddy's listener and peer check name the same addresses the compose pins give", () => {
    expect(tunnelFront).toMatch(/\n      tunnel:\n        ipv4_address: 192\.168\.255\.250\n/);
    expect(tunnelFront).toContain("REGULAIT_TUNNEL_CADDY_ADDR: 192.168.255.250");
    expect(tunnelFront).toContain("REGULAIT_TUNNEL_CLOUDFLARED_ADDR: 192.168.255.251");
    expect(compose).toMatch(/\n  tunnel:\n(?:    #.*\n)*    ipam:\n      config:\n        - subnet: 192\.168\.255\.248\/29\n/);
  });

  it("both fronts mount the one shared routes file", () => {
    expect(tlsFront).toContain("- ./infra/caddy/routes.Caddyfile:/etc/caddy/routes.Caddyfile:ro");
    expect(tunnelFront).toContain("- ./infra/caddy/routes.Caddyfile:/etc/caddy/routes.Caddyfile:ro");
    expect(tunnelFront).toContain("- ./infra/caddy/tunnel.Caddyfile:/etc/caddy/Caddyfile:ro");
  });

  it("the tunnel Caddyfile never asks for a certificate and listens only on its tunnel address", () => {
    expect(tunnelCaddyfile).toMatch(/\n\tauto_https off\n/);
    expect(tunnelCaddyfile).toMatch(/\nhttp:\/\/\{\$REGULAIT_PUBLIC_HOST:set-regulait-public-host\.invalid\}:8080 \{\n\tbind \{\$REGULAIT_TUNNEL_CADDY_ADDR:127\.0\.0\.1\}\n/);
    expect(tunnelCaddyfile).not.toMatch(/^\s*tls\s/m);
  });

  it("checks the peer, then the scheme, then the client address, before any shared route", () => {
    const route = tunnelCaddyfile.slice(tunnelCaddyfile.indexOf("\troute {"));
    const order = [
      "abort @not_cloudflared",
      "redir @not_https https://{host}{uri} 308",
      "respond @bad_client_ip",
      "import regulait_routes {http.request.header.CF-Connecting-IP} https",
    ].map((s) => route.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(tunnelCaddyfile).toContain("@not_cloudflared not remote_ip {$REGULAIT_TUNNEL_CLOUDFLARED_ADDR:127.0.0.1}/32");
  });

  it("the shared routes overwrite every forwarding header and strip CF-Connecting-IP for both upstreams", () => {
    for (const header of ["X-Forwarded-For {args[0]}", "X-Real-IP {args[0]}", "X-Forwarded-Proto {args[1]}", "X-Forwarded-Host {host}", "-CF-Connecting-IP"]) {
      expect(routes.split(`header_up ${header}\n`).length - 1, header).toBe(2);
    }
  });
});

describe("docker compose config (when the CLI is available)", () => {
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  const hasCompose = probe.status === 0;
  const config = (args, env = {}) => {
    const r = spawnSync("docker", ["compose", ...args, "config", "--format", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, COMPOSE_PROFILES: "", ...env },
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  it.skipIf(!hasCompose)("the default stack has neither tunnel service nor the tunnel network", () => {
    const c = config([]);
    expect(Object.keys(c.services)).not.toContain("cloudflared");
    expect(Object.keys(c.services)).not.toContain("caddy-tunnel");
    expect(Object.keys(c.networks ?? {})).not.toContain("tunnel");
  });

  it.skipIf(!hasCompose)("the tunnel profile adds both, with no published port and the token only in the environment", () => {
    const c = config(["--profile", "tunnel"], { REGULAIT_CF_TUNNEL_TOKEN: TOKEN, REGULAIT_PUBLIC_HOST: "demo.example.com" });
    const cf = c.services.cloudflared;
    const front = c.services["caddy-tunnel"];
    expect(cf.ports ?? []).toEqual([]);
    expect(front.ports ?? []).toEqual([]);
    expect(Object.keys(cf.networks)).toEqual(["tunnel"]);
    expect(cf.environment.TUNNEL_TOKEN).toBe(TOKEN);
    expect(JSON.stringify(cf.command)).not.toContain(TOKEN);
    expect(front.networks.regulait.ipv4_address).toBe("172.28.0.2");
    expect(front.environment.REGULAIT_PUBLIC_HOST).toBe("demo.example.com");
  });
});
