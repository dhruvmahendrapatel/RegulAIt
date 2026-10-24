/**
 * ADR-0195 A4 — the shadow-AI remediation start. The body keeps the finding reference (how the server finds a
 * workflow that started but never linked), the placeholder environment is never accepted, and a started-but-unlinked
 * workflow from the SERVER disables both starting another and linking a different one. Rendered with
 * react-dom/server (no DOM).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PlanBody } from "./ShadowRemediationPanel";
import {
  linkableInstances,
  remediationReference,
  startFormFrom,
  startInstanceBody,
  startWillMatch,
  statusScrollOptions,
  type RemediationPlan,
} from "./shadowRemediationModel";

const FINDING = "99999999-9999-4999-8999-999999999991";
const INSTANCE = "99999999-9999-4999-8999-999999999992";

const plan = (over: Partial<RemediationPlan> = {}): RemediationPlan => ({
  findingId: FINDING,
  subject: "acme/billing",
  provider: "example-provider",
  severity: "high",
  replacementAgent: null,
  steps: [],
  workflowRequest: {
    route: "POST /v1/workflows/instances",
    body: {
      change: {
        description: `Pull acme/billing (example-provider) into governance — ${remediationReference(FINDING)}`,
        paths: ["acme/billing", "src/llm.ts"],
        changeType: "shadow-ai-remediation",
        environment: "unstated",
        targetSystem: "acme/billing",
      },
    },
    needsInput: ["change.environment"],
  },
  assignment: { changeType: "shadow-ai-remediation", ruleConfigured: true, defaultTemplate: { name: "shadow-ai-remediation", state: "active" } },
  pendingLink: null,
  note: "",
  ...over,
});

const render = (p: RemediationPlan) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <PlanBody plan={p} onLinked={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** the opening tag of the button whose label is `label` */
const buttonTag = (html: string, label: string) => {
  const end = html.indexOf(label);
  return html.slice(html.lastIndexOf("<button", end), end);
};

describe("shadow-AI remediation start body", () => {
  it("keeps the finding reference on the description, whatever the person typed", () => {
    const built = startInstanceBody(plan(), { ...startFormFrom(plan()), description: "Move billing onto the gateway", environment: "staging" });
    expect(built.ok && built.body.change.description).toBe(`Move billing onto the gateway — ${remediationReference(FINDING)}`);
    const kept = startInstanceBody(plan(), { ...startFormFrom(plan()), environment: "staging" });
    expect(kept.ok && kept.body.change.description).toBe(plan().workflowRequest.body.change.description);
    expect(kept.ok && kept.body.change.paths).toEqual(["acme/billing", "src/llm.ts"]);
  });

  it("shows the description without the raw finding id, and the start puts the reference back (SH5)", () => {
    const shown = startFormFrom(plan()).description;
    expect(shown).not.toContain(FINDING);
    expect(shown).toBe("Pull acme/billing (example-provider) into governance");
    const built = startInstanceBody(plan(), { ...startFormFrom(plan()), environment: "staging" });
    expect(built.ok && built.body.change.description).toContain(remediationReference(FINDING));
  });

  it("never accepts the placeholder environment", () => {
    expect(startInstanceBody(plan(), { ...startFormFrom(plan()), environment: "unstated" })).toMatchObject({ ok: false });
  });

  it("suggests staging as the example environment, in the field and in the problem line (D3 #33)", () => {
    expect(render(plan())).toContain('placeholder="for example staging"');
    expect(startInstanceBody(plan(), { ...startFormFrom(plan()), environment: "" })).toEqual({
      ok: false,
      problem: "Name the environment the usage runs in (for example staging).",
    });
  });

  it("brings the status line into view only as far as needed, and without animation under reduced motion (D3 F22)", () => {
    expect(statusScrollOptions(false)).toEqual({ block: "nearest", behavior: "smooth" });
    expect(statusScrollOptions(true)).toEqual({ block: "nearest", behavior: "auto" });
  });

  it("knows when a start can match: a rule, or a default still to be installed; not a retired default", () => {
    expect(startWillMatch(plan())).toBe(true);
    expect(startWillMatch(plan({ assignment: { changeType: "shadow-ai-remediation", ruleConfigured: false, defaultTemplate: { name: "x", state: "not_installed" } } }))).toBe(true);
    expect(startWillMatch(plan({ assignment: { changeType: "shadow-ai-remediation", ruleConfigured: false, defaultTemplate: { name: "x", state: "retired" } } }))).toBe(false);
  });
});

describe("a workflow that started but never linked (server state)", () => {
  it("with none pending, both forms are enabled and no retry is shown", () => {
    const html = render(plan());
    expect(html).not.toContain('data-testid="shadow-started-unlinked"');
    expect(buttonTag(html, "Start remediation workflow…")).not.toContain("disabled");
    expect(buttonTag(html, "Link workflow…")).not.toContain("disabled");
  });

  it("with one pending, only the retry of THAT link is offered: start and link-another are disabled", () => {
    const html = render(plan({ pendingLink: { instanceId: INSTANCE, startedAt: "2026-10-17T10:00:00.000Z" } }));
    expect(html).toContain('data-testid="shadow-started-unlinked"');
    expect(html).toContain(INSTANCE);
    expect(buttonTag(html, "Start remediation workflow…")).toContain("disabled");
    expect(buttonTag(html, "Link workflow…")).toContain("disabled");
    expect(buttonTag(html, "Retry linking this workflow")).not.toContain("disabled");
    const select = html.slice(html.lastIndexOf("<select", html.indexOf("— choose a workflow —")), html.indexOf("— choose a workflow —"));
    expect(select).toContain("disabled");
  });

  it("a retired default with no rule says so; a default still to come is not a warning", () => {
    const retired = render(plan({ assignment: { changeType: "shadow-ai-remediation", ruleConfigured: false, defaultTemplate: { name: "x", state: "retired" } } }));
    expect(retired).toContain('data-testid="shadow-no-assignment-rule"');
    expect(retired).toContain("its default workflow was retired");
    const coming = render(plan({ assignment: { changeType: "shadow-ai-remediation", ruleConfigured: false, defaultTemplate: { name: "x", state: "not_installed" } } }));
    expect(coming).not.toContain('data-testid="shadow-no-assignment-rule"');
    expect(coming).toContain('data-testid="shadow-default-workflow"');
  });
});

describe("a finding that is already linked", () => {
  it("while the link stands, start and link-another are disabled", () => {
    const html = render(plan({ currentLink: { instanceId: INSTANCE, status: "blocked_on_plan", replaceable: false } }));
    expect(html).toContain('data-testid="shadow-current-link"');
    expect(buttonTag(html, "Start remediation workflow…")).toContain("disabled");
    expect(buttonTag(html, "Link workflow…")).toContain("disabled");
  });

  it("a link to a workflow that ended denied can be replaced: both forms are enabled and the replace is announced", () => {
    const html = render(plan({ currentLink: { instanceId: INSTANCE, status: "denied", replaceable: true } }));
    expect(html).toContain('data-testid="shadow-current-link"');
    expect(html).toContain("replaces the old link");
    expect(buttonTag(html, "Start remediation workflow…")).not.toContain("disabled");
    expect(buttonTag(html, "Link workflow…")).not.toContain("disabled");
  });
});

describe("the link list", () => {
  it("offers only live remediation workflows started from this finding's plan", () => {
    const ref = remediationReference(FINDING);
    const listed = [
      { id: "ok", status: "blocked_on_plan", change: { changeType: "shadow-ai-remediation", description: `x — ${ref}` } },
      { id: "aborted", status: "aborted", change: { changeType: "shadow-ai-remediation", description: `x — ${ref}` } },
      { id: "denied", status: "denied", change: { changeType: "shadow-ai-remediation", description: `x — ${ref}` } },
      { id: "rolled-back", status: "rolled_back", change: { changeType: "shadow-ai-remediation", description: `x — ${ref}` } },
      { id: "completed", status: "completed", change: { changeType: "shadow-ai-remediation", description: `x — ${ref}` } },
      { id: "other-type", status: "running", change: { changeType: "feature", description: `x — ${ref}` } },
      { id: "other-finding", status: "running", change: { changeType: "shadow-ai-remediation", description: "x — shadow-AI finding 0" } },
      { id: "no-change", status: "running" },
    ];
    // completed is the successful end and stays linkable; denied, aborted and rolled back never are
    expect(linkableInstances(FINDING, listed).map((i) => i.id)).toEqual(["ok", "completed"]);
  });
});
