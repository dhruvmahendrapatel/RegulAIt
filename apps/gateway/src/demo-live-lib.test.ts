/**
 * ADR-0202 (lane L) — the live-demo profile, with the API and the vendors STUBBED: what the setup posts, that a re-run
 * duplicates nothing, that no secret reaches a report, the egress entries (exact hosts, opt-in), the secrets-file
 * checks, and the read-only probes. No database, no network.
 */
import { describe, expect, it } from "vitest";
import {
  applyLiveDemoSetup,
  EGRESS_ALLOW_HOSTS_PATH,
  ensureLiveEgressHosts,
  jiraSiteHost,
  LIVE_NAMES,
  liveDemoEgressHosts,
  liveProfileRequested,
  loadSecretsFile,
  neededSecrets,
  readLiveDemoConfig,
  scrub,
  type ApiCall,
  type LiveSecrets,
} from "./demo-live-lib.js";
import { runLiveProbes, type LiveProbeInput, type ProbeFetch } from "./demo-live-check.js";

const ENV = {
  REGULAIT_DEMO_GITHUB_REPO: "regulait-demo/payments-api",
  REGULAIT_DEMO_JIRA_SITE: "regulait-demo.atlassian.net",
  REGULAIT_DEMO_JIRA_PROJECT: "DEMO",
  REGULAIT_DEMO_JIRA_EMAIL: "owner@demo.example.com",
  REGULAIT_DEMO_ADO_ORG: "regulait-demo",
  REGULAIT_DEMO_ADO_PROJECT: "Payments",
  REGULAIT_DEMO_SLACK_CHANNEL: "C0123456789",
  REGULAIT_DEMO_SLACK_TEAM_ID: "T0123456789",
};
const SECRETS: LiveSecrets = {
  githubToken: "test-only-github-aaaaaaaaaaaaaaaa",
  jiraApiToken: "test-only-jira-bbbbbbbbbbbbbbbb",
  adoPat: "test-only-ado-cccccccccccccccc",
  slackBotToken: "test-only-slackbot-dddddddddddddddd",
  slackSigningSecret: "test-only-signing-eeeeeeeeeeeeeeee",
};
const secretValues = Object.values(SECRETS) as string[];

/** an in-memory API: records every call, keeps created rows so a re-run sees them */
function fakeApi(opts: { refuse?: Record<string, { status: number; body: unknown }> } = {}) {
  const calls: Array<{ method: string; url: string; payload?: any }> = [];
  const store = { git: [] as any[], pm: [] as any[], connectors: [] as any[], chatops: [] as any[], hosts: [] as any[] };
  const call: ApiCall = async (method, url, payload) => {
    calls.push({ method, url, payload });
    const refused = opts.refuse?.[`${method} ${url}`];
    if (refused) return refused;
    if (method === "GET" && url === "/v1/git/connections") return { status: 200, body: { connections: store.git } };
    if (method === "GET" && url === "/v1/pm/connections") return { status: 200, body: { connections: store.pm } };
    if (method === "GET" && url === "/v1/connectors") return { status: 200, body: { connectors: store.connectors } };
    if (method === "GET" && url === "/v1/chatops/connections") return { status: 200, body: { connections: store.chatops } };
    if (method === "GET" && url === EGRESS_ALLOW_HOSTS_PATH) return { status: 200, body: { hosts: store.hosts } };
    const p = payload as any;
    if (method === "POST" && url === "/v1/git/connections") return store.git.push({ name: p.name }), { status: 201, body: { name: p.name } };
    if (method === "POST" && url === "/v1/pm/connections") return store.pm.push({ name: p.name }), { status: 201, body: { name: p.name, webhookSecret: `rglwh_${p.name}` } };
    if (method === "POST" && url === "/v1/connectors") return store.connectors.push({ id: "11111111-1111-1111-1111-111111111111", name: p.name }), { status: 201, body: { id: "11111111-1111-1111-1111-111111111111" } };
    if (method === "POST" && url.endsWith("/credential")) return { status: 201, body: {} };
    if (method === "POST" && url === "/v1/chatops/connections") return store.chatops.push({ name: p.name }), { status: 201, body: { id: "x" } };
    if (method === "POST" && url === EGRESS_ALLOW_HOSTS_PATH) return store.hosts.push({ host: p.host }), { status: 201, body: {} };
    return { status: 404, body: { error: "not_stubbed" } };
  };
  return { call, calls, store };
}

describe("live-demo config", () => {
  it("is opt-in, spelled exactly", () => {
    expect(liveProfileRequested({})).toBe(false);
    expect(liveProfileRequested({ REGULAIT_DEMO_PROFILE: "mock" })).toBe(false);
    expect(liveProfileRequested({ REGULAIT_DEMO_PROFILE: "live" })).toBe(true);
  });

  it("reads every integration from env, and skips an unset one with a reason", () => {
    const { config, problems } = readLiveDemoConfig(ENV);
    expect(config.github).toEqual({ owner: "regulait-demo", repo: "payments-api" });
    expect(config.jira).toEqual({ site: "regulait-demo.atlassian.net", project: "DEMO", email: "owner@demo.example.com" });
    expect(config.azureDevOps).toEqual({ org: "regulait-demo", project: "Payments" });
    expect(config.slack).toEqual({ channel: "C0123456789", teamId: "T0123456789" });
    expect(problems).toEqual([]);
    const partial = readLiveDemoConfig({ REGULAIT_DEMO_GITHUB_REPO: ENV.REGULAIT_DEMO_GITHUB_REPO });
    expect(Object.keys(partial.config)).toEqual(["github"]);
    expect(partial.problems).toHaveLength(3);
    expect(neededSecrets(partial.config)).toEqual(["githubToken"]);
  });

  it("accepts only a <site>.atlassian.net Jira host", () => {
    expect(jiraSiteHost("https://regulait-demo.atlassian.net")).toBe("regulait-demo.atlassian.net");
    expect(jiraSiteHost("regulait-demo.atlassian.net")).toBe("regulait-demo.atlassian.net");
    for (const bad of ["*.atlassian.net", "atlassian.net", "evil.atlassian.net.example.com", "https://x.atlassian.net/path", "https://u:p@x.atlassian.net", "x.atlassian.com"]) {
      expect(jiraSiteHost(bad)).toBeNull();
    }
  });
});

describe("live-demo egress entries", () => {
  it("are exact hosts with a stated reason, the Jira tenant site included, and no wildcard", () => {
    const hosts = liveDemoEgressHosts(ENV);
    expect(hosts.map((h) => h.host)).toEqual(["api.github.com", "regulait-demo.atlassian.net", "dev.azure.com", "slack.com", "api.resend.com"]);
    for (const h of hosts) {
      expect(h.host).not.toContain("*");
      expect(h.note).toMatch(/ADR-0202/);
    }
    // no Jira site configured: no Jira entry, never a wildcard in its place
    expect(liveDemoEgressHosts({}).map((h) => h.host)).toEqual(["api.github.com", "dev.azure.com", "slack.com", "api.resend.com"]);
  });

  it("adds only the missing hosts, and reports a step-up refusal instead of forcing it", async () => {
    const api = fakeApi({
      refuse: { [`POST ${EGRESS_ALLOW_HOSTS_PATH}`]: { status: 403, body: { error: "step_up_required", actionKind: "settings_relax" } } },
    });
    api.store.hosts.push({ host: "api.github.com" });
    const out = await ensureLiveEgressHosts(api.call, liveDemoEgressHosts(ENV));
    expect(out.present).toEqual(["api.github.com"]);
    expect(out.needsAdmin).toEqual(["regulait-demo.atlassian.net", "dev.azure.com", "slack.com", "api.resend.com"]);
    expect(out.added).toEqual([]);
  });
});

describe("secrets file", () => {
  const read = (content: string) => ({ stat: () => ({ mode: 0o100600, isFile: () => true }), read: () => content });
  it("reads a 0600 JSON file outside the repository", () => {
    expect(loadSecretsFile("/home/op/.regulait-live.json", "/srv/regulait", read(JSON.stringify(SECRETS)))).toEqual(SECRETS);
  });
  it("refuses a path inside the repository, a relative path, a group-readable file and unknown keys", () => {
    expect(() => loadSecretsFile("/srv/regulait/secrets.json", "/srv/regulait", read("{}"))).toThrow(/inside the repository/);
    expect(() => loadSecretsFile("secrets.json", "/srv/regulait", read("{}"))).toThrow(/absolute/);
    expect(() =>
      loadSecretsFile("/home/op/s.json", "/srv/regulait", { stat: () => ({ mode: 0o100644, isFile: () => true }), read: () => "{}" }),
    ).toThrow(/chmod 600/);
    expect(() => loadSecretsFile("/home/op/s.json", "/srv/regulait", read('{"awsKey":"x"}'))).toThrow(/unknown key/);
  });
  it("never quotes the file's content in a parse error", () => {
    let msg = "";
    try {
      loadSecretsFile("/home/op/s.json", "/srv/regulait", read(`{"githubToken": ${SECRETS.githubToken}`));
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/not valid JSON/);
    expect(msg).not.toContain(SECRETS.githubToken!);
  });
});

describe("applyLiveDemoSetup (stubbed API)", () => {
  it("posts each live connection once, with the right shape", async () => {
    const api = fakeApi();
    const { config } = readLiveDemoConfig(ENV);
    const res = await applyLiveDemoSetup(api.call, config, SECRETS);
    expect(res.steps.every((s) => s.outcome === "created" || s.outcome === "updated")).toBe(true);
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([
      "/v1/git/connections",
      "/v1/pm/connections",
      "/v1/pm/connections",
      "/v1/connectors",
      "/v1/connectors/11111111-1111-1111-1111-111111111111/credential",
      "/v1/chatops/connections",
    ]);
    expect(posts[0]!.payload).toEqual({ name: LIVE_NAMES.github, provider: "github", token: SECRETS.githubToken });
    expect(posts[1]!.payload).toMatchObject({
      name: LIVE_NAMES.jira,
      provider: "jira",
      baseUrl: "https://regulait-demo.atlassian.net",
      project: "DEMO",
      token: `owner@demo.example.com:${SECRETS.jiraApiToken}`,
    });
    expect(posts[2]!.payload).toMatchObject({ provider: "azure_devops", baseUrl: "https://dev.azure.com/regulait-demo", project: "Payments", token: SECRETS.adoPat });
    expect(posts[3]!.payload).toEqual({ name: LIVE_NAMES.slackConnector, kind: "chat", providerKind: "slack" });
    expect(posts[5]!.payload).toMatchObject({
      provider: "slack",
      signingSecret: SECRETS.slackSigningSecret,
      defaultChannel: "C0123456789",
      slackTeamId: "T0123456789",
    });
    expect(res.inbound.map((i) => i.connection)).toEqual([LIVE_NAMES.jira, LIVE_NAMES.azureDevOps]);
  });

  it("is idempotent: a re-run creates nothing and only re-posts the Slack bot token", async () => {
    const api = fakeApi();
    const { config } = readLiveDemoConfig(ENV);
    await applyLiveDemoSetup(api.call, config, SECRETS);
    api.calls.length = 0;
    const again = await applyLiveDemoSetup(api.call, config, SECRETS);
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/v1/connectors/11111111-1111-1111-1111-111111111111/credential"]);
    expect(again.steps.filter((s) => s.outcome === "created")).toEqual([]);
    expect(again.inbound).toEqual([]);
    expect(api.store.git).toHaveLength(1);
    expect(api.store.pm).toHaveLength(2);
  });

  it("skips an integration whose secret was not supplied", async () => {
    const api = fakeApi();
    const { config } = readLiveDemoConfig(ENV);
    const res = await applyLiveDemoSetup(api.call, config, { githubToken: SECRETS.githubToken });
    expect(res.steps.filter((s) => s.outcome === "skipped").map((s) => s.beat)).toEqual(["pm-sync", "pm-sync", "chatops-approval"]);
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/v1/git/connections"]);
  });

  it("puts no secret in any report, even when the API echoes one back", async () => {
    const api = fakeApi({
      refuse: {
        "POST /v1/git/connections": { status: 400, body: { error: "egress_blocked", detail: `token ${SECRETS.githubToken} refused` } },
        "POST /v1/pm/connections": {
          status: 422,
          body: { error: "x", detail: `basic ${Buffer.from(`:${SECRETS.adoPat}`).toString("base64")} ${SECRETS.jiraApiToken}` },
        },
      },
    });
    const { config } = readLiveDemoConfig(ENV);
    const res = await applyLiveDemoSetup(api.call, config, SECRETS);
    const text = JSON.stringify(res.steps);
    expect(res.steps.some((s) => s.outcome === "failed")).toBe(true);
    for (const v of secretValues) expect(text).not.toContain(v);
    expect(text).not.toContain(Buffer.from(`:${SECRETS.adoPat}`).toString("base64"));
    expect(text).toContain("[redacted]");
  });

  it("scrub replaces the raw, base64 basic-auth and URL-encoded forms", () => {
    const s = { githubToken: "tok/en+value=1" };
    expect(scrub(`a tok/en+value=1 b ${encodeURIComponent("tok/en+value=1")} c ${Buffer.from(":tok/en+value=1").toString("base64")}`, s)).toBe(
      "a [redacted] b [redacted] c [redacted]",
    );
  });
});

describe("live probes (stubbed vendors)", () => {
  const base = (over: Partial<LiveProbeInput> = {}): LiveProbeInput => ({
    config: readLiveDemoConfig(ENV).config,
    github: { token: SECRETS.githubToken! },
    jira: { token: `owner@demo.example.com:${SECRETS.jiraApiToken}`, baseUrl: "https://regulait-demo.atlassian.net" },
    azureDevOps: { token: SECRETS.adoPat!, baseUrl: "https://dev.azure.com/regulait-demo" },
    slack: { token: SECRETS.slackBotToken!, signingSecretSet: true },
    simulated: async () => false,
    fetchFor: async () => okFetch,
    publicUrl: "https://demo.example.com",
    ...over,
  });
  const seen: Array<{ url: string; method: string }> = [];
  const okFetch: ProbeFetch = async (url, init) => {
    seen.push({ url, method: init.method });
    return { status: 200, json: async () => (url.includes("slack.com") ? { ok: true } : {}) };
  };

  it("passes every beat with one read-only call each", async () => {
    seen.length = 0;
    const checks = await runLiveProbes(base());
    expect(checks.every((c) => c.level === "PASS")).toBe(true);
    expect(seen).toEqual([
      { url: "https://api.github.com/repos/regulait-demo/payments-api", method: "GET" },
      { url: "https://regulait-demo.atlassian.net/rest/api/2/project/DEMO", method: "GET" },
      { url: "https://dev.azure.com/regulait-demo/_apis/projects/Payments?api-version=7.1", method: "GET" },
      { url: "https://slack.com/api/auth.test", method: "POST" },
    ]);
  });

  it("fails a refused or rejected probe without printing its token", async () => {
    const checks = await runLiveProbes(
      base({
        fetchFor: async (baseUrl) => {
          if (baseUrl.includes("atlassian")) throw new Error(`host not allow-listed (${SECRETS.jiraApiToken})`);
          return async (url) => ({ status: url.includes("slack") ? 200 : 401, json: async () => ({ ok: false, error: "invalid_auth" }) });
        },
      }),
    );
    expect(checks.filter((c) => c.level === "FAIL").map((c) => c.beat)).toEqual([
      "git-pr (live-github)",
      "pm-sync (live-jira)",
      "pm-sync (live-azure-devops)",
      "chatops-approval (live-slack)",
    ]);
    const text = JSON.stringify(checks);
    for (const v of secretValues) expect(text).not.toContain(v);
  });

  it("does not probe a beat switched to simulated, and says so", async () => {
    seen.length = 0;
    const checks = await runLiveProbes(base({ simulated: async (b) => b === "pm-sync" }));
    expect(checks.find((c) => c.beat === "pm-sync")).toMatchObject({ level: "WARN" });
    expect(seen.some((s) => s.url.includes("atlassian") || s.url.includes("dev.azure.com"))).toBe(false);
  });

  it("fails a configured integration with no connection", async () => {
    const checks = await runLiveProbes(base({ github: undefined, slack: undefined }));
    expect(checks.find((c) => c.beat === "git-pr")).toMatchObject({ level: "FAIL" });
    expect(checks.find((c) => c.beat === "chatops-approval")).toMatchObject({ level: "FAIL" });
  });
});
