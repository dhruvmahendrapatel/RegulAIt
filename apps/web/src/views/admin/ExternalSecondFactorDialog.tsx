/**
 * ADR-0240 — one dialog, for both admin screens that invite someone from outside: a supplier contact (Supplier access
 * on a vendor) and an auditor (Trust publishing). It reads the grant's second-factor state only while it is open (one
 * request per click, never one per table row) and offers the reset: a reason, then the app-wide step-up prompt
 * (`identity_manage`, audited). The caller passes how to read and reset, so each request names its own route.
 *
 * The model (labels, sentences, when a reset is off and why) is `externalSecondFactor.ts`.
 */
import { useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { fmtAt } from "../../api/format";
import { Badge, Button, ErrorState, Modal, SkeletonBlock } from "../../ui/kit";
import { RefusalNotice } from "../../ui/RefusalNotice";
import { ReasonModal, useAction } from "./adminKit";
import v from "../views.module.css";
import {
  factorLabel,
  factorSentence,
  factorTone,
  resetBlock,
  resetSummary,
  type ExternalFactorResetResult,
  type ExternalFactorView,
} from "./externalSecondFactor";

export function ExternalSecondFactorDialog(props: {
  /** who the grant belongs to, as the admin knows them (an e-mail address or a name) */
  holder: string | null;
  queryKey: QueryKey;
  load: () => Promise<ExternalFactorView>;
  reset: (reason: string) => Promise<ExternalFactorResetResult>;
  onClose: () => void;
  /** refresh the caller's own list (sessions and links change on a reset) */
  onReset?: () => Promise<unknown> | void;
}) {
  const open = props.holder !== null;
  const qc = useQueryClient();
  const act = useAction();
  const [asking, setAsking] = useState(false);
  const factor = useQuery({ queryKey: props.queryKey, queryFn: props.load, enabled: open, retry: false });
  const block = act.busy ? "Resetting…" : resetBlock(factor.data);

  const doReset = (reason: string) => {
    setAsking(false);
    void act.run(async () => {
      const out = await props.reset(reason);
      await Promise.all([qc.invalidateQueries({ queryKey: props.queryKey }), props.onReset?.()]);
      return resetSummary(out);
    });
  };

  return (
    <>
      <Modal
        open={open && !asking}
        title={props.holder ? `Second factor for ${props.holder}` : "Second factor"}
        onClose={props.onClose}
        actions={
          <>
            <Button onClick={props.onClose}>Close</Button>
            <Button variant="danger" disabled={block !== null} title={block ?? undefined} onClick={() => setAsking(true)}>
              Reset second factor
            </Button>
          </>
        }
      >
        {factor.isLoading ? (
          <SkeletonBlock lines={3} />
        ) : factor.error || !factor.data ? (
          <ErrorState title="The second factor could not be loaded" message="Try again in a moment." onRetry={() => void factor.refetch()} />
        ) : (
          <div className={v.stackTight}>
            <div>
              <Badge tone={factorTone(factor.data.state)}>{factorLabel(factor.data.state)}</Badge>
            </div>
            <p>{factorSentence(factor.data, fmtAt)}</p>
            {factor.data.failedAttempts > 0 && factor.data.state !== "locked" && (
              <p className={v.faint}>
                {factor.data.failedAttempts} wrong {factor.data.failedAttempts === 1 ? "code" : "codes"} in a row so far.
              </p>
            )}
            <p className={v.faint}>
              A reset removes the factor, ends their sessions and cancels every unused link. Send a new link afterwards; they
              set up the factor again when they open it.
            </p>
            {block && !act.busy && <p className={v.faint}>{block}</p>}
          </div>
        )}
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <RefusalNotice guidance={act.guidance} />
      </Modal>
      <ReasonModal
        open={open && asking}
        title={props.holder ? `Reset the second factor for ${props.holder}?` : "Reset the second factor?"}
        body={<p>They can no longer sign in until you send a new link. The reason is recorded in the audit trail.</p>}
        confirmLabel="Reset second factor"
        danger
        placeholder="Reason (required, recorded in the audit trail)"
        onConfirm={doReset}
        onCancel={() => setAsking(false)}
      />
    </>
  );
}
