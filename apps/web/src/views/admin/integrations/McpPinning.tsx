/**
 * ADR-0246 (P27): MCP definition pinning and high-risk tooling, on their own lazy page (`/admin/mcp-servers/pinning`)
 * and the per-server definition-pin page, both routed from App.tsx into this chunk. The MCP servers page links here
 * from its header, the way it links to MCP bundles, so these screens add nothing to admin-integrations (ADR-0344
 * per-route budgets; the owner chose lazy-loading over a ceiling raise).
 */
import { useState } from "react";
import { PageHeader } from "../../../shell/AppShell";
import { SubpageTrail } from "../../../ui/ListPreview";
import { Card, Field, Select } from "../../../ui/kit";
import { optionEls, useServers } from "../adminKit";
import { McpChangedSinceApprovalCard } from "./McpDefinitionPins";
import { McpAuthorisedTargetsCard, McpHighRiskCard } from "./McpHighRisk";
import v from "../../views.module.css";

export { default as McpDefinitionPinsPage } from "./McpDefinitionPins";

/** The fleet view: definitions changed since approval, one chosen server's risk class and policy, and the targets. */
export function McpPinningPage() {
  const servers = useServers();
  // no server is preselected: the high-risk card shows only for a server the admin picks
  const [serverId, setServerId] = useState("");
  const list = servers.data?.servers ?? [];
  return (
    <>
      <SubpageTrail parent="MCP servers" parentTo="/admin/mcp-servers" current="Pinning and high-risk tooling" />
      <PageHeader
        title="Pinning and high-risk tooling"
        sub="Definitions changed since an admin approved them, each server's risk class and policy, and the targets high-risk tools may reach."
      />
      <div className={v.stack}>
        <McpChangedSinceApprovalCard />
        <Card title="Server risk class" caption="Pick a server to see and change its risk class and high-risk policy.">
          <Field label="Server">
            <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
              {optionEls(list.map((s) => ({ v: s.id, l: s.name })), "Choose a server")}
            </Select>
          </Field>
        </Card>
        <McpHighRiskCard server={list.find((s) => s.id === serverId)} />
        <McpAuthorisedTargetsCard />
      </div>
    </>
  );
}
