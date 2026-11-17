/**
 * Managed settings (lane UI-D, D1 slice 1; ADR-0310, #850): export a user's or a role's effective MCP entitlements as
 * a signed managed-settings bundle, list every version, and download a version's archive to push through MDM.
 *
 * Task: an admin picks a person or a role, exports, and downloads the signed archive. An export with an unchanged
 * policy makes no new version; the page says so and points at the current one. Exporting is audited by the gateway
 * and tightens nothing on its own, so it has no step-up.
 *
 * Reads: one keyset page of bundles at a time ("Load more"), the user directory and the role list (for names and the
 * pickers). The overlay and the export are one declared flow (exportReducer). The model is managedSettingsModel.ts.
 */
import { useMemo, useReducer, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { Button, Card, EmptyState, Field, Input, Modal, RowActions, Select, Table } from "../../../ui/kit";
import { QueryGate, downloadCsv, useAction, useRoles, useUserPicker } from "../adminKit";
import {
  EXPORT_IDLE,
  archiveName,
  exportBlockedReason,
  exportBody,
  exportReducer,
  filterValue,
  listPath,
  parseFilter,
  resultWords,
  subjectWords,
  versionProblem,
  type Bundle,
  type BundlePage,
  type ExportResult,
  type SubjectFilter,
  type SubjectKind,
} from "./managedSettingsModel";
import v from "../../views.module.css";

const KEY = ["admin", "managed-settings-bundles"] as const;

export default function ManagedSettingsPage() {
  const qc = useQueryClient();
  const users = useUserPicker();
  const roles = useRoles();
  const [filter, setFilter] = useState<SubjectFilter>(null);
  const [flow, send] = useReducer(exportReducer, EXPORT_IDLE);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: [...KEY, filterValue(filter)],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<BundlePage>(listPath(filter, pageParam)),
    getNextPageParam: (last) => last.next,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.bundles) ?? [], [list.data]);
  const names = useMemo(
    () => ({
      users: new Map((users.data?.users ?? []).map((u) => [u.id, u.displayName || u.email] as const)),
      roles: new Map((roles.data?.roles ?? []).map((r) => [r.id, r.name] as const)),
    }),
    [users.data, roles.data],
  );

  const download = (b: Bundle) => {
    setDownloadError(null);
    void downloadCsv(`/v1/managed-settings/bundles/${encodeURIComponent(b.id)}/archive`, archiveName(b), setDownloadError);
  };

  return (
    <>
      <PageHeader
        title="Managed settings"
        crumbs={["Integrations", "Managed settings"]}
        sub="Signed managed-settings bundles for coding tools, compiled from a person's or a role's MCP entitlements."
        info={
          <p>
            A bundle holds each coding tool's own managed-settings file, listing only the MCP servers the person or role
            is entitled to, plus a signed manifest. Push the archive through your device management. Exporting again
            makes a new version only when the entitlements changed.
          </p>
        }
      />
      <div className={v.stack}>
        {flow.last && (
          <p role="status" className={v.dim}>
            {subjectWords(flow.last.subject, names)}: {resultWords(flow.last)}{" "}
            <Button size="sm" variant="ghost" onClick={() => download(flow.last!)}>
              Download version {flow.last.version}
            </Button>
          </p>
        )}
        {downloadError && (
          <p className={v.errLine} role="alert">
            {downloadError}
          </p>
        )}
        <Card
          title="Bundles"
          count={list.data ? rows.length : null}
          countNoun={["version", "versions"]}
          actions={
            <Button variant="primary" onClick={() => send({ type: "open" })}>
              Export a bundle
            </Button>
          }
        >
          <div className={v.row}>
            <Field label="Show bundles for">
              <Select value={filterValue(filter)} onChange={(e) => setFilter(parseFilter(e.target.value))}>
                <option value="">Everyone</option>
                <SubjectOptions users={users.data?.users ?? []} roles={roles.data?.roles ?? []} />
              </Select>
            </Field>
          </div>
          <Table<Bundle>
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void list.refetch()}
            rows={rows}
            rowKey={(b) => b.id}
            empty={
              filter ? (
                <EmptyState title="No bundles for this subject yet" />
              ) : (
                <EmptyState title="No bundles yet" body="Export a bundle for a person or a role to push their MCP entitlements to coding tools." />
              )
            }
            columns={[
              { key: "subject", header: "For", render: (b) => subjectWords(b.subject, names) },
              { key: "version", header: "Version", render: (b) => `v${b.version}`, align: "right" },
              { key: "servers", header: "MCP servers", render: (b) => String(b.serverCount), align: "right" },
              { key: "key", header: "Signed with", render: (b) => <code>{b.keyId}</code> },
              { key: "at", header: "Exported", render: (b) => fmtAt(b.createdAt) },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (b) => (
                  <RowActions
                    slot="managed-settings"
                    primary={
                      <Button size="sm" aria-label={`Download version ${b.version} for ${subjectWords(b.subject, names)}`} onClick={() => download(b)}>
                        Download
                      </Button>
                    }
                  />
                ),
              },
            ]}
          />
          {list.hasNextPage && (
            <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </Card>
      </div>
      {flow.step !== "closed" && (
        <ExportModal
          flow={flow}
          send={send}
          users={users}
          roles={roles}
          onExported={() => void qc.invalidateQueries({ queryKey: KEY })}
        />
      )}
    </>
  );
}

type UserList = NonNullable<ReturnType<typeof useUserPicker>["data"]>["users"];
type RoleList = NonNullable<ReturnType<typeof useRoles>["data"]>["roles"];

function SubjectOptions(props: { users: UserList; roles: RoleList }) {
  return (
    <>
      <optgroup label="People">
        {props.users.map((u) => (
          <option key={u.id} value={`user:${u.id}`}>
            {u.displayName || u.email}
          </option>
        ))}
      </optgroup>
      <optgroup label="Roles">
        {props.roles.map((r) => (
          <option key={r.id} value={`role:${r.id}`}>
            {r.name}
          </option>
        ))}
      </optgroup>
    </>
  );
}

function ExportModal(props: {
  flow: ReturnType<typeof exportReducer>;
  send: (e: Parameters<typeof exportReducer>[1]) => void;
  users: ReturnType<typeof useUserPicker>;
  roles: ReturnType<typeof useRoles>;
  onExported: () => void;
}) {
  const act = useAction();
  const [subject, setSubject] = useState("");
  const [minVersion, setMinVersion] = useState("");
  const [checked, setChecked] = useState(false);
  const blocked = exportBlockedReason(props.flow);
  const chosen = parseFilter(subject);
  const subjectError = checked && !chosen ? "Choose a person or a role." : null;
  const versionError = checked ? versionProblem(minVersion) : null;

  const submit = () => {
    setChecked(true);
    if (blocked || !chosen || versionProblem(minVersion)) return;
    props.send({ type: "submit" });
    let result: ExportResult | null = null;
    void act
      .run(async () => {
        result = await api.post<ExportResult>("/v1/managed-settings/bundles", exportBody(chosen.kind as SubjectKind, chosen.id, minVersion));
      }, "Bundle exported")
      .then((ok) => {
        if (ok && result) {
          props.onExported();
          props.send({ type: "ok", result });
        } else props.send({ type: "fail" });
      });
  };

  return (
    <Modal
      open
      title="Export a managed-settings bundle"
      onClose={() => props.send({ type: "close" })}
      actions={
        <>
          <Button aria-disabled={blocked !== null} onClick={() => props.send({ type: "close" })}>
            Cancel
          </Button>
          <Button variant="primary" aria-disabled={blocked !== null} aria-describedby={blocked ? "export-blocked" : undefined} onClick={submit}>
            {props.flow.step === "exporting" ? "Exporting…" : "Export and sign"}
          </Button>
        </>
      }
    >
      <form
        aria-label="New managed-settings bundle"
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <QueryGate
          loading={props.users.isLoading || props.roles.isLoading}
          error={props.users.error ?? props.roles.error}
          onRetry={() => {
            void props.users.refetch();
            void props.roles.refetch();
          }}
        >
          <Field label="For" error={subjectError}>
            <Select value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={() => setChecked(true)}>
              <option value="">Choose a person or a role</option>
              <SubjectOptions users={(props.users.data?.users ?? []).filter((u) => !u.disabledAt)} roles={props.roles.data?.roles ?? []} />
            </Select>
          </Field>
          {props.users.data && !props.users.data.complete && (
            <p className={v.dim}>Only the first part of the directory loaded; a person not listed was not loaded.</p>
          )}
        </QueryGate>
        <Field label="Claude Code minimum version (optional)" error={versionError}>
          <Input value={minVersion} onChange={(e) => setMinVersion(e.target.value)} onBlur={() => setChecked(true)} placeholder="1.0.30" />
        </Field>
        {blocked && (
          <p id="export-blocked" className={v.dim} role="status">
            {blocked}
          </p>
        )}
        {act.error && (
          <p className={v.errLine} role="alert">
            {act.error}
          </p>
        )}
        <RefusalNotice guidance={act.guidance} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
