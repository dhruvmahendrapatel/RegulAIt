/**
 * ADR-0205 — the setup assistant's draft view. A model refusal shows inline with the rule-based draft kept, each
 * field names its source, and rendering a draft never applies it (only the admin's click calls `onUse`). Rendered
 * with react-dom/server (no DOM, no network).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DraftResultView, draftButtonLabel, type AgentSetupDraft, type AssistResponse } from "./AgentSetupAssistant";

const f = <T,>(value: T, source: "rules" | "model" | "mock" = "rules") => ({ value, source });
const draft: AgentSetupDraft = {
  name: f("ticket-digest-agent"),
  tier: f(1),
  systemPrompt: f("Your purpose: summarise tickets", "mock"),
  purpose: f("Summarises tickets."),
  riskTier: { value: "limited", source: "rules", why: "the agent takes actions" },
  grants: f("Grant it to no one at registration."),
  approvalRule: f("Actions that change data need a person's approval."),
  monthlyBudgetUsd: f(100),
  intendedUse: f("Summarises tickets."),
  limitations: f("Outputs may be wrong."),
};
const resp = (model: AssistResponse["model"]): AssistResponse => ({ draft, model, disclaimer: "Suggestions only." });

describe("agent setup assistant draft view (ADR-0205)", () => {
  it("shows a model refusal inline, with the rule-based draft still shown", () => {
    const html = renderToStaticMarkup(
      <DraftResultView result={resp({ status: "refused", reason: "no grant for this agent" })} onUse={() => {}} />,
    );
    expect(html).toContain('data-testid="agent-setup-assist-refusal"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("no grant for this agent");
    expect(html).toContain('data-testid="agent-setup-assist-draft"');
  });

  it("labels each field's source and shows no refusal for a clean draft", () => {
    const html = renderToStaticMarkup(
      <DraftResultView result={resp({ status: "drafted", source: "mock", agentId: "a", fields: ["systemPrompt"] })} onUse={() => {}} />,
    );
    expect(html).not.toContain("agent-setup-assist-refusal");
    expect(html).toContain(">mock<");
    expect(html).toContain("rules");
  });

  it("never applies the draft by rendering it", () => {
    const onUse = vi.fn();
    renderToStaticMarkup(<DraftResultView result={resp({ status: "not_requested" })} onUse={onUse} />);
    expect(onUse).not.toHaveBeenCalled();
  });

  it("labels the draft button while a draft runs, so a slow model call is visible", () => {
    expect(draftButtonLabel(true)).toBe("Drafting…");
    expect(draftButtonLabel(false)).toBe("Draft configuration");
  });
});
