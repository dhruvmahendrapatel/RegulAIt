import { useState } from "react";
import { api } from "../../../api/client";
import { Button, Card, Field, Select } from "../../../ui/kit";
import type { AdminUser } from "../../../api/adminTypes";
import { optionEls, useAction, useUserPicker, userOpts, type UserPickerPage } from "../adminKit";
import v from "../../views.module.css";

interface OwnedIntegration { id: string; name: string; ownerUserId?: string | null; ownership?: "owned" | "unowned" | "orphaned" }

export function IntegrationOwnership({ kind, rows }: { kind: "servers" | "connectors"; rows: OwnedIntegration[] }) {
  const [id, setId] = useState("");
  const row = rows.find((item) => item.id === id);
  return <Card title={kind === "servers" ? "MCP server ownership" : "Connector ownership"}>
    <Field label={kind === "servers" ? "Server to assign" : "Connector to assign"}>
      <Select value={id} onChange={(event) => setId(event.target.value)}>
        <option value="">— select —</option>
        {rows.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.ownership ?? "ownership not reported"}</option>)}
      </Select>
    </Field>
    {row && <OwnerForm key={`${kind}:${row.id}:${row.ownerUserId ?? ""}`} kind={kind} row={row} />}
  </Card>;
}

/**
 * What the picker can say about the current owner. Only a complete list can
 * prove someone is missing; a person absent from a truncated page is
 * "not_loaded" — kept selectable, never shown as inactive.
 */
export type OwnerStatus = "none" | "active" | "inactive" | "not_found" | "not_loaded";
export function ownerStatus(owner: string, page: UserPickerPage | undefined, saved?: Pick<OwnedIntegration, "ownerUserId" | "ownership">): OwnerStatus {
  if (owner === "") return "none";
  const found = page?.users.find((user: AdminUser) => user.id === owner);
  if (found) return found.disabledAt === null ? "active" : "inactive";
  if (saved?.ownerUserId === owner && saved.ownership === "orphaned") return "inactive";
  return page?.complete ? "not_found" : "not_loaded";
}

/**
 * Save is offered only for a real change to an owner who may hold it: saving
 * the loaded owner again would write an identical owner-changed audit row and
 * could restore a stale owner over another admin's change.
 */
export function canSaveOwner(owner: string, row: Pick<OwnedIntegration, "ownerUserId">, status: OwnerStatus): boolean {
  return owner !== (row.ownerUserId ?? "") && status !== "inactive" && status !== "not_found";
}

function OwnerForm({ kind, row }: { kind: "servers" | "connectors"; row: OwnedIntegration }) {
  const users = useUserPicker();
  const act = useAction();
  const [owner, setOwner] = useState(row.ownerUserId ?? "");
  const active = users.data?.users.filter((user) => user.disabledAt === null) ?? [];
  const status = users.data ? ownerStatus(owner, users.data, row) : "none";
  return <form className={v.stack} onSubmit={(event) => {
    event.preventDefault();
    void act.run(() => api.put(`/v1/${kind}/${row.id}/owner`, { ownerUserId: owner || null }), "Owner updated");
  }}>
    <p>Current ownership: {row.ownership ?? "not reported"}. An orphaned integration names a person whose account is no longer active.</p>
    <Field label={`Owner for ${row.name}`}><Select value={owner} onChange={(event) => setOwner(event.target.value)} disabled={act.busy || users.isLoading || !!users.error}>
      <option value="">Unassigned</option>
      {status === "inactive" && <option value={owner} disabled>Current owner inactive — choose an active person or unassign</option>}
      {status === "not_found" && <option value={owner} disabled>Current owner not found — choose an active person or unassign</option>}
      {status === "not_loaded" && <option value={owner}>Current owner (not in the people loaded here)</option>}
      {optionEls(userOpts(active))}
    </Select></Field>
    <p>Only active people can be assigned. Assigning or clearing an owner is audited and grants no permission to call this integration.</p>
    {users.data && !users.data.complete && <UserListTruncated count={users.data.users.length} />}
    {users.error && <PeopleLoadError onRetry={() => void users.refetch()} />}
    <Button type="submit" disabled={act.busy || users.isLoading || !!users.error || !canSaveOwner(owner, row, status)}>Save owner</Button>
    {act.error && <p role="alert">{act.error}</p>}
  </form>;
}

/** Shown when GET /v1/users returned its maximum page: the list is partial. */
export function UserListTruncated({ count }: { count: number }) {
  return <p role="status">Only the first {count.toLocaleString()} people are loaded here, so some people cannot be picked. Someone missing from this list is not loaded, not inactive.</p>;
}

/** The people list failed to load: say so and offer the retry, never a silently disabled form. */
export function PeopleLoadError({ onRetry }: { onRetry: () => void }) {
  return <p role="alert">Could not load people. <Button type="button" onClick={onRetry}>Retry loading people</Button></p>;
}
