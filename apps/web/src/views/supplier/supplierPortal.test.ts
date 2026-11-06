/**
 * ADR-0221 — the supplier page's pure checks: reading the sign-in token from the address fragment, the file checks
 * made before sending (the gateway re-checks the bytes), and the values mirrored from @regulait/shared.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPT_ATTRIBUTE,
  base64FromDataUrl,
  fileLimitLabel,
  fileProblem,
  INVITE_TOKEN_RE,
  LINK_REFUSAL_DETAIL,
  readFileAsBase64,
  SESSION_REFUSAL_DETAIL,
  statementProblem,
  SUBMISSION_STATUSES,
  SUPPLIER_LIMITS,
  SUPPLIER_STATUS_LABEL,
  tokenFromHash,
  withoutHash,
} from "./supplierPortal";

const TOKEN = `rglsi_${"A".repeat(20)}${"b".repeat(20)}_-9`;

describe("tokenFromHash", () => {
  it("reads a well-formed sign-in token, with or without the leading #", () => {
    expect(TOKEN).toMatch(INVITE_TOKEN_RE);
    expect(tokenFromHash(`#${TOKEN}`)).toEqual({ kind: "token", token: TOKEN });
    expect(tokenFromHash(TOKEN)).toEqual({ kind: "token", token: TOKEN });
    expect(tokenFromHash(`#${encodeURIComponent(TOKEN)}`)).toEqual({ kind: "token", token: TOKEN });
  });
  it("says there is nothing when the fragment is empty", () => {
    expect(tokenFromHash("")).toEqual({ kind: "none" });
    expect(tokenFromHash("#")).toEqual({ kind: "none" });
    expect(tokenFromHash("#   ")).toEqual({ kind: "none" });
  });
  it("refuses anything that is not a sign-in token, so nothing else is ever sent", () => {
    expect(tokenFromHash("#rglsi_short")).toEqual({ kind: "invalid" });
    expect(tokenFromHash(`#rglss_${"a".repeat(43)}`)).toEqual({ kind: "invalid" }); // a session token is not a link
    expect(tokenFromHash(`#${TOKEN}x`)).toEqual({ kind: "invalid" });
    expect(tokenFromHash("#%E0%A4%A")).toEqual({ kind: "invalid" }); // a malformed escape
    expect(tokenFromHash("#<script>")).toEqual({ kind: "invalid" });
  });
  it("rebuilds the address without the fragment", () => {
    expect(withoutHash("/ui/supplier", "")).toBe("/ui/supplier");
    expect(withoutHash("/ui/supplier", "?a=1")).toBe("/ui/supplier?a=1");
  });
});

describe("fileProblem", () => {
  const max = SUPPLIER_LIMITS.fileMaxBytes;
  it("accepts the five types by their name endings, in any case", () => {
    for (const name of ["a.pdf", "a.PNG", "a.jpg", "a.jpeg", "notes.txt", "data.CSV", "my.report.v2.pdf"]) {
      expect(fileProblem({ name, size: 10 })).toBeNull();
    }
    expect(ACCEPT_ATTRIBUTE).toBe(".pdf,.png,.jpg,.jpeg,.txt,.csv");
  });
  it("refuses another type, or a name with no ending", () => {
    for (const name of ["a.exe", "a.docx", "a.svg", "a.html", "pdf", ".pdf", "a."]) {
      expect(fileProblem({ name, size: 10 })).toMatch(/Choose a PDF, PNG, JPEG, plain text or CSV file/);
    }
  });
  it("refuses an empty file and one over the limit, and allows exactly the limit", () => {
    expect(fileProblem({ name: "a.pdf", size: 0 })).toMatch(/empty/);
    expect(fileProblem({ name: "a.pdf", size: max })).toBeNull();
    expect(fileProblem({ name: "a.pdf", size: max + 1 })).toBe("This file is too large. A file can be at most 2 MB.");
  });
  it("refuses a name longer than the gateway takes", () => {
    expect(fileProblem({ name: `${"n".repeat(197)}.pdf`, size: 1 })).toMatch(/name is too long/);
  });
  it("labels the limit as people read it", () => {
    expect(fileLimitLabel()).toBe("2 MB");
    expect(fileLimitLabel(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("base64 from a chosen file", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("strips the data: prefix", () => {
    expect(base64FromDataUrl("data:application/pdf;base64,JVBERi0=")).toBe("JVBERi0=");
    expect(base64FromDataUrl("data:;base64,")).toBe("");
    expect(base64FromDataUrl("JVBERi0=")).toBe("JVBERi0=");
  });

  it("reads the file through FileReader and answers only the base64", async () => {
    class FakeReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((buf) => {
          this.result = `data:text/plain;base64,${Buffer.from(buf).toString("base64")}`;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("FileReader", FakeReader);
    await expect(readFileAsBase64(new Blob(["hello"]))).resolves.toBe(Buffer.from("hello").toString("base64"));
  });

  it("says the file could not be read when the reader fails", async () => {
    class FailingReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("FileReader", FailingReader);
    await expect(readFileAsBase64(new Blob(["x"]))).rejects.toThrow("The file could not be read. Choose it again.");
  });
});

describe("statementProblem", () => {
  it("needs some text and keeps to the limit", () => {
    expect(statementProblem("   ")).toBe("Write your answer before sending it.");
    expect(statementProblem("We encrypt at rest.")).toBeNull();
    expect(statementProblem("x".repeat(SUPPLIER_LIMITS.statementMax))).toBeNull();
    expect(statementProblem("x".repeat(SUPPLIER_LIMITS.statementMax + 1))).toBe("Your answer is too long. It can be at most 4,000 characters.");
  });
});

describe("labels", () => {
  it("names every status for the supplier, including an answer a newer one replaced", () => {
    for (const st of SUBMISSION_STATUSES) {
      expect(SUPPLIER_STATUS_LABEL[st], st).toBeTruthy();
    }
    expect(SUPPLIER_STATUS_LABEL.withdrawn).toBe("Replaced by a newer answer");
  });
});

describe("the mirrored values match @regulait/shared", () => {
  it("limits, refusals and the token rule", async () => {
    // runtime-only import: the SPA does not depend on @regulait/shared
    const sharedPath = new URL("../../../../../packages/shared/src/supplier-portal.ts", import.meta.url).pathname;
    const s = (await import(/* @vite-ignore */ sharedPath)) as {
      SUPPLIER_PORTAL_LIMITS: Record<string, unknown>;
      SUPPLIER_LINK_REFUSAL: { detail: string };
      SUPPLIER_SESSION_REFUSAL: { detail: string };
      SUPPLIER_INVITE_TOKEN_RE: RegExp;
      SUPPLIER_FILE_TYPES: readonly string[];
      SUPPLIER_SUBMISSION_STATUSES: readonly string[];
      supplierQuestionSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    for (const k of Object.keys(SUPPLIER_LIMITS) as Array<keyof typeof SUPPLIER_LIMITS>) {
      expect(SUPPLIER_LIMITS[k], k).toBe(s.SUPPLIER_PORTAL_LIMITS[k]);
    }
    expect(SUPPLIER_LIMITS.perAccessSubmissionsMax).toBe(500);
    expect(SUPPLIER_LIMITS.perAccessFileBytesMax).toBe(50 * 1024 * 1024);
    expect([...SUBMISSION_STATUSES]).toEqual([...s.SUPPLIER_SUBMISSION_STATUSES]);
    expect(LINK_REFUSAL_DETAIL).toBe(s.SUPPLIER_LINK_REFUSAL.detail);
    expect(SESSION_REFUSAL_DETAIL).toBe(s.SUPPLIER_SESSION_REFUSAL.detail);
    expect(INVITE_TOKEN_RE.source).toBe(s.SUPPLIER_INVITE_TOKEN_RE.source);
  });
});
