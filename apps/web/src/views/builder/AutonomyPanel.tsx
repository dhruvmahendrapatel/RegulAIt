/**
 * ADR-0180 §5 (A8) — the agent's autonomy class on the Configure panel.
 *
 * Shows the OBSERVED class and the facts behind it in plain language, the
 * DECLARED class with a control to declare (or withdraw) one, the control
 * floor the stricter class needs with pass/fail and how to fix each, and a
 * warning when the declaration is lower than what the agent does. Only the
 * agent's steward (owner) or an admin sees it: the gateway refuses everyone
 * else, and the panel is not rendered for them.
 */
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../api/format";
import type { BuilderAgentDetail } from "../../api/types";
import { Badge, Button, Field, Select, Textarea } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { AUTONOMY_CLASSES, AUTONOMY_CLASS_INFO, autonomyLabel as label, belowObservedCopy, floorSummary, type AutonomyClass } from "./autonomyModel";
import { bk, builderApi } from "./builderApi";
import s from "./builder.module.css";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AutonomyPanel(props: { agent: BuilderAgentDetail }) {
  const { agent } = props;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    // re-read whenever the agent changes (a tool, a schedule, a channel…)
    queryKey: [...bk.autonomy(agent.id), agent.updatedAt],
    queryFn: () => builderApi.getAutonomy(agent.id),
  });
  const v = q.data?.autonomy;
  const [choice, setChoice] = useState<string>("");
  const [note, setNote] = useState("");
  const [noteErr, setNoteErr] = useState<string | null>(null);
  useEffect(() => {
    setChoice(v?.declared?.class ?? "");
    setNote(v?.declared?.note ?? "");
  }, [v?.declared?.class, v?.declared?.note]);
  const declare = useMutation({
    mutationFn: (body: { class: AutonomyClass | null; note?: string }) => builderApi.declareAutonomy(agent.id, body),
    onSuccess: (res) => {
      queryClient.setQueryData([...bk.autonomy(agent.id), agent.updatedAt], { autonomy: res.autonomy });
      toast(res.autonomy.declared ? `Declared ${label(res.autonomy.declared.class)}` : "Declaration withdrawn", "success");
    },
  });
  const reasonsId = useId();

  if (q.isPending) return <p className={s.small}>Loading the autonomy class…</p>;
  if (q.isError || !v) return <p className={s.small}>Couldn&apos;t load the autonomy class: {errText(q.error)}</p>;

  const save = () => {
    const cls = (choice || null) as AutonomyClass | null;
    if (cls && !note.trim()) {
      setNoteErr("Say why you declare this class.");
      return;
    }
    setNoteErr(null);
    declare.mutate(cls ? { class: cls, note: note.trim() } : { class: null });
  };
  const dirty = (choice || null) !== (v.declared?.class ?? null) || (choice !== "" && note.trim() !== (v.declared?.note ?? ""));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }} data-testid="autonomy-panel">
      {v.declaredBelowObserved && (
        <div className={s.danger} role="status">
          <p className={s.dangerTitle}>Declared lower than what it does</p>
          <p className={s.small} style={{ margin: 0 }}>
            {belowObservedCopy(v)}
          </p>
        </div>
      )}

      <div>
        <div className={s.subhead}>Observed class</div>
        <p className={s.small} style={{ margin: "4px 0" }}>
          <Badge tone={v.observed.class === "assist" ? "neutral" : "info"}>{label(v.observed.class)}</Badge>{" "}
          {AUTONOMY_CLASS_INFO[v.observed.class].description}
        </p>
        <p className={s.small} id={reasonsId} style={{ margin: 0 }}>
          Why:
        </p>
        {v.observed.reasons.length ? (
          <ul aria-labelledby={reasonsId} className={s.small} style={{ margin: "2px 0 0", paddingLeft: 18 }}>
            {v.observed.reasons.map((r) => (
              <li key={r.ruleId}>{r.text}</li>
            ))}
          </ul>
        ) : (
          <p className={s.small} style={{ margin: "2px 0 0" }}>
            Nothing it is set up to do goes beyond answering when a person asks.
          </p>
        )}
        <p className={s.small} style={{ margin: "4px 0 0" }}>
          What it was seen doing covers the last {v.observed.windowDays} days.
        </p>
      </div>

      <div>
        <div className={s.subhead}>Declared class</div>
        <p className={s.small} style={{ margin: "4px 0" }}>
          {v.declared ? (
            <>
              <Badge tone="primary">{label(v.declared.class)}</Badge> declared{v.declared.declaredBy?.name ? ` by ${v.declared.declaredBy.name}` : ""}{" "}
              {ago(v.declared.declaredAt)}
              {v.declared.note ? ` — “${v.declared.note}”` : ""}
            </>
          ) : (
            "Not declared, so the observed class applies."
          )}
        </p>
        <Field label="Declare a class">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={declare.isPending}>
            <option value="">No declaration (use the observed class)</option>
            {AUTONOMY_CLASSES.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </Select>
        </Field>
        {choice !== "" && (
          <Field label="Why this class" error={noteErr}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} disabled={declare.isPending} />
          </Field>
        )}
        <p className={s.small} style={{ margin: "4px 0" }}>
          You may declare a lower class than observed, but the stricter class&apos;s controls still apply and the gap is reported.
        </p>
        {declare.isError && (
          <p role="alert" className={s.small} style={{ margin: "4px 0", color: "var(--rg-critical-deep)" }}>
            {errText(declare.error)}
          </p>
        )}
        <Button size="sm" variant="primary" disabled={!dirty || declare.isPending} onClick={save}>
          Save declaration
        </Button>
      </div>

      <div>
        <div className={s.subhead}>Controls for {label(v.effective)}</div>
        {v.floors.length === 0 ? (
          <p className={s.small} style={{ margin: "4px 0 0" }}>
            {floorSummary([])}
          </p>
        ) : (
          <>
            <p className={s.small} style={{ margin: "4px 0" }}>
              {floorSummary(v.floors)}
            </p>
            <ul className={s.list} aria-label="Autonomy controls" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {v.floors.map((f) => (
                <li key={f.id} className={s.listRow}>
                  <span className={s.listRowMain}>
                    <span className={s.listRowTitle}>
                      <Badge tone={f.met ? "ok" : "danger"}>{f.met ? "In place" : "Missing"}</Badge>
                      {f.label}
                    </span>
                    <span className={s.listRowSub}>{f.detail}</span>
                    {!f.met && <span className={s.listRowSub}>How to fix: {f.fix}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <p className={s.small} style={{ margin: 0 }}>
        {v.useCases.length
          ? `Counts toward: ${v.useCases.map((u) => u.name).join(", ")}. `
          : "No open use case counts this agent yet. "}
        {v.scope}
      </p>
    </div>
  );
}
