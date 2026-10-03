/**
 * Group → role mapping (ADR-0038).
 *
 * The screen where an IdP group becomes an entitlement — and, just as
 * importantly, where it is visible that most of them do not. Three things this
 * page exists to keep honest:
 *
 *  - **an unmapped group grants nothing.** Every group any identity path has
 *    asserted is listed below, mapped or not, so "the IdP renamed the group and
 *    everyone quietly lost access" shows up as a sighting with no mapping
 *    instead of as a support ticket. There is no "default role for unmapped
 *    groups" control here because there is no such setting — it would be a
 *    default-allow backdoor.
 *  - **a mapping delegates that role's grants to whoever administers the group
 *    in the IdP.** The blast radius is stated at the point of the decision, not
 *    discovered afterwards.
 *  - **no mapping can confer admin.** `isAdmin` is not a role, so it is not in
 *    the role picker and there is no code path to it. A group called
 *    "SOC-Admins" can be mapped to a role with broad grants; it can never be
 *    mapped to the platform admin bit.
 *
 * Removing a mapping does not strip anyone here: the derived assignments are
 * reconciled away on each holder's next login or sync, which is the same single
 * removal path a group membership disappearing in the IdP takes.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { AssertedGroup, GroupRoleMapping, Role } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
} from "../../../ui/kit";
import { QueryGate, optionEls, roleOpts, useAction, useRoles } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

type Source = "saml" | "oidc" | "scim";

const SOURCE_LABEL: Record<Source, string> = {
  scim: "SCIM (synced group)",
  oidc: "OIDC (groups claim)",
  saml: "SAML (group attribute)",
};

export default function GroupMappingsPage() {
  const roles = useRoles();
  const mappings = useQuery({
    queryKey: ["admin", "group-role-mappings"],
    queryFn: () => api.get<{ mappings: GroupRoleMapping[] }>("/v1/group-role-mappings"),
  });
  const asserted = useQuery({
    queryKey: ["admin", "asserted-groups"],
    queryFn: () =>
      api.get<{ assertedGroups: AssertedGroup[]; unmappedCount: number }>(
        "/v1/group-role-mappings/asserted-groups",
      ),
  });

  const act = useAction();
  const [source, setSource] = useState<Source | "">("");
  const [externalGroup, setExternalGroup] = useState("");
  const [roleId, setRoleId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<GroupRoleMapping | null>(null);
  const [unmappedOnly, setUnmappedOnly] = useState(true);

  const roleName = (id: string) =>
    (roles.data?.roles ?? []).find((r: Role) => r.id === id)?.name ?? id;

  const rows = (asserted.data?.assertedGroups ?? []).filter((g) => (unmappedOnly ? !g.mapped : true));

  return (
    <>
      <PageHeader
        title="Group → role mapping"
        sub="Turn an IdP group into a regulAIt role. A group with no mapping grants nothing."
        info={<p>Turn an IdP group into a regulAIt role — explicitly, one mapping at a time. A group with no mapping grants nothing: membership in it is recorded and inert. Mapping is purely additive, it confers exactly the mapped role's grants and never more, a per-user revocation still beats it, and no group can ever confer the platform admin bit.</p>}
      />
      <div className={v.stack}>
        <Card title="Map a group to a role">
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                await api.post("/v1/group-role-mappings", {
                  source,
                  externalGroup: externalGroup.trim(),
                  roleId,
                });
                setExternalGroup("");
              }, "Mapping created");
            }}
          >
            <Field label="Asserted by">
              <Select
                required
                value={source}
                onChange={(e) => setSource(e.target.value as Source | "")}
              >
                {optionEls(
                  (Object.keys(SOURCE_LABEL) as Source[]).map((s) => ({ v: s, l: SOURCE_LABEL[s] })),
                  "— select the identity path —",
                )}
              </Select>
            </Field>
            <Field label="Group as the IdP asserts it" grow>
              <Input
                required
                value={externalGroup}
                onChange={(e) => setExternalGroup(e.target.value)}
                placeholder="Finance-Readonly"
              />
            </Field>
            <Field label="Role it confers">
              <Select required value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                {optionEls(roleOpts(roles.data?.roles), "— select a role —")}
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={act.busy}>
              Create mapping
            </Button>
          </form>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
          <p className={v.faint}>
            The group identifier is matched exactly as the IdP asserts it — a SCIM group's external
            id (or its display name where the connector sends none), an entry in the OIDC{" "}
            <span className={v.mono}>groups</span> claim, or a value of the SAML group attribute. It
            is scoped per identity path on purpose: “Engineering” asserted over SAML and
            “Engineering” synced over SCIM are two different assertions from two different trust
            paths, and each is opted into separately. Holders pick the role up on their next login
            or sync; they lose it the same way.
          </p>
        </Card>

        <Card flush>
          <Table<GroupRoleMapping>
            columns={[
              {
                key: "source",
                header: "Asserted by",
                sort: (m) => m.source,
                render: (m) => <Badge>{m.source}</Badge>,
              },
              {
                key: "group",
                header: "IdP group",
                sort: (m) => m.externalGroup,
                render: (m) => <span className={v.mono}>{m.externalGroup}</span>,
              },
              {
                key: "role",
                header: "Confers role",
                sort: (m) => m.roleName,
                render: (m) => m.roleName || roleName(m.roleId),
              },
              {
                key: "created",
                header: "Created",
                sort: (m) => m.createdAt,
                render: (m) => ago(m.createdAt),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (m) => (
                  <Button size="sm" variant="danger" onClick={() => setConfirmDelete(m)}>
                    remove
                  </Button>
                ),
              },
            ]}
            rows={mappings.data?.mappings ?? []}
            rowKey={(m) => m.id}
            loading={mappings.isLoading}
            error={mappings.error}
            onRetry={() => void mappings.refetch()}
            empty={
              <EmptyState
                title="No group is mapped to a role"
                body="Every group your IdP asserts is currently inert — membership is recorded and grants nothing. That is the default, and it is the safe one."
              />
            }
          />
        </Card>

        <QueryGate
          loading={asserted.isLoading}
          error={asserted.error}
          onRetry={() => void asserted.refetch()}
        >
          <Card
            title={`Groups your IdP has asserted${
              asserted.data ? ` — ${asserted.data.unmappedCount} mapped to nothing` : ""
            }`}
          >
            <label className={v.rowTight}>
              <input
                type="checkbox"
                checked={unmappedOnly}
                onChange={(e) => setUnmappedOnly(e.target.checked)}
              />
              <span>Show only groups that grant nothing</span>
            </label>
            <Table<AssertedGroup>
              columns={[
                { key: "source", header: "Asserted by", render: (g) => <Badge>{g.source}</Badge> },
                {
                  key: "group",
                  header: "Group",
                  sort: (g) => g.externalGroup,
                  render: (g) => <span className={v.mono}>{g.externalGroup}</span>,
                },
                {
                  key: "mapped",
                  header: "Grants",
                  render: (g) =>
                    g.mapped ? (
                      <span>{g.roles.map((r) => r.roleName).join(", ")}</span>
                    ) : (
                      <Badge tone="warn" title="no mapping exists, so membership confers nothing">
                        nothing
                      </Badge>
                    ),
                },
                {
                  key: "seen",
                  header: "Times seen",
                  sort: (g) => g.seenCount,
                  render: (g) => String(g.seenCount),
                },
                {
                  key: "last",
                  header: "Last asserted",
                  sort: (g) => g.lastSeenAt,
                  render: (g) => ago(g.lastSeenAt),
                },
              ]}
              rows={rows}
              rowKey={(g) => `${g.source}:${g.externalGroup}`}
              empty={
                <EmptyState
                  title={unmappedOnly ? "Every asserted group is mapped" : "No group has been asserted yet"}
                  body={
                    unmappedOnly
                      ? "Nothing your IdP sends is silently inert."
                      : "No sync or federated login has carried a group yet. SAML and OIDC providers only emit groups once you name the carrying attribute/claim on the SSO screen."
                  }
                />
              }
            />
            <p className={v.faint}>
              A group listed here with <strong>nothing</strong> in the Grants column is being
              asserted by your directory and conferring no access. That is the correct default for a
              group nobody mapped — and it is also what an IdP-side rename looks like, so a mapping
              that used to work and a group that never had one are deliberately the same, visible,
              row rather than a silent difference.
            </p>
          </Card>
        </QueryGate>
      </div>

      <ConfirmModal
        open={confirmDelete !== null}
        title={`Remove the mapping of “${confirmDelete?.externalGroup}”?`}
        body={`Holders keep the ${confirmDelete?.roleName ?? "mapped"} role until their next login or sync, when reconciliation removes the group-derived assignment. Anyone an admin also assigned that role to DIRECTLY keeps it — an admin assignment is never removed by a sync.`}
        confirmLabel="Remove mapping"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const m = confirmDelete;
          setConfirmDelete(null);
          if (m) void act.run(() => api.del(`/v1/group-role-mappings/${m.id}`), "Mapping removed");
        }}
      />
    </>
  );
}
