/**
 * ADR-0350 §5: the Device groups tab. A group's rules only narrow (ask or deny). Creating a group, adding a device and
 * adding a rule tighten policy (audited, no step-up). Deleting a group, removing a device and removing a rule loosen
 * it, so each is confirmed in a dialog that says what loosens, then asks the person to confirm it's them
 * (`settings_relax`), and is audited.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime, plural } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, EmptyState, ErrorState, Field, InfoButton, Input, Modal, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import {
  ENDPOINT_GROUP_RULE_KINDS,
  FILE_ACCESS,
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  KIND_LABEL,
  PACKAGE_ECOSYSTEMS,
  VERDICT_LABEL,
  VERDICT_TONE,
  devicePlatform,
  emptyRuleDraft,
  ruleBody,
  rulePattern,
  suggestedRuleId,
  type DeviceGroup,
  type GroupRule,
  type GroupRuleKind,
  type GroupRuleVerdict,
  type PolicyDevice,
  type RuleDraft,
} from "./endpointPolicyModel";
import { POLICY_KEY, refusalText, useDeviceGroups, usePolicyDevices } from "./endpointPolicyData";
import v from "../../views.module.css";
import e from "./endpointPolicy.module.css";

const STEP_UP_CHIP = "Asks you to confirm it's you";

/** a write, then the page's reads again; the refusal stays on screen in words */
function useWrite() {
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

/**
 * A change that LOOSENS a device's policy: the dialog says what loosens before anything is sent, and the send asks
 * the person to confirm it's them. Cancelling the step-up leaves everything as it was and says so.
 */
function RelaxButton(props: {
  label: string;
  /** the accessible name, when the visible label is shared by every row */
  name: string;
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  variant?: "default" | "danger";
  send: (headers: Record<string, string>) => Promise<unknown>;
  done: string;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const w = useWrite();
  return (
    <>
      <Button size="sm" variant={props.variant ?? "default"} aria-label={props.name} onClick={() => setOpen(true)}>
        {props.label}
      </Button>
      <Modal
        open={open}
        title={props.title}
        onClose={() => {
          setOpen(false);
          w.setError(null);
        }}
        actions={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              busy={w.busy}
              onClick={() =>
                void w.run(() => withStepUp(props.send), props.done).then((ok) => {
                  if (ok) {
                    setOpen(false);
                    props.onDone?.();
                  }
                })
              }
            >
              {props.confirmLabel}
            </Button>
          </>
        }
      >
        <div className={v.stack}>
          <div>{props.consequence}</div>
          <p className={e.warnNote}>This loosens policy, so you'll be asked to confirm it's you. The change is audited.</p>
          {w.error && (
            <p className={v.errLine} role="alert">
              {w.error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

function NewGroup(props: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const w = useWrite();
  const close = () => {
    setOpen(false);
    setName("");
    setDescription("");
    setProblem(null);
    w.setError(null);
  };
  const submit = () => {
    const n = name.trim();
    if (!n) return setProblem("Give the group a name.");
    if (n.length > GROUP_NAME_MAX) return setProblem(`A name is at most ${GROUP_NAME_MAX} characters.`);
    if (description.length > GROUP_DESCRIPTION_MAX) return setProblem(`A description is at most ${GROUP_DESCRIPTION_MAX} characters.`);
    setProblem(null);
    let created: string | null = null;
    void w
      .run(async () => {
        created = (await api.post<{ id: string }>("/v1/endpoint-device-groups", { name: n, ...(description.trim() ? { description: description.trim() } : {}) })).id;
      }, `Created the group ${n}`)
      .then((ok) => {
        if (ok && created) {
          props.onCreated(created);
          close();
        }
      });
  };
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        New group
      </Button>
      <Modal
        open={open}
        title="New device group"
        onClose={close}
        actions={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" busy={w.busy} onClick={submit}>
              Create group
            </Button>
          </>
        }
      >
        <div className={v.stack}>
          <Field label="Name" error={problem}>
            <Input value={name} maxLength={GROUP_NAME_MAX} onChange={(ev) => setName(ev.target.value)} />
          </Field>
          <Field label="Description (optional)">
            <Textarea rows={2} value={description} maxLength={GROUP_DESCRIPTION_MAX} onChange={(ev) => setDescription(ev.target.value)} />
          </Field>
          <p className={v.faint}>A new group has no devices and no rules, so it changes nothing until you add them. Creating it is audited.</p>
          {w.error && (
            <p className={v.errLine} role="alert">
              {w.error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

function AddRule(props: { group: DeviceGroup }) {
  const [d, setD] = useState<RuleDraft>(emptyRuleDraft);
  const [problem, setProblem] = useState<string | null>(null);
  const w = useWrite();
  const set = (patch: Partial<RuleDraft>) => setD((x) => ({ ...x, ...patch }));
  const submit = () => {
    const out = ruleBody(d);
    if ("problem" in out) return setProblem(out.problem);
    setProblem(null);
    void w.run(() => api.post(`/v1/endpoint-device-groups/${props.group.id}/rules`, out.body), `Added the rule to ${props.group.name}`).then((ok) => {
      if (ok) setD((x) => ({ ...emptyRuleDraft(), verdict: x.verdict, kind: x.kind }));
    });
  };
  return (
    <div className={v.stackTight}>
      <form
        className={e.addRow}
        aria-label={`Add a rule to ${props.group.name}`}
        onSubmit={(ev) => {
          ev.preventDefault();
          submit();
        }}
      >
        <Field label="Effect">
          <Select value={d.verdict} onChange={(ev) => set({ verdict: ev.target.value as GroupRuleVerdict })}>
            <option value="deny">Deny</option>
            <option value="ask">Ask first</option>
          </Select>
        </Field>
        <Field label="Kind">
          <Select value={d.kind} onChange={(ev) => set({ kind: ev.target.value as GroupRuleKind })}>
            {ENDPOINT_GROUP_RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        {d.kind === "exec" && (
          <Field label="Pattern" grow help="The command's words, separated by spaces; * is a wildcard. No pipes, quotes or redirections.">
            <Input value={d.command} placeholder="e.g. terraform apply *" onChange={(ev) => set({ command: ev.target.value })} />
          </Field>
        )}
        {d.kind === "file" && (
          <>
            <Field label="Access">
              <Select value={d.access} onChange={(ev) => set({ access: ev.target.value as RuleDraft["access"] })}>
                {FILE_ACCESS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pattern" grow help="An absolute path glob: start it with /, ~/, **/ or a drive letter such as C:/.">
              <Input value={d.path} placeholder="e.g. **/.env*" onChange={(ev) => set({ path: ev.target.value })} />
            </Field>
          </>
        )}
        {d.kind === "package" && (
          <>
            <Field label="Ecosystem">
              <Select value={d.ecosystem} onChange={(ev) => set({ ecosystem: ev.target.value as RuleDraft["ecosystem"] })}>
                {PACKAGE_ECOSYSTEMS.map((x) => (
                  <option key={x} value={x}>
                    {x === "*" ? "any" : x}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pattern" grow help="The package name, a glob: * matches any name.">
              <Input value={d.name} placeholder="e.g. *" onChange={(ev) => set({ name: ev.target.value })} />
            </Field>
          </>
        )}
        <Field label="Rule id" help="How the device policy and an exception name this rule. Left empty, the suggested id is used.">
          <Input value={d.ruleId} placeholder={suggestedRuleId(d)} onChange={(ev) => set({ ruleId: ev.target.value })} />
        </Field>
        <Button type="submit" variant="primary" busy={w.busy}>
          Add rule
        </Button>
      </form>
      {(problem ?? w.error) && (
        <p className={v.errLine} role="alert">
          {problem ?? w.error}
        </p>
      )}
      <p className={v.faint}>Adding a rule only tightens policy: no step-up, audited. Removing one asks you to confirm it's you.</p>
    </div>
  );
}

function RulesTable(props: { group: DeviceGroup }) {
  const g = props.group;
  return (
    <Table<GroupRule>
      rows={g.rules}
      rowKey={(r) => r.id}
      empty={<EmptyState title="No narrowing rule yet" body="This group changes nothing on its devices until you add a deny or ask-first rule below." />}
      columns={[
        { key: "effect", header: "Effect", render: (r) => <Badge tone={VERDICT_TONE[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Badge> },
        { key: "kind", header: "Kind", render: (r) => KIND_LABEL[r.kind] },
        { key: "pattern", header: "Pattern", render: (r) => <span className={v.mono}>{rulePattern(r)}</span> },
        { key: "ruleId", header: "Rule id", render: (r) => <span className={v.mono}>{r.ruleId}</span> },
        {
          key: "actions",
          header: "",
          srHeader: "Actions",
          align: "right",
          render: (r) => (
            <RelaxButton
              label="Remove"
              name={`Remove rule ${r.ruleId}`}
              title={`Remove the rule ${r.ruleId}?`}
              consequence={
                <>
                  {`The ${plural(g.deviceIds.length, "device")} in ${g.name} stop applying `}
                  <Badge tone={VERDICT_TONE[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Badge> <span className={v.mono}>{rulePattern(r)}</span> on their next policy.
                </>
              }
              confirmLabel="Remove rule"
              send={(h) => stepUpApi.del(`/v1/endpoint-device-groups/${g.id}/rules/${encodeURIComponent(r.ruleId)}`, undefined, h)}
              done={`Removed the rule ${r.ruleId}`}
            />
          ),
        },
      ]}
    />
  );
}

function DevicesCard(props: { group: DeviceGroup; groups: DeviceGroup[]; devices: PolicyDevice[] | undefined; devicesError: unknown; onRetry: () => void }) {
  const g = props.group;
  const byId = useMemo(() => new Map((props.devices ?? []).map((d) => [d.id, d])), [props.devices]);
  const addable = (props.devices ?? []).filter((d) => !d.revokedAt && !g.deviceIds.includes(d.id));
  const [pick, setPick] = useState("");
  const w = useWrite();
  useEffect(() => setPick(""), [g.id]);
  const rows = g.deviceIds.map((id) => ({ id, device: byId.get(id) ?? null }));
  const others = (id: string) => props.groups.filter((x) => x.id !== g.id && x.deviceIds.includes(id)).map((x) => x.name);
  const add = () => {
    if (!pick) return w.setError("Choose an enrolled device to add.");
    void w.run(() => api.post(`/v1/endpoint-device-groups/${g.id}/members`, { deviceId: pick }), `Added the device to ${g.name}`).then((ok) => ok && setPick(""));
  };
  return (
    <Card
      title={<h3 className={v.sectionTitle}>{`Devices in this group (${g.deviceIds.length})`}</h3>}
      actions={
        <div className={e.cellActions}>
          <Field label="Add an enrolled device">
            <Select value={pick} onChange={(ev) => setPick(ev.target.value)} disabled={!props.devices}>
              <option value="">{props.devices ? (addable.length ? "Choose a device" : "No other enrolled device") : "Loading devices…"}</option>
              {addable.map((d) => (
                <option key={d.id} value={d.id}>
                  {`${d.devicePseudonym} · ${d.os}/${d.arch}`}
                </option>
              ))}
            </Select>
          </Field>
          <Button busy={w.busy} onClick={add} aria-disabled={!pick || undefined}>
            Add
          </Button>
        </div>
      }
    >
      <div className={v.stackTight}>
        {w.error && (
          <p className={v.errLine} role="alert">
            {w.error}
          </p>
        )}
        {props.devicesError != null && (
          <ErrorState title="Couldn't load the enrolled devices" message="The device list could not be read, so devices show by id only." onRetry={props.onRetry} />
        )}
        <Table
          rows={rows}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No device in this group" body="Add an enrolled device above. Its rules apply on the device's next policy." />}
          columns={[
            { key: "device", header: "Device", render: (r) => <span className={v.mono}>{r.device?.devicePseudonym ?? `${r.id.slice(0, 8)}…`}</span> },
            {
              key: "platform",
              header: "Platform",
              render: (r) => (r.device ? `${devicePlatform(r.device)}${r.device.revokedAt ? " (revoked)" : ""}` : <span className={v.faint}>not in the device list</span>),
            },
            { key: "others", header: "Other groups", render: (r) => others(r.id).join(", ") || "—" },
            { key: "last", header: "Last report", render: (r) => fmtDateTime(r.device?.lastReportAt ?? null, "never") },
            {
              key: "actions",
              header: "",
              srHeader: "Actions",
              align: "right",
              render: (r) => {
                const label = r.device?.devicePseudonym ?? r.id;
                return (
                  <RelaxButton
                    label="Remove"
                    name={`Remove ${label} from ${g.name}`}
                    title={`Remove ${label} from ${g.name}?`}
                    consequence={`The device stops applying this group's ${plural(g.rules.length, "rule")} on its next policy.`}
                    confirmLabel="Remove device"
                    send={(h) => stepUpApi.del(`/v1/endpoint-device-groups/${g.id}/members/${r.id}`, undefined, h)}
                    done={`Removed the device from ${g.name}`}
                  />
                );
              },
            },
          ]}
        />
        <p className={v.faint}>Removing a device from a group loosens its policy, so it asks you to confirm it's you.</p>
      </div>
    </Card>
  );
}

export default function DeviceGroupsTab() {
  const groups = useDeviceGroups();
  const devices = usePolicyDevices();
  const list = groups.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const group = list.find((g) => g.id === selected) ?? list[0] ?? null;

  if (groups.isLoading) return <Card><SkeletonBlock lines={6} /></Card>;
  if (groups.isError)
    return (
      <Card>
        <ErrorState title="Couldn't load the device groups" message={refusalText(groups.error)} onRetry={() => void groups.refetch()} />
      </Card>
    );

  return (
    <div className={e.split}>
      <div className={e.side}>
        <Card title={<h2 className={v.sectionTitle}>Groups</h2>} actions={<NewGroup onCreated={setSelected} />}>
          <div className={v.stack}>
            {list.length === 0 ? (
              <EmptyState title="No device group yet" body="Every enrolled device follows the organisation's rules. Create a group to add stricter rules for some devices." />
            ) : (
              <ul className={e.groupList}>
                {list.map((g) => (
                  <li key={g.id}>
                    <button type="button" className={e.group} aria-pressed={g.id === group?.id} onClick={() => setSelected(g.id)}>
                      <b>{g.name}</b>
                      <span className={e.groupMeta}>{`${plural(g.deviceIds.length, "device")} · ${plural(g.rules.length, "rule")}`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className={v.faint}>A device in several groups gets every group's rules. The strictest wins.</p>
          </div>
        </Card>
      </div>
      {group && (
        <div className={e.main}>
          <Card
            title={<h2 className={v.sectionTitle}>{group.name}</h2>}
            actions={
              <div className={e.cellActions}>
                <span className={e.stepChip}>{STEP_UP_CHIP}</span>
                <RelaxButton
                  label="Delete group"
                  name={`Delete group ${group.name}`}
                  variant="danger"
                  title={`Delete the group ${group.name}?`}
                  consequence={`Its ${plural(group.rules.length, "rule")} stop applying on its ${plural(group.deviceIds.length, "device")}, and its memberships are deleted with it.`}
                  confirmLabel="Delete group"
                  send={(h) => stepUpApi.del(`/v1/endpoint-device-groups/${group.id}`, undefined, h)}
                  done={`Deleted the group ${group.name}`}
                  onDone={() => setSelected(null)}
                />
              </div>
            }
          >
            <div className={v.stack}>
              {group.description && <p className={v.dim}>{group.description}</p>}
              <p className={v.faint}>{`Deleting a group loosens policy on its ${plural(group.deviceIds.length, "device")}, so it asks you to confirm it's you and is audited.`}</p>
              <h3 className={v.sectionTitle}>
                Narrowing rules{" "}
                <InfoButton label="narrowing rules">
                  A group rule can only make a device stricter: “Deny” refuses the command, file access or package, and “Ask
                  first” makes the agent ask the person at the device. There is no “Allow” here; to loosen one rule on one
                  device for a while, request a command exception.
                </InfoButton>
              </h3>
              <RulesTable group={group} />
              <AddRule key={group.id} group={group} />
            </div>
          </Card>
          <DevicesCard group={group} groups={list} devices={devices.data} devicesError={devices.error} onRetry={() => void devices.refetch()} />
        </div>
      )}
    </div>
  );
}
