/**
 * ADR-0350 §5 (lane E31, owner-approved on #453): Endpoint policy, under Discovery.
 *
 * Two tabs over thirteen admin routes:
 *  - Device groups: groups whose ask/deny rules only NARROW what AI coding agents may run on their devices. Adding a
 *    group, a device or a rule tightens policy (audited, no step-up); deleting a group, removing a device or removing
 *    a rule loosens it, so each asks the person to confirm it's them (`settings_relax`).
 *  - Command exceptions: a time-limited relaxation of one rule on one device, requested by one admin and approved by
 *    another, named one. The approver approves the exact terms digest (`approval_decide`), plus a settings relaxation
 *    when it lasts longer than 24 hours. The requester can never approve their own request: the button says why.
 *
 * Lazy, in the Discovery screens' chunk (screens/admin-ai-governance.ts), so the entry bundle carries none of it.
 */
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, TabPanel, Tabs } from "../../../ui/kit";
import { awaitingMe } from "./endpointPolicyModel";
import { useCommandExceptions, useDeviceGroups, useMyId } from "./endpointPolicyData";
import DeviceGroupsTab from "./DeviceGroupsTab";
import CommandExceptionsTab from "./CommandExceptionsTab";
import e from "./endpointPolicy.module.css";

const TABS = ["groups", "exceptions"] as const;
type Tab = (typeof TABS)[number];

export default function EndpointPolicyPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(asked ?? "") ? (asked as Tab) : "groups";
  const me = useMyId();
  const groups = useDeviceGroups();
  const exceptions = useCommandExceptions();
  const items = exceptions.data?.pages.flatMap((p) => p.items) ?? [];
  const toApprove = awaitingMe(items, me);
  const choose = (id: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("tab", id);
        return n;
      },
      { replace: true },
    );
  return (
    <>
      <PageHeader
        title="Endpoint policy"
        sub="What AI coding agents may run on enrolled devices. A device group can only narrow the organisation's rules: it adds “ask first” or “deny”, never “allow”. To loosen one rule on one device, request a time-limited exception."
        info={
          <>
            The on-device agent applies the organisation's command, file and package rules, then every rule of every group
            the device is in; the strictest verdict wins. Loosening anything, by deleting a group, removing a device or a
            rule, or approving an exception, asks you to confirm it's you, and every change is in the audit log.
          </>
        }
      />
      <Tabs
        label="Endpoint policy"
        idPrefix="endpoint-policy"
        active={tab}
        onChange={choose}
        tabs={[
          { id: "groups", label: groups.data ? `Device groups (${groups.data.length})` : "Device groups" },
          {
            id: "exceptions",
            label: (
              <>
                Command exceptions
                {toApprove > 0 && (
                  <span className={e.tabCount}>
                    <Badge tone="warn">{`${toApprove} to approve`}</Badge>
                  </span>
                )}
              </>
            ),
          },
        ]}
      />
      <TabPanel idPrefix="endpoint-policy" id="groups" active={tab}>
        <DeviceGroupsTab />
      </TabPanel>
      <TabPanel idPrefix="endpoint-policy" id="exceptions" active={tab} lazy>
        <CommandExceptionsTab me={me} />
      </TabPanel>
    </>
  );
}
