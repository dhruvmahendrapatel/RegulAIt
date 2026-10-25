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
import { ReasonModal, useAction } from "../adminKit";
import v from "../../views.module.css";

interface Beat {
  beatId: string;
  label: string;
  mode: "live" | "simulated";
  live: string;
  simulated: string;
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
    void act
      .run(() => api.put(`/v1/demo/beats/${b.beatId}`, { simulated: b.mode === "live", reason }))
      .then(() => beats.refetch());
  };

  return (
    <Card title="Demo beats: live or simulated">
      <ul className={v.stack}>
        {(beats.data?.beats ?? []).map((b) => (
          <li key={b.beatId}>
            <Badge tone={b.mode === "live" ? "ok" : "warn"}>{b.mode}</Badge> {b.label}{" "}
            <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => setPending(b)}>
              {b.mode === "live" ? "Simulate" : "Go live"}
            </Button>
          </li>
        ))}
      </ul>
      {act.error && <div className={v.errLine}>{act.error}</div>}
      <ReasonModal
        open={pending !== null}
        title={`${pending?.label}: ${toSimulated ? "simulated" : "live"}`}
        body={<p>{toSimulated ? pending?.simulated : pending?.live}. Audited.</p>}
        minLength={3}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </Card>
  );
}
