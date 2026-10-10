/**
 * ADR-0189 B9 (R51): the SPDX fields panel. Rendered with react-dom/server (no
 * DOM): the banner names exactly what is still undeclared, each value carries
 * its provenance, and a non-admin is shown no controls at all.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpdxBanner, SpdxFieldsPanel, SpdxFieldsView } from "./SpdxFieldsPanel";
import type { SpdxDeclarationView, SpdxFieldsResponse } from "./spdxFields";

const ADMIN = "11111111-0000-4000-8000-000000000001";
const decl = (over: Partial<SpdxDeclarationView>): SpdxDeclarationView => ({
  seq: 1,
  property: "releaseTime",
  withdrawn: false,
  value: "2026-01-31T09:30:00Z",
  source: "supplier_declared",
  declaredByUserId: ADMIN,
  declaredAt: "2026-10-10T08:15:30.123Z",
  ...over,
});
const response = (over: Partial<SpdxFieldsResponse>): SpdxFieldsResponse => ({
  subject: { kind: "model_card", id: "99999999-5555-4000-8000-000000000001" },
  declarable: ["releaseTime", "downloadLocation", "packageVersion"],
  current: [],
  undeclared: ["releaseTime", "downloadLocation", "packageVersion"],
  history: [],
  historyLimit: 200,
  ...over,
});
const names = new Map([[ADMIN, "Avery Admin"]]);
const noop = () => {};

describe("SpdxBanner", () => {
  it("names every undeclared mandatory property and says not_producible", () => {
    const html = renderToStaticMarkup(<SpdxBanner kind="model_card" undeclared={["releaseTime", "downloadLocation", "packageVersion"]} />);
    expect(html).toContain('data-producible="false"');
    expect(html).toContain("SPDX output for this model card is <code>not_producible</code> until these properties are declared:");
    expect(html).toContain("Release time, Download location, Package version.");
  });
  it("a pinned model version stands in for the package version", () => {
    const html = renderToStaticMarkup(<SpdxBanner kind="model_card" undeclared={["packageVersion"]} pinnedModelVersion="model-2025-06-01" />);
    expect(html).toContain('data-producible="true"');
    expect(html).toContain("model-2025-06-01");
  });
  it("an undeclared dataset type is noAssertion, not a blocker", () => {
    const html = renderToStaticMarkup(<SpdxBanner kind="training_dataset" undeclared={["datasetType"]} />);
    expect(html).toContain('data-producible="true"');
    expect(html).toContain("noAssertion");
    expect(html).not.toContain("not_producible");
  });
});

describe("SpdxFieldsView", () => {
  const partial = response({
    current: [decl({ seq: 2 })],
    undeclared: ["downloadLocation", "packageVersion"],
    history: [decl({ seq: 2 }), decl({ seq: 1, value: "2026-01-30T00:00:00Z", source: "admin_entered" })],
  });

  it("shows the value with its source, who and when, and the history", () => {
    const html = renderToStaticMarkup(<SpdxFieldsView kind="model_card" data={partial} names={names} onSet={noop} onWithdraw={noop} />);
    expect(html).toContain('data-testid="spdx-value-releaseTime">2026-01-31T09:30:00Z<');
    expect(html).toContain("Supplier declared");
    expect(html).toContain("Avery Admin");
    expect(html).toContain("2026-10-10T08:15:30Z");
    expect(html).toContain("History (2)");
    expect(html).toContain("Admin entered");
    expect(html).toContain("Download location, Package version.");
  });

  it("an admin gets set, correct and withdraw; withdraw is disabled where there is nothing to withdraw", () => {
    const html = renderToStaticMarkup(<SpdxFieldsView kind="model_card" data={partial} names={names} onSet={noop} onWithdraw={noop} />);
    expect(html).toContain(">Correct release time<");
    expect(html).toContain(">Set download location<");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="There is no current value to withdraw\."[^>]*>Withdraw download location</);
  });

  it("without the admin callbacks there are no edit controls", () => {
    const html = renderToStaticMarkup(<SpdxFieldsView kind="model_card" data={partial} names={names} onSet={null} onWithdraw={null} />);
    expect(html).not.toContain("Withdraw");
    expect(html).not.toContain("<button");
    expect(html).not.toContain(">Set ");
    expect(html).not.toContain(">Correct ");
  });

  it("a withdrawn row reads as withdrawn in the history", () => {
    const html = renderToStaticMarkup(
      <SpdxFieldsView
        kind="eval_dataset"
        data={response({
          subject: { kind: "eval_dataset", id: "x" },
          declarable: ["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"],
          undeclared: ["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"],
          history: [decl({ seq: 3, property: "builtTime", withdrawn: true, value: null, source: "admin_entered" })],
        })}
        names={names}
        onSet={noop}
        onWithdraw={noop}
      />,
    );
    expect(html).toContain(">withdrawn<");
    expect(html).toContain("Built time, Originated by, Release time, Download location.");
  });
});

describe("SpdxFieldsPanel", () => {
  it("renders nothing, and fetches nothing, without an admin session", () => {
    expect(renderToStaticMarkup(<SpdxFieldsPanel kind="model_card" subjectId="99999999-5555-4000-8000-000000000001" />)).toBe("");
  });
});
