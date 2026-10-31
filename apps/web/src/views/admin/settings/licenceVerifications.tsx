/**
 * The licence verification trail's row and columns, shared by the licensing overview's preview and the trail's own
 * page (LicenceVerificationsPage), so the page loads in its own chunk.
 */
import { ago } from "../../../api/format";
import { Badge, EmptyState } from "../../../ui/kit";
import type { DataColumn } from "../../../ui/DataList";
import v from "../../views.module.css";

export interface VerificationRow {
  id: string;
  at: string;
  trigger: string;
  ok: boolean;
  state: string;
  ruleId: string;
  reason: string;
  signingKeyId: string | null;
}

/** ADR-0226: the trail's columns; the ids and sortable ones match the gateway's VERIFICATIONS_LIST */
export const VERIFICATION_COLUMNS: Array<DataColumn<VerificationRow>> = [
  { key: "at", header: "When", main: true, sortable: true, render: (c) => ago(c.at) },
  { key: "trigger", header: "Trigger", main: true, sortable: true, render: (c) => c.trigger },
  {
    key: "ok",
    header: "",
    srHeader: "Status",
    main: true,
    required: "A refused check is a warning, so status is always shown",
    render: (c) => <Badge tone={c.ok ? "ok" : "danger"}>{c.ok ? "ok" : "REFUSED"}</Badge>,
  },
  { key: "state", header: "State", main: true, sortable: true, render: (c) => c.state },
  { key: "rule", header: "Rule", main: true, sortable: true, render: (c) => <code>{c.ruleId}</code> },
  { key: "reason", header: "Reason", main: true, render: (c) => <span className={v.faint}>{c.reason}</span> },
];

export const VERIFICATIONS_EMPTY = (
  <EmptyState
    title="Nothing has ever been verified on this deployment"
    body="Every install, every operator-driven check and every refusal lands here — including artifacts that were refused and therefore never became a licence."
  />
);

