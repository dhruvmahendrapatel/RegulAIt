/**
 * ADR-0350 §5: the Command exceptions tab. An exception loosens ONE rule on ONE device for at most 168 hours:
 *  - an admin requests it and names ANOTHER active admin as approver (the API and the database refuse self-approval;
 *    here the approve button is never live for the requester, and says why);
 *  - only that approver approves, with a step-up bound to the exact terms digest shown in the review panel
 *    (`approval_decide`), plus a settings relaxation when it lasts longer than 24 hours;
 *  - any other admin may reject; only the requester may cancel; any admin may revoke an active one.
 * The state and the allowed transitions come from the API's lifecycle table on each row, so a button is live exactly
 * when the server would accept it; a refusal (a concurrent decision, changed terms) is shown in words and the list
 * reloads.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorState, Field, InfoButton, Input, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { ReasonModal } from "../adminKit";
import {
  DURATION_CHOICES,
  ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS,
  ENDPOINT_RULE_ID,
  REASON_MAX,
  STATE_TONE,
  VERDICT_LABEL,
  VERDICT_TONE,
  approveBlock,
  approveStepUps,
  cancelBlock,
  devicePlatform,
  hoursText,
  rejectBlock,
  revokeBlock,
  rulePattern,
  stateLabel,
  type CommandException,
  type ExceptionVerdict,
  type GroupRule,
  type MachineJson,
  type PolicyDevice,
} from "./endpointPolicyModel";
import { POLICY_KEY, refusalText, useCommandExceptions, useDeviceGroups, usePeople, usePolicyDevices } from "./endpointPolicyData";
import v from "../../views.module.css";
import e from "./endpointPolicy.module.css";

type Known = { rule: GroupRule; group: string };
type Name = (id: string | null | undefined) => string;

function useDecide() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(ok, "success");
      return true;
    } catch (err) {
      setError(refusalText(err));
      return false;
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: POLICY_KEY });
    }
  };
  return { busy, error, setError, run };
}

/** an action the viewer cannot take: still focusable, with the reason one click away */
function Blocked(props: { label: string; reason: string; variant?: "default" | "primary" | "danger" }) {
  return (
    <span className={e.cellActions}>
      <Button size="sm" variant={props.variant ?? "default"} aria-disabled onClick={(ev) => ev.preventDefault()} aria-label={`${props.label}, unavailable`}>
        {props.label}
      </Button>
      <InfoButton label={`the reason you can't ${props.label.toLowerCase()}`} align="end">
        {props.reason}
      </InfoButton>
    </span>
  );
}

function RuleCell(props: { ruleId: string; known: Known | undefined }) {
  const k = props.known;
  return (
    <span>
      {k && (
        <>
          <Badge tone={VERDICT_TONE[k.rule.verdict]}>{VERDICT_LABEL[k.rule.verdict]}</Badge>{" "}
          <span className={v.mono}>{rulePattern(k.rule)}</span>
          <br />
        </>
      )}
      <span className={k ? v.faint : v.mono}>{k ? `${props.ruleId} · ${k.group}` : props.ruleId}</span>
    </span>
  );
}

function Lifecycle(props: { machine: MachineJson | undefined }) {
  const t = props.machine?.transitions;
  return (
    <InfoButton label="the exception lifecycle" term="The exception lifecycle">
      {t ? (
        <>
          {Object.entries(t).map(([event, d]) => (
            <span key={event} style={{ display: "block" }}>
              <b>{`${event}: ${d.from.join(", ")} → ${d.to}.`}</b> {d.summary}
            </span>
          ))}
          <span style={{ display: "block" }}>An approved exception reads as expired once its time is up; nothing has to run for that.</span>
        </>
      ) : (
        "Requested, then approved, rejected or cancelled. An approved exception is active until it expires, or until an admin revokes it."
      )}
    </InfoButton>
  );
}

function Review(props: {
  x: CommandException;
  me: string | null;
  name: Name;
  known: Known | undefined;
  device: PolicyDevice | undefined;
  onClose: () => void;
  onReject: () => void;
}) {
  const { x, me, name } = props;
  const [decisionReason, setDecisionReason] = useState("");
  const d = useDecide();
  const block = approveBlock(x, me, name(x.approverUserId));
  const reject = rejectBlock(x, me);
  const twice = approveStepUps(x) > 1;
  const approve = () =>
    void d
      .run(
        () =>
          withStepUp((h) =>
            stepUpApi.post(`/v1/endpoint-command-exceptions/${x.id}/approve`, { termsDigest: x.termsDigest, ...(decisionReason.trim() ? { decisionReason: decisionReason.trim() } : {}) }, h),
          ),
        `Approved for ${hoursText(x.hours)}`,
      )
      .then((ok) => ok && props.onClose());
  const terms: Array<[string, ReactNode]> = [
    ["Rule loosened", <RuleCell key="r" ruleId={x.ruleId} known={props.known} />],
    ["Loosened to", <Badge key="v" tone={VERDICT_TONE[x.verdict]}>{VERDICT_LABEL[x.verdict]}</Badge>],
    ["Device", <span key="d" className={v.mono}>{props.device ? `${props.device.devicePseudonym} (${devicePlatform(props.device)})` : x.deviceId}</span>],
    ["Duration", `${hoursText(x.hours)} from approval`],
    ["Reason", x.reason],
    ["Requested by", `${name(x.requestedBy)}, ${fmtDateTime(x.createdAt, "")}`],
    ["Approver", name(x.approverUserId)],
    ["Terms digest", <span key="t" className={v.mono} data-testid="terms-digest">{x.termsDigest}</span>],
  ];
  return (
    <Card className={`${e.pane} ${e.review}`} title={<h2 className={v.sectionTitle}>{`Review ${x.requestedBy === me ? "your" : `${name(x.requestedBy)}'s`} request`}</h2>}>
      <div className={v.stack} role="region" aria-label="Review the request">
        <dl className={e.terms}>
          {terms.map(([k, val]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{val}</dd>
            </div>
          ))}
        </dl>
        <p className={v.faint}>You approve exactly these terms. If the request changes, the digest changes and this approval no longer applies.</p>
        {twice && (
          <p className={e.warnNote}>
            {`Longer than ${ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS} hours: approving also asks you to confirm a settings relaxation, so you'll confirm it's you twice.`}
          </p>
        )}
        {!block && (
          <Field label="Decision note (optional, audited)">
            <Input value={decisionReason} maxLength={REASON_MAX} onChange={(ev) => setDecisionReason(ev.target.value)} />
          </Field>
        )}
        {block && (
          <p className={v.hint} role="note" data-testid="approve-blocked">
            {block}
          </p>
        )}
        {d.error && (
          <p className={v.errLine} role="alert">
            {d.error}
          </p>
        )}
        <div className={e.actions}>
          {!block && <span className={e.stepChip}>{twice ? "Asks you to confirm it's you, twice" : "Asks you to confirm it's you"}</span>}
          <Button onClick={props.onClose}>Close</Button>
          {reject ? <Blocked label="Reject" reason={reject} /> : <Button onClick={props.onReject}>Reject</Button>}
          {block ? (
            <Blocked label={`Approve for ${hoursText(x.hours)}`} reason={block} variant="primary" />
          ) : (
            <Button variant="primary" busy={d.busy} onClick={approve}>
              {`Approve for ${hoursText(x.hours)}`}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function RequestForm(props: { me: string | null; devices: PolicyDevice[] | undefined; rules: Known[]; onClose: () => void }) {
  const people = usePeople(props.me);
  const [deviceId, setDeviceId] = useState("");
  const [ruleChoice, setRuleChoice] = useState("");
  const [otherRule, setOtherRule] = useState("");
  const [verdict, setVerdict] = useState<ExceptionVerdict>("ask");
  const [hours, setHours] = useState<number>(2);
  const [approver, setApprover] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const d = useDecide();
  const devices = (props.devices ?? []).filter((x) => !x.revokedAt);
  const ruleIds = [...new Map(props.rules.map((k) => [k.rule.ruleId, k])).values()];
  const ruleId = ruleChoice === "__other" ? otherRule.trim() : ruleChoice;
  const noApprover = !people.loading && people.approvers.length === 0;
  const submit = () => {
    if (!props.me) return setProblem("An exception is requested by a signed-in person, not by a token.");
    if (!deviceId) return setProblem("Choose the device.");
    if (!ENDPOINT_RULE_ID.test(ruleId)) return setProblem("Choose the rule to loosen, or type a valid rule id (lower case, a-z 0-9 . _ -, up to 64 characters).");
    if (!approver) return setProblem("Name another admin as approver.");
    if (!reason.trim()) return setProblem("Give a reason: the approver reads it, and it is part of the terms they approve.");
    setProblem(null);
    void d
      .run(() => api.post("/v1/endpoint-command-exceptions", { deviceId, ruleId, verdict, hours, reason: reason.trim(), approverUserId: approver }), `Requested; ${people.name(approver)} can now approve it`)
      .then((ok) => ok && props.onClose());
  };
  return (
    <Card className={e.pane} title={<h2 className={v.sectionTitle}>Request an exception</h2>}>
      <form
        className={v.stack}
        aria-label="Request an exception"
        onSubmit={(ev) => {
          ev.preventDefault();
          submit();
        }}
      >
        <Field label="Device">
          <Select value={deviceId} onChange={(ev) => setDeviceId(ev.target.value)}>
            <option value="">{props.devices ? (devices.length ? "Choose a device" : "No enrolled device") : "Loading devices…"}</option>
            {devices.map((x) => (
              <option key={x.id} value={x.id}>
                {`${x.devicePseudonym} · ${x.os}/${x.arch}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Rule to loosen">
          <Select value={ruleChoice} onChange={(ev) => setRuleChoice(ev.target.value)}>
            <option value="">Choose a rule</option>
            {ruleIds.map((k) => (
              <option key={k.rule.ruleId} value={k.rule.ruleId}>
                {`${VERDICT_LABEL[k.rule.verdict]} · ${rulePattern(k.rule)} (${k.group})`}
              </option>
            ))}
            <option value="__other">Another rule, by its id</option>
          </Select>
        </Field>
        {ruleChoice === "__other" && (
          <Field label="Rule id" help="The id the device policy gives the rule, for a rule that is not in a device group.">
            <Input value={otherRule} onChange={(ev) => setOtherRule(ev.target.value)} />
          </Field>
        )}
        <div className={v.row}>
          <Field label="Loosen to">
            <Select value={verdict} onChange={(ev) => setVerdict(ev.target.value as ExceptionVerdict)}>
              <option value="ask">Ask first</option>
              <option value="allow">Allow</option>
            </Select>
          </Field>
          <Field label="For">
            <Select value={String(hours)} onChange={(ev) => setHours(Number(ev.target.value))}>
              {DURATION_CHOICES.map((h) => (
                <option key={h} value={h}>
                  {hoursText(h)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Approver (another admin)">
            <Select value={approver} onChange={(ev) => setApprover(ev.target.value)} disabled={noApprover}>
              <option value="">{people.loading ? "Loading admins…" : noApprover ? "No other active admin" : "Choose an admin"}</option>
              {people.approvers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName || u.email}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {noApprover && (
          <p className={v.errLine} role="alert">
            There is no other active admin to approve it. An exception always needs a second admin; you can't approve your own.
          </p>
        )}
        {!people.complete && <p className={v.faint}>Not every account could be loaded; an admin missing from the list was not loaded, not refused.</p>}
        <Field label="Reason">
          <Textarea rows={2} value={reason} maxLength={REASON_MAX} onChange={(ev) => setReason(ev.target.value)} />
        </Field>
        {hours > ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS && (
          <p className={e.warnNote}>{`Longer than ${ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS} hours: the approver is also asked to confirm a settings relaxation.`}</p>
        )}
        {(problem ?? d.error) && (
          <p className={v.errLine} role="alert">
            {problem ?? d.error}
          </p>
        )}
        <div className={e.actions}>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={d.busy} aria-disabled={noApprover || undefined}>
            Send request
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function CommandExceptionsTab(props: { me: string | null }) {
  const me = props.me;
  const exceptions = useCommandExceptions();
  const groups = useDeviceGroups();
  const devices = usePolicyDevices();
  const people = usePeople(me);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [rejecting, setRejecting] = useState<CommandException | null>(null);
  const [revoking, setRevoking] = useState<CommandException | null>(null);
  const [cancelling, setCancelling] = useState<CommandException | null>(null);
  const d = useDecide();

  const items = exceptions.data?.pages.flatMap((p) => p.items) ?? [];
  const machine = exceptions.data?.pages[0]?.machine;
  const known = useMemo(() => {
    const m = new Map<string, Known>();
    for (const g of groups.data ?? []) for (const r of g.rules) if (!m.has(r.ruleId)) m.set(r.ruleId, { rule: r, group: g.name });
    return m;
  }, [groups.data]);
  const deviceById = useMemo(() => new Map((devices.data ?? []).map((x) => [x.id, x])), [devices.data]);
  const current = items.find((x) => x.id === reviewing) ?? null;
  const requested = items.filter((x) => x.state === "requested").length;
  const active = items.filter((x) => x.state === "approved").length;

  const actions = (x: CommandException) => {
    if (x.state === "requested") {
      if (x.requestedBy === me) {
        const c = cancelBlock(x, me);
        return (
          <span className={e.cellActions}>
            {c ? <Blocked label="Cancel" reason={c} /> : <Button size="sm" onClick={() => setCancelling(x)} aria-label={`Cancel the request for ${x.ruleId}`}>Cancel</Button>}
            <Blocked label="Approve" reason={approveBlock(x, me, people.name(x.approverUserId)) ?? ""} variant="primary" />
          </span>
        );
      }
      const r = rejectBlock(x, me);
      return (
        <span className={e.cellActions}>
          {r ? <Blocked label="Reject" reason={r} /> : <Button size="sm" onClick={() => setRejecting(x)} aria-label={`Reject the request for ${x.ruleId}`}>Reject</Button>}
          <Button size="sm" variant="primary" onClick={() => setReviewing(x.id)} aria-label={`Review the request for ${x.ruleId}`}>
            Review…
          </Button>
        </span>
      );
    }
    if (x.state === "approved") {
      const r = revokeBlock(x);
      return r ? <Blocked label="Revoke" reason={r} variant="danger" /> : (
        <Button size="sm" variant="danger" onClick={() => setRevoking(x)} aria-label={`Revoke the exception for ${x.ruleId}`}>
          Revoke
        </Button>
      );
    }
    return null;
  };

  return (
    <div className={v.stack}>
      <p className={`${v.dim} ${e.intro}`}>
        An exception loosens one rule on one device for a limited time. Another admin must approve it; you can't approve your own. It
        ends by itself at its expiry, or earlier if someone revokes it. <Lifecycle machine={machine} />
      </p>
      <Card
        title={
          <h2 className={v.sectionTitle}>
            Exceptions{" "}
            {exceptions.data && (
              <span className={v.faint} style={{ fontWeight: 400 }}>{`${items.length}${exceptions.hasNextPage ? "+" : ""} · ${requested} requested · ${active} active`}</span>
            )}
          </h2>
        }
        actions={
          <Button variant="primary" size="sm" onClick={() => setRequesting(true)} aria-expanded={requesting}>
            Request an exception
          </Button>
        }
      >
        <div className={v.stackTight}>
          {d.error && (
            <p className={v.errLine} role="alert">
              {d.error}
            </p>
          )}
          {exceptions.isLoading ? (
            <SkeletonBlock lines={5} />
          ) : exceptions.isError ? (
            <ErrorState title="Couldn't load the exceptions" message={refusalText(exceptions.error)} onRetry={() => void exceptions.refetch()} />
          ) : (
            <Table<CommandException>
              rows={items}
              rowKey={(x) => x.id}
              empty={<EmptyState title="No exception yet" body="Every device follows its rules as written. Request an exception to loosen one rule on one device for a while." />}
              columns={[
                { key: "rule", header: "Rule", render: (x) => <RuleCell ruleId={x.ruleId} known={known.get(x.ruleId)} /> },
                { key: "device", header: "Device", render: (x) => <span className={v.mono}>{deviceById.get(x.deviceId)?.devicePseudonym ?? `${x.deviceId.slice(0, 8)}…`}</span> },
                { key: "to", header: "Loosened to", render: (x) => <Badge tone={VERDICT_TONE[x.verdict]}>{VERDICT_LABEL[x.verdict]}</Badge> },
                { key: "for", header: "For", render: (x) => (x.state === "approved" && x.notAfter ? `until ${fmtDateTime(x.notAfter, "")}` : hoursText(x.hours)) },
                { key: "by", header: "Requested by", render: (x) => people.name(x.requestedBy) },
                { key: "approver", header: "Approver", render: (x) => (x.approverUserId === me ? <b>You</b> : people.name(x.approverUserId)) },
                { key: "state", header: "State", render: (x) => <Badge tone={STATE_TONE[x.state] ?? "neutral"}>{stateLabel(x, me)}</Badge> },
                { key: "actions", header: "", srHeader: "Actions", align: "right", render: actions },
              ]}
            />
          )}
          {exceptions.hasNextPage && (
            <div>
              <Button size="sm" busy={exceptions.isFetchingNextPage} onClick={() => void exceptions.fetchNextPage()}>
                Show older exceptions
              </Button>
            </div>
          )}
        </div>
      </Card>
      {(current || requesting) && (
        <div className={e.split}>
          {current && (
            <Review
              key={current.id}
              x={current}
              me={me}
              name={people.name}
              known={known.get(current.ruleId)}
              device={deviceById.get(current.deviceId)}
              onClose={() => setReviewing(null)}
              onReject={() => setRejecting(current)}
            />
          )}
          {requesting && <RequestForm me={me} devices={devices.data} rules={[...known.values()]} onClose={() => setRequesting(false)} />}
        </div>
      )}
      <ReasonModal
        open={rejecting !== null}
        title="Reject this request?"
        body={<p>The requester is told it was refused. The reason is audited.</p>}
        confirmLabel="Reject"
        danger
        onCancel={() => setRejecting(null)}
        onConfirm={(reason) => {
          const x = rejecting!;
          setRejecting(null);
          void d.run(() => api.post(`/v1/endpoint-command-exceptions/${x.id}/reject`, { reason }), "Rejected the request").then((ok) => ok && reviewing === x.id && setReviewing(null));
        }}
      />
      <ReasonModal
        open={revoking !== null}
        title="Revoke this exception?"
        body={<p>The device stops applying it on its next policy, before its expiry. Revoking tightens policy, so no step-up is needed. The reason is audited.</p>}
        confirmLabel="Revoke"
        danger
        onCancel={() => setRevoking(null)}
        onConfirm={(reason) => {
          const x = revoking!;
          setRevoking(null);
          void d.run(() => api.post(`/v1/endpoint-command-exceptions/${x.id}/revoke`, { reason }), "Revoked the exception");
        }}
      />
      <ConfirmModal
        open={cancelling !== null}
        title="Cancel your request?"
        body="The approver can no longer approve it. Cancelling is audited."
        confirmLabel="Cancel request"
        onCancel={() => setCancelling(null)}
        onConfirm={() => {
          const x = cancelling!;
          setCancelling(null);
          void d.run(() => api.post(`/v1/endpoint-command-exceptions/${x.id}/cancel`, {}), "Cancelled your request");
        }}
      />
    </div>
  );
}
