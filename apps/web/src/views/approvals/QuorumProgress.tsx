/**
 * ADR-0186 A/B — where a tool-call approval stands: "1 of 2 approvals", who
 * has decided (each principal once, with how they proved it), and how this
 * approval must be signed. Renders nothing for any other approval kind.
 */
import type { Approval } from "../../api/types";
import { ago } from "../../api/format";
import { Badge } from "../../ui/kit";
import v from "../views.module.css";
import { DECISION_METHOD_COPY, isToolCallApproval, quorumProgress, signatureModeOf } from "./signedDecision";

const MODE_COPY: Record<string, string> = {
  passkey: "each approver signs this exact call with a passkey",
  step_up: "each approver confirms it's them",
  off: "signing is off for this approval (an audited relaxation)",
};

export function QuorumProgress(props: { approval: Approval }) {
  const r = props.approval;
  const progress = quorumProgress(r);
  if (!progress || !isToolCallApproval(r)) return null;
  const decisions = r.decisions ?? [];
  const mode = signatureModeOf(r);
  return (
    <div className={v.stack} style={{ gap: 4 }} data-testid={`quorum-${r.id}`}>
      <span className={v.rowTight} style={{ flexWrap: "wrap" }}>
        <Badge tone={progress.count >= progress.quorum ? "ok" : progress.quorum > 1 ? "warn" : "neutral"}>
          {progress.label}
        </Badge>
        <span className={v.faint} title={MODE_COPY[mode]}>
          {mode === "passkey" ? "passkey-signed" : mode === "step_up" ? "step-up" : "unsigned"}
        </span>
      </span>
      {decisions.length > 0 && (
        <ul aria-label="Decisions so far" style={{ margin: 0, paddingLeft: "1.1em" }}>
          {decisions.map((d) => (
            <li key={`${d.principalUserId ?? "?"}-${d.at}`} className={v.dim}>
              {d.principalName ?? d.principalUserId ?? "someone"} {d.decision}
              {d.deciderUserId && d.deciderUserId !== d.principalUserId
                ? ` (by their delegate ${d.deciderName ?? d.deciderUserId})`
                : ""}
              {" · "}
              {DECISION_METHOD_COPY[d.method] ?? d.method}
              {d.at ? ` · ${ago(d.at)}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
