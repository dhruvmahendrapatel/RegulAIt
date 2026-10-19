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

function renderDiscovery() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(["admin", "discovery", "scanners"], { kinds });
  qc.setQueryData(["admin", "discovery", "sources"], {
    sources: [source],
    posture: { sourcesTotal: 1, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "Nothing is scanned." },
  });
  qc.setQueryData(["admin", "discovery", "runs"], { runs: [run] });
  qc.setQueryData(["admin", "discovery", "settings"], { credentialWarningAgeDays: 90, endpointRetentionDays: 90, version: 1 });
  qc.setQueryData(["admin", "discovery", "federation"], federation);
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
    expect(html).toContain("docs/deployment/CLOUD_DISCOVERY.md");
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
