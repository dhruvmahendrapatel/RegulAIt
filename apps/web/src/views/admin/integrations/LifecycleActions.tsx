/**
 * ADR-0207 (G3, G4) — Disable / Enable / Delete for an integration row (connectors, MCP servers).
 *
 * The order is fixed: a live object is disabled first (reason required, audited), and only a
 * disabled one can be deleted. Enabling again is a relaxation and is stepped up. A delete the
 * gateway refuses because audit evidence still refers to the object is explained in the dialog.
 * Each page passes its own calls, so every route is named literally where it is called.
 */
import { useState, type ReactNode } from "react";
import { ApiError } from "../../../api/client";
import { withStepUp } from "../../../stepup/stepUp";
import { fmtAt } from "../../../api/format";
import { Badge, Button, ConfirmModal, InfoButton, Modal, RowActions } from "../../../ui/kit";
import { ReasonModal, useAction } from "../adminKit";
import { useToast } from "../../../ui/toast";
import v from "../../views.module.css";

/** the primary-slot width every lifecycle table uses (X7: one value per table) */
export const LIFECYCLE_SLOT = "5.5rem";

export interface LifecycleRow {
  id: string;
  name: string;
  enabled?: boolean;
  disabledReason?: string | null;
  disabledAt?: string | null;
  disabledBy?: string | null;
}

/** "disabled" in danger, with who/when/why behind an (i) */
export function DisabledBadge(props: { row: LifecycleRow; noun: string }) {
  if (props.row.enabled !== false) return null;
  return (
    <span className={v.row} style={{ gap: "var(--s1)" }}>
      <Badge tone="danger">disabled</Badge>
      <InfoButton label={`why ${props.noun} ${props.row.name} is disabled`} term="Disabled">
        <span style={{ display: "block" }}>
          {props.row.disabledAt ? `${fmtAt(props.row.disabledAt)}` : "Date not reported"}
          {props.row.disabledBy ? ` by ${props.row.disabledBy}` : ""}
        </span>
        <span style={{ display: "block" }}>Reason: {props.row.disabledReason ?? "Not reported"}</span>
      </InfoButton>
    </span>
  );
}

export interface LifecycleConfig {
  /** "connector", "MCP server" */
  noun: string;
  /** `POST …/:id/enabled` with `{ enabled: false, reason }` */
  disable: (id: string, reason: string) => Promise<unknown>;
  /** `POST …/:id/enabled` with `{ enabled: true }`, carrying the step-up headers */
  enable: (id: string, stepUpHeaders: Record<string, string>) => Promise<unknown>;
  /** `DELETE …/:id` */
  remove: (id: string) => Promise<unknown>;
  disableBody: ReactNode;
  enableBody: ReactNode;
  deleteBody: ReactNode;
  /** the 409 code the delete is refused with while evidence refers to the object */
  inUseCode: string;
  /** the refusal in the page's words, from the 409 payload */
  inUseText: (payload: Record<string, unknown>) => string;
  /** one column of actions, for a wide table (X7 stacked) */
  stacked?: boolean;
}

export function useLifecycle(cfg: LifecycleConfig) {
  const act = useAction();
  const { toast } = useToast();
  const [disabling, setDisabling] = useState<LifecycleRow | null>(null);
  const [enabling, setEnabling] = useState<LifecycleRow | null>(null);
  const [deleting, setDeleting] = useState<LifecycleRow | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  /** `primary`: the page's own first action (an Edit), shown before Disable / Enable */
  const actions = (r: LifecycleRow, primary?: ReactNode) => {
    const off = r.enabled === false;
    return (
      // the row may be clickable (MCP servers open their tools); a button here acts, never opens the row
      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <RowActions
          slot={LIFECYCLE_SLOT}
          stacked={cfg.stacked}
          {...(primary ? { primary } : {})}
          secondary={
            off ? (
              <Button size="sm" aria-label={`Enable ${cfg.noun} ${r.name}`} disabled={act.busy} onClick={() => setEnabling(r)}>
                Enable
              </Button>
            ) : (
              <Button size="sm" aria-label={`Disable ${cfg.noun} ${r.name}`} disabled={act.busy} onClick={() => setDisabling(r)}>
                Disable
              </Button>
            )
          }
          rest={
            off ? (
              <Button size="sm" variant="danger" aria-label={`Delete ${cfg.noun} ${r.name}`} disabled={act.busy} onClick={() => setDeleting(r)}>
                Delete
              </Button>
            ) : (
              <span className={v.row} style={{ gap: "var(--s1)", flexWrap: cfg.stacked ? "wrap" : "nowrap" }}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-disabled
                  title="Disable it first"
                  aria-label={`Delete ${cfg.noun} ${r.name}, unavailable: disable it first`}
                  style={{ opacity: 0.5, cursor: "not-allowed" }}
                  onClick={(e) => e.preventDefault()}
                >
                  Delete
                </Button>
                <span className={v.faint} style={{ whiteSpace: "nowrap" }}>
                  Disable it first
                </span>
              </span>
            )
          }
        />
      </span>
    );
  };

  const closeDelete = () => {
    setDeleting(null);
    setRefusal(null);
  };

  const dialogs = (
    <>
      <ReasonModal
        open={disabling !== null}
        title={`Disable ${cfg.noun} “${disabling?.name}”?`}
        body={<p className={v.flush}>{cfg.disableBody}</p>}
        danger
        minLength={10}
        confirmLabel={`Disable ${cfg.noun}`}
        placeholder="reason (required, audited, at least 10 characters)"
        onCancel={() => setDisabling(null)}
        onConfirm={(reason) => {
          const r = disabling;
          setDisabling(null);
          if (r) void act.run(() => cfg.disable(r.id, reason), `${cap(cfg.noun)} “${r.name}” disabled`);
        }}
      />
      <ConfirmModal
        open={enabling !== null}
        title={`Enable ${cfg.noun} “${enabling?.name}”?`}
        body={<p className={v.flush}>{cfg.enableBody}</p>}
        confirmLabel={`Enable ${cfg.noun}`}
        onCancel={() => setEnabling(null)}
        onConfirm={() => {
          const r = enabling;
          setEnabling(null);
          // enabling is a relaxation: the gateway asks for a step-up, answered by the shared dialog
          if (r)
            void act.run(
              () => withStepUp((h) => cfg.enable(r.id, h)),
              `${cap(cfg.noun)} “${r.name}” enabled`,
            );
        }}
      />
      <Modal
        open={deleting !== null}
        title={`Delete ${cfg.noun} “${deleting?.name}”?`}
        onClose={closeDelete}
        actions={
          refusal ? (
            <Button onClick={closeDelete}>Close</Button>
          ) : (
            <>
              <Button onClick={closeDelete}>Cancel</Button>
              <Button
                variant="danger"
                disabled={deleteBusy}
                onClick={() => {
                  const r = deleting;
                  if (!r) return;
                  setDeleteBusy(true);
                  let deleted = false;
                  void act
                    .run(async () => {
                      try {
                        await cfg.remove(r.id);
                        deleted = true;
                      } catch (e) {
                        // the refusal the person reads is the dialog's own sentence, not a toast
                        if (e instanceof ApiError && e.status === 409 && e.payload?.error === cfg.inUseCode) {
                          setRefusal(cfg.inUseText(e.payload as Record<string, unknown>));
                          return;
                        }
                        throw e;
                      }
                    }, null)
                    .then(() => {
                      setDeleteBusy(false);
                      if (deleted) {
                        toast(`${cap(cfg.noun)} “${r.name}” deleted`, "success");
                        closeDelete();
                      }
                    });
                }}
              >
                Delete {cfg.noun}
              </Button>
            </>
          )
        }
      >
        <div className={v.stack}>
          <p className={v.flush}>{cfg.deleteBody}</p>
          {refusal && (
            <p className={`${v.errLine} ${v.flush}`} data-testid="delete-refusal">
              {refusal}
            </p>
          )}
        </div>
      </Modal>
    </>
  );

  return { actions, dialogs, act };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "3 approvals and 1 chat connection" — counts in words, zero counts left out */
export function countsText(parts: Array<[number | undefined, string, string]>): string {
  const said = parts.filter(([n]) => (n ?? 0) > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (said.length <= 1) return said[0] ?? "other records";
  return `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
}
