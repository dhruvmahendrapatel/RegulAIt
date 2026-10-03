/**
 * ADR-0053 — THE ROUTE AUTH CLASSES, IN ONE PLACE.
 *
 * These two sets ARE the gateway's authorization posture: `app.ts`'s auth hook
 * refuses anything not in `AUTH_EXEMPT_ROUTES` without a credential, and its
 * admin gate refuses anything not in `NON_ADMIN_ROUTES` without `isAdmin`.
 *
 * They used to live inside `buildApp`, invisible to anything but the two hooks
 * that read them. ADR-0053 needs a published spec to state, per route, what
 * credential it requires — and a spec that *restates* the posture in a second
 * table is a spec that will be wrong the first time someone edits one and not
 * the other. So the sets moved here, unchanged, and `openapi.ts` derives the
 * documented auth class from THESE OBJECTS rather than from a parallel list.
 * The documented auth cannot drift from the enforced auth because there is only
 * one of them.
 *
 * The declaration order matters: this module must not import `app.ts` (which
 * imports it), so it depends only on the two route-name constants that were
 * already module-level.
 */
import { SCIM_ROUTES } from "./scim.js";
import {
  PROTECTED_RESOURCE_METADATA_MCP_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "./mcp-auth-metadata.js";
import { WEB_UI_ROUTES } from "./web-serving.js";

export const AUTH_EXEMPT_ROUTES = new Set([
  "/v1/pm/webhooks/:connectionName",
  // ADR-0061 — the ChatOps interaction callback. Slack/Teams hold no RegulAIt
  // credential, so this route cannot require one: it authenticates IN-ROUTE on
  // the workspace's signing secret over the exact raw body, with a replay
  // window, before it does anything else. Identical posture to the PM webhook
  // above. Passing the signature does NOT authorize a decision — the chat user
  // id is then mapped to a real human and the ONE decide path re-checks
  // entitlement server-side.
  "/v1/chatops/:connectionName/interactions",
  // /admin and /app are 302s to /ui (ADR-0026 phase-2 swap) — a browser
  // hits a bookmark before it has any credential, so the redirect itself
  // must not require one. The legacy shells they used to serve are GONE
  // (ADR-0033); /legacy/* registers no route at all.
  "/admin",
  "/app",
  "/",
  "/health",
  "/auth/login",
  "/auth/mfa/verify",
  "/auth/login-with-key",
  "/auth/logout",
  "/auth/oidc/providers",
  "/auth/oidc/:providerId/start",
  "/auth/oidc/callback",
  // ADR-0036 — the SAML twin. The provider list and /start are pre-credential
  // by definition; the ACS is called by the IdP (or by the user's browser
  // carrying the IdP's POST), which likewise holds no RegulAIt credential —
  // the assertion IS the credential and it is validated in-route. The
  // metadata document is public by design: entity id, ACS URL and our PUBLIC
  // certificate, i.e. exactly what an IdP admin would otherwise retype.
  "/auth/saml/providers",
  "/auth/saml/:providerId/start",
  "/auth/saml/:providerId/acs",
  "/auth/saml/:providerId/metadata",
  // ADR-0097 — RFC 9728 protected-resource metadata. Unauthenticated BY
  // DEFINITION: the whole point of the document is to tell a client that has
  // no credential yet how to get one, and RFC 9728 §3 places it at a
  // well-known path a client fetches before any authenticated call. Same
  // posture, and the same reasoning, as the SAML metadata document above: it
  // contains no secret and names no fact an unauthenticated caller could not
  // already observe. The scoped variant deliberately does not check whether
  // the server id exists — a 404 there would enumerate the registry.
  PROTECTED_RESOURCE_METADATA_PATH,
  PROTECTED_RESOURCE_METADATA_MCP_PATH,
  // ADR-0037 — SCIM is a SEPARATE TRUST PATH, and this exemption is what
  // makes that true rather than aspirational. These routes must never
  // authenticate via a human session cookie or a user's API key: they
  // authenticate ONLY against `scim_tokens`, inside scim.ts's own
  // encapsulated preHandler. Exempting them here means the hook below cannot
  // be the thing that lets a user credential in; presenting one to /scim/v2
  // gets a SCIM 401 from that preHandler, because it is not in `scim_tokens`.
  ...SCIM_ROUTES,
  // the /ui SPA shell (ADR-0026): a static, zero-data page like /app and
  // /admin above — the browser hits it before it has any credential; every
  // API call the page makes still authenticates normally.
  ...WEB_UI_ROUTES,
]);

export const NON_ADMIN_ROUTES = new Set([
  // ADR-0097 — RFC 9728 protected-resource metadata. A route must be BOTH
  // auth-exempt (above) and non-admin (here) to be reachable with no
  // credential — either gate refusing is a refusal — and a discovery document
  // a client can only read once it is already authenticated discovers nothing.
  `GET ${PROTECTED_RESOURCE_METADATA_PATH}`,
  `GET ${PROTECTED_RESOURCE_METADATA_MCP_PATH}`,
  "POST /v1/approvals/:approvalId/decide",
  "GET /v1/users/:userId/servers/:serverId/tools",
  "POST /mcp/:serverId",
  "POST /v1/agents/:agentId/invoke",
  // ADR-0065 — creating a training job. Its gate is the caller's OWN
  // entitlement to the base agent the customisation is anchored to, checked
  // inside the handler by the same `evaluateAgent` path an invoke takes: a
  // person who may not use a model may not train a derivative of it. Every
  // other RegulAIt-LLM route stays admin-only through the default gate, because
  // uploading a corpus, configuring a backend credential and promoting an
  // artifact to a dispatchable agent are all org-wide acts.
  "POST /v1/llm/jobs",
  // ADR-0020: the provider-shaped compatibility surfaces are the DEVELOPER's
  // path — a non-admin calling from their IDE — exactly like the MCP proxy
  // above. Their governance is the ordinary evaluateAgent entitlement check
  // inside the shim, not admin-ness. The interception SETTINGS endpoints are
  // deliberately NOT here: writing the posture stays admin-only.
  "POST /v1/messages",
  "POST /v1/chat/completions",
  // ADR-0066 §1 — the discovery endpoint. Non-admin for exactly the reason the
  // two shims above are: it is the DEVELOPER's setup call, and its governance
  // is the per-caller entitlement filter inside the handler, not admin-ness.
  // The list is scoped to the caller, so a non-admin learns nothing about
  // models they were not granted — an ungranted model is ABSENT, not 403'd.
  "GET /v1/models",
  // ADR-0066 §2 — a user may issue, inspect and revoke virtual keys for
  // THEMSELVES. That is a strict narrowing of their own entitlements and needs
  // no admin. Issuing on behalf of another user, and pinning which platform
  // credential a key burns, both refuse in-handler unless the caller is admin.
  // Note these are NOT in VIRTUAL_KEY_ALLOWED_ROUTES: a virtual key cannot
  // reach them, so a key can never mint another key.
  "POST /v1/virtual-keys",
  "GET /v1/virtual-keys",
  "GET /v1/virtual-keys/:keyId/usage",
  "PATCH /v1/virtual-keys/:keyId",
  "DELETE /v1/virtual-keys/:keyId",
  "POST /v1/connectors/:connectorId/invoke",
  "POST /v1/conversations",
  "GET /v1/conversations",
  "GET /v1/conversations/:conversationId",
  "DELETE /v1/conversations/:conversationId",
  "GET /v1/users/:userId/agents",
  "GET /v1/users/:userId/connectors",
  // ADR-0080 — the AI use-case FRONT-door. Non-admin for the same reason
  // starting a workflow instance is: the person proposing an AI use case is
  // the requester, not an admin. List/detail/edit are self-scoped INSIDE the
  // handler (owner-or-admin, exactly like the traces routes above refuse a
  // cross-user read). Conspicuously NOT here: the RETIRE endpoint — taking a
  // registered use case out of service is an org-wide act and stays admin —
  // and there is no status-writing route at all, because approved/rejected
  // exist only as decisions of the linked intake instance on the one queue.
  "POST /v1/use-cases",
  // ADR-0149: any proposer may ask for suggestions; nothing is written
  "POST /v1/use-cases/intake/assist",
  // C3: owner-or-admin, enforced in the handler like the detail route
  "GET /v1/use-cases/:useCaseId/overview",
  // ADR-0161: the deploy gate — owner-or-admin, enforced in the handler (a
  // pipeline runs as the service account that owns the use case it ships)
  "POST /v1/gates/deploy",
  "GET /v1/use-cases",
  "GET /v1/use-cases/:useCaseId",
  // ADR-0058 mapping view. Non-admin for the same reason the detail route is:
  // it is the owner's own use case. The EVIDENCE half is separately gated by
  // evaluateReportAccess, so a non-admin owner sees the control mapping and
  // only the counts their report entitlement already permits.
  "GET /v1/use-cases/:useCaseId/frameworks",
  // ADR-0124 — the execution read is NOT admin-only, on purpose. It is the
  // endpoint somebody opens when their work starts being refused, and "the
  // deployment is halted" is a far better answer than a silent denial that
  // looks like lost access. It exposes no secret and no other user's data.
  "GET /v1/execution",
  "PATCH /v1/use-cases/:useCaseId",
  // ADR-0168: a condition's OWNER may mark it met without being an admin or
  // the use case's owner — the handler enforces owner / use-case owner / admin
  "POST /v1/use-cases/:useCaseId/conditions/:conditionId/met",
  // ADR-0081 — the AI risk register, the same shape as the use-case routes
  // above: naming a risk is a front-door act, and list/detail/edit/transition
  // are owner-or-admin INSIDE the handler. Conspicuously NOT here: the ACCEPT
  // endpoint — recording that the org accepts a residual risk is an org-wide
  // act and stays admin — and there is no status-writing PATCH at all
  // (transitions are their own audited endpoint, acceptance its own record).
  "POST /v1/risks",
  "GET /v1/risks",
  "GET /v1/risks/library",
  // G2/X8: the scenario library — same class as the risk library
  "GET /v1/risks/scenarios",
  "GET /v1/risks/:riskId",
  "PATCH /v1/risks/:riskId",
  "POST /v1/risks/:riskId/transition",
  // ADR-0147: owner-or-admin, enforced in the handler like PATCH
  "PUT /v1/risks/:riskId/residual",
  "POST /v1/risks/:riskId/controls",
  "DELETE /v1/risks/:riskId/controls/:controlRef",
  // ADR-0084 — the AI vendor registry, the same shape again: proposing a
  // vendor is a front-door act, and list/detail/edit are owner-or-admin
  // INSIDE the handler. Recording a vendor ATTESTATION is owner-or-admin too
  // (it records a claim, it enforces nothing and satisfies nothing).
  // Conspicuously NOT here: the RETIRE endpoint — taking a vendor out of the
  // registry is an org-wide act and stays admin — and there is no
  // status-writing route at all, because approved/rejected exist only as
  // decisions of the linked assessment instance on the one queue.
  "POST /v1/vendors",
  "GET /v1/vendors",
  "GET /v1/vendors/:vendorId",
  "PATCH /v1/vendors/:vendorId",
  "POST /v1/vendors/:vendorId/attestations",
  "POST /v1/workflows/instances",
  "POST /v1/workflows/instances/:instanceId/artifacts",
  "POST /v1/workflows/instances/:instanceId/advance",
  "POST /v1/workflows/instances/:instanceId/checks",
  "POST /v1/workflows/instances/:instanceId/recheck",
  "POST /v1/workflows/instances/:instanceId/deploy-override",
  "POST /v1/workflows/instances/:instanceId/abort",
  "GET /v1/workflows/instances/:instanceId",
  "GET /v1/approvals",
  // ADR-0046 — the review workbench's REVIEWER-facing surface. Each of these
  // is a non-admin route for the same reason deciding an approval is: the
  // person doing the reviewing is not an admin. Every one of them still
  // applies the caller's own eligibility inside the handler — bulk goes
  // through the ONE decide path per item, claim refuses a non-member, views
  // are scoped to the owner, and workload is scoped by ADR-0022 visibility.
  // Authoring ROUTING RULES and SLA POLICIES is conspicuously NOT here:
  // deciding whose queue work lands in, and when it escalates, stays admin.
  "POST /v1/approvals/bulk",
  "POST /v1/approvals/:approvalId/claim",
  "GET /v1/approvals/workload",
  "GET /v1/approvals/views",
  "POST /v1/approvals/views",
  "DELETE /v1/approvals/views/:id",
  // ADR-0069 — a person may read THEIR OWN consolidated (metered + imported)
  // spend. The handler refuses unless the caller IS that user, so this widens
  // nothing: cross-user cost visibility stays an admin surface, because a
  // colleague's imported per-seat spend is exactly the figure that must not
  // leak sideways. Every other cost-import route — uploading a file, asserting
  // an identity mapping, reading fleet-wide — is absent here on purpose.
  "GET /v1/users/:userId/cost-consolidated",
  // ADR-0070 — a person may list and read THEIR OWN traces, and only their own.
  // Every one of these four is self-scoped INSIDE the handler: a non-admin who
  // passes `userId` for somebody else gets a 403 rather than a silently-ignored
  // parameter, and a non-admin reading another person's trace id gets a 403
  // naming why. A trace carries prompts, tool arguments and outputs — the most
  // sensitive data in this system — so this is default-deny with a self
  // exception, exactly like the consolidated-cost route directly above it. The
  // exporter routes (`/v1/tracing/*`) are conspicuously NOT here: configuring
  // and firing an outbound telemetry pipe is an admin act.
  "GET /v1/traces",
  "GET /v1/traces/:traceId",
  "GET /v1/sessions",
  "GET /v1/cost-events",
  "GET /v1/usage-events",
  // ADR-0047: a team lead generating and reading THEIR OWN scorecard. Every
  // one of these applies `evaluateReportAccess` inside the handler, which
  // returns the exact project-id list the caller may query and refuses
  // outright when that list is empty or the definition carries an ORG
  // reporting grant. Authoring DEFINITIONS and SCHEDULES, and driving the
  // schedule sweep, are conspicuously NOT here: deciding what an org-wide
  // board report contains, and who receives it, stays admin.
  "POST /v1/reports/definitions/:id/generate",
  "GET /v1/reports/runs",
  "GET /v1/reports/runs/:id",
  "GET /v1/reports/runs/:id/export",
  // ADR-0059: running and reading a BLAST-RADIUS PREVIEW. Non-admin for the
  // same reason report generation is — the team lead asking "would this rule
  // break my team" is exactly the person it exists for — and scoped inside by
  // `resolvePolicySimulationScope`, which REFUSES (never silently narrows) a
  // request naming subjects outside the caller's team visibility. Changing the
  // preview-required-before-activate dial is conspicuously NOT here.
  "POST /v1/policy-simulations",
  "GET /v1/policy-simulations",
  "GET /v1/policy-simulations/:id",
  // ADR-0058: EVALUATING a compliance pack and reading the resulting scorecard.
  // Same reasoning, same function: the handler applies `evaluateReportAccess`
  // — ADR-0047's, not a second copy — and every evidence collector builds its
  // WHERE clause FROM the returned project-id list, so a team lead's HIPAA
  // scorecard cannot contain another team's audit rows. AUTHORING packs,
  // ACTIVATING a version and RECORDING an attestation are conspicuously NOT
  // here: deciding what a framework's controls mean, and stating on the
  // organisation's behalf that an organisational control is met, stays admin.
  "POST /v1/compliance/packs/:id/evaluate",
  "GET /v1/compliance/pack-reports",
  "GET /v1/compliance/pack-reports/:id",
  // ADR-0056: the governance copilot. NON-ADMIN ON PURPOSE — the compliance
  // officer asking "who accessed PII last quarter" is exactly the person this
  // exists for, and gating it on admin would have made the entitlement-scoped
  // retrieval untested theatre. The containment is in the handler and it is
  // structural: the retrieval resolves the CALLER to a concrete project-id list
  // and builds every WHERE clause from it, an identity-less caller is refused
  // outright (there is no entitlement set to inherit), and a non-admin sees
  // only their own questions and their own proposals. The copilot has no
  // mutating tools, so there is nothing here an admin gate would be protecting.
  "GET /v1/copilot/tools",
  "POST /v1/copilot/ask",
  "GET /v1/copilot/queries",
  "POST /v1/copilot/proposals",
  "GET /v1/copilot/proposals",
  // ADR-0049: a team lead reading THEIR OWN forecast and THEIR OWN project's
  // anomaly flags. Both resolve the caller's entitlement to a CONCRETE
  // project-id set through ADR-0047's `evaluateReportAccess` — the same
  // function, not a second copy — and build every ledger query FROM that set,
  // so neither a projection nor a flag can reveal another team's spend.
  // Authoring POLICIES, recording SCHEDULED CHANGES and DRIVING the evaluator
  // are conspicuously NOT here: deciding what counts as anomalous, and
  // reading every project's ledger to find out, stays admin.
  "GET /v1/spend/forecast",
  "GET /v1/spend/anomalies",
  // ADR-0051: a team lead cutting and reading THEIR OWN team's billing view.
  // Same mechanism as ADR-0047/0049 — `evaluateReportAccess` resolves the
  // caller to a CONCRETE project-id set and every usage_events query is built
  // FROM that set, so an invoice can never total another team's spend. A view
  // cut by a caller who can see only PART of the period's scope is recorded
  // `coversFullScope: false` and is refused at issue time. Authoring RATE
  // CARDS, opening PERIODS, CLOSING a period and ISSUING an invoice are
  // conspicuously NOT here: deciding what a customer owes stays admin.
  "POST /v1/billing/periods/:id/statements",
  "GET /v1/billing/statements",
  "GET /v1/billing/statements/:id",
  "GET /v1/billing/statements/:id/export",
  "POST /v1/billing/statements/:id/reconcile",
  // ADR-0050: lineage reads. Every one narrows to the caller's own project
  // memberships INSIDE the handler — the same narrowing pillar 4 applies to
  // the context store itself, so lineage cannot become a side channel that
  // reveals context the /context endpoints would refuse. `GET
  // /v1/lineage/overview` is conspicuously NOT here: an org-wide census of
  // every project's provenance volume is an admin view.
  "GET /v1/lineage",
  "GET /v1/lineage/runs/:runId",
  "GET /v1/lineage/nodes",
  "POST /v1/users/:userId/model-credentials",
  "GET /v1/users/:userId/model-credentials",
  "DELETE /v1/users/:userId/model-credentials/:provider",
  "POST /v1/projects/:projectId/members",
  "GET /v1/projects/:projectId/members",
  "PATCH /v1/projects/:projectId/members/:userId",
  "DELETE /v1/projects/:projectId/members/:userId",
  "POST /v1/projects/:projectId/context",
  "GET /v1/projects/:projectId/context",
  "GET /v1/projects/:projectId/context/graph",
  "POST /v1/projects/:projectId/context/promote",
  "GET /v1/projects/:projectId/compliance",
  "GET /v1/projects/:projectId/costs",
  "GET /v1/projects/:projectId/costs.csv",
  // ADR-0044: triggering an eval run is governed by the caller's own AGENT
  // entitlement (evaluateAgent inside the runner), not by admin-ness — the
  // same reasoning as the invoke path above. Everything that AUTHORS what a
  // gate measures (datasets, cases, versions, the baseline) stays admin-only.
  "POST /v1/evals/runs",
  // ADR-0057: a red-team run IS an eval run (its probes go through the very
  // same `runEvalSuite` → `executeGovernedDispatch`), so it is gated by the
  // caller's own AGENT entitlement for exactly the reason above — a user who
  // cannot invoke an agent cannot probe it either. Authoring the ATTACK LIBRARY
  // stays admin-only: a library edit changes what the promotion gate measures.
  "POST /v1/redteam/runs",
  "POST /v1/runs",
  "POST /v1/runs/decompose",
  "POST /v1/runs/:runId/events",
  "POST /v1/runs/:runId/nodes/:nodeId/dispatch",
  "POST /v1/runs/:runId/auto",
  "GET /v1/runs/:runId",
  "POST /v1/runs/:runId/pm-sync",
  "POST /v1/workflows/instances/:instanceId/pm-sync",
  "GET /v1/pm/links",
  "POST /v1/decisions",
  "GET /v1/decisions",
  "POST /v1/pm/webhooks/:connectionName",
  "GET /admin",
  "GET /app",
  "GET /",
  "GET /health",
  // ADR-0026: the SPA shell, same static-page reasoning as /app above
  ...WEB_UI_ROUTES.map((r) => `GET ${r}`),
  // ADR-0025: the auth surface — login endpoints are pre-identity, the
  // self-service endpoints (me/change-password/TOTP) are every signed-in
  // human's own account. Admin-ness is not the point of any of them.
  "POST /auth/login",
  "POST /auth/mfa/verify",
  "POST /auth/login-with-key",
  "POST /auth/logout",
  "GET /auth/me",
  "POST /auth/change-password",
  // ADR-0030: a user managing their OWN username — their own account, like
  // change-password. Whether it is ALLOWED at all is the org's call
  // (org_settings.username_self_service, default false = admin-managed);
  // admin-ness is not the point of the route, so it is not the gate.
  "POST /auth/username",
  "POST /auth/totp/enroll",
  "POST /auth/totp/activate",
  "POST /auth/totp/disable",
  // ADR-0039: self-service session management — every route operates only
  // on the CALLER's own sessions (ownership is inside the WHERE clause);
  // admin-ness is not the point, exactly like change-password above.
  "GET /auth/sessions",
  "POST /auth/sessions/:sessionId/revoke",
  "POST /auth/sessions/revoke-others",
  "GET /auth/oidc/providers",
  "GET /auth/oidc/:providerId/start",
  "GET /auth/oidc/callback",
  // ADR-0036 — the SAML twin of the three above. Auth-exempt AND non-admin:
  // a browser at the login screen has no credential, and the IdP posting an
  // assertion to the ACS has no RegulAIt identity at all — the assertion is
  // the credential, and it is validated in-route.
  "GET /auth/saml/providers",
  "GET /auth/saml/:providerId/start",
  "POST /auth/saml/:providerId/acs",
  "GET /auth/saml/:providerId/metadata",
  // ADR-0037: the admin gate keys on a USER's isAdmin flag, and a SCIM
  // connector deliberately has no user identity at all — so it would 403
  // here on every request. The gate that actually applies to these routes is
  // scim.ts's own token check; admin-ness is not, and cannot be, the point.
  // The /v1/scim/* token-management endpoints are conspicuously NOT listed:
  // issuing a provisioning credential stays admin-only.
  ...SCIM_ROUTES.flatMap((r) =>
    ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => `${m} ${r}`),
  ),
  // ADR-0053: the published contract and its versioning policy. Any
  // AUTHENTICATED caller may read the spec they are building against —
  // admin-ness is not the point of a contract document. It is deliberately not
  // auth-EXEMPT: the route list of a governance deployment is not something to
  // hand an anonymous prober. `?include=all` (the internal routes) re-checks
  // isAdmin inside the handler, because THAT part is an operator view.
  "GET /v1/openapi.json",
  "GET /v1/api/versioning",
  "GET /v1/me",
  "GET /v1/model-providers/status",
  "GET /v1/runs",
  "GET /v1/workflows/instances",
  "GET /v1/projects",
  "GET /v1/users/directory",
  // ADR-0061: see the AUTH_EXEMPT note above. The admin gate keys on a USER's
  // isAdmin flag and Slack has no user identity at all, so admin-ness is not,
  // and cannot be, the gate here. The gate that applies is the signature check
  // plus the identity mapping plus the one decide path.
  "POST /v1/chatops/:connectionName/interactions",
]);

/**
 * What credential does a route actually demand? Read STRAIGHT off the two sets
 * above plus SCIM_ROUTES — the same data the hooks branch on.
 *
 *  - `public`      no credential at all (login surface, health, the SPA shell,
 *                  the PM webhook which authenticates in-route on its own
 *                  per-connection secret);
 *  - `scim-token`  a SEPARATE TRUST PATH (ADR-0037): authenticates ONLY against
 *                  `scim_tokens` inside scim.ts's own preHandler. A human
 *                  session or a user's API key is NOT accepted here, so this is
 *                  deliberately not a weaker or stronger form of `user` — it is
 *                  a different credential type entirely;
 *  - `user`        any authenticated identity (API key, bootstrap token or
 *                  session cookie); admin-ness is not the gate, though the
 *                  handler still applies the caller's own entitlement;
 *  - `admin`       the DEFAULT. `users.is_admin` is required by the preHandler
 *                  before the handler is ever reached.
 */
export type RouteAuthClass = "public" | "scim-token" | "user" | "admin";

const SCIM_ROUTE_SET: ReadonlySet<string> = new Set<string>(SCIM_ROUTES);

export function routeAuthClass(method: string, url: string): RouteAuthClass {
  if (SCIM_ROUTE_SET.has(url)) return "scim-token";
  const key = `${method.toUpperCase()} ${url}`;
  const nonAdmin = NON_ADMIN_ROUTES.has(key);
  const exempt = AUTH_EXEMPT_ROUTES.has(url);
  // A route must be BOTH auth-exempt and non-admin to be reachable with no
  // credential: the auth hook and the admin gate both run, and either one
  // refusing is a refusal. `/v1/pm/webhooks/:connectionName` is exempt and
  // non-admin; `/auth/login` likewise. Anything exempt but NOT non-admin would
  // 403 for an anonymous caller, so it is honestly `admin`.
  if (exempt && nonAdmin) return "public";
  if (nonAdmin) return "user";
  return "admin";
}
