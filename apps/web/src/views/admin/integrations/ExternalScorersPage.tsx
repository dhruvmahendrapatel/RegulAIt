/**
 * External eval scorers (ADR-0088) — the admin surface for plugging a
 * Fiddler-class scoring endpoint the operator runs or buys into the eval
 * harness as a GOVERNED, DISCLOSED instrument.
 *
 * The page idiom is CustomProvidersPage's, because the decision is the same
 * shape — an admin-typed outbound endpoint under the egress guard — applied
 * to a measuring instrument instead of a model:
 *
 *  1. THE LIFECYCLE IS register → test → enable, AND IT IS NOT OPTIONAL. A
 *     scorer registers DISABLED; enabling without a passed connection test is
 *     refused; moving the baseUrl re-arms the gate. The connection test POSTs
 *     a real probe and requires a reply that conforms to OUR contract.
 *  2. REFUSALS ARE SHOWN VERBATIM — the egress guard's own reason, the
 *     endpoint's own failure text. Never "something went wrong".
 *  3. THE DISCLOSURE IS ON THE PAGE, not in an ADR: an external score is the
 *     vendor's opinion; RegulAIt governs the call and records provenance
 *     (`method: "external:<name>"` on every row) — it does not validate the
 *     instrument.
 *
 * What is deliberately NOT here: any attachment to the inline guardrail path
 * (ADR-0042 stays local-detector only — ADR-0088's named boundary), any
 * in-house scoring model, and any vendor-specific API dialect: the wire
 * contract is ours, and a vendor that speaks something else gets a thin
 * translation shim the operator controls.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { ExternalScorer } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Table } from "../../../ui/kit";
import { QueryGate, useAction, useEgressAllowHosts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

/** the judge-backed kinds an instrument may claim — the registration schema
 * refuses anything else, so the lexical metrics are not even expressible */
const CLAIMABLE_KINDS = ["llm_as_judge", "groundedness_judge", "answer_relevance_judge"] as const;

const useExternalScorers = () =>
  useQuery({
    queryKey: ["admin", "external-scorers"],
    queryFn: () => api.get<{ scorers: ExternalScorer[] }>("/v1/external-scorers"),
  });

export default function ExternalScorersPage() {
  const scorers = useExternalScorers();
  const hosts = useEgressAllowHosts();
  const act = useAction();
  const [removing, setRemoving] = useState<ExternalScorer | null>(null);

  // register form
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [kinds, setKinds] = useState<string[]>(["groundedness_judge"]);
  const [plaintext, setPlaintext] = useState(false);

  const toggleKind = (k: string) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <>
      <PageHeader
        title="External scorers"
        sub="Bring your own scoring instrument — a Fiddler-class endpoint you run or buy — as a governed, disclosed eval scorer. RegulAIt governs the call and records provenance; it does not validate the instrument."
      />
      <div className={v.stack}>
        <Card title="What an external score is, and is not">
          <p className={v.faint}>
            An external score is <strong>the vendor&apos;s opinion</strong>. Every eval result an
            external instrument scores is stamped <code>method: &quot;external:&lt;name&gt;&quot;</code> —
            never blended with the local lexical metrics or a model judge&apos;s verdict. A named
            scorer that is unknown, disabled, not claiming the metric, or refused by the egress
            guard refuses the whole run with a 422 <em>before any row is written</em>, exactly like
            a missing judge (ADR-0067). The deterministic (lexical) metrics never route externally.
            To use one: set <code>{"{"}&quot;externalScorer&quot;: &quot;&lt;name&gt;&quot;{"}"}</code> in a
            judge-backed scorer&apos;s config on the Evaluations page.
          </p>
          <p className={v.faint}>
            The wire contract is ours, not the vendor&apos;s API: one POST of{" "}
            <code>{"{input, output, context, scorerKind}"}</code> returning{" "}
            <code>{"{score: 0..1, reasons?}"}</code>. A vendor that speaks a different dialect gets a
            thin translation shim you control. The inline guardrail path (ADR-0042) stays
            local-detector only — an external verdict inside every dispatch is a latency and
            data-egress decision this slice deliberately does not make.
          </p>
        </Card>

        <QueryGate
          loading={scorers.isLoading}
          error={scorers.error}
          onRetry={() => void scorers.refetch()}
        >
          <Card title="Register a scoring endpoint">
            <p className={v.faint}>
              The endpoint URL is a typed destination under the same egress governance as a custom
              LLM provider: its host must be in the egress allow-list (managed on the Custom LLM
              providers page), private ranges and plaintext http are per-host opt-ins, and the
              guard re-checks on every request. A new scorer registers <strong>disabled</strong>{" "}
              until its connection test passes.
              {(hosts.data?.hosts ?? []).length === 0 && (
                <> The allow-list is currently empty, so no endpoint is reachable yet.</>
              )}
            </p>
            <form
              className={a.formRow}
              onSubmit={(e) => {
                e.preventDefault();
                void act
                  .run(
                    () =>
                      api.post("/v1/external-scorers", {
                        name,
                        baseUrl,
                        ...(apiKey ? { apiKey } : {}),
                        scorerKinds: kinds,
                        ...(plaintext ? { allowPlaintextHttp: true } : {}),
                      }),
                    `External scorer '${name}' registered — run its connection test, then enable it`,
                  )
                  .then((ok) => {
                    if (ok) {
                      setName("");
                      setBaseUrl("");
                      setApiKey("");
                    }
                  });
              }}
            >
              <Field label="Scorer name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="fiddler-shim"
                  required
                />
              </Field>
              <Field label="Endpoint URL" grow>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://scoring.internal/v1/score"
                  required
                />
              </Field>
              <Field label="Auth secret (optional, sent as Bearer)">
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="never shown again"
                  autoComplete="off"
                />
              </Field>
              <div role="group" aria-label="Scorer kinds claimed">
                <span className={v.faint}>Claims to serve (judge-backed kinds only)</span>
                <div className={v.stack}>
                  {CLAIMABLE_KINDS.map((k) => (
                    <span key={k} style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
                      <input
                        type="checkbox"
                        id={`xs-kind-${k}`}
                        checked={kinds.includes(k)}
                        onChange={() => toggleKind(k)}
                      />
                      <label htmlFor={`xs-kind-${k}`}>
                        <code>{k}</code>
                      </label>
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
                <input
                  type="checkbox"
                  id="xs-plaintext"
                  checked={plaintext}
                  onChange={(e) => setPlaintext(e.target.checked)}
                />
                <label htmlFor="xs-plaintext" className={v.faint}>
                  Plaintext http — the endpoint half of the two-flag opt-in; the matching
                  allow-list entry must opt in too
                </label>
              </div>
              <Button type="submit" disabled={act.busy || kinds.length === 0}>
                Register scorer
              </Button>
            </form>
            {act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )}
          </Card>

          <Card title="Registered scorers">
            {(scorers.data?.scorers ?? []).length === 0 ? (
              <EmptyState
                title="No external scorers registered"
                body="Nothing here means every eval scores locally or through the governed model judge — that is the shipped posture, not a gap."
              />
            ) : (
              <Table
                rows={scorers.data?.scorers ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "name", header: "Name", render: (r) => <code>{r.name}</code> },
                  { key: "url", header: "Endpoint", render: (r) => <code>{r.baseUrl}</code> },
                  {
                    key: "kinds",
                    header: "Claims to serve",
                    render: (r) => <span className={v.faint}>{r.scorerKinds.join(", ")}</span>,
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (r) =>
                      r.enabled ? (
                        <Badge tone="ok">enabled</Badge>
                      ) : r.lastTestError ? (
                        <Badge tone="danger" title={r.lastTestError}>
                          last test failed
                        </Badge>
                      ) : r.lastTestedAt ? (
                        <Badge tone="info">tested {ago(r.lastTestedAt)} — enable it</Badge>
                      ) : (
                        <Badge tone="warn">never tested</Badge>
                      ),
                  },
                  {
                    key: "auth",
                    header: "Auth",
                    render: (r) => (r.hasApiKey ? "secret set" : "keyless"),
                  },
                  {
                    key: "actions",
                    header: "",
                    render: (r) => (
                      <div className={v.row}>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={act.busy}
                          onClick={() =>
                            void act.run(
                              () => api.post(`/v1/external-scorers/${r.id}/test`, {}),
                              `Connection test for '${r.name}' passed`,
                            )
                          }
                        >
                          Test
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={act.busy}
                          onClick={() =>
                            void act.run(
                              () =>
                                api.post(`/v1/external-scorers/${r.id}/enabled`, {
                                  enabled: !r.enabled,
                                }),
                              r.enabled ? `'${r.name}' disabled` : `'${r.name}' enabled`,
                            )
                          }
                        >
                          {r.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => setRemoving(r)}>
                          Remove
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            )}
            <p className={v.faint}>
              The last failed test&apos;s reason is kept on the row (hover the badge). Moving an
              endpoint disables the scorer until a fresh test passes. Removing a scorer that a
              dataset still names makes that dataset&apos;s next run refuse with{" "}
              <code>external_scorer_unknown</code> — it never silently scores another way.
            </p>
          </Card>
        </QueryGate>
      </div>
      <ConfirmModal
        open={removing !== null}
        title="Remove external scorer?"
        body={
          removing
            ? `'${removing.name}' will be removed. Any dataset whose scorer config still names it will refuse its next run with external_scorer_unknown.`
            : ""
        }
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) {
            void act.run(
              () => api.del(`/v1/external-scorers/${target.id}`),
              `External scorer '${target.name}' removed`,
            );
          }
        }}
      />
    </>
  );
}
