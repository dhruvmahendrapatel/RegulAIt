/**
 * Privacy (records of processing and data-subject requests): the words the two pages show for the gateway's codes,
 * and the shapes they read. The gateway's own vocabularies live in packages/shared/src/privacy-ops.ts; these tables
 * must name every member, which privacyModel.test.ts checks.
 */

export const DATA_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  email: "Email address",
  phone: "Phone number",
  credit_card: "Payment card number",
  ssn: "US Social Security number",
  aadhaar: "Aadhaar number (India)",
  cpf: "CPF (Brazil)",
  bsn: "BSN (Netherlands)",
  sin: "Social Insurance Number (Canada)",
  tfn: "Tax File Number (Australia)",
  steuer_id: "Tax ID (Germany)",
  nir: "Social security number (France)",
  dni_nie: "DNI or NIE (Spain)",
  codice_fiscale: "Codice fiscale (Italy)",
  nino: "National Insurance number (UK)",
};
export const DATA_CATEGORIES = Object.keys(DATA_CATEGORY_LABELS);

export const LAWFUL_BASIS_LABELS: Readonly<Record<string, string>> = {
  consent: "Consent",
  contract: "Contract",
  legal_obligation: "Legal obligation",
  vital_interests: "Vital interests",
  public_task: "Public task",
  legitimate_interests: "Legitimate interests",
};

export const DSR_KIND_LABELS: Readonly<Record<string, string>> = {
  access: "Access",
  erasure: "Erasure",
  objection: "Objection",
};

export const DSR_STATUS_LABELS: Readonly<Record<string, string>> = {
  received: "Received",
  in_progress: "In progress",
  completed: "Completed",
  rejected: "Rejected",
};

export const DSR_STORE_LABELS: Readonly<Record<string, string>> = {
  accounts: "User accounts",
  conversations: "Conversations",
  project_context: "Shared project context",
  audit_trail: "Audit trail",
};

export const ERASURE_LABELS: Readonly<Record<string, string>> = {
  erased: "Erased",
  tombstoned: "Kept, tombstone recorded",
  retained: "Kept",
};

export interface ProcessingRecord {
  id: string;
  name: string;
  purpose: string;
  lawfulBasis: string;
  dataCategories: string[];
  retentionDays: number;
  recipients: string[];
  projectId: string | null;
  projectName: string | null;
  useCaseId: string | null;
  useCaseName: string | null;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
}

export interface StoreFinding {
  store: string;
  matches: number;
  erasure: string;
  note: string;
}

export interface DataSubjectRequest {
  id: string;
  kind: string;
  identifierKind: "email" | "phone";
  reference: string | null;
  processingRecordId: string | null;
  status: string;
  receivedAt: string;
  dueAt: string;
  overdue: boolean;
  located: StoreFinding[] | null;
  locatedAt: string | null;
  closedAt: string | null;
  closeNote: string | null;
  createdAt: string;
}

export interface Tombstone {
  store: string;
  rowCount: number;
  retainedUntil: string | null;
  reason: string;
  createdAt: string;
}

export const label = (table: Readonly<Record<string, string>>, code: string): string => table[code] ?? code;

/** "Email address, Phone number" */
export const categoryList = (codes: readonly string[]): string => codes.map((c) => label(DATA_CATEGORY_LABELS, c)).join(", ");

export const isOpen = (r: Pick<DataSubjectRequest, "status">): boolean => r.status === "received" || r.status === "in_progress";

/** the same shape check the gateway runs, so a mistyped identifier is caught before it is sent */
export function identifierProblem(kind: "email" | "phone", raw: string): string | null {
  const t = raw.trim();
  if (kind === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t) ? null : "Enter a full email address.";
  return /^\+?\d{7,15}$/.test(t.replace(/[^\d+]/g, "")) ? null : "Enter a phone number of 7 to 15 digits.";
}

/** a new or edited record's categories that the stored record did not permit: the change needs identity confirmation */
export function widens(before: Pick<ProcessingRecord, "dataCategories" | "status"> | null, categories: readonly string[], status: string): boolean {
  if (status !== "active") return false;
  if (!before || before.status !== "active") return true;
  const had = new Set(before.dataCategories);
  return categories.some((c) => !had.has(c));
}
