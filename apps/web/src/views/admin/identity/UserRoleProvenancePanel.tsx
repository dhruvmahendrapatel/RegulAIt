/**
 * ADR-0038 — which roles a user holds, and WHY: an admin assigned it
 * (`direct`), a group mapping produced it (`group`), or both. Read from
 * `GET /v1/users/:userId/role-provenance`. Admin status is not a role and no
 * mapping can produce it; the gateway says so and this panel repeats it.
 *
 * Every field is read as unknown input: a row with an origin this build does
 * not know shows that origin as it is, never as "direct".
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { Badge, EmptyState, Table, type Tone } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";

export interface ProvenanceMapping {
  mappingId: string;
  source: string;
  externalGroup: string;
  currentlyAssertedViaScim: boolean;
}
export interface ProvenanceRole {
  roleId: string;
  roleName: string;
  origins: string[];
  provenance: string;
  assignedAt: string;
  viaMappings?: ProvenanceMapping[];
}
export interface RoleProvenance {
  userId: string;
  email: string;
  isAdmin: boolean;
  isAdminGroupDerivable: boolean;
  roles: ProvenanceRole[];
}

const PROVENANCE: Record<string, { tone: Tone; label: string }> = {
  direct: { tone: "neutral", label: "assigned by an admin" },
  group: { tone: "info", label: "from a group mapping" },
  both: { tone: "primary", label: "assigned and from a group" },
};

/** a mapping in words: which group, from where, and whether SCIM asserts it now */
export function mappingText(m: ProvenanceMapping): string {
  const source = m.source === "scim" ? "SCIM" : m.source.toUpperCase();
  const asserted =
    m.source === "scim"
      ? m.currentlyAssertedViaScim
        ? " (SCIM asserts this membership now)"
        : " (SCIM does not assert this membership now)"
      : " (asserted per sign-in; see the audit log)";
  return `${source} group “${m.externalGroup}”${asserted}`;
}

export default function UserRoleProvenancePanel(props: { userId: string }) {
  const q = useQuery({
    queryKey: ["admin", "role-provenance", props.userId],
    queryFn: () => api.get<RoleProvenance>(`/v1/users/${encodeURIComponent(props.userId)}/role-provenance`),
  });
  const roles = Array.isArray(q.data?.roles) ? q.data!.roles : [];
  return (
    <div className={v.stack} data-testid="role-provenance">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data ? (
          <>
            <p className={v.faint}>
              {q.data.isAdmin ? "This user is an administrator. " : ""}
              Administrator status is not a role: it is set by an admin on the Lifecycle tab, and no group mapping can grant it.
            </p>
            <Table<ProvenanceRole>
              rows={roles}
              rowKey={(r) => r.roleId}
              columns={[
                { key: "role", header: "Role", sort: (r) => r.roleName, render: (r) => r.roleName },
                {
                  key: "why",
                  header: "Why they hold it",
                  render: (r) => {
                    const p = PROVENANCE[r.provenance];
                    return <Badge tone={p?.tone ?? "warn"}>{p?.label ?? `origin: ${r.provenance}`}</Badge>;
                  },
                },
                {
                  key: "via",
                  header: "Group mappings",
                  render: (r) =>
                    r.viaMappings && r.viaMappings.length > 0 ? (
                      <ul className={v.stack} style={{ margin: 0, paddingLeft: "1.2em" }}>
                        {r.viaMappings.map((m) => (
                          <li key={m.mappingId}>{mappingText(m)}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className={v.faint}>none</span>
                    ),
                },
                { key: "since", header: "Since", sort: (r) => r.assignedAt, render: (r) => ago(r.assignedAt) },
              ]}
              empty={<EmptyState title="No roles" body="This user holds no role, directly or through a group mapping." />}
            />
          </>
        ) : null}
      </QueryGate>
    </div>
  );
}
