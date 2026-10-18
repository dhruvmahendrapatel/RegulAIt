/**
 * ADR-0195 A5 — FEDERATED GIT-PROVIDER CREDENTIALS for the repo scanners.
 *
 * A repo source's credential is federated by default wherever the provider supports it (ADR-0180); a stored
 * read-only token stays the explicit fallback (a `settings_relax` step-up, SD0 decision 3). What each provider
 * supports was checked against its documentation on 2026-10-18 (ADR-0195 "As built: A5"):
 *
 *  - AZURE DEVOPS (`entra_workload_identity`, fully keyless): the run mints a federation token for its source
 *    (`sub` = `regulait:discovery-source:<id>`, `aud` = `api://AzureADTokenExchange`, 300 s) and exchanges it at
 *    Entra (client credentials with a client assertion) for an access token to Azure DevOps
 *    (`499b84ac-1321-427f-aa17-267ca6975798/.default`). The exchange is `@azure/identity`'s
 *    `ClientAssertionCredential` on the guarded HttpClient, the same path as the SD2 Azure scanner.
 *  - GITHUB (`github_app_installation`): GitHub accepts no external OIDC token for its API. The deployment's GitHub
 *    App key (a deploy-time PEM file named by `REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE`, never stored in the database,
 *    like the ADR-0188 issuer key) signs an RS256 JWT of at most 10 minutes, exchanged for a 1-hour installation
 *    token requested with `contents: read` and `metadata: read` only. Any other permission GitHub grants refuses the
 *    credential as write scope. The source's credential names the App id and the installation id; an App id that is
 *    not this deployment's App is refused before any call.
 *  - GITLAB, BITBUCKET: no inbound federation exists; a federated credential is refused at save time and here.
 *
 * Every call goes through the run's guarded fetch; every token, JWT and assertion is registered for scrubbing before
 * it is used, and no error text carries one.
 */
import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { SignJWT } from "jose";
import { azureCredential } from "@regulait/cloud-discovery";
import type { RepoCredentialKind } from "@regulait/git-provider";
import {
  AZURE_DEVOPS_ENTRA_SCOPE,
  GITHUB_APP_ID_ENV,
  GITHUB_APP_PRIVATE_KEY_FILE_ENV,
  GITHUB_APP_READ_PERMISSIONS,
  REPO_FEDERATION_MECHANISM,
  federationUnsupportedReason,
} from "@regulait/shared";

/** a federated credential that cannot be used; the message never carries a secret */
export class GitFederationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitFederationError";
  }
}

/** the parts of the scan context the exchanges use (structural, as `RepoScanContext` is) */
export interface GitFederationContext {
  source: { kind: string; target: Readonly<Record<string, string>> };
  credential: { publicConfig: Readonly<Record<string, string>> };
  fetch: typeof fetch;
  throttle: () => Promise<void>;
  registerSecret: (value: string) => void;
  signal: AbortSignal;
  federation?: { sourceToken: (audience: string) => Promise<string> };
}

/** a short-lived provider token for one run */
export interface FederatedGitToken {
  token: string;
  credentialKind: RepoCredentialKind;
  /** epoch ms; the scanner re-exchanges before it */
  expiresAt: number;
  writeScope: "read_only" | "write" | "unverified";
  detail: string;
}

export interface GitFederationDeps {
  /** TEST SEAM: the deployment's GitHub App (default: read from the environment) */
  githubApp?: () => GitHubAppKey | null;
  /** TEST SEAM: the clock (epoch ms) */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// the deployment's GitHub App
// ---------------------------------------------------------------------------

export interface GitHubAppKey {
  appId: string;
  privateKey: KeyObject;
}

const MAX_KEY_FILE_BYTES = 64 * 1024;
let appMemo: { file: string; appId: string; mtimeMs: number; size: number; key: GitHubAppKey } | null = null;

/**
 * The deployment's GitHub App, or null when neither variable is set (then a federated GitHub credential is refused).
 * One variable without the other, an unreadable file, or anything but one RSA private key of 2048 bits or more
 * refuses (fail closed). GitHub issues the key as PKCS#1 PEM; PKCS#8 is accepted too.
 */
export function configuredGitHubApp(env: NodeJS.ProcessEnv = process.env): GitHubAppKey | null {
  const appId = env[GITHUB_APP_ID_ENV]?.trim() ?? "";
  const file = env[GITHUB_APP_PRIVATE_KEY_FILE_ENV]?.trim() ?? "";
  if (!appId && !file) return null;
  const bad = () =>
    new GitFederationError(`${GITHUB_APP_ID_ENV} and ${GITHUB_APP_PRIVATE_KEY_FILE_ENV} must both be set: a numeric App id and a readable file holding the App's RSA private key`);
  if (!/^[0-9]{1,20}$/.test(appId) || !file) throw bad();
  let st;
  try {
    st = statSync(file);
  } catch {
    throw bad();
  }
  if (!st.isFile() || st.size > MAX_KEY_FILE_BYTES) throw bad();
  if (appMemo && appMemo.file === file && appMemo.appId === appId && appMemo.mtimeMs === st.mtimeMs && appMemo.size === st.size) return appMemo.key;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: readFileSync(file, "utf8"), format: "pem" });
  } catch {
    throw bad();
  }
  if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw bad();
  const key = { appId, privateKey };
  appMemo = { file, appId, mtimeMs: st.mtimeMs, size: st.size, key };
  return key;
}

const GITHUB_JWT_LIFETIME_SECONDS = 540;
const GITHUB_JWT_BACKDATE_SECONDS = 60;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const numericId = (v: string | undefined): v is string => typeof v === "string" && /^[0-9]{1,20}$/.test(v);

/** GitHub App installation token, downscoped to read-only contents and metadata */
export async function githubInstallationToken(ctx: GitFederationContext, deps: GitFederationDeps = {}): Promise<FederatedGitToken> {
  const app = (deps.githubApp ?? configuredGitHubApp)();
  if (!app) {
    throw new GitFederationError(
      `a federated GitHub credential needs this deployment's GitHub App: set ${GITHUB_APP_ID_ENV} and ${GITHUB_APP_PRIVATE_KEY_FILE_ENV}, or store a read-only token in static mode`,
    );
  }
  const { appId, installationId } = ctx.credential.publicConfig;
  if (!numericId(appId) || !numericId(installationId)) throw new GitFederationError("a federated GitHub credential names a numeric appId and installationId");
  // the credential is bound to one App: a token is never minted for an App the admin did not name
  if (appId !== app.appId) throw new GitFederationError(`the credential names GitHub App ${appId}, but this deployment's GitHub App is ${app.appId}`);
  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(app.appId)
    .setIssuedAt(nowSec - GITHUB_JWT_BACKDATE_SECONDS)
    .setExpirationTime(nowSec + GITHUB_JWT_LIFETIME_SECONDS)
    .sign(app.privateKey);
  ctx.registerSecret(jwt);
  let base = ctx.source.target.baseUrl ?? "https://api.github.com";
  while (base.endsWith("/")) base = base.slice(0, -1);
  await ctx.throttle();
  const res = await ctx.fetch(`${base}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ permissions: GITHUB_APP_READ_PERMISSIONS }),
    signal: ctx.signal,
  });
  const text = (await res.text()).slice(0, MAX_TOKEN_RESPONSE_BYTES);
  let body: { token?: unknown; expires_at?: unknown; permissions?: unknown; message?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }
  if (typeof body.token === "string" && body.token.length > 0) ctx.registerSecret(body.token);
  if (!res.ok) {
    const why =
      res.status === 401
        ? "GitHub rejected the App's JWT (is the key file this App's current private key?)"
        : res.status === 404
          ? `installation ${installationId} of GitHub App ${appId} was not found (is the App installed on the organisation?)`
          : res.status === 422
            ? "the App does not hold read access to repository contents and metadata"
            : `GitHub answered ${res.status}`;
    throw new GitFederationError(`the installation token exchange failed: ${why}`);
  }
  if (typeof body.token !== "string" || body.token.length === 0) throw new GitFederationError("the installation token exchange returned no token");
  const expires = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  const perms = body.permissions && typeof body.permissions === "object" ? Object.entries(body.permissions as Record<string, unknown>) : [];
  const write = perms.filter(([, v]) => v !== "read").map(([k]) => k);
  return {
    token: body.token,
    credentialKind: "github_app_installation",
    // GitHub's installation tokens last an hour; without a parseable expiry, assume less
    expiresAt: Number.isFinite(expires) ? expires : (deps.now?.() ?? Date.now()) + 30 * 60_000,
    writeScope: write.length > 0 ? "write" : perms.length > 0 ? "read_only" : "unverified",
    detail:
      write.length > 0
        ? `the installation token grants more than read: ${write.slice(0, 10).join(", ")}`
        : perms.length > 0
          ? `installation token permissions: ${perms.map(([k]) => `${k}:read`).slice(0, 10).join(", ")}`
          : "GitHub reported no permissions for the installation token; write scope unverified",
  };
}

/** the AADSTS code of an Entra error, the only part of its text kept */
const aadstsCode = (err: unknown): string | null => {
  const m = /AADSTS[0-9]{5,7}/.exec(err instanceof Error ? err.message : String(err));
  return m ? m[0] : null;
};

/** an Entra access token for Azure DevOps, obtained with a federation token (no stored secret) */
export async function azureDevOpsAccessToken(ctx: GitFederationContext, deps: GitFederationDeps = {}): Promise<FederatedGitToken> {
  const federation = ctx.federation;
  if (!federation) throw new GitFederationError("this run has no federation tokens (is the credential federated?)");
  const { tenantId, clientId } = ctx.credential.publicConfig;
  if (!tenantId || !clientId) throw new GitFederationError("a federated Azure DevOps credential names the Entra tenantId and the app registration's clientId");
  const credential = azureCredential({
    fetch: ctx.fetch,
    onSecret: ctx.registerSecret,
    credential: { mode: "azure_federated", tenantId, clientId },
    oidcToken: federation.sourceToken,
  });
  await ctx.throttle();
  let token: { token: string; expiresOnTimestamp: number } | null;
  try {
    token = await credential.getToken(AZURE_DEVOPS_ENTRA_SCOPE, { abortSignal: ctx.signal });
  } catch (err) {
    const code = aadstsCode(err);
    const hint =
      code === "AADSTS700211" || code === "AADSTS700212" || code === "AADSTS700213" || code === "AADSTS70021"
        ? " (the app registration has no federated credential matching this issuer, subject and audience api://AzureADTokenExchange)"
        : "";
    // the minter's own refusals (federation off, an audience the credential does not name) carry no secret
    const own = err instanceof Error && !code && /federation|audience/i.test(err.message) ? `: ${err.message.slice(0, 300)}` : "";
    throw new GitFederationError(`the Entra token exchange for Azure DevOps failed${code ? ` (${code})` : ""}${hint}${own}`);
  }
  if (!token?.token) throw new GitFederationError("the Entra token exchange for Azure DevOps returned no token");
  ctx.registerSecret(token.token);
  return {
    token: token.token,
    credentialKind: "entra_access_token",
    expiresAt: token.expiresOnTimestamp,
    writeScope: "unverified",
    detail: "an Entra access token carries no Azure DevOps scopes; write scope unverified (add the service principal to the Readers group only)",
  };
}

/** the federated token for a repo source's kind; refuses a kind with no inbound federation */
export async function federatedGitToken(ctx: GitFederationContext, deps: GitFederationDeps = {}): Promise<FederatedGitToken> {
  const mechanism = (REPO_FEDERATION_MECHANISM as Readonly<Record<string, string | null>>)[ctx.source.kind] ?? null;
  if (mechanism === "github_app_installation") return githubInstallationToken(ctx, deps);
  if (mechanism === "entra_workload_identity") return azureDevOpsAccessToken(ctx, deps);
  throw new GitFederationError(federationUnsupportedReason(ctx.source.kind) ?? `${ctx.source.kind.slice(0, 40)} has no federated credential`);
}
