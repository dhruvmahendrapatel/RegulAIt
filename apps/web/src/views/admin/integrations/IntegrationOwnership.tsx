import { useState } from "react";
import { api } from "../../../api/client";
import { Button, Card, Field, Select } from "../../../ui/kit";
import { optionEls, useAction, useUsers, userOpts } from "../adminKit";
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

function OwnerForm({ kind, row }: { kind: "servers" | "connectors"; row: OwnedIntegration }) {
  const users = useUsers();
  const act = useAction();
  const [owner, setOwner] = useState(row.ownerUserId ?? "");
  const active = users.data?.users?.filter((user) => user.disabledAt === null) ?? [];
  const unavailable = owner !== "" && !active.some((user) => user.id === owner);
  return <form className={v.stack} onSubmit={(event) => {
    event.preventDefault();
    void act.run(() => api.put(`/v1/${kind}/${row.id}/owner`, { ownerUserId: owner || null }), "Owner updated");
  }}>
    <p>Current ownership: {row.ownership ?? "not reported"}. An orphaned integration names a person whose account is no longer active.</p>
    <Field label={`Owner for ${row.name}`}><Select value={owner} onChange={(event) => setOwner(event.target.value)} disabled={act.busy || users.isLoading || !!users.error}>
      <option value="">Unassigned</option>
      {unavailable && <option value={owner} disabled>Current owner unavailable — choose an active person or unassign</option>}
      {optionEls(userOpts(active))}
    </Select></Field>
    <p>Only active people can be assigned. Assigning or clearing an owner is audited and grants no permission to call this integration.</p>
    {users.error && <p role="alert">Could not load people. <Button type="button" onClick={() => void users.refetch()}>Retry loading people</Button></p>}
    <Button type="submit" disabled={act.busy || users.isLoading || !!users.error || unavailable}>Save owner</Button>
    {act.error && <p role="alert">{act.error}</p>}
  </form>;
}
