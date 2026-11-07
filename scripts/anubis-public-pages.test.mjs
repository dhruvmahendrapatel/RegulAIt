// ADR-0258 (backlog P34): the optional Anubis bot check in front of the PUBLIC pages only. No Anubis or Caddy runs
// here; these checks pin the wiring that makes it safe: off by default, the public paths and nothing else, Caddy as
// the only proxy to the gateway, a non-2xx deny, no client-chosen address or path, no open redirect, nothing
// downloaded at run time, and the installer's switch.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const compose = read("docker-compose.yml");
const routes = read("infra/caddy/routes.Caddyfile");
const policy = read("infra/anubis/policy.yaml");
const allowlist = read("infra/anubis/allowlist.yaml");
const k8s = read("infra/anubis/k8s/anubis.yaml");
const install = read("scripts/install.sh");
const bundle = read("scripts/build-image-bundle.sh");

const DIGEST = "sha256:5fcbce70ee6168be5b226d19bec90111d0acd0daf13028fa06b044cf3ebbbd5f";
const IMAGE = `ghcr.io/techarohq/anubis:v1.28.2@${DIGEST}`;
const PUBLIC_PATHS = "/ui/trust /ui/trust/* /ui/audit /ui/audit/* /ui/supplier /ui/supplier/* /v1/trust-center /v1/trust-center/* /v1/auditor/* /v1/supplier/*";

const block = (name) => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n|\n[a-z]/);
  return rest.slice(0, next + 1);
};
// a Caddyfile snippet's body, from its `(name) {` line to the closing brace at column 0
const snippet = (name) => {
  const start = routes.indexOf(`\n(${name}) {\n`);
  expect(start, name).toBeGreaterThan(-1);
  return routes.slice(start, routes.indexOf("\n}\n", start) + 3);
};

describe("compose: the anubis service", () => {
  const svc = block("anubis");

  it("is opt-in under its own profile, pinned by digest, with no published port", () => {
    expect(svc).toMatch(/\n    profiles: \["anubis"\]\n/);
    expect(svc).toContain(`\n    image: ${IMAGE}\n`);
    expect(svc).not.toMatch(/\n    ports:/);
    expect(svc).toMatch(/\n    networks:\n      - regulait\n/);
  });

  it("runs in subrequest mode, hardened, with the policy and allow-list mounted read-only", () => {
    expect(svc).toContain('      TARGET: " "\n');
    expect(svc).toContain("      POLICY_FNAME: /etc/anubis/policy.yaml\n");
    expect(svc).toContain("    read_only: true\n");
    expect(svc).toContain("    cap_drop: [ALL]\n");
    expect(svc).toContain('    security_opt: ["no-new-privileges:true"]\n');
    expect(svc).toContain("      - ./infra/anubis/policy.yaml:/etc/anubis/policy.yaml:ro\n");
    expect(svc).toContain("      - ${REGULAIT_ANUBIS_ALLOWLIST_FILE:-./infra/anubis/allowlist.yaml}:/etc/anubis/allowlist.yaml:ro\n");
  });

  it("never redirects a passed visitor off this deployment's name (no open redirect)", () => {
    expect(svc).toContain("      REDIRECT_DOMAINS: ${REGULAIT_PUBLIC_HOST:-${REGULAIT_TLS_HOST:-set-regulait-public-host.invalid}}\n");
  });

  it("issues a strict, short-lived, address-bound pass cookie and serves nothing extra", () => {
    for (const line of [
      'COOKIE_HTTP_ONLY: "true"',
      'COOKIE_SECURE: "true"',
      "COOKIE_SAME_SITE: Lax",
      "COOKIE_EXPIRATION_TIME: 12h",
      "JWT_RESTRICTION_HEADER: X-Real-IP",
      'SERVE_ROBOTS_TXT: "false"',
      'OG_PASSTHROUGH: "false"',
    ]) expect(svc).toContain(`      ${line}\n`);
  });

  it("keeps its ops log bounded", () => {
    expect(svc).toMatch(/\n    logging:\n      driver: local\n      options:\n        max-size: 5m\n        max-file: "2"\n/);
  });

  it("both public fronts carry the switch, off by default", () => {
    for (const front of ["caddy", "caddy-tunnel"]) {
      expect(block(front)).toContain("      REGULAIT_ANUBIS: ${REGULAIT_ANUBIS:-off}\n");
    }
  });
});

describe("Caddy: the public-page gate", () => {
  it("picks the gate from REGULAIT_ANUBIS, default off, and only `on` and `off` exist", () => {
    expect(routes).toContain("\timport regulait_public_gate_{$REGULAIT_ANUBIS:off} {args[0]} {args[1]}\n");
    expect([...routes.matchAll(/\n\((regulait_public_gate_[a-z]+)\) \{/g)].map((m) => m[1]).sort()).toEqual([
      "regulait_public_gate_off",
      "regulait_public_gate_on",
    ]);
    // the gate comes before the catch-all gateway handle
    expect(routes.indexOf("import regulait_public_gate_")).toBeLessThan(routes.indexOf("\thandle {\n\t\timport regulait_gateway_proxy"));
  });

  it("off: Anubis's path answers 404 and nothing else changes", () => {
    const off = snippet("regulait_public_gate_off");
    expect(off).toContain("\thandle /.within.website/* {\n\t\trespond 404\n\t}\n");
    expect(off).not.toContain("forward_auth");
    expect(off).not.toContain("reverse_proxy");
  });

  it("on: checks exactly the public pages, then proxies to the gateway through the shared proxy", () => {
    const on = snippet("regulait_public_gate_on");
    expect(on).toContain(`\t@regulait_public_pages path ${PUBLIC_PATHS}\n`);
    expect(on.match(/^\t+forward_auth /gm)).toHaveLength(1);
    expect(on).toContain("\thandle @regulait_public_pages {\n\t\troute {\n\t\t\tforward_auth {$REGULAIT_ANUBIS_UPSTREAM:anubis:8923} {\n");
    expect(on).toContain("uri /.within.website/x/cmd/anubis/api/check\n");
    expect(on).toContain("\t\t\timport regulait_gateway_proxy {args[0]} {args[1]}\n");
    // Anubis is never the gateway's proxy: the only reverse_proxy here goes to Anubis itself
    expect(on.match(/^\t+reverse_proxy /gm)).toHaveLength(1);
    expect(on).toContain("reverse_proxy {$REGULAIT_ANUBIS_UPSTREAM:anubis:8923} {");
    // neither the admin console, the API at large nor /idp is named
    for (const p of ["/ui/admin", "/ui/*", "/v1/*", "/idp", "/admin"]) expect(on).not.toContain(` ${p}`);
  });

  it("on: only a 401 becomes a redirect to the challenge; a deny goes back as it is", () => {
    const on = snippet("regulait_public_gate_on");
    expect(on).toContain("@anubis_challenge status 401\n");
    expect(on).toContain("redir * /.within.website/?redir={uri} 307\n");
  });

  it("on: Anubis sees the address the front vouches for, never a client-chosen address or path", () => {
    const on = snippet("regulait_public_gate_on");
    for (const header of ["X-Forwarded-For {args[0]}", "X-Real-IP {args[0]}", "X-Forwarded-Proto {args[1]}", "-CF-Connecting-IP", "-X-Original-Uri"]) {
      expect(on.split(`header_up ${header}\n`).length - 1, header).toBe(2);
    }
  });

  it("on: the pass-challenge request, which can carry a sign-in link's fragment, is kept out of the access log", () => {
    expect(snippet("regulait_public_gate_on")).toContain("log_skip /.within.website/x/cmd/anubis/api/pass-challenge\n");
  });
});

describe("the Anubis policy", () => {
  const live = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

  it("works air-gapped: no GeoIP/ASN, DNS blocklist, remote address list or Open Graph fetch", () => {
    const p = live(policy);
    for (const key of ["geoip:", "asns:", "remote_addresses_url", "thoth"]) expect(p).not.toContain(key);
    expect(p).toMatch(/\ndnsbl: false\n/);
    expect(p).toMatch(/\nopenGraph:\n {2}enabled: false\n/);
    expect(p).toMatch(/\nhoneypot:\n {2}enabled: false\n/);
    expect(p).toMatch(/\nstore:\n {2}backend: memory\n/);
    expect(live(allowlist)).not.toContain("remote_addresses_url");
  });

  it("denies with a non-2xx status, so a proxy reading the status never lets a denied scraper through", () => {
    expect(policy).toMatch(/\nstatus_codes:\n {2}CHALLENGE: 200\n {2}DENY: 403\n/);
  });

  it("allow-list first, then known scrapers denied, good bots only by choice, then everyone challenged", () => {
    const rules = [...live(policy).matchAll(/\n {2}- (?:import: (\S+)|name: (\S+))/g)].map((m) => m[1] ?? m[2]);
    expect(rules).toEqual([
      "/etc/anubis/allowlist.yaml",
      "(data)/bots/_deny-pathological.yaml",
      "(data)/meta/ai-block-aggressive.yaml",
      "regulait-public-pages-challenge",
    ]);
    // good bots are offered, commented out
    expect(policy).toContain("  # - import: (data)/crawlers/_allow-good.yaml\n");
    expect(live(policy)).toMatch(/- name: regulait-public-pages-challenge\n {4}path_regex: \^\/\.\*\$\n {4}action: CHALLENGE\n {4}challenge:\n {6}algorithm: fast\n {6}difficulty: 4\n/);
    // never the timed meta-refresh challenge (WCAG 2.2.1)
    expect(live(policy)).not.toContain("metarefresh");
  });

  it("logs to stdio and binds metrics inside the compose network", () => {
    expect(policy).toMatch(/\nlogging:\n {2}sink: stdio\n {2}level: INFO\n/);
    expect(policy).toMatch(/\nmetrics:\n {2}bind: ":9090"\n {2}network: tcp\n/);
  });

  it("the shipped allow-list allows only a documentation address", () => {
    const addrs = [...live(allowlist).matchAll(/\n {4}- (\S+)/g)].map((m) => m[1]);
    expect(addrs).toEqual(["192.0.2.1/32"]);
  });
});

describe("the Kubernetes hook, the installer and the bundle name the same image", () => {
  it("k8s: same digest, subrequest mode, non-root, read-only, cluster-internal", () => {
    expect(k8s).toContain(`image: ${IMAGE}\n`);
    expect(k8s).toContain('- { name: TARGET, value: " " }');
    expect(k8s).toContain("- { name: REDIRECT_DOMAINS, value: regulait.example.com }");
    expect(k8s).toContain("runAsNonRoot: true");
    expect(k8s).toContain("readOnlyRootFilesystem: true");
    expect(k8s).toContain("type: ClusterIP");
    expect(k8s).toContain("replicas: 1");
  });

  it("install.sh and build-image-bundle.sh pin the same tag and image ids", () => {
    const ids = (text) => text.match(/ANUBIS_IMAGE_IDS="([^"]+)"/)?.[1];
    expect(ids(install)).toBeTruthy();
    expect(ids(bundle)).toBe(ids(install));
    expect(ids(install)).toContain(DIGEST);
    expect(install).toContain('ANUBIS_TAG="ghcr.io/techarohq/anubis:v1.28.2"\n');
    expect(bundle).toContain(`ANUBIS_IMAGE="${IMAGE}"\n`);
  });
});

describe("scripts/install.sh --check", () => {
  const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
  const run = (dir, args) => {
    const dataKey = spawnSync("openssl", ["rand", "-hex", "32"], { encoding: "utf8" }).stdout.trim();
    const env = { ...process.env };
    for (const k of ["REGULAIT_DEMO_LICENSE", "REGULAIT_ANUBIS", "COMPOSE_PROFILES"]) delete env[k];
    const r = spawnSync(
      "bash",
      [path.join(ROOT, "scripts/install.sh"), "--check", "--yes", "--mode", "byoc", "--dir", dir, "--data-key", dataKey, "--min-disk-gb", "0", ...args],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  const withDir = (fn) => {
    const dir = mkdtempSync(path.join(tmpdir(), "anubis-install-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.runIf(hasOpenssl)("off by default; --anubis turns it on and adds the profile; re-runs keep it; --no-anubis turns it off", () => {
    withDir((dir) => {
      const envOf = () => readFileSync(path.join(dir, ".env"), "utf8");
      let r = run(dir, ["--domain", "anubis.example"]);
      expect(r.status, r.output.slice(-1500)).toBe(0);
      expect(envOf()).toContain("\nREGULAIT_ANUBIS=off\n");
      expect(r.output).not.toContain("--profile anubis");

      r = run(dir, ["--domain", "anubis.example", "--anubis"]);
      expect(r.status, r.output.slice(-1500)).toBe(0);
      expect(envOf()).toContain("\nREGULAIT_ANUBIS=on\n");
      expect(r.output).toContain("--profile tls --profile anubis up -d");

      r = run(dir, ["--domain", "anubis.example"]);
      expect(envOf()).toContain("\nREGULAIT_ANUBIS=on\n");

      r = run(dir, ["--domain", "anubis.example", "--no-anubis"]);
      expect(envOf()).toContain("\nREGULAIT_ANUBIS=off\n");
    });
  });

  it.runIf(hasOpenssl)("refuses --anubis without Caddy in front (--tls none)", () => {
    withDir((dir) => {
      const r = run(dir, ["--tls", "none", "--anubis"]);
      expect(r.status).toBe(1);
      expect(r.output).toContain("--anubis needs Caddy in front");
    });
  });

  it.runIf(hasOpenssl)("air-gapped --anubis runs the bundle's plain tag, never pulling", () => {
    withDir((dir) => {
      const r = run(dir, ["--mode", "air_gapped", "--domain", "anubis.corp", "--anubis"]);
      expect(r.status, r.output.slice(-1500)).toBe(0);
      const override = readFileSync(path.join(dir, "compose.install.yml"), "utf8");
      expect(override).toContain("\n  anubis:\n    image: ghcr.io/techarohq/anubis:v1.28.2\n    pull_policy: never\n");
    });
  });
});
