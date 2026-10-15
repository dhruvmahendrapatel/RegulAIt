/**
 * ADR-0188 S8 — outbound MCP identity on the MCP servers screen:
 *
 *  - `IdentityPropagationCell`: the per-server setting in the registry table (`PATCH /v1/servers/:id`
 *    `{ identityPropagation }`). Turning it on sends identity data to a third party, so the gateway asks for a
 *    `settings_relax` step-up (ADR-0180, ADR-0186 A); turning it off asks nothing. A stdio server has no HTTP
 *    request to carry the header, so the cell says so instead of offering it.
 *  - `McpIdentityAssertionCard`: for the selected server, what is sent and how the upstream verifies it, with the
 *    example from docs/api/MCP_IDENTITY_ASSERTION.md, and (the S8 follow-up) `AgentIdDisclosureControl`: whether
 *    agents are named by pairwise ids (the default) or by their workload IDs.
 */
import { useState } from "react";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import type { McpServer } from "../../../api/adminTypes";
import { Badge, Button, Card, ConfirmModal, Select } from "../../../ui/kit";
import { useAction } from "../adminKit";
import {
  AGENT_ID_FORM_OPTIONS,
  ASSERTION_CLAIMS,
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_ASSERTION_TYP,
  IDENTITY_PROPAGATION_OPTIONS,
  JWKS_PATH,
  VERIFY_EXAMPLE,
  agentIdFormOf,
  canonicalAudience,
  identityPropagationOf,
  type AgentIdForm,
  type IdentityPropagation,
} from "./mcpIdentityModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

export function IdentityPropagationCell(props: { server: McpServer }) {
  const act = useAction();
  const stored = identityPropagationOf(props.server);
  const [value, setValue] = useState(stored);
  const [confirming, setConfirming] = useState(false);
  // `data-identity-propagation`: a stable hook for the screen tests (never a column position)
  if (props.server.transport === "stdio") return <span data-identity-propagation="">Not applicable</span>;
  const save = (next: IdentityPropagation) =>
    void act.run(
      () =>
        // turning it on is a relaxation the gateway confirms with a step-up; turning it off asks nothing
        withStepUp((h) => stepUpApi.patch(`/v1/servers/${props.server.id}`, { identityPropagation: next }, h)),
      `Identity to upstream for ${props.server.name} saved`,
    );
  return (
    // the registry rows are clickable (they toggle the cards below); editing here, and the confirmation (rendered
    // in place), must not also toggle the row
    <span data-identity-propagation="" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <form
        className={v.row}
        aria-label={`Identity to upstream for ${props.server.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          // sending identity to a third party is a relaxation: say so before the step-up is asked for
          if (value === "signed_assertion") setConfirming(true);
          else save(value);
        }}
      >
        <Select
          value={value}
          onChange={(e) => setValue(e.target.value === "signed_assertion" ? "signed_assertion" : "none")}
          aria-label={`Identity sent to upstream ${props.server.name}`}
        >
          {IDENTITY_PROPAGATION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" disabled={act.busy || value === stored}>
          Save
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <ConfirmModal
        open={confirming}
        title={`Send caller identity to ${props.server.name}?`}
        confirmLabel="Send a signed assertion"
        body={
          <p>
            Every allowed call to {props.server.name} will carry a signed assertion of who it is for and which agent is acting, each as a pairwise
            id for this server (never an email, a name or a global agent id). This shares identity data with a third party, so it relaxes the strict default and asks you to confirm
            it&apos;s you. The change is audited, and it turns off again if the server&apos;s URL changes.
          </p>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          save("signed_assertion");
        }}
      />
    </span>
  );
}

/**
 * The S8 follow-up, on the identity card of a server that is sent an assertion: how the agents in `act` are named
 * (`PATCH /v1/servers/:id` `{ discloseAgentWorkloadIds }`). Disclosing workload IDs is a relaxation the gateway
 * confirms with a `settings_relax` step-up, so it is confirmed here first; going back to pairwise ids saves directly.
 */
export function AgentIdDisclosureControl(props: { server: McpServer }) {
  const act = useAction();
  const stored = agentIdFormOf(props.server);
  const [value, setValue] = useState(stored);
  const [confirming, setConfirming] = useState(false);
  const save = (next: AgentIdForm) =>
    void act.run(
      () =>
        withStepUp((h) =>
          stepUpApi.patch(`/v1/servers/${props.server.id}`, { discloseAgentWorkloadIds: next === "workload_id" }, h),
        ),
      `Agent ids sent to ${props.server.name} saved`,
    );
  return (
    // `data-agent-id-disclosure`: a stable hook for the screen tests (never a position)
    <div data-agent-id-disclosure="">
      <form
        className={v.row}
        aria-label={`Agent ids for ${props.server.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (value === "workload_id") setConfirming(true);
          else save(value);
        }}
      >
        <Select
          value={value}
          onChange={(e) => setValue(e.target.value === "workload_id" ? "workload_id" : "pairwise")}
          aria-label={`Agent ids sent to upstream ${props.server.name}`}
        >
          {AGENT_ID_FORM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" disabled={act.busy || value === stored}>
          Save
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <ConfirmModal
        open={confirming}
        title={`Disclose agent workload IDs to ${props.server.name}?`}
        confirmLabel="Disclose workload IDs"
        body={
          <>
            <p>
              Each assertion sent to {props.server.name} will name every acting agent by its workload ID (its SPIFFE ID) instead of a
              pairwise id for this server. The person the call is for stays pairwise.
            </p>
            <ul>
              <li>Workload IDs are global: every server that receives them sees the same value for the same agent.</li>
              <li>So upstreams can correlate the same agent across servers, and the calls it makes for a person.</li>
              <li>An identifier an admin typed in for an agent is sent exactly as it was typed, including anything written in it.</li>
            </ul>
            <p>
              This relaxes the strict default, so you will be asked to confirm it&apos;s you. The change is audited, and it turns off again if
              the server&apos;s URL changes or the signed assertion is turned off.
            </p>
          </>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          save("workload_id");
        }}
      />
    </div>
  );
}

export function McpIdentityAssertionCard(props: { server: McpServer | undefined }) {
  const { server } = props;
  if (!server) return null;
  const on = identityPropagationOf(server) === "signed_assertion";
  const audience = server.transport === "stdio" ? null : canonicalAudience(server.url);
  return (
    <Card
      title="Identity sent to this upstream"
      actions={<Badge tone={on ? "warn" : "ok"}>{on ? "Signed assertion per call" : "Nothing sent (default)"}</Badge>}
    >
      {server.transport === "stdio" ? (
        <p>This is a stdio server. It has no HTTP request to carry an identity assertion, so none is ever sent.</p>
      ) : (
        <>
          <p>
            {on
              ? "Each allowed tool call, and each allowed protocol request, to this server carries a signed assertion of who the call is for and which agent is acting. Every assertion sent is audited. If one cannot be made, the call is refused rather than sent without it."
              : "Nothing about the caller is sent to this server. Turning on a signed assertion per call shares identity data with a third party, so it needs a step-up and is audited. If the server's URL changes, the setting turns off again."}
          </p>
          <p>
            Header <span className={v.mono}>{IDENTITY_ASSERTION_HEADER}</span>: a JWT signed with EdDSA, type{" "}
            <span className={v.mono}>{IDENTITY_ASSERTION_TYP}</span>, lifetime 60 seconds. Its audience for this server is{" "}
            <span className={v.mono}>{audience ?? "not available (the URL is not an http(s) URL)"}</span>. The upstream verifies it
            against this deployment&apos;s public keys at <span className={v.mono}>{`<your RegulAIt public URL>${JWKS_PATH}`}</span>.
          </p>
          <ul aria-label="Claims in the assertion">
            {ASSERTION_CLAIMS.map((c) => (
              <li key={c.claim}>
                <span className={v.mono}>{c.claim}</span>: {c.meaning}
              </li>
            ))}
          </ul>
          <p>
            Never sent: the person&apos;s email, name or user id, roles, project, grant, tool arguments, scope or budget. An agent&apos;s global
            workload id is sent only if you choose to disclose it below.
          </p>
          <h3 className={v.dim}>Agent ids sent</h3>
          {on ? (
            <>
              <p>
                {agentIdFormOf(server) === "workload_id"
                  ? "Agents are named by their workload IDs (SPIFFE IDs). These are global, so upstreams can correlate the same agent across servers."
                  : "Agents are named by a pairwise id for this server: stable here, unlinkable across servers. Disclosing their workload IDs instead is a relaxation that needs a step-up."}
              </p>
              <AgentIdDisclosureControl key={`${server.id}:${agentIdFormOf(server)}`} server={server} />
            </>
          ) : (
            <p>Agent ids are sent only inside a signed assertion. Turn the assertion on first to choose how agents are named.</p>
          )}
          <details>
            <summary>Verification example for the upstream operator (JavaScript, jose)</summary>
            <pre className={a.snippet} data-testid="mcp-identity-verify-example">
              {VERIFY_EXAMPLE}
            </pre>
            <p className={v.dim}>The full format is in docs/api/MCP_IDENTITY_ASSERTION.md.</p>
          </details>
        </>
      )}
    </Card>
  );
}
