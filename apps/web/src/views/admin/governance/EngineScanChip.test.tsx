/**
 * ADR-0187 X28 — the engine-scan evidence chip on a model card: engine,
 * version, result, date and a link to the scan's run; an executable format, an
 * unknown or a missing scan never renders as clean. Rendered with
 * react-dom/server (no DOM).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { EngineScanEvidenceChip, ScanStatusBadge } from "./EngineScanChip";
import { SCAN_CHIP, scanStatus, type ArtifactScan } from "./modelArtifacts";

const scan = (over: Partial<ArtifactScan>): ArtifactScan => ({
  id: "99999999-9999-4000-8000-000000000001",
  artifactId: "99999999-8888-4000-8000-000000000001",
  engineRunId: "99999999-7777-4000-8000-000000000001",
  sha256: "0".repeat(64),
  format: "safetensors",
  verdict: "clean",
  chip: SCAN_CHIP.clean,
  admissible: true,
  findings: [],
  scannerVersion: "0.8.8",
  createdAt: "2026-10-09T10:00:00.000Z",
  ...over,
});
const chip = (s: ArtifactScan | null) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <EngineScanEvidenceChip scan={s} />
    </MemoryRouter>,
  );

describe("EngineScanEvidenceChip", () => {
  it("shows engine, version, result, date and a link to the scan and its run", () => {
    const html = chip(scan({}));
    expect(html).toContain('data-clean="true"');
    expect(html).toContain(">Clean<");
    expect(html).toContain(SCAN_CHIP.clean);
    expect(html).toContain("Engine: modelscan v0.8.8");
    expect(html).toContain("Scanned Oct 9, 2026");
    expect(html).toContain(">Admissible<");
    expect(html).toContain('href="/admin/admission?tab=artifacts&amp;artifact=99999999-8888-4000-8000-000000000001&amp;run=99999999-7777-4000-8000-000000000001"');
    expect(html.toLowerCase()).not.toMatch(/\bsafe\b/);
  });

  it("a pickle scan never renders clean, whatever the record claims", () => {
    for (const verdict of ["no_known_unsafe", "clean"]) {
      const html = chip(scan({ format: "pickle", verdict, admissible: verdict === "clean", findings: [{ kind: "executable_format", id: "pickle", severity: "high" }] }));
      expect(html, verdict).toContain('data-clean="false"');
      expect(html, verdict).not.toContain(">Clean<");
      expect(html, verdict).toContain(">Not admissible<");
    }
  });

  it("unknown and not_run never render clean", () => {
    for (const verdict of ["unknown", "not_run"]) {
      const html = chip(scan({ verdict, format: "pickle", admissible: false }));
      expect(html).toContain('data-clean="false"');
      expect(html).toContain(">Not clean<");
    }
  });

  it("a cited scan the gateway could not read is unavailable, not clean", () => {
    const html = chip(null);
    expect(html).toContain("Scan record unavailable");
    expect(html).toContain(">Not clean<");
  });

  it("a scan without a run says so instead of linking to one", () => {
    const html = chip(scan({ engineRunId: null }));
    expect(html).toContain("no run recorded");
    expect(html).not.toContain("run=");
  });
});

describe("ScanStatusBadge", () => {
  it("never scanned reads as a word, not just a colour", () => {
    const html = renderToStaticMarkup(<ScanStatusBadge status={scanStatus(null)} />);
    expect(html).toContain(">Not scanned<");
    expect(html).toContain('data-clean="false"');
  });
});
