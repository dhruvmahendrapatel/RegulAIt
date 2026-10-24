/**
 * Design batch D2 (intake and use-case record, #547/#453): what the presenter's S4 intake and G1 record say.
 * en-GB draft times, pack status explained by an (i) disclosure rather than hover text, digests without an
 * ARIA-prohibited label, and no internal script path on an admin screen. Rendered with react-dom/server from
 * seeded query data (no DOM, no network).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { savedAtText } from "./intakeDraft";
import { PackAppliedBadge } from "./UseCaseOverviewPage";
import { DecisionRecordTab } from "./DecisionRecordTab";
import { OfflineVerifyNote } from "./BomEvidencePanel";

describe("draft saved time (D2-01)", () => {
  afterEach(() => vi.useRealTimers());

  it("is a 24-hour en-GB time today, never a 12-hour AM/PM one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 21, 9, 0));
    const text = savedAtText(new Date(2026, 9, 21, 7, 58).toISOString());
    expect(text).toBe("07:58");
    expect(savedAtText(new Date(2026, 9, 21, 19, 5).toISOString())).toBe("19:05");
  });

  it("is the shared en-GB date and time on another day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 23, 9, 0));
    expect(savedAtText(new Date(2026, 9, 21, 7, 58).toISOString())).toBe("21 Oct 2026, 07:58");
  });

  it("says nothing for an unreadable value", () => {
    expect(savedAtText("not a date")).toBe("");
  });
});

const pack = (patch: Record<string, unknown>) =>
  ({ id: "f", framework: "eu-ai-act", version: 1, title: "EU AI Act", cascadeTag: "eu-ai-act", profileExists: true, carriedByUseCase: true, controls: [], ...patch }) as never;

describe("framework pack status (D2-04)", () => {
  it.each([
    [{ cascadeTag: null }, "Mapping only"],
    [{}, "Applied"],
    [{ carriedByUseCase: false, profileExists: false }, "Not applied"],
  ])("explains %o in an (i) disclosure, not a hover title", (patch, label) => {
    const html = renderToStaticMarkup(<PackAppliedBadge framework={pack(patch)} />);
    expect(html).toContain(`>${label}</span>`);
    // the disclosure renders closed; its button is the keyboard and screen-reader route to the meaning
    expect(html).toContain('aria-label="What is pack status?"');
    expect(html).not.toContain("title=");
  });
});

describe("decision record digests (D2-06)", () => {
  it("never puts aria-label on <code>, and reads the whole digest to assistive technology", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const digest = "a".repeat(64);
    qc.setQueryData(["use-case", "uc", "decision-records"], {
      records: [{
        id: "r1", outcome: "approved", decidedAt: "2026-10-21T07:58:00Z", decidedByName: "Avery Approver", approvalId: null, workflowInstanceId: null,
        reviewPolicyVersion: 2, requiredTestsDigest: digest, intakeTemplateId: null, intakeTemplateName: "Default", intakeDefinitionDigest: null,
        euAiActRulesetVersion: 1, intakeAssistVersion: "1", answersDigest: digest,
      }],
      current: { euAiActRulesetVersion: 1, intakeAssistVersion: "1" },
    });
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><DecisionRecordTab useCaseId="uc" /></QueryClientProvider>);
    expect(html).not.toMatch(/<code[^>]*aria-label/);
    expect(html).not.toMatch(/title="[^"]*digest/i);
    expect(html).toContain(`Answers digest: ${digest}`);
    expect(html).toContain(`<span aria-hidden="true">${digest.slice(0, 12)}</span>`);
  });
});

describe("AI BOM offline verification note (D2-19)", () => {
  it("names no internal script path, and keeps the trust-root warning", () => {
    const html = renderToStaticMarkup(<OfflineVerifyNote />);
    expect(html).not.toMatch(/scripts\/|\.mjs|node /);
    expect(html).toContain("never the trust root");
  });
});
