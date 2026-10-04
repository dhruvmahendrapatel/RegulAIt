/**
 * ADR-0172 — the closed picker's markup (react-dom/server, no DOM): named by
 * its label AND value, a dialog popup, logos decorative. The open-state
 * keyboard behaviour is covered by e2e/models-portal.mock.spec.ts.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPicker, ProviderMark, ProviderTiles, type ModelPickerAgent } from "./ModelPicker";

const agents: ModelPickerAgent[] = [
  { id: "a", name: "claude-opus", provider: "anthropic", providerLabel: "Anthropic", model: "claude-opus-5", tier: 2, logoKey: "anthropic", readinessLabel: "Ready", readinessTone: "ok" },
  { id: "b", name: "demo", provider: "mock", providerLabel: "Mock", model: "mock-fast", tier: 0, logoKey: null, readinessLabel: "Ready", readinessTone: "ok" },
];

describe("ModelPicker (closed)", () => {
  it("names the trigger by the label plus the current value, and shows the value", () => {
    const html = renderToStaticMarkup(<ModelPicker agents={agents} value="a" onChange={() => {}} label="Agent" />);
    const labelledby = /aria-labelledby="([^"]+)"/.exec(html)![1]!.split(" ");
    expect(labelledby).toHaveLength(2);
    expect(html).toContain(`id="${labelledby[0]}" class=`);
    expect(html).toMatch(new RegExp(`id="${labelledby[0]}"[^>]*>Agent<`));
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("claude-opus");
    expect(html).toContain("claude-opus-5 · tier 2");
    // the logo never adds to the name
    expect(html).toMatch(/<span aria-hidden="true"[^>]*><img[^>]*alt="Anthropic"/);
    // closed: no listbox in the DOM
    expect(html).not.toContain('role="listbox"');
  });

  it("asks for a choice when the value matches nothing", () => {
    const html = renderToStaticMarkup(<ModelPicker agents={agents} value="" onChange={() => {}} label="Agent" />);
    expect(html).toContain("Choose a model");
  });

  it("says why when disabled, and stays focusable (aria-disabled, not disabled)", () => {
    const html = renderToStaticMarkup(
      <ModelPicker agents={agents} value="a" onChange={() => {}} label="Agent" disabledReason="A reply is streaming" />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    const describedby = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toMatch(new RegExp(`id="${describedby}"[^>]*>A reply is streaming<`));
  });
});

describe("ProviderMark / ProviderTiles", () => {
  it("keeps a cell's text as its only accessible content", () => {
    const html = renderToStaticMarkup(<ProviderMark provider="anthropic" label="Anthropic" />);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*><img/);
    expect(html).toMatch(/<\/span>anthropic<\/span>$/);
  });

  it("renders native radios in a fieldset named by its legend, one checked", () => {
    const html = renderToStaticMarkup(
      <ProviderTiles legend="Provider" value="mock" onChange={() => {}} options={[{ value: "anthropic", label: "Anthropic" }, { value: "mock", label: "Mock" }]} />,
    );
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Provider<\/legend>/);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/checked="" value="mock"/);
  });
});

describe("ModelPicker — ADR-0173 'allowed here'", () => {
  const policy = {
    rules: [
      { feature: "chat" as const, dataClass: null, restricted: true, allowedAgentIds: ["b"], allowedProviders: [], defaultAgentId: null },
    ],
  };

  it("says when the chosen model is not allowed for this feature, and ties the reason to the trigger", () => {
    const html = renderToStaticMarkup(
      <ModelPicker agents={agents} value="a" onChange={() => {}} label="Agent" feature="chat" policy={policy} />,
    );
    expect(html).toContain("Not allowed here:");
    expect(html).toContain("does not allow this model for Chat");
    const describedby = /aria-describedby="([^"]+)"/.exec(html)![1]!;
    expect(html).toMatch(new RegExp(`id="${describedby}"[^>]*>Not allowed here:`));
    // the trigger itself stays operable — only the forbidden choice is refused
    expect(html).not.toContain('aria-disabled="true"');
  });

  it("is silent for an allowed model, for another feature, and when no feature is named", () => {
    const allowed = renderToStaticMarkup(<ModelPicker agents={agents} value="b" onChange={() => {}} label="Agent" feature="chat" policy={policy} />);
    expect(allowed).not.toContain("Not allowed here");
    const otherFeature = renderToStaticMarkup(<ModelPicker agents={agents} value="a" onChange={() => {}} label="Agent" feature="builder" policy={policy} />);
    expect(otherFeature).not.toContain("Not allowed here");
    const noFeature = renderToStaticMarkup(<ModelPicker agents={agents} value="a" onChange={() => {}} label="Agent" policy={policy} />);
    expect(noFeature).not.toContain("Not allowed here");
  });
});
