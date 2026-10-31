/**
 * ChatOps identity links on their own page (P3, #453 c6527514889; ADR-0061): every chat identity bound to a regulAIt
 * person, with the shared list control, a verification filter, Remove, and the form that makes a link. The ChatOps
 * overview keeps a five-row preview with the admin-asserted count in its heading.
 */
import { useMemo, useState } from "react";
import { Route, Routes } from "react-router-dom";
import ChatOpsPage from "./ChatOpsPage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import { SubpageTrail } from "../../../ui/ListPreview";
import { useAction } from "../adminKit";
import v from "../../views.module.css";

export interface IdentityLink {
  id: string;
  connectionId: string;
  chatUserId: string;
  chatUserEmail: string;
  userId: string;
  emailVerifiedSource: string;
  createdAt: string;
  /** ADR-0219: the workspace's name, joined by the list contract */
  connectionName?: string | null;
}

export default function ChatIdentityLinksPage() {
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: ["chatops", "connections"],
    queryFn: () => api.get<{ connections: Array<{ id: string; name: string }> }>("/v1/chatops/connections"),
  });
  const act = useAction();
  const [linkPosture, setLinkPosture] = useState<string | null>(null);
  const [verification, setVerification] = useState("");
  const filters = useMemo(() => ({ verification: verification || undefined }), [verification]);
  const [linkConnection, setLinkConnection] = useState("");
  const [chatUserId, setChatUserId] = useState("");
  const [linkEmail, setLinkEmail] = useState("");
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["chatops", "links"] });
  return (
    <>
      <SubpageTrail parent="ChatOps approvals" parentTo="/admin/chatops" current="Identity links" />
      <PageHeader title="Chat ↔ regulAIt identity links" sub="Each chat identity a bot may act for, and the person it is bound to." />
      <Card title="Identity links" info={linkPosture ? <p>{linkPosture}</p> : undefined}>
        <div className={v.row}>
          <Badge tone="warn">Unverified identity</Badge>
          <Field label="Email verification">
            <Select value={verification} onChange={(e) => setVerification(e.target.value)}>
              <option value="">Any</option>
              <option value="idp">idp</option>
              <option value="scim">scim</option>
              <option value="admin_asserted">admin_asserted</option>
            </Select>
          </Field>
        </div>
        <DataList<IdentityLink>
          listId="chat-identity-links"
          noun="identity links"
          endpoint="/v1/chatops/identity-links"
          exportPath="/v1/chatops/identity-links/export.xlsx"
          queryKey={["chatops", "links", "list"]}
          legacyKey="links"
          filters={filters}
          defaultSort={{ key: "created", dir: "desc" }}
          rowKey={(r) => r.id}
          onRows={(_rows, raw) => setLinkPosture(typeof raw.posture === "string" ? raw.posture : null)}
          empty={<EmptyState title="No identity links yet" body="A chat user acts as a regulAIt person only through a link an administrator makes below." />}
          columns={[
            { key: "chatuser", header: "Chat identity", main: true, sortable: true, render: (r) => <code>{r.chatUserId}</code> },
            { key: "email", header: "Bound to", main: true, sortable: true, render: (r) => r.chatUserEmail },
            {
              key: "verified",
              header: "Email verification",
              main: true,
              sortable: true,
              required: "An admin-asserted link is a warning, so verification is always shown",
              render: (r) => <Badge tone={r.emailVerifiedSource === "admin_asserted" ? "warn" : "ok"}>{r.emailVerifiedSource}</Badge>,
            },
            { key: "workspace", header: "Workspace", main: true, sortable: true, render: (r) => r.connectionName ?? "—" },
            { key: "created", header: "Created", main: true, sortable: true, render: (r) => ago(r.createdAt) },
            {
              key: "remove",
              header: "",
              srHeader: "Actions",
              action: true,
              render: (r) => (
                <Button
                  disabled={act.busy}
                  onClick={() => void act.run(() => api.del(`/v1/chatops/identity-links/${r.id}`), "Link removed").then((ok) => ok && refresh())}
                >
                  Remove
                </Button>
              ),
            },
          ]}
        />

        <Field label="Workspace">
          <Select value={linkConnection} onChange={(e) => setLinkConnection(e.target.value)}>
            <option value="">select…</option>
            {(connections.data?.connections ?? []).map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Chat user id">
          <Input value={chatUserId} onChange={(e) => setChatUserId(e.target.value)} placeholder="U0123456789" />
        </Field>
        <Field label="regulAIt user email (must already exist)">
          <Input value={linkEmail} onChange={(e) => setLinkEmail(e.target.value)} />
        </Field>
        <div className={v.row}>
          <Button
            variant="primary"
            disabled={act.busy}
            onClick={() =>
              void act
                .run(
                  () => api.post("/v1/chatops/identity-links", { connectionName: linkConnection, chatUserId, email: linkEmail }),
                  "Identity linked",
                )
                .then((ok) => ok && refresh())
            }
          >
            Link identity
          </Button>
        </div>
      </Card>
    </>
  );
}

/**
 * The ChatOps area: the ChatOps page (with its identity-links preview) at the index, the full chat-identity-links list
 * on its own nested route. One lazy chunk mounted at `chatops/*`, reached through the approvals/audit screen barrel, so
 * the sub-page adds nothing to the entry bundle (ADR-0196 U4; the SPA route census follows this module).
 */
export function ChatOpsArea() {
  return (
    <Routes>
      <Route index element={<ChatOpsPage />} />
      <Route path="identity-links" element={<ChatIdentityLinksPage />} />
    </Routes>
  );
}
