import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Approval } from "../../api/types";
import { Badge, Button, CodeBlock, Modal, StatusBadge } from "../../ui/kit";
import { inspectApprovalAction } from "./approvalReview";
import s from "./actionReview.module.css";

export function McpActionReview(props: {
  approval: Approval;
  controls?: (blockedReason: string | null, close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dialog = body.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]')]
        .filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus();
      }
    };
    dialog.addEventListener("keydown", trap);
    return () => dialog.removeEventListener("keydown", trap);
  }, [open]);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.querySelector("button")?.focus();
  }, []);
  const approval = props.approval;
  const view = open ? inspectApprovalAction(approval, now) : null;
  const payloadText = useMemo(() => view?.payload ? JSON.stringify(view.payload, null, 2) : null, [view?.payload]);
  return <>
    <span ref={trigger}><Button size="sm" onClick={() => setOpen(true)} aria-label={`Review action ${approval.toolName ?? approval.id}`}>
      Review action
    </Button></span>
    {open && view && <Modal open wide className={s.dialog} title="Review MCP action" onClose={close} actions={<>
      {props.controls && <div className={s.controls}>{props.controls(view.blockedReason, close)}</div>}
      <Button onClick={close}>Close</Button>
    </>}>
      <div className={s.body} ref={body}>
        <div className={s.status}>
          <StatusBadge status={approval.status} />
          {view.kind === "redacted" && <Badge tone="info">PII redacted</Badge>}
          {approval.approvalScope === "tool" && <Badge tone="warn">Tool-wide consent</Badge>}
        </div>
        <dl className={s.facts}>
          <dt>Tool</dt><dd>{approval.toolName ?? "Not recorded"}</dd>
          <dt>Server</dt><dd>{approval.serverName ?? approval.serverId ?? "Not recorded"}</dd>
          <dt>Project</dt><dd>{approval.projectName ?? approval.projectId ?? "Unattributed"}</dd>
          <dt>Requested by</dt><dd>{approval.requestedByName ?? approval.userId}</dd>
          <dt>Consent scope</dt><dd>{approval.approvalScope === "action" ? "Exact action" : approval.approvalScope === "tool" ? "Other arguments for this tool are permitted" : "Not recorded"}</dd>
          <dt>Expires</dt><dd>{approval.expiresAt === null ? "Never" : approval.expiresAt && Number.isFinite(Date.parse(approval.expiresAt)) ? new Date(approval.expiresAt).toLocaleString() : "Not recorded"}</dd>
        </dl>
        {view.blockedReason && <p className={s.warning} role="alert">{view.blockedReason}</p>}
        {view.payload && <section aria-label="Action payload" className={s.payload}>
          <div className={s.payloadHeading}>
            <h3>{view.kind === "redacted" ? "Effective arguments" : view.kind === "legacy" ? "Legacy preview" : "Recorded arguments"}</h3>
            <span>Credentials masked</span>
          </div>
          <CodeBlock maxHeight="360px">{payloadText ?? ""}</CodeBlock>
        </section>}
        <details className={s.binding}>
          <summary>Binding details</summary>
          <dl className={s.facts}>
            <dt>Approval</dt><dd><code>{approval.id}</code></dd>
            <dt>Action fingerprint</dt><dd><code>{approval.argumentsDigest ?? "Not recorded"}</code></dd>
            <dt>Policy fingerprint</dt><dd><code>{approval.contextDigest ?? "Not recorded"}</code></dd>
            {view.transformation && <>
              <dt>Original fingerprint</dt><dd><code>{view.transformation.originalDigest}</code></dd>
              <dt>Effective fingerprint</dt><dd><code>{view.transformation.effectiveDigest}</code></dd>
              <dt>Schema fingerprint</dt><dd><code>{view.transformation.schemaDigest}</code></dd>
              <dt>Text transformation</dt><dd>{view.transformation.textVersion}</dd>
              <dt>Payload transformation</dt><dd>{view.transformation.payloadVersion}</dd>
              <dt>Additional ID policies</dt><dd>{view.transformation.internationalCategories.join(", ") || "None"}</dd>
            </>}
          </dl>
        </details>
      </div>
    </Modal>}
  </>;
}
