/**
 * ADR-0255 (P31) — THE GOVERNED CONNECTOR CATALOGUE: a clean-room runtime for a
 * curated set of Activepieces community "pieces".
 *
 * WHAT IS (AND IS NOT) TAKEN FROM ACTIVEPIECES. Nothing executable. No
 * `@activepieces/*` package is a dependency, and no piece's code runs here.
 * Each curated piece below is re-implemented against the vendor's own public
 * REST API; what is taken from the upstream piece is its VOCABULARY — the piece
 * name, the action names and display names, and their read/write
 * classification — so an admin who knows the Activepieces catalogue recognises
 * the actions. The upstream package and version each entry was read from are
 * recorded in `upstream` (and in THIRD_PARTY.md, with the licence reasoning).
 * Only `packages/pieces/community/*` is ever a source; `packages/ee/` and
 * `packages/server/api/src/app/ee` (the proprietary Enterprise licence) never
 * are, and `scripts/activepieces-ee-guard.mjs` fails CI on any reference to them.
 *
 * WHY NOT RUN THE PIECES (ADR-0255 option a). An upstream piece makes its HTTP
 * calls through `@activepieces/pieces-common`'s axios client or a vendor SDK
 * (`@slack/web-api`, `octokit`, `googleapis`), none of which takes an injected
 * fetch, so its requests could not be routed through the egress-guarded fetch.
 * Its credentials live in the piece's own `context.auth`/store, and the
 * framework pulls in the Activepieces engine contract. Every one of those is a
 * hard requirement this module meets instead.
 *
 * THE CONTRACT, kept identical to every other adapter in this package:
 *  - `object` names the ACTION, `payload` carries its props, validated by a
 *    strict zod schema (unknown keys are refused, every string is bounded);
 *  - `operation` must equal the action's classification — a read can never
 *    reach a mutating upstream call, so a read-only grant means read-only;
 *  - every request goes through the injected `fetchImpl`, which on the gateway
 *    path is the egress-guarded fetch (ADR-0034/0062/0167) and re-adjudicates
 *    every URL, the OAuth token exchange included;
 *  - an action is a fixed, declarative request builder. There is no action that
 *    takes a URL, a method or code from the caller (the upstream "custom API
 *    call" actions and the `http`, `graphql`, `webhook` and code pieces are
 *    excluded on purpose), so no piece runs arbitrary user code.
 */
import { scrubSecrets, secretRepresentations } from "@regulait/shared";
import { z } from "zod";

/** The connector `provider_kind` of each curated piece (kept literal in index.ts too; see the note there). */
export const PIECE_PROVIDER_KINDS = [
  "piece_slack",
  "piece_jira_cloud",
  "piece_github",
  "piece_google_sheets",
  "piece_gmail",
] as const;
export type PieceProviderKind = (typeof PIECE_PROVIDER_KINDS)[number];

export function isPieceProviderKind(value: string): value is PieceProviderKind {
  return (PIECE_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** An adapter failure, with the upstream status when there was one. Mirrors ConnectorProviderError's shape. */
export class PieceCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** seconds the upstream asked us to wait, on a 429 */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PieceCallError";
  }
}

type PieceFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;

// ---------------------------------------------------------------------------
// Bounded prop schemas. Plain strings with length caps and parser-free checks,
// never a regex with nested quantifiers (M-074: input regexes stay linear).
// ---------------------------------------------------------------------------
const text = (max: number) => z.string().min(1).max(max);
/** an identifier that becomes ONE path segment; encoded on use, and never `.` or `..` */
const segment = (max = 200) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v !== "." && v !== ".." && !v.includes("/") && !v.includes("\\"), "must be a single path segment");

const slackChannelMessage = z.object({ channel: segment(100), text: text(40_000), threadTs: segment(40).optional() }).strict();
const slackDirectMessage = z.object({ userId: segment(40), text: text(40_000) }).strict();
const slackFindUserByEmail = z.object({ email: z.email().max(320) }).strict();

const jiraIssueKey = z.object({ issueIdOrKey: segment(100) }).strict();
const jiraAddComment = z.object({ issueIdOrKey: segment(100), comment: text(32_000) }).strict();
const jiraTransition = z.object({ issueIdOrKey: segment(100), transitionId: segment(20) }).strict();

const githubRepo = z.object({ owner: segment(100), repo: segment(100) }).strict();
const githubIssue = z
  .object({
    owner: segment(100),
    repo: segment(100),
    title: text(256),
    body: z.string().max(65_536).optional(),
    labels: z.array(text(50)).max(20).optional(),
  })
  .strict();
const githubPull = z.object({ owner: segment(100), repo: segment(100), pullNumber: z.int().min(1).max(1_000_000_000) }).strict();
const githubComment = z
  .object({ owner: segment(100), repo: segment(100), issueNumber: z.int().min(1).max(1_000_000_000), body: text(65_536) })
  .strict();

const sheetsSpreadsheet = z.object({ spreadsheetId: segment(200) }).strict();
const sheetsRange = z.object({ spreadsheetId: segment(200), range: segment(200) }).strict();
const sheetsAppend = z
  .object({
    spreadsheetId: segment(200),
    range: segment(200),
    values: z.array(z.array(z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()])).max(200)).min(1).max(1_000),
  })
  .strict();

/** one RFC 5322 address, no display name and no line breaks (a header-injection guard) */
const mailbox = z.email().max(320);
const gmailSend = z
  .object({
    to: z.array(mailbox).min(1).max(50),
    cc: z.array(mailbox).max(50).optional(),
    subject: z
      .string()
      .min(1)
      .max(998)
      .refine((v) => !/[\r\n]/.test(v), "must be a single line"),
    body: text(500_000),
  })
  .strict();
const gmailGetMessage = z.object({ messageId: segment(100) }).strict();

// ---------------------------------------------------------------------------
// The curated catalogue.
// ---------------------------------------------------------------------------
type Method = "GET" | "POST";
interface PieceRequest {
  method: Method;
  /** path below the piece's base URL, every caller value already encoded */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface PieceActionDef {
  /** the upstream action name (the catalogue vocabulary) */
  name: string;
  displayName: string;
  classification: "read" | "write";
  props: z.ZodType;
  request(props: never): PieceRequest;
}

export type PieceAuth = "bearer" | "jira_basic" | "google_oauth";

export interface PieceDef {
  /** the catalogue key: the upstream piece directory under packages/pieces/community */
  key: string;
  kind: PieceProviderKind;
  displayName: string;
  upstream: { npm: string; version: string; path: string };
  auth: PieceAuth;
  /** the compiled API base; null when the credential names the host (Jira Cloud's site) */
  baseUrl: string | null;
  actions: readonly PieceActionDef[];
}

const enc = encodeURIComponent;
const act = <S extends z.ZodType>(
  name: string,
  displayName: string,
  classification: "read" | "write",
  props: S,
  request: (p: z.infer<S>) => PieceRequest,
): PieceActionDef => ({ name, displayName, classification, props, request: request as (p: never) => PieceRequest });

/** Atlassian Document Format for a plain-text comment (Jira Cloud REST v3 takes ADF, not a string) */
const adf = (t: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const CURATED_PIECES: readonly PieceDef[] = [
  {
    key: "slack",
    kind: "piece_slack",
    displayName: "Slack",
    upstream: { npm: "@activepieces/piece-slack", version: "0.23.1", path: "packages/pieces/community/slack" },
    auth: "bearer",
    baseUrl: "https://slack.com/api",
    actions: [
      act("send_channel_message", "Send Message To A Channel", "write", slackChannelMessage, (p) => ({
        method: "POST",
        path: "/chat.postMessage",
        body: { channel: p.channel, text: p.text, ...(p.threadTs ? { thread_ts: p.threadTs } : {}) },
      })),
      act("send_direct_message", "Send Message To A User", "write", slackDirectMessage, (p) => ({
        method: "POST",
        path: "/chat.postMessage",
        body: { channel: p.userId, text: p.text },
      })),
      act("find_user_by_email", "Find User by Email", "read", slackFindUserByEmail, (p) => ({
        method: "GET",
        path: "/users.lookupByEmail",
        query: { email: p.email },
      })),
    ],
  },
  {
    key: "jira-cloud",
    kind: "piece_jira_cloud",
    displayName: "Jira Cloud",
    upstream: { npm: "@activepieces/piece-jira-cloud", version: "0.6.4", path: "packages/pieces/community/jira-cloud" },
    auth: "jira_basic",
    baseUrl: null,
    actions: [
      act("get_issue", "Get Issue", "read", jiraIssueKey, (p) => ({ method: "GET", path: `/rest/api/3/issue/${enc(p.issueIdOrKey)}` })),
      act("get_issue_transitions", "Get Issue Transitions", "read", jiraIssueKey, (p) => ({
        method: "GET",
        path: `/rest/api/3/issue/${enc(p.issueIdOrKey)}/transitions`,
      })),
      act("add_comment", "Add Comment", "write", jiraAddComment, (p) => ({
        method: "POST",
        path: `/rest/api/3/issue/${enc(p.issueIdOrKey)}/comment`,
        body: { body: adf(p.comment) },
      })),
      act("transition_issue", "Transition Issue", "write", jiraTransition, (p) => ({
        method: "POST",
        path: `/rest/api/3/issue/${enc(p.issueIdOrKey)}/transitions`,
        body: { transition: { id: p.transitionId } },
      })),
    ],
  },
  {
    key: "github",
    kind: "piece_github",
    displayName: "GitHub",
    upstream: { npm: "@activepieces/piece-github", version: "0.11.1", path: "packages/pieces/community/github" },
    auth: "bearer",
    baseUrl: "https://api.github.com",
    actions: [
      act("get_repository", "Get Repository", "read", githubRepo, (p) => ({ method: "GET", path: `/repos/${enc(p.owner)}/${enc(p.repo)}` })),
      act("get_pull_request", "Get Pull Request", "read", githubPull, (p) => ({
        method: "GET",
        path: `/repos/${enc(p.owner)}/${enc(p.repo)}/pulls/${p.pullNumber}`,
      })),
      act("github_create_issue", "Create Issue", "write", githubIssue, (p) => ({
        method: "POST",
        path: `/repos/${enc(p.owner)}/${enc(p.repo)}/issues`,
        body: { title: p.title, ...(p.body !== undefined ? { body: p.body } : {}), ...(p.labels ? { labels: p.labels } : {}) },
      })),
      act("create_issue_comment_ai", "Create Issue Comment", "write", githubComment, (p) => ({
        method: "POST",
        path: `/repos/${enc(p.owner)}/${enc(p.repo)}/issues/${p.issueNumber}/comments`,
        body: { body: p.body },
      })),
    ],
  },
  {
    key: "google-sheets",
    kind: "piece_google_sheets",
    displayName: "Google Sheets",
    upstream: { npm: "@activepieces/piece-google-sheets", version: "0.19.5", path: "packages/pieces/community/google-sheets" },
    auth: "google_oauth",
    baseUrl: "https://sheets.googleapis.com",
    actions: [
      act("sheets_get_spreadsheet", "Get Spreadsheet Info", "read", sheetsSpreadsheet, (p) => ({
        method: "GET",
        path: `/v4/spreadsheets/${enc(p.spreadsheetId)}`,
        query: { includeGridData: "false" },
      })),
      act("sheets_get_values", "Read Cell Range", "read", sheetsRange, (p) => ({
        method: "GET",
        path: `/v4/spreadsheets/${enc(p.spreadsheetId)}/values/${enc(p.range)}`,
      })),
      act("sheets_append_values", "Append Values (Raw)", "write", sheetsAppend, (p) => ({
        method: "POST",
        path: `/v4/spreadsheets/${enc(p.spreadsheetId)}/values/${enc(p.range)}:append`,
        query: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
        body: { values: p.values },
      })),
    ],
  },
  {
    key: "gmail",
    kind: "piece_gmail",
    displayName: "Gmail",
    upstream: { npm: "@activepieces/piece-gmail", version: "0.18.6", path: "packages/pieces/community/gmail" },
    auth: "google_oauth",
    baseUrl: "https://gmail.googleapis.com",
    actions: [
      act("gmail_get_profile", "Get Profile", "read", z.object({}).strict(), () => ({ method: "GET", path: "/gmail/v1/users/me/profile" })),
      act("gmail_get_message", "Get Message", "read", gmailGetMessage, (p) => ({
        method: "GET",
        path: `/gmail/v1/users/me/messages/${enc(p.messageId)}`,
        query: { format: "metadata" },
      })),
      act("gmail_send_email", "Send Email", "write", gmailSend, (p) => ({
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
        body: { raw: rfc822(p) },
      })),
    ],
  },
];

/** a plain-text RFC 822 message, base64url as the Gmail API takes it. Every header value is single-line by schema. */
function rfc822(p: z.infer<typeof gmailSend>): string {
  const lines = [
    `To: ${p.to.join(", ")}`,
    ...(p.cc?.length ? [`Cc: ${p.cc.join(", ")}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(p.subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(p.body, "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const BY_KIND = new Map(CURATED_PIECES.map((p) => [p.kind, p]));
const BY_KEY = new Map(CURATED_PIECES.map((p) => [p.key, p]));

export function curatedPieceByKind(kind: string): PieceDef | undefined {
  return BY_KIND.get(kind as PieceProviderKind);
}
export function curatedPieceByKey(key: string): PieceDef | undefined {
  return BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// Credentials. Stored by the gateway in connector_credentials (AES-256-GCM,
// REGULAIT_DATA_KEY), decrypted per call and handed in here; a piece never
// keeps or persists one.
// ---------------------------------------------------------------------------
const jiraCredentialSchema = z
  .object({
    /** the Jira Cloud site root, e.g. https://acme.atlassian.net — a host and nothing else */
    siteUrl: z.string().min(1).max(300),
    email: z.email().max(320),
    apiToken: z.string().min(1).max(500),
  })
  .strict();
const googleCredentialSchema = z
  .object({
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(500),
    refreshToken: z.string().min(1).max(2_000),
  })
  .strict();

export interface JiraPieceCredential {
  siteUrl: string;
  email: string;
  apiToken: string;
}
export type GooglePieceCredential = z.infer<typeof googleCredentialSchema>;

/** Jira Cloud's site: https, an `*.atlassian.net` host, no port, credentials, path, query or fragment. */
function jiraSiteOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PieceCallError("jira-cloud credential: siteUrl is not an absolute URL", 400);
  }
  const host = u.hostname.toLowerCase();
  const pathOk = u.pathname === "/" || u.pathname === "";
  if (u.protocol !== "https:" || u.username || u.password || u.port || !pathOk || u.search || u.hash) {
    throw new PieceCallError("jira-cloud credential: siteUrl must be https://<site>.atlassian.net with nothing after the host", 400);
  }
  const label = host.endsWith(".atlassian.net") ? host.slice(0, -".atlassian.net".length) : "";
  if (!label || label.includes(".")) {
    throw new PieceCallError("jira-cloud credential: siteUrl must be a single <site>.atlassian.net host", 400);
  }
  return `https://${host}`;
}

function parseJson(token: string, piece: string): unknown {
  try {
    return JSON.parse(token);
  } catch {
    throw new PieceCallError(`${piece} credential must be a JSON object`, 400);
  }
}

export function parseJiraPieceCredential(token: string): JiraPieceCredential {
  const r = jiraCredentialSchema.safeParse(parseJson(token, "jira-cloud"));
  if (!r.success) throw new PieceCallError("jira-cloud credential must be {siteUrl, email, apiToken}", 400);
  return { ...r.data, siteUrl: jiraSiteOrigin(r.data.siteUrl) };
}

export function parseGooglePieceCredential(token: string): GooglePieceCredential {
  const r = googleCredentialSchema.safeParse(parseJson(token, "google"));
  if (!r.success) throw new PieceCallError("google credential must be {clientId, clientSecret, refreshToken}", 400);
  return r.data;
}

/** Validate a credential's shape at write time (the same parse the call makes). Throws PieceCallError. */
export function parsePieceCredential(kind: PieceProviderKind, token: string): void {
  const piece = BY_KIND.get(kind)!;
  if (piece.auth === "jira_basic") parseJiraPieceCredential(token);
  else if (piece.auth === "google_oauth") parseGooglePieceCredential(token);
  else if (!token.trim() || token.length > 2_000) throw new PieceCallError(`${piece.key} credential must be a token`, 400);
}

/**
 * The hosts a piece reaches: the one an admin TYPED (Jira's site, adjudicated against the allow-list under every
 * posture) and the vendor's COMPILED ones (which follow the deployment posture). Same split as
 * `connectorCredentialHosts`, which delegates here.
 */
export function pieceHosts(kind: PieceProviderKind, token: string | null): { typed: string | null; compiled: string[] } {
  const piece = BY_KIND.get(kind)!;
  if (piece.auth === "jira_basic") return { typed: token ? parseJiraPieceCredential(token).siteUrl : null, compiled: [] };
  const compiled = piece.baseUrl ? [piece.baseUrl] : [];
  if (piece.auth === "google_oauth") compiled.push(GOOGLE_TOKEN_URL);
  return { typed: null, compiled };
}

// ---------------------------------------------------------------------------
// The runtime.
// ---------------------------------------------------------------------------
export interface PieceInvocation {
  operation: "read" | "write";
  object?: string | null;
  payload?: Record<string, unknown> | null;
}

export class PieceConnectorProvider {
  readonly kind: PieceProviderKind;
  private readonly piece: PieceDef;

  constructor(
    kind: PieceProviderKind,
    private readonly token: string,
    private readonly fetchImpl: PieceFetch,
  ) {
    this.kind = kind;
    this.piece = BY_KIND.get(kind)!;
  }

  async invoke(inv: PieceInvocation): Promise<{ status: number; body: unknown }> {
    const name = inv.object ?? "";
    const action = this.piece.actions.find((a) => a.name === name);
    if (!action) {
      throw new PieceCallError(
        `${this.piece.key}: unknown action '${name.slice(0, 100)}'; expected one of ${this.piece.actions.map((a) => a.name).join(", ")}`,
        400,
      );
    }
    if (action.classification !== inv.operation) {
      throw new PieceCallError(`${this.piece.key}.${action.name} is a ${action.classification} action; it cannot run as a ${inv.operation}`, 400);
    }
    const parsed = action.props.safeParse(inv.payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(payload)"}: ${i.message}`);
      throw new PieceCallError(`${this.piece.key}.${action.name}: invalid props (${issues.join("; ")})`, 400);
    }
    const req = action.request(parsed.data as never);
    const { base, headers, secrets } = await this.authorise();
    const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
    const res = await this.fetchImpl(`${base}${req.path}${qs}`, {
      method: req.method,
      headers: { accept: "application/json", ...headers, ...(req.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
    const raw = await res.text();
    if (res.status === 429) {
      const after = Number.parseInt(res.headers?.get("retry-after") ?? "", 10);
      throw new PieceCallError(`${this.piece.key}.${action.name}: upstream rate limit`, 429, Number.isFinite(after) && after >= 0 ? after : undefined);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new PieceCallError(`${this.piece.key}.${action.name}: upstream ${res.status}: ${scrubSecrets(raw.slice(0, 500), secrets)}`, res.status);
    }
    let body: unknown = raw ? raw : null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* a non-JSON 2xx is data */
    }
    // Slack answers HTTP 200 with {ok:false,error} for a refused call
    if (this.piece.key === "slack" && body && typeof body === "object" && (body as { ok?: unknown }).ok === false) {
      const err = String((body as { error?: unknown }).error ?? "unknown_error").slice(0, 100);
      if (err === "ratelimited") throw new PieceCallError(`slack.${action.name}: upstream rate limit`, 429);
      throw new PieceCallError(`slack.${action.name}: ${err}`, 502);
    }
    return { status: res.status, body };
  }

  private async authorise(): Promise<{ base: string; headers: Record<string, string>; secrets: string[] }> {
    const p = this.piece;
    if (p.auth === "bearer") {
      const extra: Record<string, string> =
        p.key === "github" ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } : {};
      return { base: p.baseUrl!, headers: { authorization: `Bearer ${this.token}`, ...extra }, secrets: secretRepresentations(this.token) };
    }
    if (p.auth === "jira_basic") {
      const c = parseJiraPieceCredential(this.token);
      const basic = Buffer.from(`${c.email}:${c.apiToken}`, "utf8").toString("base64");
      return { base: c.siteUrl, headers: { authorization: `Basic ${basic}` }, secrets: [...secretRepresentations(c.apiToken), ...secretRepresentations(basic)] };
    }
    const c = parseGooglePieceCredential(this.token);
    const secrets = [...secretRepresentations(c.clientSecret), ...secretRepresentations(c.refreshToken)];
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }).toString(),
    });
    const raw = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new PieceCallError(`${p.key}: token exchange failed (${res.status}): ${scrubSecrets(raw.slice(0, 300), secrets)}`, res.status === 400 ? 401 : res.status);
    }
    let accessToken: unknown;
    try {
      accessToken = (JSON.parse(raw) as { access_token?: unknown }).access_token;
    } catch {
      accessToken = undefined;
    }
    if (typeof accessToken !== "string" || !accessToken) throw new PieceCallError(`${p.key}: token exchange returned no access_token`, 502);
    return { base: p.baseUrl!, headers: { authorization: `Bearer ${accessToken}` }, secrets: [...secrets, ...secretRepresentations(accessToken)] };
  }
}
