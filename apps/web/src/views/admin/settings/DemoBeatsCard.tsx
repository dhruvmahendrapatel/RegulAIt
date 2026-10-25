/**
 * ADR-0202 decision 4 — the demo beats' simulated fallback, on the Execution control page because that is the page
 * opened when something is going wrong. Lazy-loaded (the `all JS` ceiling has no headroom). Every beat is live by
 * default; switching one needs a reason, which the gateway audits. A simulated beat is labelled "simulated" here and
 * by the beat itself on stage.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime } from "../../../api/format";
import { Badge, Button, Card, ErrorState, SkeletonBlock } from "../../../ui/kit";
import { ReasonModal, useAction } from "../adminKit";
import v from "../../views.module.css";

interface Beat {
  beatId: string;
  label: string;
  mode: "live" | "simulated";
  live: string;
  simulated: string;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export default function DemoBeatsCard() {
  const act = useAction();
  const beats = useQuery({ queryKey: ["admin", "demo-beats"], queryFn: () => api.get<{ beats: Beat[] }>("/v1/demo/beats") });
  const [pending, setPending] = useState<Beat | null>(null);
  const toSimulated = pending?.mode === "live";

  const confirm = (reason: string) => {
    const b = pending;
    setPending(null);
    if (!b) return;
    // useAction toasts a refusal and re-fetches every ["admin"] query once the write lands
    void act.run(() => api.put(`/v1/demo/beats/${b.beatId}`, { simulated: b.mode === "live", reason }));
  };

  return (
    <Card title="Demo beats: live or simulated">
      {beats.isPending && <SkeletonBlock lines={3} />}
      {beats.isError && <ErrorState title="Couldn't load the demo beats" message={beats.error.message} onRetry={() => void beats.refetch()} />}
      <ul className={v.stack}>
        {(beats.data?.beats ?? []).map((b) => (
          <li key={b.beatId}>
            <Badge tone={b.mode === "live" ? "ok" : "warn"}>{b.mode}</Badge> {b.label}{" "}
            <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => setPending(b)}>
              {b.mode === "live" ? "Simulate" : "Go live"}
            </Button>
            {b.updatedAt && (
              <div className={v.hint}>
                {b.reason} ({b.updatedBy}, {fmtDateTime(b.updatedAt)})
              </div>
            )}
          </li>
        ))}
      </ul>
      <ReasonModal
        open={pending !== null}
        title={`${pending?.label}: ${toSimulated ? "simulated" : "live"}`}
        body={toSimulated ? pending?.simulated : pending?.live}
        minLength={3}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </Card>
  );
}
