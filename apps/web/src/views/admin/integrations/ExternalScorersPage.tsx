/**
 * External eval scorers (ADR-0088) — the admin surface for plugging a
 * third-party scoring endpoint the operator runs or buys into the eval
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
 * Two uses, kept apart on the page (CXR-ADM-002): an EVAL use (a judge-backed
 * scorer names the instrument; the run's input/output/context go to it), and,
 * since ADR-0220, an INLINE use — a scorer claiming a `guardrail_*` kind can
 * back a trained detector on the Guardrails page, and then the prompt or
 * completion text of live dispatches is POSTed to it. ADR-0088's original
 * "inline stays local-detector only" boundary no longer holds and the copy
 * says so. Not here: the trained-detector settings themselves (they live on
 * the Guardrails page), any in-house scoring model, and any vendor-specific
 * API dialect: the wire contract is ours, and a vendor that speaks something
 * else gets a thin translation shim the operator controls.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import type { ExternalScorer } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Table } from "../../../ui/kit";
import { QueryGate, useAction, useEgressAllowHosts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { EditExternalScorerButton } from "../editForms";

/** the judge-backed kinds an instrument may claim, plus (ADR-0220) the three
 * guardrail kinds a trained-detector service serves on the Guardrails page —
 * the registration schema refuses anything else, so the lexical metrics are
 * not even expressible */
const CLAIMABLE_KINDS = [
  "llm_as_judge",
  "groundedness_judge",
  "answer_relevance_judge",
  "guardrail_pii",
  "guardrail_prompt_injection",
  "guardrail_harm",
] as const;

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
        sub="regulAIt governs the call and records provenance; it does not validate the instrument."
        info={<p>Bring your own scoring instrument — a scoring endpoint you run or buy — as a governed, disclosed eval scorer. regulAIt governs the call and records provenance; it does not validate the instrument.</p>}
      />
      <div className={v.stack}>
        <Card
          title="What an external score is, and is not"
          infoLabel="an external score"
          info={
            <>
              <p>
                Every eval result an external instrument scores is stamped{" "}
                <code>method: &quot;external:&lt;name&gt;&quot;</code> — never blended with the local lexical
                metrics or a model judge&apos;s verdict. A named scorer that is unknown, disabled, not claiming the
                metric, or refused by the egress guard refuses the whole run with a 422{" "}
                <em>before any row is written</em>, exactly like a missing judge. The deterministic (lexical) metrics
                never route externally. To use one: set{" "}
                <code>{"{"}&quot;externalScorer&quot;: &quot;&lt;name&gt;&quot;{"}"}</code> in a judge-backed
                scorer&apos;s config on the Evaluations page.
              </p>
              <p>
                The wire contract is ours, not the vendor&apos;s API: one POST of{" "}
                <code>{"{input, output, context, scorerKind}"}</code> returning{" "}
                <code>{"{score: 0..1, reasons?}"}</code>. A vendor that speaks a different dialect gets a thin
                translation shim you control.
              </p>
              <p>
                <strong>Two uses, and where your text goes.</strong>
              </p>
              <ul>
                <li>
                  <strong>Evaluations.</strong> When an eval run names a scorer, that run&apos;s input, output and
                  context are sent to the scorer&apos;s URL, once per scored row.
                </li>
                <li>
                  <strong>Inline trained detectors (ADR-0220).</strong> A scorer that ticks a guardrail kind
                  (<code>guardrail_pii</code>, <code>guardrail_prompt_injection</code>, <code>guardrail_harm</code>) can
                  back a trained detector. Once a detector is turned on, the prompt or completion text of live
                  requests is sent to that scorer&apos;s URL during the request, through the egress guard. Nothing is
                  sent inline until an admin turns a detector on, in the Trained detectors tab of the{" "}
                  <Link className={v.inlineLink} to="/admin/guardrails">Guardrails</Link> page.
                </li>
              </ul>
            </>
          }
        >
          <p className={v.faint}>
            An external score is <strong>the vendor&apos;s opinion</strong>. A scorer is used by evaluations, and
            inline on live requests only when it backs a trained detector that an admin has turned on (Trained
            detectors tab of <Link className={v.inlineLink} to="/admin/guardrails">Guardrails</Link>).
          </p>
        </Card>

        <QueryGate
          query={scorers}
        >
          <Card
            title="Register a scoring endpoint"
            info={
              <p>
                The endpoint URL is a typed destination under the same egress governance as a custom LLM provider:
                its host must be in the egress allow-list (managed on the Custom LLM providers page), private ranges
                and plaintext http are per-host opt-ins, and the guard re-checks on every request.
              </p>
            }
          >
            <p className={v.faint}>
              A new scorer registers <strong>disabled</strong> until its connection test passes.
              {(hosts.data?.hosts ?? []).length === 0 && (
                <>
                  {" "}
                  <Badge tone="warn" info="The allow-list is currently empty, so no endpoint is reachable yet.">
                    Egress allow-list empty
                  </Badge>
                </>
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
                <span className={v.faint}>Claims to serve (evaluation kinds, and the guardrail kinds used by trained detectors)</span>
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

          <Card
            title="Registered scorers"
            info={
              <p>
                With none registered, every eval scores locally or through the governed model judge — that is the
                shipped posture, not a gap. The last failed test&apos;s reason is kept on the row (open the (i) beside
                the badge). Moving an endpoint disables the scorer until a fresh test passes. Removing a scorer that a
                dataset still names makes that dataset&apos;s next run refuse with <code>external_scorer_unknown</code>{" "}
                — it never silently scores another way.
              </p>
            }
          >
            {(scorers.data?.scorers ?? []).length === 0 ? (
              <EmptyState title="No external scorers registered" />
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
                        <Badge tone="danger" infoLabel={`why the last test of ${r.name} failed`} info={r.lastTestError}>
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
                    srHeader: "Actions",
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
                              // enabling a scorer an enabled trained detector uses is a settings_relax step-up
                              // (external-scorers.ts); withStepUp opens the proof and resends this exact call
                              () =>
                                withStepUp((h) =>
                                  stepUpApi.post(`/v1/external-scorers/${r.id}/enabled`, { enabled: !r.enabled }, h),
                                ),
                              r.enabled ? `'${r.name}' disabled` : `'${r.name}' enabled`,
                            )
                          }
                        >
                          {r.enabled ? "Disable" : "Enable"}
                        </Button>
                        <EditExternalScorerButton scorer={r} />
                        <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => setRemoving(r)}>
                          Remove
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            )}
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
