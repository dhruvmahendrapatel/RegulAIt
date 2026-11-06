/**
 * ADR-0197 demo screen polish — the Discovery sources page (S1) and the audit page (G8) as a presenter sees them:
 * human labels with the codes kept as secondary text, no environment variable named on an admin screen, one
 * en-GB date format, no "(disabled)" in a button label, and the audit trail ahead of the evidence tools.
 * Rendered with react-dom/server from seeded query data (no DOM, no network).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import DiscoverySourcesPage from "./DiscoverySourcesPage";
import AuditLogPage from "./AuditLogPage";
import type { FederationStatusView } from "./FederationCard";
import type { DiscoveryRunView, DiscoverySourceView, ScannerKindView } from "./discoverySourcesModel";

const AT = "2026-10-26T00:11:07.000Z";

const kinds: ScannerKindView[] = [
  { kind: "repo_github", label: "GitHub repositories", family: "repo", slice: "SD1", evidenceKinds: ["repo_scan"], subjectKinds: ["repo"], built: true, requiresCredential: true },
  { kind: "cloud_aws", label: "AWS", family: "cloud", slice: "SD2", evidenceKinds: ["cloud_inventory", "cloud_audit_log"], subjectKinds: ["cloud_resource"], built: true, requiresCredential: true },
];
const source: DiscoverySourceView = {
  id: "s1", name: "Acme GitHub", kind: "repo_github", target: { org: "acme" }, scope: { orgLevel: true, include: [] }, enabled: false,
  scheduleIntervalSeconds: 86400, version: 1, nextRunAt: null, lastRunAt: null, scannerBuilt: true, credential: null, lastRun: null,
};
const run: DiscoveryRunView = {
  id: "r1", sourceId: "s1", kind: "repo_github", trigger: "manual", status: "succeeded", attempt: 1, startedAt: AT, finishedAt: AT,
  observed: 3, matched: 1, findingsCreated: 1, findingsUpdated: 0,
  catalogueGaps: [{ kind: "desktop_app", value: "cli.anthropic.claude" }, { kind: "ide_extension", value: "github.copilot" }],
  readOutcomes: [{ read: "repos", status: "read" }], rawOutputSha256: null, errorCode: null, errorDetail: null, createdAt: AT,
};
const federation: FederationStatusView = {
  enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 300, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" },
  subjectFormat: "", audiences: { aws: "", azure: "", gcp: "" },
};

/** a query that has failed, as react-query holds it after a 5xx */
function failQuery(qc: QueryClient, queryKey: string[]) {
  qc.getQueryCache().build(qc, { queryKey }).setState({ status: "error", error: new Error("gateway unavailable"), fetchStatus: "idle" });
}

/**
 * `fed` / `runs` / `settings` null: that read has not answered yet; "fail": it failed.
 */
function renderDiscovery(
  fed: FederationStatusView | null | "fail" = federation,
  opts: { runs?: DiscoveryRunView[] | null | "fail"; kinds?: ScannerKindView[]; settings?: null | "fail" } = {},
) {
  // retryOnMount off: a failed read stays failed on this render, as it is between a 5xx and the reader's Retry
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
  qc.setQueryData(["admin", "discovery", "scanners"], { kinds: opts.kinds ?? kinds });
  qc.setQueryData(["admin", "discovery", "sources"], {
    sources: [source],
    posture: { sourcesTotal: 1, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "Nothing is scanned." },
  });
  const runs = opts.runs === undefined ? [run] : opts.runs;
  // P3: the overview reads one small page of runs: its preview rows, the total and the failed count
  const preview = ["admin", "discovery", "runs", "preview", "estimate"];
  if (runs === "fail") {
    failQuery(qc, preview);
  } else if (runs) {
    const failed = runs.filter((r) => r.status === "failed").length;
    qc.setQueryData(preview, { items: runs, nextCursor: null, nextOffset: null, total: runs.length, totalIsEstimate: false, raw: { items: runs, failed } });
  }
  if (opts.settings === "fail") failQuery(qc, ["admin", "discovery", "settings"]);
  else if (opts.settings !== null) qc.setQueryData(["admin", "discovery", "settings"], { credentialWarningAgeDays: 90, endpointRetentionDays: 90, version: 1 });
  if (fed === "fail") failQuery(qc, ["admin", "discovery", "federation"]);
  else if (fed) qc.setQueryData(["admin", "discovery", "federation"], fed);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DiscoverySourcesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Discovery sources (S1)", () => {
  const html = renderDiscovery();
  it("labels the add button plainly and explains that a new source starts off", () => {
    expect(html).not.toContain("Add source (disabled)");
    expect(html).toMatch(/>Add source<\/button>/);
    expect(html).toContain("A new source is added turned off");
  });
  it("shows scanner kinds and evidence kinds in words, keeping the codes as secondary text", () => {
    expect(html).toContain("GitHub repositories");
    expect(html).toContain("Cloud inventory, Cloud audit log");
    expect(html).toContain("cloud_inventory, cloud_audit_log");
    expect(html).toContain("repo_github");
  });
  it("names catalogue gaps with their kind, the code kept", () => {
    expect(html).toContain("IDE extension: <strong>GitHub Copilot</strong>");
    expect(html).toContain("Desktop app: <strong>Anthropic Claude</strong>");
    expect(html).toContain("ide_extension:github.copilot");
  });
  it("never names the environment variable behind a missing public URL", () => {
    expect(html).not.toContain("REGULAIT_PUBLIC_URL");
    expect(html).toContain("public URL is not configured");
    // D3 (#46): plain wording, no internal doc path and no cloud API call
    expect(html).toContain("as described in the cloud discovery deployment guide");
    expect(html).not.toContain("docs/deployment/");
    expect(html).not.toContain("AssumeRoleWithWebIdentity");
    expect(html).toContain("each AWS source assumes your role directly with a short-lived token from this issuer");
  });
  it("says what turning federation on does, and what it asks, in both states (D3 #36)", () => {
    expect(html).toContain("Turning it on lets federated cloud sources run, and asks you to confirm it&#x27;s you.");
    const on = renderDiscovery({ ...federation, enabled: true });
    expect(on).toContain(
      "Federation is on, so federated cloud sources can run. Rotating to a new key or revoking a key asks you to confirm it&#x27;s you; turning federation off does not.",
    );
    expect(on).not.toContain("Turning it on asks you to confirm");
  });
  it("writes dates in the en-GB form, never the US one, and keeps them on one line", () => {
    expect(html).toMatch(/white-space:nowrap">\d{1,2} Oct 2026, \d{2}:\d{2}</);
    expect(html).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });
  it("spells the product name with the wordmark", () => {
    expect(html).not.toContain("RegulAIt");
    expect(html).toContain("regulAIt");
  });
});

describe("Discovery sources: design batch D1 (#547)", () => {
  const failedRun: DiscoveryRunView = {
    ...run, id: "r2", trigger: "schedule", status: "failed", attempt: 3, errorCode: "federation_token_rejected", errorDetail: "The audience was not accepted.",
  };
  it("shadow-ai-01: the federation card asserts nothing while its status loads, and a failed read says so with Retry", () => {
    const loading = renderDiscovery(null);
    expect(loading).not.toContain('data-testid="federation-status"');
    expect(loading).not.toContain("-second RS256 token");
    expect(loading).not.toContain("No federation key yet");
    const failed = renderDiscovery("fail");
    expect(failed).not.toContain('data-testid="federation-status"');
    expect(failed).toContain("gateway unavailable");
    expect(failed).toMatch(/role="alert"[^>]*>gateway unavailable/);
    // the TTL comes from the gateway, never a made-up default
    expect(renderDiscovery({ ...federation, tokenTtlSeconds: 900 })).toContain("a 900-second RS256 token");
  });
  it("shadow-ai-02: Recent runs never reads as empty or as 0 runs before (or instead of) the read", () => {
    for (const runs of [null, "fail"] as const) {
      const html = renderDiscovery(federation, { runs });
      expect(html).not.toContain("No scan has run");
      expect(html).not.toContain("0 recent runs");
      expect(html).not.toContain("0 runs");
    }
    expect(renderDiscovery(federation, { runs: "fail" })).toContain("Couldn&#x27;t load this list");
    expect(renderDiscovery(federation, { runs: [] })).toContain("0 recent runs");
  });
  it("shadow-ai-02: the Settings card states no age until the settings are read", () => {
    expect(renderDiscovery(federation, { settings: null })).not.toContain("Static credentials older than 90 days are flagged");
    expect(renderDiscovery(federation, { settings: "fail" })).toMatch(/role="alert"[^>]*>gateway unavailable/);
  });
  it("shadow-ai-04: a failed run reads in words with its detail, the code kept as secondary text", () => {
    const html = renderDiscovery(federation, { runs: [failedRun] });
    expect(html).toContain("Federation token rejected: The audience was not accepted.");
    expect(html).toContain("federation_token_rejected");
    expect(html).toContain("Scheduled · attempt 3");
    expect(html).not.toContain("schedule, attempt");
  });
  it("shadow-ai-06: an unbuilt scanner shows no internal slice or ADR number", () => {
    const html = renderDiscovery(federation, { kinds: [{ ...kinds[0]!, built: false }] });
    expect(html).toContain(">Not built yet<");
    expect(html).not.toContain("(SD1)");
    expect(html).not.toContain("ADR-0195");
  });
  it("shadow-ai-07: evidence-kind codes are visible secondary text, not a hover title", () => {
    expect(html()).not.toContain('title="cloud_inventory, cloud_audit_log"');
  });
  it("shadow-ai-19 / FS-42: the federation keys table names its actions column; slots keep Revoke out of the primary one", () => {
    const keyed = renderDiscovery({
      ...federation,
      keys: [{ kid: "k-active-0000000000000000", algorithm: "RS256", state: "active", published: true, createdAt: AT, activatedAt: AT, retiredAt: null, revokedAt: null }],
    });
    expect(keyed).toMatch(/<th[^>]*><span[^>]*>Actions<\/span><\/th>/);
    // an active key has no primary action: its slot stays empty and Revoke sits in the second one
    expect(keyed).toMatch(/<span><\/span><span><button[^>]*>Revoke<\/button><\/span>/);
  });
  it("shadow-ai-20: one name for the findings screen", () => {
    expect(html()).toContain("Findings land in Shadow-AI discovery</strong>");
    expect(html()).not.toContain("Findings land in Shadow AI<");
  });
  function html() {
    return renderDiscovery();
  }
});

describe("Audit log (G8)", () => {
  it("puts the audit trail ahead of the receipt, anchor and retention tools", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AuditLogPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const trail = html.indexOf("Filter by user");
    expect(trail).toBeGreaterThan(-1);
    for (const later of ["Signed decision receipts", "Retention"]) {
      expect(html.indexOf(later)).toBeGreaterThan(trail);
    }
  });
});
