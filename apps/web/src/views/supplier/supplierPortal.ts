/**
 * The supplier portal's browser-side contract: the limits and messages the gateway enforces, mirrored here because
 * the SPA does not depend on `@regulait/shared` at runtime (supplierPortal.test.ts pins every mirrored value against
 * `packages/shared/src/supplier-portal.ts`, so drift fails a test rather than a supplier).
 *
 * Pure functions only: no React, no platform API client. The supplier page imports this, and so does the admin
 * panel, so neither pulls the other's code into its chunk.
 */

/** mirrors SUPPLIER_PORTAL_LIMITS (the parts a screen shows or checks before sending) */
export const SUPPLIER_LIMITS = Object.freeze({
  inviteHoursMax: 72,
  inviteHoursDefault: 24,
  accessDaysMax: 30,
  accessDaysDefault: 14,
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 8,
  fileMaxBytes: 2 * 1024 * 1024,
  statementMax: 4000,
});

/** mirrors SUPPLIER_LINK_REFUSAL.detail: the one answer every refused sign-in link gets */
export const LINK_REFUSAL_DETAIL =
  "This link cannot be used. It may have expired or already been used. Ask your contact for a new link.";
/** mirrors SUPPLIER_SESSION_REFUSAL.detail: the one answer a request without a live session gets */
export const SESSION_REFUSAL_DETAIL =
  "Your session has ended. Open the most recent link you were sent, or ask your contact for a new one.";

/** mirrors SUPPLIER_INVITE_TOKEN_RE */
export const INVITE_TOKEN_RE = /^rglsi_[A-Za-z0-9_-]{43}$/;
/** mirrors the shared question id rule */
export const QUESTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** the file name endings the gateway accepts, each matched to the type it detects from the bytes */
export const ACCEPTED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "txt", "csv"] as const;
/** the `accept` attribute for a file input */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(",");

/** what the page's address fragment holds: nothing, a sign-in link token, or something that cannot be one */
export type HashToken = { kind: "none" } | { kind: "token"; token: string } | { kind: "invalid" };

/** read the sign-in token from `location.hash` (`#rglsi_…`); the caller clears the hash straight after */
export function tokenFromHash(hash: string): HashToken {
  const raw = (hash.startsWith("#") ? hash.slice(1) : hash).trim();
  if (raw === "") return { kind: "none" };
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return { kind: "invalid" };
  }
  return INVITE_TOKEN_RE.test(value) ? { kind: "token", token: value } : { kind: "invalid" };
}

/** the address without its fragment, for `history.replaceState` */
export function withoutHash(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

/** "2 MB" for the limit as people read it */
export function fileLimitLabel(maxBytes: number = SUPPLIER_LIMITS.fileMaxBytes): string {
  const mb = maxBytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

/** why this file cannot be sent, in words, or null when it may be (the gateway checks the bytes again) */
export function fileProblem(file: { name: string; size: number }, maxBytes: number = SUPPLIER_LIMITS.fileMaxBytes): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return "Choose a PDF, PNG, JPEG, plain text or CSV file whose name ends in .pdf, .png, .jpg, .jpeg, .txt or .csv.";
  }
  if (file.size < 1) return "This file is empty. Choose another file.";
  if (file.size > maxBytes) return `This file is too large. A file can be at most ${fileLimitLabel(maxBytes)}.`;
  if (file.name.trim().length > 200) return "This file name is too long. Rename the file to at most 200 characters.";
  return null;
}

/** the base64 part of a `data:` URL (`data:application/pdf;base64,JVBER…` → `JVBER…`) */
export function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** read a chosen file as standard base64 of its raw bytes */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read. Choose it again."));
    reader.onload = () => resolve(base64FromDataUrl(String(reader.result ?? "")));
    reader.readAsDataURL(file);
  });
}

/** why this statement cannot be sent, or null */
export function statementProblem(statement: string, max: number = SUPPLIER_LIMITS.statementMax): string | null {
  const t = statement.trim();
  if (t === "") return "Write your answer before sending it.";
  if (t.length > max) return `Your answer is too long. It can be at most ${max.toLocaleString("en-GB")} characters.`;
  return null;
}

export type SubmissionStatus = "submitted" | "accepted" | "rejected";

/** a submission's status as the supplier reads it */
export const SUPPLIER_STATUS_LABEL: Record<SubmissionStatus, string> = {
  submitted: "Waiting for review",
  accepted: "Accepted",
  rejected: "Not accepted",
};

/** a submission's status as a reviewer reads it */
export const REVIEW_STATUS_LABEL: Record<SubmissionStatus, string> = {
  submitted: "Awaiting review",
  accepted: "Accepted",
  rejected: "Rejected",
};

/** the scan result as words; a file nobody scanned says so plainly */
export function scanLabel(status: string | null | undefined): string {
  if (status === "clean") return "Scanned, clean";
  if (status === "rejected") return "Refused by the scan";
  return "Not scanned";
}

/** the detected file type as words */
export function fileTypeLabel(contentType: string | null | undefined): string {
  switch (contentType) {
    case "application/pdf":
      return "PDF";
    case "image/png":
      return "PNG image";
    case "image/jpeg":
      return "JPEG image";
    case "text/plain":
      return "Plain text";
    case "text/csv":
      return "CSV";
    default:
      return "File";
  }
}
