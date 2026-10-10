/**
 * ADR-0187 X28 — the page's own clean check. Only a verified safetensors scan
 * with no finding is clean; a pickle-family or other executable format, an
 * unverified safetensors, not-run, unknown, an unrecognised verdict and "never
 * scanned" are never clean — even when the server's record claims otherwise.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import {
  SCAN_CHIP,
  findingSentence,
  latestScan,
  nameMismatch,
  preUploadRefusal,
  refusalText,
  safeFindingId,
  scanStatus,
  statusWord,
  uploadModelArtifact,
  uploadPath,
  MIB,
  type ArtifactScan,
} from "./modelArtifacts";

const scan = (over: Partial<ArtifactScan>): ArtifactScan => ({
  id: "s1",
  artifactId: "a1",
  engineRunId: "r1",
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
const SAFETENSORS = { format: "safetensors", executable: false };
const PICKLE = { format: "pickle", executable: true };
const PICKLE_FAMILY = ["pickle", "pytorch_legacy", "pytorch_zip", "numpy", "numpy_npz", "keras_h5"];

describe("scanStatus — what can be clean", () => {
  it("a verified safetensors scan with no finding is clean and admissible", () => {
    const s = scanStatus(scan({}), SAFETENSORS);
    expect(s).toMatchObject({ clean: true, admissible: true, tone: "ok", label: SCAN_CHIP.clean, verdict: "clean" });
    expect(statusWord(s)).toBe("Clean");
  });

  it("never scanned is not clean", () => {
    for (const none of [undefined, null]) {
      const s = scanStatus(none, SAFETENSORS);
      expect(s.clean).toBe(false);
      expect(s.admissible).toBe(false);
      expect(s.label).toBe("Not scanned");
      expect(statusWord(s)).toBe("Not scanned");
    }
  });

  it("unknown and not_run are never clean, and say why", () => {
    const unknown = scanStatus(scan({ verdict: "unknown", chip: SCAN_CHIP.unknown, admissible: false, format: "pickle" }), PICKLE);
    expect(unknown).toMatchObject({ clean: false, admissible: false, label: SCAN_CHIP.unknown, tone: "warn" });
    expect(unknown.reasons.join(" ")).toMatch(/inconclusive/);
    const notRun = scanStatus(scan({ verdict: "not_run", chip: SCAN_CHIP.not_run, admissible: false, format: "gguf" }), { format: "gguf", executable: true });
    expect(notRun).toMatchObject({ clean: false, admissible: false, label: SCAN_CHIP.not_run });
    expect(notRun.reasons[0]).toMatch(/not supported by the scanner/);
    expect(statusWord(notRun)).toBe("Not clean");
  });

  it("an unrecognised verdict is inconclusive, never clean, and never shows the server's chip", () => {
    const s = scanStatus(scan({ verdict: "pass", chip: "Looks fine" }), SAFETENSORS);
    expect(s).toMatchObject({ clean: false, admissible: false, label: SCAN_CHIP.unknown });
    expect(s.label).not.toContain("fine");
  });

  it("a pickle-family format is never clean, even if the record claims clean and admissible", () => {
    for (const format of PICKLE_FAMILY) {
      const s = scanStatus(scan({ format, verdict: "clean", admissible: true }), { format, executable: true });
      expect(s.clean, format).toBe(false);
      expect(s.admissible, format).toBe(false);
      expect(s.label, format).toBe(SCAN_CHIP.unknown);
      expect(s.reasons[0], format).toMatch(/inconsistent/);
    }
  });

  it("an executable artifact is never clean even when the scan row says safetensors (the artifact's content wins)", () => {
    const s = scanStatus(scan({}), PICKLE);
    expect(s.clean).toBe(false);
    expect(s.reasons[0]).toMatch(/the artifact's content is Python pickle/);
  });

  it("an unverified safetensors (header did not verify) is never clean", () => {
    const s = scanStatus(scan({ format: "safetensors_invalid" }), { format: "safetensors_invalid", executable: true });
    expect(s.clean).toBe(false);
  });

  it("a clean claim that is not admissible, or that carries a finding, is not clean", () => {
    expect(scanStatus(scan({ admissible: false }), SAFETENSORS).clean).toBe(false);
    expect(scanStatus(scan({ findings: [{ kind: "scan_error", id: "X", severity: "medium" }] }), SAFETENSORS).clean).toBe(false);
  });

  it("no_known_unsafe is not clean and says an executable format cannot be", () => {
    const s = scanStatus(
      scan({ format: "pickle", verdict: "no_known_unsafe", chip: SCAN_CHIP.no_known_unsafe, admissible: false, findings: [{ kind: "executable_format", id: "pickle", severity: "high" }] }),
      PICKLE,
    );
    expect(s).toMatchObject({ clean: false, admissible: false, label: SCAN_CHIP.no_known_unsafe, tone: "warn" });
    expect(s.reasons.join(" ")).toMatch(/can never be clean/);
    // the same verdict without its finding still explains itself
    const bare = scanStatus(scan({ format: "pickle", verdict: "no_known_unsafe", admissible: false }), PICKLE);
    expect(bare.reasons.join(" ")).toMatch(/does not make it safe to load/);
  });

  it("unsafe names the operator from the finding's id, reduced to the display alphabet", () => {
    const s = scanStatus(
      scan({ format: "pickle", verdict: "unsafe", admissible: false, findings: [{ kind: "unsafe_operator", id: "os.system<script>", severity: "critical" }] }),
      PICKLE,
    );
    expect(s).toMatchObject({ clean: false, tone: "danger", label: SCAN_CHIP.unsafe });
    expect(statusWord(s)).toBe("Unsafe");
    expect(s.reasons[0]).toBe("An unsafe operator was found: os.system?script? (critical).");
  });

  it("no label the page produces ever says safe", () => {
    const verdicts = ["clean", "no_known_unsafe", "unsafe", "unknown", "not_run", "weird"];
    for (const v of verdicts) {
      const s = scanStatus(scan({ verdict: v, format: v === "clean" ? "safetensors" : "pickle" }), v === "clean" ? SAFETENSORS : PICKLE);
      expect(s.label.toLowerCase()).not.toMatch(/\bsafe\b/);
    }
  });
});

describe("structured reasons", () => {
  it("finding ids are bounded and reduced; an unknown kind is not clean", () => {
    expect(safeFindingId("a".repeat(300))).toHaveLength(120);
    expect(safeFindingId(42)).toBe("?");
    expect(findingSentence({ kind: "mystery", id: "z", severity: "low" })).toMatch(/treated as not clean/);
  });

  it("calls out a name that disagrees with the content", () => {
    expect(nameMismatch({ filename: "model.safetensors", format: "pickle" })).toMatch(/ends in \.safetensors, but its content is Python pickle/);
    expect(nameMismatch({ filename: "weights.safetensors", format: "safetensors" })).toBeNull();
    expect(nameMismatch({ filename: "model.pt", format: "pytorch_legacy" })).toBeNull();
    expect(nameMismatch({ filename: "artifact", format: "pickle" })).toBeNull();
  });

  it("latestScan picks the newest whatever the order", () => {
    const old = scan({ id: "old", createdAt: "2026-10-01T00:00:00Z" });
    const nu = scan({ id: "new", createdAt: "2026-10-09T00:00:00Z" });
    expect(latestScan([old, nu])?.id).toBe("new");
    expect(latestScan([])).toBeNull();
  });
});

describe("the upload", () => {
  it("refuses a file over the declared limit before sending anything", () => {
    expect(preUploadRefusal(512 * MIB, 512)).toBeNull();
    expect(preUploadRefusal(512 * MIB + 1, 512)).toMatch(/limit is 512 MiB\. Nothing was sent/);
  });

  it("sends the name as a display-only query parameter, without a path", () => {
    expect(uploadPath("C:\\models\\a b.pkl")).toBe("/v1/model-artifacts?filename=a%20b.pkl");
    expect(uploadPath("")).toBe("/v1/model-artifacts?filename=artifact");
  });

  it("refusal sentences: known codes get ours, others the client's", () => {
    expect(refusalText(new ApiError(413, { error: "artifact_too_large", detail: "the limit is 512 MiB" }))).toMatch(/over the organisation's model-artifact size limit.*\(the limit is 512 MiB\)/);
    expect(refusalText(new ApiError(503, { error: "artifact_store_unavailable" }))).toMatch(/no model-artifact store/);
    expect(refusalText(new ApiError(409, { error: "artifact_quota_exceeded" }))).toMatch(/Artifact quota exceeded/i);
  });

  it("posts raw bytes as octet-stream with the CSRF header, reports progress, and turns a refusal into an ApiError", async () => {
    const sent: Record<string, unknown> = { headers: {} as Record<string, string> };
    let status = 201;
    let body = JSON.stringify({ artifact: { id: "a9", format: "pickle" } });
    const fake = () => {
      const x = {
        upload: {} as { onprogress?: (e: { loaded: number; total: number; lengthComputable: boolean }) => void },
        withCredentials: false,
        status: 0,
        responseText: "",
        onload: null as null | (() => void),
        onerror: null as null | (() => void),
        onabort: null as null | (() => void),
        open: (method: string, url: string) => Object.assign(sent, { method, url }),
        setRequestHeader: (k: string, v: string) => ((sent.headers as Record<string, string>)[k] = v),
        abort: () => x.onabort?.(),
        send: (b: unknown) => {
          sent.body = b;
          sent.withCredentials = x.withCredentials;
          x.upload.onprogress?.({ loaded: 2, total: 4, lengthComputable: true });
          x.status = status;
          x.responseText = body;
          x.onload?.();
        },
      };
      return x as unknown as XMLHttpRequest;
    };
    const progress: number[] = [];
    const blob = new Blob([new Uint8Array([0x80, 4, 0, 0])]);
    const ok = await uploadModelArtifact(blob, { filename: "m.pkl", xhr: fake, onProgress: (s) => progress.push(s) });
    expect(ok.artifact.id).toBe("a9");
    expect(sent).toMatchObject({ method: "POST", url: "/v1/model-artifacts?filename=m.pkl", withCredentials: true, body: blob });
    expect(sent.headers).toEqual({ "x-regulait-csrf": "1", "content-type": "application/octet-stream" });
    expect(progress).toEqual([2]);

    status = 413;
    body = JSON.stringify({ error: "artifact_too_large", detail: "the limit is 1 MiB" });
    const refused = await uploadModelArtifact(blob, { filename: "m.pkl", xhr: fake }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(413);
  });
});
