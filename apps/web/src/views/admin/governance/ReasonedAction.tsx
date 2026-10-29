/**
 * PROTOTYPE (#453 G9) — a button that opens a ReasonModal stating the consequence,
 * posts the reason, and renders a refusal the person must resolve INSIDE the dialog
 * (the dialog stays open), rather than as a toast that disappears.
 */
import { useState, type ReactNode } from "react";
import { ApiError, api, type ApiErrorPayload } from "../../../api/client";
import { Button } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { ReasonModal, useAdminInvalidate } from "../adminKit";
import v from "../../views.module.css";

export function ReasonedAction(props: {
  label: string;
  ariaLabel?: string;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  path: string;
  done: string;
  /** turn a known refusal into what the person does next; null = not this one */
  refusal?: (code: string, payload: ApiErrorPayload) => ReactNode | null;
  onDone?: () => void;
  variant?: "ghost" | "danger";
}) {
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<ReactNode | null>(null);
  const { toast } = useToast();
  const invalidate = useAdminInvalidate();
  return (
    // a row that opens on click must not also open when this button or its dialog is used
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Button
        size="sm"
        variant={props.variant ?? "ghost"}
        aria-label={props.ariaLabel ?? props.label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {props.label}
      </Button>
      <ReasonModal
        open={open}
        danger
        minLength={10}
        title={props.title}
        confirmLabel={props.confirmLabel ?? props.label}
        body={
          <>
            {props.body}
            {refused && (
              <div className={v.errLine} role="alert" data-testid="reasoned-refusal">
                {refused}
              </div>
            )}
          </>
        }
        onCancel={() => {
          setOpen(false);
          setRefused(null);
        }}
        onConfirm={(reason) => {
          setRefused(null);
          void (async () => {
            try {
              await api.post(props.path, { reason });
              setOpen(false);
              toast(props.done, "success");
              invalidate();
              props.onDone?.();
            } catch (e) {
              const known = e instanceof ApiError && typeof e.payload.error === "string" ? props.refusal?.(e.payload.error, e.payload) : null;
              setRefused(known ?? (e instanceof Error ? e.message : String(e)));
            }
          })();
        }}
      />
    </span>
  );
}
