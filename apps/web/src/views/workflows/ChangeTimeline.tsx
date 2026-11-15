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
import { useSession } from "../../session/SessionContext";
import { Badge, Button, Card, EmptyState, type Tone } from "../../ui/kit";
import { usePmLinks } from "../pm/PmAndDecisions";
import { buildChain, CHAIN_STATE_WORDS, type ChainState, eventSentence, type PmLinksRead, type WorkflowEventRow } from "./governedChange";
import v from "../views.module.css";
import s from "./workflows.module.css";
import g from "./governedChange.module.css";

const STATE_TONE: Record<ChainState, Tone> = {
  done: "ok",
  current: "primary",
  attention: "danger",
  to_do: "neutral",
  unknown: "neutral",
  not_in_template: "neutral",
};

/** the Pipeline rail's box for each state, so the chain and the rail look the same */
const STATE_BOX: Record<ChainState, string | undefined> = {
  done: s.stageDone,
  current: s.stageActive,
  attention: s.stageFailed,
  to_do: s.stage,
  unknown: s.stage,
  not_in_template: g.absent,
};

export function ChangeTimeline(props: { detail: WorkflowDetailResponse & { events?: WorkflowEventRow[] } }) {
  const { detail } = props;
  const { me } = useSession();
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
  const names = new Map(me?.user ? [[me.user.id, me.user.displayName || me.user.email]] : []);

  return (
    <>
      <Card title="Governed change">
        <ol className={g.chain} aria-label="Governed change steps">
          {chain.map((step) => (
            <li key={step.id} className={STATE_BOX[step.state]} aria-current={step.state === "current" ? "step" : undefined}>
              <strong>{step.label}</strong>
              <span>
                <Badge tone={STATE_TONE[step.state]}>{CHAIN_STATE_WORDS[step.state]}</Badge>
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
                <span className={v.faint}>{actorLabel(e.actorUserId, names)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
