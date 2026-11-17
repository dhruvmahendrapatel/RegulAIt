import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  DEFAULT_LABEL_POLICY,
  decideLabels,
  labelPolicyProblems,
  labelPolicyRelaxes,
  labelsFromMsipHeader,
  normaliseGuid,
  purviewDefinitionsFromGraph,
  readEmbeddedLabels,
  type LabelPolicy,
} from "./sensitivity-labels.js";

const HC = "f048e7b8-f3aa-4857-bf32-a317f4bc3f29";
const GEN = "0a1b2c3d-0000-4000-8000-000000000001";
const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

const docx = (parts: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries({ "[Content_Types].xml": "<Types/>", ...parts }).map(([k, v]) => [k, strToU8(v)])));

const labelInfo = (id: string, extra = "") =>
  `<?xml version="1.0" encoding="utf-8" standalone="yes"?><clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{${id.toUpperCase()}}" enabled="1" method="Privileged" siteId="{${TENANT}}" removed="0" ${extra}/></clbl:labelList>`;

const customProps = (id: string, enabled: string) =>
  `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
  `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MSIP_Label_${id}_Enabled"><vt:lpwstr>${enabled}</vt:lpwstr></property>` +
  `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="MSIP_Label_${id}_SiteId"><vt:lpwstr>${TENANT}</vt:lpwstr></property>` +
  `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="4" name="MSIP_Label_${id}_Name"><vt:lpwstr>Highly Confidential</vt:lpwstr></property>` +
  `</Properties>`;

const policy = (over: Partial<LabelPolicy> = {}): LabelPolicy => ({
  ...DEFAULT_LABEL_POLICY,
  trustedTenantIds: [TENANT],
  rules: [
    { provider: "microsoft_purview", labelId: HC, action: "block", sensitivity: "restricted" },
    { provider: "microsoft_purview", labelId: GEN, action: "allow", sensitivity: "internal" },
  ],
  ...over,
});

describe("ADR-0363 slice 1: reading embedded Purview labels", () => {
  it("normalises braced and upper-case GUIDs and rejects anything else", () => {
    expect(normaliseGuid(`{${HC.toUpperCase()}}`)).toBe(HC);
    expect(normaliseGuid("not-a-guid")).toBeNull();
    expect(normaliseGuid(`${HC}x`)).toBeNull();
  });

  it("reads LabelInfo.xml (co-authoring storage) and prefers it over a stale custom.xml", () => {
    const r = readEmbeddedLabels(docx({ "docMetadata/LabelInfo.xml": labelInfo(HC), "docProps/custom.xml": customProps(GEN, "true") }), null);
    expect(r).toEqual({ kind: "labels", labels: [{ provider: "microsoft_purview", labelId: HC, tenantId: TENANT, source: "ooxml_labelinfo" }] });
  });

  it("ignores a removed label in LabelInfo.xml", () => {
    const xml = labelInfo(HC).replace('removed="0"', 'removed="1"');
    expect(readEmbeddedLabels(docx({ "docMetadata/LabelInfo.xml": xml }), null)).toEqual({ kind: "none" });
  });

  it("reads legacy custom.xml MSIP properties, only when Enabled is true", () => {
    expect(readEmbeddedLabels(docx({ "docProps/custom.xml": customProps(HC, "true") }), null)).toEqual({
      kind: "labels",
      labels: [{ provider: "microsoft_purview", labelId: HC, tenantId: TENANT, source: "ooxml_custom_props" }],
    });
    expect(readEmbeddedLabels(docx({ "docProps/custom.xml": customProps(HC, "False") }), null)).toEqual({ kind: "none" });
  });

  it("an unlabelled docx is none; an encrypted (OLE compound) file is protected; a broken zip is unreadable", () => {
    expect(readEmbeddedLabels(docx({ "word/document.xml": "<w:document/>" }), null)).toEqual({ kind: "none" });
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
    expect(readEmbeddedLabels(cfb, null)).toEqual({ kind: "protected" });
    expect(readEmbeddedLabels(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), null)).toEqual({ kind: "unreadable", reason: "corrupt" });
  });

  it("refuses to inflate an oversized label part (zip-bomb bound)", () => {
    const big = `<Properties>${"<property name=\"x\"><vt:lpwstr>a</vt:lpwstr></property>".repeat(30000)}</Properties>`;
    expect(readEmbeddedLabels(docx({ "docProps/custom.xml": big }), null)).toEqual({ kind: "unreadable", reason: "zip_part_too_large" });
  });

  it("reads PDF info-dictionary and XMP MSIP keys", () => {
    const pdf = strToU8(
      `%PDF-1.7\n1 0 obj << /MSIP_Label_${HC}_Enabled (true) /MSIP_Label_${HC}_SiteId (${TENANT}) >> endobj\n` +
        `<pdfx:MSIP_Label_${GEN}_Enabled>false</pdfx:MSIP_Label_${GEN}_Enabled>\n%%EOF`,
    );
    expect(readEmbeddedLabels(pdf, "application/pdf")).toEqual({
      kind: "labels",
      labels: [{ provider: "microsoft_purview", labelId: HC, tenantId: TENANT, source: "pdf_metadata" }],
    });
  });

  it("reads the MSIP_Labels email header", () => {
    const h = `MSIP_Label_${HC}_Enabled=True; MSIP_Label_${HC}_SiteId=${TENANT}; MSIP_Label_${HC}_Method=Standard`;
    expect(labelsFromMsipHeader(h)).toEqual([{ provider: "microsoft_purview", labelId: HC, tenantId: TENANT, source: "email_header" }]);
  });

  it("plain text is none", () => {
    expect(readEmbeddedLabels(strToU8("hello"), "text/plain")).toEqual({ kind: "none" });
  });
});

describe("ADR-0363 slice 1: the label decision", () => {
  const labelled = (id: string, tenantId: string | null = TENANT) => ({
    kind: "labels" as const,
    labels: [{ provider: "microsoft_purview" as const, labelId: id, tenantId, source: "ooxml_labelinfo" as const }],
  });

  it("Highly Confidential blocks; General allows; strictest wins across labels", () => {
    expect(decideLabels(labelled(HC), policy()).action).toBe("block");
    expect(decideLabels(labelled(GEN), policy())).toMatchObject({ action: "allow", sensitivity: "internal" });
    const both = { kind: "labels" as const, labels: [...labelled(GEN).labels, ...labelled(HC).labels] };
    expect(decideLabels(both, policy())).toMatchObject({ action: "block", sensitivity: "restricted" });
  });

  it("strict defaults: unmapped, untrusted-tenant, protected and unreadable content all block", () => {
    expect(decideLabels(labelled("12345678-1234-4234-8234-123456789012"), policy()).action).toBe("block");
    const foreign = decideLabels(labelled(GEN, OTHER), policy());
    expect(foreign.action).toBe("block");
    expect(foreign.reasons[0]).toMatchObject({ kind: "unmapped", untrustedTenant: true });
    expect(decideLabels({ kind: "protected" }, policy()).action).toBe("block");
    expect(decideLabels({ kind: "unreadable", reason: "corrupt" }, policy()).action).toBe("block");
    expect(decideLabels({ kind: "none" }, policy())).toEqual({ action: "allow", sensitivity: null, reasons: [] });
  });

  it("a label without a SiteId is trusted only when exactly one tenant is trusted", () => {
    expect(decideLabels(labelled(GEN, null), policy()).action).toBe("allow");
    expect(decideLabels(labelled(GEN, null), policy({ trustedTenantIds: [TENANT, OTHER] })).action).toBe("block");
  });

  it("validates a mapping against the provider's definitions", () => {
    const defs = purviewDefinitionsFromGraph({ value: [{ id: HC, name: "Highly Confidential", sensitivity: 9, isActive: true }] });
    expect(labelPolicyProblems(policy(), defs)).toEqual([`label ${GEN} is not among the provider's label definitions`]);
    expect(labelPolicyProblems({ ...policy(), trustedTenantIds: ["x"] }, defs)).toContain('trusted tenant "x" is not a GUID');
  });

  it("detects relaxations (step-up) and does not flag tightening", () => {
    const base = policy();
    expect(labelPolicyRelaxes(base, { ...base, unmappedAction: "redact" })).toBe(true);
    expect(labelPolicyRelaxes(base, { ...base, trustedTenantIds: [TENANT, OTHER] })).toBe(true);
    expect(labelPolicyRelaxes(base, { ...base, rules: [{ ...base.rules[0]!, action: "redact" }, base.rules[1]!] })).toBe(true);
    expect(labelPolicyRelaxes(DEFAULT_LABEL_POLICY, { ...DEFAULT_LABEL_POLICY, rules: [{ provider: "microsoft_purview", labelId: HC, action: "block", sensitivity: "restricted" }] })).toBe(false);
    expect(labelPolicyRelaxes({ ...base, unmappedAction: "allow" }, base)).toBe(false);
  });

  it("maps Graph sensitivityLabel JSON and drops malformed entries", () => {
    expect(
      purviewDefinitionsFromGraph({
        value: [
          { id: HC, name: "Highly Confidential", sensitivity: 9, isActive: true, parent: null },
          { id: GEN, name: "General", sensitivity: 1, isActive: false, parent: { id: HC } },
          { id: "nope", name: "x" },
          { id: HC },
        ],
      }),
    ).toEqual([
      { provider: "microsoft_purview", labelId: HC, name: "Highly Confidential", parentLabelId: null, rank: 9, active: true },
      { provider: "microsoft_purview", labelId: GEN, name: "General", parentLabelId: HC, rank: 1, active: false },
    ]);
    expect(purviewDefinitionsFromGraph(null)).toEqual([]);
  });
});
