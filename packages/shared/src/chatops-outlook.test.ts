/**
 * ADR-0121 / ADR-0183 batch 2.6 — the Outlook courier's mail rendering. Pure.
 * The decision about what a card may say (the ADR-0061 fence) is taken once by
 * `composeApprovalCard`; these renderers only re-render it, and the mail never
 * carries a way to decide.
 */
import { describe, expect, it } from "vitest";
import { composeApprovalCard, outlookMessageForAlert, outlookMessageForCard } from "./index.js";

const APPROVAL = "11111111-2222-4333-8444-555555555555";
const PORTAL = `https://regulait.example.test/ui/admin/review-workbench?approval=${APPROVAL}`;
const card = (over: Partial<Parameters<typeof composeApprovalCard>[0]> = {}) =>
  composeApprovalCard({
    approvalId: APPROVAL,
    objectType: "mcp_tool",
    toolName: "patients.read",
    stageId: "prod-signoff",
    requesterLabel: "req@example.test",
    approverLabel: "dana@example.test",
    portalUrl: PORTAL,
    fenced: false,
    decidable: false,
    ...over,
  });

describe("outlookMessageForCard", () => {
  it("carries the summary and the portal link, and no way to decide", () => {
    const m = outlookMessageForCard(card());
    expect(m.subject).toBe("RegulAIt: an approval needs you");
    expect(m.body.contentType).toBe("HTML");
    expect(m.body.content).toContain("<strong>Approval required</strong>");
    expect(m.body.content).toContain("<code>patients.read</code>");
    expect(m.body.content).toContain(`<a href="${PORTAL.replace(/&/g, "&amp;")}">Open this approval in RegulAIt to decide</a>`);
    expect(m.body.content).toContain("never by replying to this message");
    // no decision affordance of any kind
    expect(m.body.content).not.toMatch(/mailto:|approve\?|reject\?|token=|regulait_approve|regulait_reject|Action\.Submit/i);
  });

  it("renders no button even when the card itself is chat-decidable", () => {
    const decidable = card({ decidable: true });
    expect(decidable.actions.length).toBeGreaterThan(0);
    const m = outlookMessageForCard(decidable);
    expect(m.body.content).not.toMatch(/Approve|Reject|Deny/);
  });

  it("a fenced approval says content is withheld, and names nothing", () => {
    const m = outlookMessageForCard(card({ fenced: true }));
    expect(m.subject).toBe("RegulAIt: an approval needs you (content withheld)");
    expect(m.body.content).toContain("details are withheld");
    for (const leak of ["patients.read", "prod-signoff", "req@example.test", "dana@example.test"]) {
      expect(m.body.content).not.toContain(leak);
    }
  });

  it("escapes operator-supplied text before adding its own tags", () => {
    const m = outlookMessageForCard(card({ toolName: "<script>alert(1)</script>", requesterLabel: '"><img src=x>' }));
    expect(m.body.content).not.toContain("<script>");
    expect(m.body.content).not.toContain("<img");
    expect(m.body.content).toContain("&lt;script&gt;");
  });

  it("a relative portal path is text, never a dead link", () => {
    const m = outlookMessageForCard(card({ portalUrl: `/admin/review-workbench?approval=${APPROVAL}` }));
    expect(m.body.content).not.toContain("<a ");
    expect(m.body.content).toContain(`Open RegulAIt at: /admin/review-workbench?approval=${APPROVAL}`);
  });
});

describe("outlookMessageForAlert", () => {
  it("is information only: severity, rule, title, link, and replies are not read", () => {
    const m = outlookMessageForAlert({ severity: "high", ruleLabel: "Spend spike\r\nBcc: x@evil.test", title: "<b>Project A</b>", portalUrl: "https://r.example.test/ui/admin/governance/alerts?alert=a1" });
    expect(m.subject).toBe("RegulAIt: governance alert (HIGH) — Spend spike Bcc: x@evil.test");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.body.content).toContain("&lt;b&gt;Project A&lt;/b&gt;");
    expect(m.body.content).toContain('<a href="https://r.example.test/ui/admin/governance/alerts?alert=a1">Open this alert in RegulAIt</a>');
    expect(m.body.content).toContain("Replies to this message are not read.");
  });
});
