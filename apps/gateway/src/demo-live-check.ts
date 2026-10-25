/**
 * ADR-0202 (lane L) — `demo:check --live-connections`: one READ-ONLY call per live connection, reported PASS / WARN /
 * FAIL per beat, without printing a credential.
 *
 * Every probe goes out through `guardConnectionCall`, the same egress guard (allow-list, DNS pin, no redirects) every
 * real call uses, so a host missing from the allow-list FAILs here exactly as it would on stage. The probes:
 *   - git-pr:            GET  https://api.github.com/repos/<owner>/<repo>            (GitHub token)
 *   - pm-sync (Jira):    GET  https://<site>.atlassian.net/rest/api/2/project/<KEY>  (email:api-token)
 *   - pm-sync (ADO):     GET  https://dev.azure.com/<org>/_apis/projects/<project>   (PAT)
 *   - chatops-approval:  POST https://slack.com/api/auth.test                         (bot token; reads identity only)
 * A beat an admin switched to its simulated fallback is reported WARN, not probed: it will not call out on stage.
 * Every detail line is scrubbed of the token it used.
 */

import { chatopsConnections, connectorCredentials, connectors, eq, gitConnections, pmConnections, type Db } from "@regulait/db";
import type { DemoCheck } from "./demo-check-lib.js";
import { isBeatSimulated, type DemoBeatId } from "./demo-beats.js";
import { LIVE_NAMES, readLiveDemoConfig, scrub, type LiveDemoConfig } from "./demo-live-lib.js";

export type ProbeSurface = "git_connection" | "pm_connection" | "connector";

export type ProbeFetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface LiveProbeInput {
  config: LiveDemoConfig;
  /** decrypted credentials of the live connections that exist, keyed by LIVE_NAMES value; absent = no connection */
  github?: { token: string };
  jira?: { token: string; baseUrl: string };
  azureDevOps?: { token: string; baseUrl: string };
  slack?: { token: string; signingSecretSet: boolean };
  simulated: (beat: DemoBeatId) => Promise<boolean>;
  /** a guarded fetch for this base URL on its egress surface (refuses with an Error whose message is the guard's reason) */
  fetchFor: (baseUrl: string, label: string, surface: ProbeSurface) => Promise<ProbeFetch>;
  publicUrl?: string | null;
}

const basic = (userPass: string) => `Basic ${Buffer.from(userPass).toString("base64")}`;

async function probe(
  input: LiveProbeInput,
  beat: DemoBeatId,
  name: string,
  token: string,
  baseUrl: string,
  surface: ProbeSurface,
  url: string,
  init: { method: string; headers: Record<string, string> },
  ok: (status: number, body: unknown) => string | null,
): Promise<DemoCheck> {
  const label = `${beat} (${name})`;
  try {
    const f = await input.fetchFor(baseUrl, `live probe '${name}'`, surface);
    const res = await f(url, init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON: judged on status alone */
    }
    const problem = ok(res.status, body);
    return problem === null
      ? { beat: label, level: "PASS", detail: `read-only probe answered HTTP ${res.status}` }
      : { beat: label, level: "FAIL", detail: scrub(problem, {}, [token]), fix: "check the token's scopes in DEMO_REAL_ACCOUNTS.md, or switch this beat to simulated" };
  } catch (err) {
    return {
      beat: label,
      level: "FAIL",
      detail: scrub(`probe refused or unreachable: ${(err as Error).message}`, {}, [token]),
      fix: "add the host to the egress allow-list (Custom LLM providers > Egress allow-list), or switch this beat to simulated",
    };
  }
}

const httpOk = (status: number) => (status >= 200 && status < 300 ? null : `HTTP ${status}`);

export async function runLiveProbes(input: LiveProbeInput): Promise<DemoCheck[]> {
  const out: DemoCheck[] = [];
  const { config } = input;
  const skipIfSimulated = async (beat: DemoBeatId): Promise<boolean> => {
    if (!(await input.simulated(beat))) return false;
    out.push({ beat, level: "WARN", detail: "switched to its simulated fallback by an admin; not probed", fix: "PUT /v1/demo/beats/" + beat + " { simulated: false } when the vendor is back" });
    return true;
  };

  if (!(await skipIfSimulated("git-pr"))) {
    if (!config.github) out.push({ beat: "git-pr", level: "WARN", detail: "no live GitHub repository configured (REGULAIT_DEMO_GITHUB_REPO)" });
    else if (!input.github) out.push({ beat: "git-pr", level: "FAIL", detail: `no '${LIVE_NAMES.github}' git connection`, fix: "run demo:live-setup" });
    else {
      const { owner, repo } = config.github;
      const t = input.github.token;
      out.push(
        await probe(input, "git-pr", LIVE_NAMES.github, t, "https://api.github.com", "git_connection", `https://api.github.com/repos/${owner}/${repo}`, {
          method: "GET",
          headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        }, httpOk),
      );
    }
  }

  if (!(await skipIfSimulated("pm-sync"))) {
    if (!config.jira && !config.azureDevOps) out.push({ beat: "pm-sync", level: "WARN", detail: "no live Jira or Azure DevOps configured" });
    if (config.jira) {
      if (!input.jira) out.push({ beat: "pm-sync (jira)", level: "FAIL", detail: `no '${LIVE_NAMES.jira}' PM connection`, fix: "run demo:live-setup" });
      else {
        const { token, baseUrl } = input.jira;
        out.push(
          await probe(input, "pm-sync", LIVE_NAMES.jira, token, baseUrl, "pm_connection", `${baseUrl.replace(/\/$/, "")}/rest/api/2/project/${encodeURIComponent(config.jira.project)}`, {
            method: "GET",
            headers: { authorization: basic(token), accept: "application/json" },
          }, httpOk),
        );
      }
    }
    if (config.azureDevOps) {
      if (!input.azureDevOps) out.push({ beat: "pm-sync (azure devops)", level: "FAIL", detail: `no '${LIVE_NAMES.azureDevOps}' PM connection`, fix: "run demo:live-setup" });
      else {
        const { token, baseUrl } = input.azureDevOps;
        out.push(
          await probe(input, "pm-sync", LIVE_NAMES.azureDevOps, token, baseUrl, "pm_connection", `${baseUrl.replace(/\/$/, "")}/_apis/projects/${encodeURIComponent(config.azureDevOps.project)}?api-version=7.1`, {
            method: "GET",
            headers: { authorization: basic(`:${token}`), accept: "application/json" },
          }, httpOk),
        );
      }
    }
  }

  if (!(await skipIfSimulated("chatops-approval"))) {
    if (!config.slack) out.push({ beat: "chatops-approval", level: "WARN", detail: "no live Slack channel configured (REGULAIT_DEMO_SLACK_CHANNEL)" });
    else if (!input.slack) out.push({ beat: "chatops-approval", level: "FAIL", detail: `no '${LIVE_NAMES.slackConnector}' connector credential`, fix: "run demo:live-setup" });
    else {
      const t = input.slack.token;
      out.push(
        await probe(input, "chatops-approval", LIVE_NAMES.slackConnector, t, "https://slack.com/api", "connector", "https://slack.com/api/auth.test", {
          method: "POST",
          headers: { authorization: `Bearer ${t}`, "content-type": "application/x-www-form-urlencoded" },
        }, (status, body) => {
          if (status !== 200) return `HTTP ${status}`;
          const b = body as { ok?: boolean; error?: string } | null;
          return b?.ok === true ? null : `auth.test answered ok:false (${typeof b?.error === "string" ? b.error : "no error code"})`;
        }),
      );
      if (!input.slack.signingSecretSet) {
        out.push({ beat: "chatops-approval (inbound)", level: "FAIL", detail: `no '${LIVE_NAMES.slackChatops}' ChatOps workspace with a signing secret`, fix: "run demo:live-setup with the Slack signing secret" });
      } else if (!input.publicUrl) {
        out.push({ beat: "chatops-approval (inbound)", level: "WARN", detail: "REGULAIT_PUBLIC_URL is not set, so Slack cannot reach the interactivity URL" });
      } else {
        out.push({ beat: "chatops-approval (inbound)", level: "PASS", detail: `signing secret set; Slack posts to ${input.publicUrl.replace(/\/$/, "")}/v1/chatops/${LIVE_NAMES.slackChatops}/interactions` });
      }
    }
  }
  return out;
}

/** gather the live connections from the database and run the probes */
export async function runLiveConnectionChecks(
  db: Db,
  deps: {
    env: NodeJS.ProcessEnv;
    decrypt: (ciphertext: string) => string;
    fetchFor: LiveProbeInput["fetchFor"];
  },
): Promise<DemoCheck[]> {
  const { config, problems } = readLiveDemoConfig(deps.env);
  const [git] = await db.select().from(gitConnections).where(eq(gitConnections.name, LIVE_NAMES.github));
  const pm = await db.select().from(pmConnections);
  const jira = pm.find((p) => p.name === LIVE_NAMES.jira);
  const ado = pm.find((p) => p.name === LIVE_NAMES.azureDevOps);
  const [slackConnector] = await db.select().from(connectors).where(eq(connectors.name, LIVE_NAMES.slackConnector));
  const [slackCred] = slackConnector
    ? await db.select().from(connectorCredentials).where(eq(connectorCredentials.connectorId, slackConnector.id))
    : [];
  const [chatops] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, LIVE_NAMES.slackChatops));
  const checks = await runLiveProbes({
    config,
    ...(git ? { github: { token: deps.decrypt(git.tokenCiphertext) } } : {}),
    ...(jira?.baseUrl ? { jira: { token: deps.decrypt(jira.tokenCiphertext), baseUrl: jira.baseUrl } } : {}),
    ...(ado?.baseUrl ? { azureDevOps: { token: deps.decrypt(ado.tokenCiphertext), baseUrl: ado.baseUrl } } : {}),
    ...(slackCred ? { slack: { token: deps.decrypt(slackCred.tokenCiphertext), signingSecretSet: Boolean(chatops?.signingSecretCiphertext) } } : {}),
    simulated: (beat) => isBeatSimulated(db, beat),
    fetchFor: deps.fetchFor,
    publicUrl: deps.env.REGULAIT_PUBLIC_URL ?? null,
  });
  return [...problems.map((p): DemoCheck => ({ beat: "live config", level: "WARN", detail: p })), ...checks];
}
