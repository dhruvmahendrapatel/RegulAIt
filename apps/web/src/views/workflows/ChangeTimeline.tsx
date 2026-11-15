/**
 * The governed change, end to end: the seven-step chain (work item → plan →
 * sign-off → agent build → pull request → checks → merge approval) and the
 * recorded history of the workflow instance, on its detail page.
 *
 * Reads only what is already served: the detail response's `events`, and the
 * PM links query PmLinksCard also makes (same cache key, so one request).
 * The model is governedChange.ts.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { fmtAt } from "../../api/format";
import type { PmLink, WorkflowDetailResponse } from "../../api/types";
import { Badge, Card, EmptyState, type Tone } from "../../ui/kit";
import {
  buildChain,
  CHAIN_STATE_WORDS,
  type ChainState,
  eventSentence,
  eventTone,
  sortEvents,
  type WorkflowEventRow,
} from "./governedChange";
import v from "../views.module.css";
import s from "./governedChange.module.css";

const STATE_TONE: Record<ChainState, Tone> = {
  done: "ok",
  current: "primary",
  attention: "danger",
  to_do: "neutral",
  not_in_template: "neutral",
};

export function ChangeTimeline(props: { detail: WorkflowDetailResponse & { events?: WorkflowEventRow[] } }) {
  const { detail } = props;
  const instanceId = detail.instance.id;
  // the same key PmLinksCard uses for its non-live read, so the two share one request
  const links = useQuery({
    queryKey: ["pm-links", "workflow_instance", instanceId, false],
    queryFn: () => api.get<{ links: PmLink[] }>(`/v1/pm/links?instanceId=${instanceId}`),
    retry: false,
  });
  // a failed links read is not "no work item": the chain says it could not tell
  const chain = buildChain(detail, {
    count: links.data?.links?.length ?? 0,
    loaded: links.isSuccess,
  }).map((step) =>
    step.id === "work_item" && links.isError ? { ...step, detail: "Could not read the linked work items" } : step,
  );
  const events = sortEvents(detail.events ?? []);

  return (
    <>
      <Card
        title="Governed change"
        info="Each step comes from this change's template. A step the template does not have is shown as such, never as done."
      >
        <ol className={s.chain} aria-label="Governed change steps">
          {chain.map((step, i) => (
            <li key={step.id} className={s[step.state]} aria-current={step.state === "current" ? "step" : undefined}>
              <span className={s.index} aria-hidden="true">
                {i + 1}
              </span>
              <span className={s.label}>{step.label}</span>
              <span className={s.badge}>
                <Badge tone={STATE_TONE[step.state]}>{CHAIN_STATE_WORDS[step.state]}</Badge>
              </span>
              <span className={s.detail}>{step.detail}</span>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="History" contain count={events.length} countNoun={["event", "events"]}>
        {events.length === 0 ? (
          <EmptyState title="No events recorded yet" body="Events appear here as the change moves through its stages." />
        ) : (
          <ol className={s.history}>
            {events.map((e) => (
              <li key={e.id} className={s.event}>
                <time className={v.mono} dateTime={e.at}>
                  {fmtAt(e.at)}
                </time>
                <span className={s[`tone_${eventTone(e.event.kind)}`]}>{eventSentence(e.event)}</span>
                <span className={v.faint}>{e.actorUserId ? "by a person" : "by the system"}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
