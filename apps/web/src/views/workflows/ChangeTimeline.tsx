/**
 * The governed change, end to end: the seven-step chain (work item → plan →
 * sign-off → agent build → pull request → checks → merge approval) and the
 * recorded history of the workflow instance, on its detail page.
 *
 * Reads only what is already served: the detail response's `events`, and the
 * PM links through PmLinksCard's own hook (usePmLinks), so the page makes one
 * links request. The model is governedChange.ts; the stage boxes are the
 * Pipeline rail's (workflows.module.css), so the two read alike.
 */
import { ApiError } from "../../api/client";
import { actorLabel, fmtAt } from "../../api/format";
import type { WorkflowDetailResponse } from "../../api/types";
import { Badge, Button, Card, EmptyState, type Tone } from "../../ui/kit";
import { usePmLinks } from "../pm/PmAndDecisions";
import { buildChain, CHAIN_STATE_WORDS, type ChainState, eventSentence, type PmLinksRead, type WorkflowEventRow } from "./governedChange";
import v from "../views.module.css";
import s from "./workflows.module.css";
import g from "./governedChange.module.css";

/** the detail endpoint carries no names, and the users list is admin-only: actors show as a short id */
const NO_NAMES = new Map<string, string>();

/** each state's badge tone and the Pipeline rail's box, so the chain and the rail look the same */
const LOOK: Record<ChainState, [Tone, string | undefined]> = {
  done: ["ok", s.stageDone],
  current: ["primary", s.stageActive],
  attention: ["danger", s.stageFailed],
  to_do: ["neutral", s.stage],
  unknown: ["neutral", s.stage],
  not_in_template: ["neutral", g.absent],
};

export function ChangeTimeline(props: { detail: WorkflowDetailResponse & { events?: WorkflowEventRow[] } }) {
  const { detail } = props;
  const links = usePmLinks({ objectType: "workflow_instance", objectId: detail.instance.id });
  // the links route answers 404 to a reader it does not admit (a past approver): not visible, not an error
  const pm: PmLinksRead = links.isPending
    ? { state: "loading" }
    : links.isError
      ? links.error instanceof ApiError && links.error.status === 404
        ? { state: "hidden" }
        : { state: "error" }
      : { state: "ok", links: links.data?.links ?? [] };
  const chain = buildChain(detail, pm);
  // the server returns the events oldest first (workflows.ts); kept as sent
  const events = detail.events ?? [];

  return (
    <>
      <Card title="Governed change">
        <ol className={g.chain} aria-label="Governed change steps">
          {chain.map((step) => (
            <li key={step.id} className={LOOK[step.state][1]} aria-current={step.state === "current" ? "step" : undefined}>
              <strong>{step.label}</strong>
              <span>
                <Badge tone={LOOK[step.state][0]}>{CHAIN_STATE_WORDS[step.state]}</Badge>
              </span>
              <span>{step.detail}</span>
              {step.id === "work_item" && pm.state === "error" && (
                <Button variant="ghost" size="sm" onClick={() => void links.refetch()}>
                  Retry
                </Button>
              )}
            </li>
          ))}
        </ol>
      </Card>

      <Card title="History" contain count={events.length} countNoun={["event", "events"]}>
        {events.length === 0 ? (
          <EmptyState title="No events recorded yet" body="Events appear here as the change moves through its stages." />
        ) : (
          <ol className={v.stackTight}>
            {events.map((e) => (
              <li key={e.id} className={v.row}>
                <time className={v.mono} dateTime={e.at}>
                  {fmtAt(e.at)}
                </time>
                <span>{eventSentence(e.event)}</span>
                <span className={v.faint}>{actorLabel(e.actorUserId, NO_NAMES)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
