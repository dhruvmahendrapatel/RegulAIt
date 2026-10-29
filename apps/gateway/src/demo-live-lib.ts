/**
 * ADR-0202 (lane L) — THE LIVE-DEMO PROFILE: real GitHub, Jira Cloud, Azure DevOps and Slack connections for the
 * hosted demo, created through the product's own API. Pure apart from the injected `call`, `fetch` and file reads, so
 * the suite drives every step with stubs.
 *
 * WHERE THE CREDENTIALS COME FROM, AND WHERE THEY NEVER GO
 *
 *  - Non-secret settings (repository, Jira site, Azure DevOps organisation, Slack channel) are environment variables,
 *    listed in `LIVE_DEMO_ENV`. They name places, not keys.
 *  - Secrets come from ONE of: a hidden prompt (the CLI), or a JSON file OUTSIDE the repository whose path is in
 *    `REGULAIT_DEMO_LIVE_SECRETS_FILE`. The file must be mode 0600 or stricter and must not sit inside the checkout,
 *    so a credential can never be committed by accident (`loadSecretsFile`).
 *  - A secret is posted to the API and nothing else: it is never printed, never logged, and every message this module
 *    returns is scrubbed of every secret value it was given (`scrub`), including an API error body that echoed one.
 *
 * THE MOCK SEED STAYS THE DEFAULT. Nothing here runs unless an operator runs `demo:live-setup`, and the live egress
 * entries are added by the seed only under `REGULAIT_DEMO_PROFILE=live`.
 *
 * IDEMPOTENT. A connection that already exists by name is kept, not duplicated; the Slack bot token is re-posted
 * (the connector credential route upserts). A git or PM connection's token is not replaced in place: a rotated GitHub,
 * Jira or Azure DevOps token is applied by deleting that connection ("Delete connection" on the admin Git connections
 * or PM connections page, or `DELETE /v1/git|pm/connections/:name`) and re-running.
 *
 * Open source first (ADR-0176): no library is needed. Reading a hidden line is `node:readline`, the JSON file is
 * `node:fs`, and the calls are the product's own API.
 */

import path from "node:path";

/** the connection names this profile owns; the mock seed's `demo-git` / `demo-pm` are untouched */
export const LIVE_NAMES = {
  github: "live-github",
  jira: "live-jira",
  azureDevOps: "live-azure-devops",
  slackConnector: "live-slack",
  slackChatops: "live-slack",
} as const;

/** the non-secret settings, by environment variable */
export const LIVE_DEMO_ENV = {
  profile: "REGULAIT_DEMO_PROFILE",
  secretsFile: "REGULAIT_DEMO_LIVE_SECRETS_FILE",
  githubRepo: "REGULAIT_DEMO_GITHUB_REPO",
  jiraSite: "REGULAIT_DEMO_JIRA_SITE",
  jiraProject: "REGULAIT_DEMO_JIRA_PROJECT",
  jiraEmail: "REGULAIT_DEMO_JIRA_EMAIL",
  adoOrg: "REGULAIT_DEMO_ADO_ORG",
  adoProject: "REGULAIT_DEMO_ADO_PROJECT",
  slackChannel: "REGULAIT_DEMO_SLACK_CHANNEL",
  slackTeamId: "REGULAIT_DEMO_SLACK_TEAM_ID",
} as const;

/** the secrets, by their key in the secrets file (and the prompt that asks for each) */
export const LIVE_SECRET_KEYS = {
  githubToken: "GitHub fine-grained token",
  jiraApiToken: "Jira Cloud API token",
  adoPat: "Azure DevOps personal access token",
  slackBotToken: "Slack bot token (xoxb-)",
  slackSigningSecret: "Slack signing secret",
} as const;
export type LiveSecretKey = keyof typeof LIVE_SECRET_KEYS;
export type LiveSecrets = Partial<Record<LiveSecretKey, string>>;

export interface LiveDemoConfig {
  github?: { owner: string; repo: string };
  jira?: { site: string; project: string; email: string };
  azureDevOps?: { org: string; project: string };
  slack?: { channel: string; teamId?: string };
}

const JIRA_SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;
const GITHUB_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const ADO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/;
// public channels only: the manifest has no groups:read / groups:history scope, so a private (G…) channel is refused
const SLACK_CHANNEL = /^C[A-Z0-9]{6,20}$/;
const SLACK_TEAM = /^T[A-Z0-9]{6,20}$/;

/** the live profile is opt-in, spelled exactly */
export function liveProfileRequested(env: NodeJS.ProcessEnv): boolean {
  return (env[LIVE_DEMO_ENV.profile] ?? "").trim().toLowerCase() === "live";
}

/**
 * ADR-0202 lane L review finding 1 (ADR-0181 FX3 for this script): `demo:live-setup` stores real vendor tokens through
 * a bootstrap admin, so it refuses, before migrations or any write, unless the live profile is asked for explicitly AND
 * the database is a demo one (every admin is a seed persona). Pass `realAdmins: null` for the first check, made before
 * a database pool exists; pass `realAdminEmails(db)` for the second. null = the setup may run.
 */
export function liveSetupRefusal(env: NodeJS.ProcessEnv, realAdmins: readonly string[] | null): string | null {
  if (!liveProfileRequested(env)) {
    return (
      `Refusing to set up live connections: ${LIVE_DEMO_ENV.profile}=live is not set. The live profile stores real ` +
      "vendor tokens and runs only when asked for explicitly, on a database seeded with the same setting. Nothing was written."
    );
  }
  if (realAdmins && realAdmins.length > 0) {
    const shown = realAdmins.slice(0, 3).join(", ") + (realAdmins.length > 3 ? `, and ${realAdmins.length - 3} more` : "");
    return (
      `Refusing to set up live connections: this database has an admin who is not a demo persona (${shown}), so it is ` +
      "in real use. The live-demo setup only ever runs on a database whose admins are its own personas. Use a fresh " +
      "database for the demo. Nothing was written."
    );
  }
  return null;
}

/**
 * The Jira Cloud site HOST from its env var, or null. Accepts the bare host or an https URL with no path, and only a
 * `<site>.atlassian.net` host: the egress guard matches hosts exactly (no wildcards), so the allow-list carries this
 * one tenant site rather than `*.atlassian.net`.
 */
export function jiraSiteHost(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  let host = raw.trim().toLowerCase();
  if (host.startsWith("https://")) {
    try {
      const u = new URL(host);
      if (u.pathname !== "/" || u.search || u.username || u.port) return null;
      host = u.hostname;
    } catch {
      return null;
    }
  }
  return JIRA_SITE.test(host) ? host : null;
}

/** read and validate the non-secret settings; an integration with any setting missing is left out, with the reason */
export function readLiveDemoConfig(env: NodeJS.ProcessEnv): { config: LiveDemoConfig; problems: string[] } {
  const config: LiveDemoConfig = {};
  const problems: string[] = [];
  const get = (k: string) => (env[k] ?? "").trim();
  const E = LIVE_DEMO_ENV;

  const repo = get(E.githubRepo);
  const m = GITHUB_REPO.exec(repo);
  if (m) config.github = { owner: m[1]!, repo: m[2]! };
  else problems.push(repo ? `${E.githubRepo} must be owner/repo` : `GitHub skipped: ${E.githubRepo} is not set`);

  const site = jiraSiteHost(env[E.jiraSite]);
  const project = get(E.jiraProject);
  const email = get(E.jiraEmail);
  if (site && /^[A-Z][A-Z0-9_]{1,9}$/.test(project) && /^[^\s@]+@[^\s@]+$/.test(email)) {
    config.jira = { site, project, email };
  } else if (get(E.jiraSite) || project || email) {
    problems.push(`Jira skipped: ${E.jiraSite} must be <site>.atlassian.net, ${E.jiraProject} a project key and ${E.jiraEmail} the token owner's email`);
  } else problems.push(`Jira skipped: ${E.jiraSite} is not set`);

  const org = get(E.adoOrg);
  const adoProject = get(E.adoProject);
  if (ADO_NAME.test(org) && ADO_NAME.test(adoProject)) config.azureDevOps = { org, project: adoProject };
  else problems.push(org || adoProject ? `Azure DevOps skipped: ${E.adoOrg} and ${E.adoProject} must both be names` : `Azure DevOps skipped: ${E.adoOrg} is not set`);

  const channel = get(E.slackChannel);
  const teamId = get(E.slackTeamId);
  if (SLACK_CHANNEL.test(channel) && (teamId === "" || SLACK_TEAM.test(teamId))) {
    config.slack = { channel, ...(teamId ? { teamId } : {}) };
  } else problems.push(channel ? `Slack skipped: ${E.slackChannel} must be a channel id (C…) and ${E.slackTeamId}, if set, a team id (T…)` : `Slack skipped: ${E.slackChannel} is not set`);

  return { config, problems };
}

/**
 * The live profile's egress allow-list entries, narrowest form the guard supports (exact host). Why each one:
 *  - api.github.com: the GitHub REST API, the git provider's only host (no git-over-https push).
 *  - <site>.atlassian.net: the ONE Jira Cloud tenant site; never a wildcard (the guard has none, deliberately).
 *  - dev.azure.com: Azure DevOps Services REST for work items and repositories.
 *  - slack.com: the Slack Web API (chat.postMessage, chat.update, conversations.*, auth.test).
 *  - api.resend.com: the Resend email API for lane E's product email channel.
 */
export function liveDemoEgressHosts(env: NodeJS.ProcessEnv): Array<{ host: string; note: string }> {
  const hosts = [
    { host: "api.github.com", note: "live demo: GitHub REST API for the git-pr beat (ADR-0202)" },
    { host: "dev.azure.com", note: "live demo: Azure DevOps REST for the pm-sync beat (ADR-0202)" },
    { host: "slack.com", note: "live demo: Slack Web API for the chatops-approval beat (ADR-0202)" },
    { host: "api.resend.com", note: "live demo: Resend email API for the email-notify beat (ADR-0202 lane E)" },
  ];
  const site = jiraSiteHost(env[LIVE_DEMO_ENV.jiraSite]);
  if (site) hosts.splice(1, 0, { host: site, note: "live demo: the one Jira Cloud site for the pm-sync beat (ADR-0202); exact host, no wildcard" });
  return hosts;
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

export interface SecretsFileDeps {
  /** `lstat`, not `stat`: a symbolic link at the path is refused rather than followed */
  lstat: (p: string) => { mode: number; isFile: () => boolean; isSymbolicLink: () => boolean };
  /** `realpathSync`: the outside-the-checkout check compares resolved paths, so a link in a parent directory cannot point it inside */
  realpath: (p: string) => string;
  read: (p: string) => string;
}

/** the path is outside the checkout (`repoRoot`), so a secrets file cannot be committed with the repository */
export function isOutsideRepo(filePath: string, repoRoot: string): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(filePath));
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/**
 * Read the secrets file. Refused, with a reason that names no secret, when the path is inside the repository, is not
 * a regular file, is readable or writable by group or others, or is not a JSON object of strings with known keys.
 */
export function loadSecretsFile(filePath: string, repoRoot: string, deps: SecretsFileDeps): LiveSecrets {
  if (!path.isAbsolute(filePath)) throw new Error(`${LIVE_DEMO_ENV.secretsFile} must be an absolute path`);
  if (!isOutsideRepo(filePath, repoRoot)) {
    throw new Error(`${LIVE_DEMO_ENV.secretsFile} points inside the repository; keep the secrets file outside the checkout`);
  }
  const st = deps.lstat(filePath);
  if (st.isSymbolicLink()) throw new Error(`${LIVE_DEMO_ENV.secretsFile} is a symbolic link; point it at the file itself`);
  if (!st.isFile()) throw new Error(`${LIVE_DEMO_ENV.secretsFile} is not a regular file`);
  if (!isOutsideRepo(deps.realpath(filePath), deps.realpath(repoRoot))) {
    throw new Error(`${LIVE_DEMO_ENV.secretsFile} resolves inside the repository; keep the secrets file outside the checkout`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${LIVE_DEMO_ENV.secretsFile} is readable by group or others; run chmod 600 on it`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.read(filePath));
  } catch {
    // the parser's message can quote the file's content, so it is not passed on
    throw new Error(`${LIVE_DEMO_ENV.secretsFile} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${LIVE_DEMO_ENV.secretsFile} must hold one JSON object`);
  }
  const out: LiveSecrets = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(k in LIVE_SECRET_KEYS)) throw new Error(`${LIVE_DEMO_ENV.secretsFile} has an unknown key '${k}'; expected ${Object.keys(LIVE_SECRET_KEYS).join(", ")}`);
    if (typeof v !== "string") throw new Error(`${LIVE_DEMO_ENV.secretsFile} key '${k}' must be a string`);
    if (v.trim() !== "") out[k as LiveSecretKey] = v.trim();
  }
  return out;
}

export interface InboundFileDeps {
  /** `lstat`, or null when nothing is at the path yet */
  lstat: (p: string) => { isFile: () => boolean; isSymbolicLink: () => boolean } | null;
  realpath: (p: string) => string;
}

/**
 * Where the inbound webhook secrets may be written, or the refusal. The path must be absolute, its directory must
 * resolve outside the checkout, and whatever already sits at the path must be a regular file, never a symbolic link.
 * The CLI then writes a 0600 temp file (`wx`) in that directory and renames it over the path, so no link is followed.
 */
export function inboundFileRefusal(filePath: string, repoRoot: string, deps: InboundFileDeps): string | null {
  const name = "REGULAIT_DEMO_LIVE_INBOUND_FILE";
  if (!path.isAbsolute(filePath)) return `${name} must be an absolute path`;
  if (!isOutsideRepo(path.join(deps.realpath(path.dirname(filePath)), path.basename(filePath)), deps.realpath(repoRoot))) {
    return `${name} must be outside the repository`;
  }
  const st = deps.lstat(filePath);
  if (st?.isSymbolicLink()) return `${name} is a symbolic link; point it at a plain file path`;
  if (st && !st.isFile()) return `${name} is not a regular file`;
  return null;
}

/** the secrets each configured integration needs, in prompt order */
export function neededSecrets(config: LiveDemoConfig): LiveSecretKey[] {
  const keys: LiveSecretKey[] = [];
  if (config.github) keys.push("githubToken");
  if (config.jira) keys.push("jiraApiToken");
  if (config.azureDevOps) keys.push("adoPat");
  if (config.slack) keys.push("slackBotToken", "slackSigningSecret");
  return keys;
}

/** replace every secret value (and its base64 basic-auth forms) in a message */
export function scrub(text: string, secrets: LiveSecrets, extra: string[] = []): string {
  const values = [...Object.values(secrets), ...extra].filter((v): v is string => typeof v === "string" && v.length >= 4);
  const forms = new Set<string>();
  // a basic-auth pair ("email:api-token") is scrubbed whole and by its secret half
  const expanded = values.flatMap((v) => (v.includes(":") ? [v, v.slice(v.lastIndexOf(":") + 1)] : [v])).filter((v) => v.length >= 4);
  for (const v of expanded) {
    forms.add(v);
    forms.add(Buffer.from(v).toString("base64"));
    forms.add(Buffer.from(`:${v}`).toString("base64"));
    forms.add(encodeURIComponent(v));
  }
  let out = text;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join("[redacted]");
  return out;
}

// ---------------------------------------------------------------------------
// the API calls
// ---------------------------------------------------------------------------

/** the egress allow-list route this module reads and writes */
export const EGRESS_ALLOW_HOSTS_PATH = "/v1/egress-allow-hosts";

export type ApiCall = (method: string, url: string, payload?: unknown) => Promise<{ status: number; body: any }>;

export type StepOutcome = "created" | "kept" | "updated" | "skipped" | "failed";
export interface StepReport {
  beat: "git-pr" | "pm-sync" | "chatops-approval";
  step: string;
  outcome: StepOutcome;
  detail: string;
}

export interface LiveSetupResult {
  steps: StepReport[];
  /** product-minted inbound secrets the operator registers in Jira and Azure DevOps. Never a vendor credential. */
  inbound: Array<{ connection: string; provider: "jira" | "azure_devops"; webhookSecret: string }>;
}

function errorDetail(res: { status: number; body: any }): string {
  const b = res.body;
  const parts = [`HTTP ${res.status}`];
  if (b && typeof b === "object") {
    if (typeof b.error === "string") parts.push(b.error);
    if (typeof b.detail === "string") parts.push(b.detail);
  }
  return parts.join(": ");
}

/**
 * Create (or keep) every live connection the configuration and secrets allow. Each step reports what it did; a
 * failure in one integration does not stop the others. Every detail is scrubbed of every secret.
 */
export async function applyLiveDemoSetup(call: ApiCall, config: LiveDemoConfig, secrets: LiveSecrets): Promise<LiveSetupResult> {
  const steps: StepReport[] = [];
  const inbound: LiveSetupResult["inbound"] = [];
  const report = (s: StepReport) => steps.push({ ...s, detail: scrub(s.detail, secrets) });
  const missing = (beat: StepReport["beat"], step: string, key: LiveSecretKey) =>
    report({ beat, step, outcome: "skipped", detail: `no ${LIVE_SECRET_KEYS[key]} supplied` });

  // --- GitHub (git-pr) ---
  if (config.github) {
    if (!secrets.githubToken) missing("git-pr", "github connection", "githubToken");
    else {
      const list = await call("GET", "/v1/git/connections");
      const exists = ((list.body?.connections ?? []) as Array<{ name: string }>).some((c) => c.name === LIVE_NAMES.github);
      if (exists) report({ beat: "git-pr", step: "github connection", outcome: "kept", detail: `'${LIVE_NAMES.github}' exists; to replace its token, use "Delete connection" on the admin Git connections page (/ui/admin/git-connections), then re-run` });
      else {
        const res = await call("POST", "/v1/git/connections", { name: LIVE_NAMES.github, provider: "github", token: secrets.githubToken });
        report(
          res.status < 300
            ? { beat: "git-pr", step: "github connection", outcome: "created", detail: `'${LIVE_NAMES.github}' for ${config.github.owner}/${config.github.repo}` }
            : { beat: "git-pr", step: "github connection", outcome: "failed", detail: errorDetail(res) },
        );
      }
    }
  }

  // --- Jira Cloud and Azure DevOps (pm-sync) ---
  const pmTargets: Array<{ name: string; provider: "jira" | "azure_devops"; key: LiveSecretKey; payload: () => Record<string, unknown> }> = [];
  if (config.jira) {
    const j = config.jira;
    pmTargets.push({
      name: LIVE_NAMES.jira,
      provider: "jira",
      key: "jiraApiToken",
      // Jira Cloud basic auth is "email:api-token" (pm-provider JiraProvider)
      payload: () => ({ name: LIVE_NAMES.jira, provider: "jira", baseUrl: `https://${j.site}`, project: j.project, token: `${j.email}:${secrets.jiraApiToken}` }),
    });
  }
  if (config.azureDevOps) {
    const a = config.azureDevOps;
    pmTargets.push({
      name: LIVE_NAMES.azureDevOps,
      provider: "azure_devops",
      key: "adoPat",
      payload: () => ({ name: LIVE_NAMES.azureDevOps, provider: "azure_devops", baseUrl: `https://dev.azure.com/${encodeURIComponent(a.org)}`, project: a.project, token: secrets.adoPat }),
    });
  }
  if (pmTargets.length > 0) {
    const list = await call("GET", "/v1/pm/connections");
    const names = new Set(((list.body?.connections ?? []) as Array<{ name: string }>).map((c) => c.name));
    for (const t of pmTargets) {
      const step = `${t.provider} connection`;
      if (!secrets[t.key]) missing("pm-sync", step, t.key);
      else if (names.has(t.name)) report({ beat: "pm-sync", step, outcome: "kept", detail: `'${t.name}' exists; its webhook secret was shown when it was created` });
      else {
        const res = await call("POST", "/v1/pm/connections", t.payload());
        if (res.status < 300) {
          report({ beat: "pm-sync", step, outcome: "created", detail: `'${t.name}'` });
          if (typeof res.body?.webhookSecret === "string") inbound.push({ connection: t.name, provider: t.provider, webhookSecret: res.body.webhookSecret });
        } else report({ beat: "pm-sync", step, outcome: "failed", detail: errorDetail(res) });
      }
    }
  }

  // --- Slack (chatops-approval): connector, its bot token, and the inbound ChatOps workspace ---
  if (config.slack) {
    if (!secrets.slackBotToken) missing("chatops-approval", "slack connector", "slackBotToken");
    else {
      const list = await call("GET", "/v1/connectors");
      let connectorId: string | undefined = ((list.body?.connectors ?? []) as Array<{ id: string; name: string }>).find((c) => c.name === LIVE_NAMES.slackConnector)?.id;
      if (connectorId) report({ beat: "chatops-approval", step: "slack connector", outcome: "kept", detail: `'${LIVE_NAMES.slackConnector}' exists` });
      else {
        const res = await call("POST", "/v1/connectors", { name: LIVE_NAMES.slackConnector, kind: "chat", providerKind: "slack" });
        if (res.status < 300 && typeof res.body?.id === "string") {
          connectorId = res.body.id;
          report({ beat: "chatops-approval", step: "slack connector", outcome: "created", detail: `'${LIVE_NAMES.slackConnector}'` });
        } else report({ beat: "chatops-approval", step: "slack connector", outcome: "failed", detail: errorDetail(res) });
      }
      if (connectorId) {
        const cred = await call("POST", `/v1/connectors/${connectorId}/credential`, { token: secrets.slackBotToken });
        report(
          cred.status < 300
            ? { beat: "chatops-approval", step: "slack bot token", outcome: "updated", detail: "stored encrypted on the connector" }
            : { beat: "chatops-approval", step: "slack bot token", outcome: "failed", detail: errorDetail(cred) },
        );
        if (!secrets.slackSigningSecret) missing("chatops-approval", "slack chatops workspace", "slackSigningSecret");
        else {
          const ws = await call("GET", "/v1/chatops/connections");
          const exists = ((ws.body?.connections ?? []) as Array<{ name: string }>).some((c) => c.name === LIVE_NAMES.slackChatops);
          if (exists) report({ beat: "chatops-approval", step: "slack chatops workspace", outcome: "kept", detail: `'${LIVE_NAMES.slackChatops}' exists` });
          else {
            const res = await call("POST", "/v1/chatops/connections", {
              name: LIVE_NAMES.slackChatops,
              provider: "slack",
              connectorId,
              signingSecret: secrets.slackSigningSecret,
              defaultChannel: config.slack.channel,
              ...(config.slack.teamId ? { slackTeamId: config.slack.teamId } : {}),
            });
            report(
              res.status < 300
                ? { beat: "chatops-approval", step: "slack chatops workspace", outcome: "created", detail: `'${LIVE_NAMES.slackChatops}' posting to ${config.slack.channel}` }
                : { beat: "chatops-approval", step: "slack chatops workspace", outcome: "failed", detail: errorDetail(res) },
            );
          }
        }
      }
    }
  }
  return { steps, inbound };
}

/**
 * Add the live egress entries that are missing. Adding an entry is a stepped-up relaxation (ADR-0186 A), which the
 * bootstrap credential passes only during first-admin setup; after that a refusal is REPORTED, not forced, and an
 * admin adds the host in the UI (the same rule as the seed's `seedDemoEgressAllow`).
 */
export async function ensureLiveEgressHosts(
  call: ApiCall,
  hosts: Array<{ host: string; note: string }>,
): Promise<{ added: string[]; present: string[]; needsAdmin: string[]; failed: string[] }> {
  const out = { added: [] as string[], present: [] as string[], needsAdmin: [] as string[], failed: [] as string[] };
  const list = await call("GET", EGRESS_ALLOW_HOSTS_PATH);
  const have = new Set(((list.body?.hosts ?? []) as Array<{ host: string }>).map((h) => h.host));
  for (const { host, note } of hosts) {
    if (have.has(host)) {
      out.present.push(host);
      continue;
    }
    const res = await call("POST", EGRESS_ALLOW_HOSTS_PATH, { host, note });
    if (res.status < 300) out.added.push(host);
    else if (res.status === 403 && res.body?.error === "step_up_required") out.needsAdmin.push(host);
    else out.failed.push(`${host} (${errorDetail(res)})`);
  }
  return out;
}
