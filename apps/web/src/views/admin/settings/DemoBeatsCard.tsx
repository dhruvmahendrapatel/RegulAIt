/**
 * ADR-0202 decision 4 — the demo beats' simulated fallback, on the Execution control page because that is the page
 * opened when something is going wrong. Lazy-loaded (the `all JS` ceiling has no headroom). Every beat is live by
 * default; switching one needs a reason, which the gateway audits. A simulated beat is labelled "simulated" here and
 * by the beat itself on stage.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Badge, Button, Card } from "../../../ui/kit";
import { QueryGate, ReasonModal, useAction } from "../adminKit";
import v from "../../views.module.css";

interface Beat {
  beatId: string;
  label: string;
  mode: "live" | "simulated";
  live: string;
  simulated: string;
  reason: string | null;
}

export default function DemoBeatsCard() {
  const act = useAction();
  const beats = useQuery({ queryKey: ["admin", "demo-beats"], queryFn: () => api.get<{ beats: Beat[] }>("/v1/demo/beats") });
  const [pending, setPending] = useState<Beat | null>(null);
  const toLive = pending?.mode === "simulated";

  const confirm = (reason: string) => {
    const b = pending;
    setPending(null);
    // useAction toasts a refusal and re-fetches every ["admin"] query once the write lands
    if (b) void act.run(() => api.put(`/v1/demo/beats/${b.beatId}`, { simulated: !toLive, reason }));
  };

  // QueryGate is the admin pages' shared skeleton and error-with-Retry
  return (
    <QueryGate loading={beats.isPending} error={beats.error} onRetry={() => void beats.refetch()}>
      <Card title="Demo beats: live or simulated">
        <ul className={v.stack}>
          {beats.data?.beats.map((b) => (
            <li key={b.beatId}>
              {/* the last switch's reason on hover; who and when are in the audit log (demo-beat-fallback-changed) */}
              <Badge tone={b.mode === "live" ? "ok" : "warn"} title={b.reason ?? undefined}>
                {b.mode}
              </Badge>{" "}
              {b.label}{" "}
              <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => setPending(b)}>
                {b.mode === "live" ? "Simulate" : "Go live"}
              </Button>
            </li>
          ))}
        </ul>
        <ReasonModal
          open={pending !== null}
          title={`${pending?.label}: ${toLive ? "live" : "simulated"}`}
          body={toLive ? pending?.live : pending?.simulated}
          minLength={3}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      </Card>
    </QueryGate>
  );
}
