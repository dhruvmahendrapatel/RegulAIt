/**
 * Custom LLM providers (ADR-0034) — the admin surface for pointing RegulAIt at
 * an endpoint we do not own: Ollama, vLLM, LM Studio, LocalAI, Azure OpenAI, a
 * Bedrock proxy, an internal gateway. Pillar 3's air-gapped mode has no model
 * story without it.
 *
 * THIS PAGE IS A SECURITY SURFACE, so it teaches the model rather than hiding
 * it. Three things drive every design choice here:
 *
 *  1. THE LIFECYCLE IS register → test → enable, AND IT IS NOT OPTIONAL. A
 *     provider is registered DISABLED; enabling one that has not passed a
 *     connection test is refused; moving `baseUrl` (or the plaintext flag)
 *     DISABLES it and clears `lastTestedAt`, so the gate re-arms. Every row
 *     therefore shows where it actually is in that sequence — never tested /
 *     tested OK at <time> / last test failed: <reason> — instead of leaving an
 *     admin to discover the rule from an error toast.
 *
 *  2. REFUSALS ARE SHOWN VERBATIM. A blocked destination is a `403
 *     egress_blocked` carrying a real reason; a failed connection test is a
 *     real `502` carrying the upstream's own message. Both are rendered word
 *     for word, with the gateway's own code. Flattening either into "something
 *     went wrong" would delete the only output the egress guard exists to
 *     produce: WHY a destination was refused.
 *
 *  3. THE UI TEACHES, THE SERVER DECIDES. Everything advisory on this page —
 *     the pre-flight gap list, the "enable is gated" note — is computed from
 *     what the browser can know for certain (the allow-list rows, the two
 *     plaintext flags, a literal private address). It never suppresses the
 *     request: the gateway re-resolves and re-checks every destination on
 *     every dispatch and again per HTTP request, because DNS can be re-pointed
 *     after an admin approves a host. So the advice is labelled as advice, and
 *     the authoritative answer always comes back from the gateway.
 *
 * The stored API key is never displayed or requested back — the API's read
 * projection has no field for it, only `hasApiKey`. A KEYLESS endpoint is a
 * first-class, supported case (local Ollama authenticates by network
 * position), not a misconfiguration.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import type {
  ConnectionTestResult,
  CustomModelProvider,
  CustomWireProtocol,
  EgressAllowHost,
  OrgSettingsResponse,
} from "../../../api/adminTypes";
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
  Modal,
  Select,
  Table,
} from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { useAdminInvalidate, useAgents, useCustomProviders, useEgressAllowHosts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import c from "./customProviders.module.css";

const WIRE_PROTOCOLS: Array<{ v: CustomWireProtocol; l: string }> = [
  { v: "openai_chat", l: "openai_chat — /chat/completions (Ollama, vLLM, LM Studio, LocalAI, Azure OpenAI)" },
  { v: "anthropic_messages", l: "anthropic_messages — /v1/messages (an Anthropic-compatible gateway)" },
];

// ---------------------------------------------------------------------------
// outcomes — one honest place for what the gateway just said
// ---------------------------------------------------------------------------

interface Outcome {
  kind: "ok" | "deny";
  /** which provider / host the outcome belongs to */
  subject: string;
  title: string;
  /** the gateway's machine code (`egress_blocked`, `connection_test_required`…) */
  code?: string;
  /** the egress guard's finer-grained verdict, when it sent one
   * (`host_not_allowlisted`, `plaintext_http_forbidden`, `blocked_address_range`…) */
  subCode?: string;
  /** the gateway's own words — rendered verbatim, never paraphrased */
  reason: string;
}

/** Map a gateway refusal onto a heading WITHOUT touching its reason text. */
function outcomeTitle(status: number, code: string | undefined): string {
  if (code === "egress_blocked") return "Egress refused";
  if (code === "connection_test_required") return "Enable is gated — no connection test has passed";
  if (code === "connection_test_failed") return "Connection test failed";
  if (code === "custom_providers_disabled") return "Custom providers are switched off for this organisation";
  if (code === "custom_provider_in_use") return "Still bound to an agent";
  if (code === "duplicate_name") return "That name is taken";
  if (code === "no_data_key") return "The server has no data key to encrypt a key with";
  if (status === 403) return "Refused";
  if (status >= 500) return "The endpoint answered with an error";
  return "Refused";
}

function toOutcome(subject: string, err: unknown): Outcome {
  if (err instanceof ApiError) {
    // `error` is the refusal's identity (`egress_blocked`); `code`, when the
    // guard sent one, is its finer verdict (`host_not_allowlisted`). Both are
    // shown — collapsing them would throw away the specific half.
    const code = err.payload.error;
    const sub = typeof err.payload.code === "string" ? err.payload.code : undefined;
    const reason =
      (typeof err.payload.detail === "string" && err.payload.detail) ||
      (typeof err.payload.message === "string" && err.payload.message) ||
      err.message;
    return {
      kind: "deny",
      subject,
      title: outcomeTitle(err.status, code),
      ...(code ? { code } : {}),
      ...(sub && sub !== code ? { subCode: sub } : {}),
      reason,
    };
  }
  return {
    kind: "deny",
    subject,
    title: "Refused",
    reason: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Run one write, keep the gateway's structured answer. The shared `useAction`
 * flattens an error to a string; this surface needs the CODE and the DETAIL
 * separately, because "which refusal was this" is the whole product here.
 */
function useGuardedAction() {
  const { toast } = useToast();
  const invalidate = useAdminInvalidate();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async (
    subject: string,
    fn: () => Promise<unknown>,
    ok: { title: string; reason: string },
  ): Promise<boolean> => {
    setBusy(true);
    setOutcome(null);
    try {
      await fn();
      setOutcome({ kind: "ok", subject, title: ok.title, reason: ok.reason });
      toast(ok.title, "success");
      invalidate();
      return true;
    } catch (err) {
      const o = toOutcome(subject, err);
      setOutcome(o);
      // The toast is the notification; the panel is the record. Both carry the
      // gateway's own reason — neither is allowed to say "something went wrong".
      toast(`${o.title} — ${o.reason}`, "error");
      invalidate();
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, outcome, setOutcome, run };
}

function OutcomePanel(props: { outcome: Outcome | null; fixes?: Fix[]; testId?: string }) {
  const o = props.outcome;
  return (
    // aria-live so a refusal announces itself: the reason is the point of the
    // guard, and a screen-reader user must not have to go hunting for it.
    <div aria-live="polite" data-testid={props.testId}>
      {o && (
        <div className={[c.panel, o.kind === "ok" ? c.panelOk : c.panelDeny].join(" ")} role={o.kind === "deny" ? "alert" : undefined}>
          <div className={c.panelHead}>
            <span>{o.title}</span>
            {o.code && <span className={c.panelCode}>{o.code}</span>}
            {o.subCode && <span className={c.panelCode}>{o.subCode}</span>}
            <span className={v.grow} />
            <span className={v.faint}>{o.subject}</span>
          </div>
          <div className={c.panelReason} data-testid="outcome-reason">
            {o.reason}
          </div>
          {o.kind === "deny" && props.fixes && props.fixes.length > 0 && (
            <>
              <div className={c.panelFixTitle}>What is still missing</div>
              <ul className={c.fixList}>
                {props.fixes.map((f) => (
                  <li key={f.key}>{f.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// advisory pre-flight — only what the browser can know FOR CERTAIN
// ---------------------------------------------------------------------------

export interface Fix {
  key: string;
  text: ReactNode;
}

const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa"];
const BLOCKED_HOST_EXACT = new Set(["localhost", "local", "internal"]);

function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/**
 * A conservative mirror of the parts of the gateway's guard that need no DNS:
 * the private-namespace host suffixes and unambiguous private IP literals. It
 * deliberately answers only "definitely private" — everything that depends on
 * resolving a name stays the gateway's call, and is reported by the gateway.
 */
function looksPrivate(host: string): boolean {
  const h = normalizeHost(host);
  if (BLOCKED_HOST_EXACT.has(h)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  if (x === 0 || x === 10 || x === 127) return true;
  if (x === 169 && y === 254) return true; // link-local — the IMDS range
  if (x === 172 && y >= 16 && y <= 31) return true;
  if (x === 192 && y === 168) return true;
  if (x === 100 && y >= 64 && y <= 127) return true; // CGNAT
  if (x >= 224) return true; // multicast + reserved
  return false;
}

/**
 * What an admin still has to do before this URL could be reached — named
 * precisely, one item per missing decision. THE TWO-FLAG PLAINTEXT RULE IS THE
 * REASON THIS EXISTS: plaintext http needs the allow-list row's opt-in AND the
 * provider's, and "one is set, the other is not" must read as exactly that,
 * not as a generic failure.
 */
function egressGaps(
  baseUrl: string,
  hosts: EgressAllowHost[],
  providerAllowsPlaintextHttp: boolean,
): Fix[] {
  const raw = baseUrl.trim();
  if (!raw) return [];
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return [{ key: "url", text: "This is not an absolute URL — it needs a scheme, e.g. https://models.example.com/v1." }];
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return [
      {
        key: "scheme",
        text: (
          <>
            Only <code>http</code> and <code>https</code> endpoints can be registered.
          </>
        ),
      },
    ];
  }
  if (u.username !== "" || u.password !== "") {
    return [
      {
        key: "userinfo",
        text: "Credentials in the URL (user:pass@host) are refused outright — the host would be ambiguous to a reviewer. Put the key in the API-key field instead.",
      },
    ];
  }
  const host = normalizeHost(u.hostname);
  if (!host) return [{ key: "host", text: "This URL has no host." }];

  const entry = hosts.find((h) => normalizeHost(h.host) === host);
  const out: Fix[] = [];
  if (!entry) {
    out.push({
      key: "allowlist",
      text: (
        <>
          <strong>{host}</strong> is not on the egress allow-list. Add it under “Egress allow-list” below —
          nothing is reachable until an admin grants the destination.
        </>
      ),
    });
    // Say the rest anyway, so adding the row and its opt-ins is ONE trip.
    if (u.protocol === "http:") {
      out.push({
        key: "plaintext-host-new",
        text: (
          <>
            This is plaintext <code>http</code>, so that new allow-list row must also tick{" "}
            <strong>Allow plaintext HTTP</strong>.
          </>
        ),
      });
    }
    if (looksPrivate(host)) {
      out.push({
        key: "private-new",
        text: (
          <>
            <strong>{host}</strong> is a private/loopback destination, so that row must also tick{" "}
            <strong>Allow private ranges</strong>.
          </>
        ),
      });
    }
  } else {
    if (u.protocol === "http:" && !entry.allowPlaintextHttp) {
      out.push({
        key: "plaintext-host",
        text: (
          <>
            Plaintext <code>http</code> needs the <em>allow-list row</em> for <strong>{host}</strong> to tick{" "}
            <strong>Allow plaintext HTTP</strong> — it currently does not.
          </>
        ),
      });
    }
    if (looksPrivate(host) && !entry.allowPrivateRanges) {
      out.push({
        key: "private",
        text: (
          <>
            <strong>{host}</strong> is a private/loopback destination, so its allow-list row must tick{" "}
            <strong>Allow private ranges</strong> — it currently does not.
          </>
        ),
      });
    }
  }
  // THE SECOND FLAG. Named separately from the first, always, so an admin who
  // set one and not the other is told which one is still missing.
  if (u.protocol === "http:" && !providerAllowsPlaintextHttp) {
    out.push({
      key: "plaintext-provider",
      text: (
        <>
          Plaintext <code>http</code> needs <em>both</em> opt-ins: this <strong>provider</strong> must tick{" "}
          <strong>Allow plaintext HTTP</strong> as well as the allow-list row. One flag is a typo; two flags
          are a decision.
        </>
      ),
    });
  }
  return out;
}

function PreflightNote(props: { baseUrl: string; gaps: Fix[]; testId?: string }) {
  if (!props.baseUrl.trim()) return null;
  if (props.gaps.length === 0) {
    return (
      <div className={[c.panel, c.panelOk].join(" ")} data-testid={props.testId}>
        <div className={c.panelHead}>Pre-flight: nothing is obviously missing</div>
        <div className={v.faint}>
          Advisory only. The gateway resolves the host and re-checks every address it answers with — at
          registration, again on every dispatch, and again per HTTP request.
        </div>
      </div>
    );
  }
  return (
    <div className={[c.panel, c.panelWarn].join(" ")} data-testid={props.testId}>
      <div className={c.panelHead}>Pre-flight: this destination would be refused</div>
      <ul className={c.fixList}>
        {props.gaps.map((f) => (
          <li key={f.key}>{f.text}</li>
        ))}
      </ul>
      <div className={v.faint}>Advisory — the gateway makes the real decision when you submit.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// connection state — the middle step of the lifecycle, made visible
// ---------------------------------------------------------------------------

interface ConnState {
  tone: "ok" | "warn" | "danger";
  label: string;
  /** the upstream's own message when the last test failed */
  detail: string | null;
  /** has a test EVER passed — this is exactly what the enable gate reads */
  gatePassed: boolean;
}

function connState(p: CustomModelProvider): ConnState {
  if (p.lastTestError) {
    return {
      tone: "danger",
      // A pass may have happened earlier: `lastTestedAt` is only ever written
      // by a pass, and a later failure does not clear it. Saying so keeps the
      // row honest about why Enable is still permitted.
      label: p.lastTestedAt ? `last test failed (last pass ${ago(p.lastTestedAt)})` : "last test failed",
      detail: p.lastTestError,
      gatePassed: p.lastTestedAt != null,
    };
  }
  if (p.lastTestedAt) {
    return { tone: "ok", label: `tested OK ${ago(p.lastTestedAt)}`, detail: null, gatePassed: true };
  }
  return { tone: "warn", label: "never tested", detail: null, gatePassed: false };
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

export default function CustomProvidersPage() {
  const providers = useCustomProviders();
  const hosts = useEgressAllowHosts();
  const org = useQuery({
    queryKey: ["admin", "org-settings"],
    queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings"),
  });

  const hostRows = hosts.data?.hosts ?? [];
  const providerRows = providers.data?.providers ?? [];
  // `undefined` while the settings are still loading — only a literal false is
  // the switch being off, so a slow request never renders the "off" banner.
  const capabilityOff = org.data?.settings.customModelProvidersEnabled === false;

  return (
    <>
      <PageHeader
        title="Custom LLM providers"
        sub="Any OpenAI- or Anthropic-compatible endpoint, governed like the rest."
        info={<p>Any OpenAI-compatible or Anthropic-Messages-compatible endpoint — Ollama, vLLM, LM Studio, LocalAI, Azure OpenAI, a Bedrock proxy, an internal gateway. An admin-typed URL is an SSRF primitive, so every destination is default-deny: allow-list the host, register (disabled), pass a connection test, then enable. This page explains the rules; the gateway enforces them and its refusals are shown here word for word.</p>}
      />
      <div className={v.stack}>
        {capabilityOff && (
          <Card>
            <div className={[c.panel, c.panelWarn].join(" ")} data-testid="capability-off">
              <div className={c.panelHead}>
                Custom LLM providers are switched off for this organisation
                <span className={c.panelCode}>customModelProvidersEnabled = false</span>
              </div>
              <div className={c.panelReason}>
                Nothing below is broken — the org master switch is off, so the gateway refuses registration
                and enablement, and every custom-provider dispatch stops with a 409 before any request
                leaves the box. Existing rows are still listed and still editable. Turn the capability back
                on under <strong>Settings → Organization → Custom LLM providers</strong>.
              </div>
            </div>
          </Card>
        )}

        <Card title="How a custom endpoint becomes usable">
          <div className={c.lifecycle}>
            <LifecycleStep
              n={1}
              title="Allow-list, then register"
              text="A destination has to be granted before it can be named, and registering NEVER enables: a new provider is stored disabled, whatever else you set."
            />
            <LifecycleStep
              n={2}
              title="Pass a connection test"
              text="A real dispatch through the egress guard, in the dialect the endpoint claims. An open TCP port is not a connection test. Only a PASS is recorded."
            />
            <LifecycleStep
              n={3}
              title="Enable"
              text="Refused while no test has passed. Later moving the endpoint URL or the plaintext flag disables the provider and clears the test — the gate re-arms."
            />
          </div>
        </Card>

        <EgressAllowListCard hosts={hostRows} loading={hosts.isLoading} providers={providerRows} />

        <ProvidersCard providers={providerRows} loading={providers.isLoading} hosts={hostRows} />

        <RegisterProviderCard hosts={hostRows} />
      </div>
    </>
  );
}

function LifecycleStep(props: { n: number; title: string; text: string }) {
  return (
    <div className={c.step}>
      {/* not aria-hidden: the ordinal IS the content here — this is a
          sequence, and "step 2 of 3" is the thing being taught. */}
      <span className={c.stepNum}>{props.n}</span>
      <div className={c.stepBody}>
        <div className={c.stepTitle}>{props.title}</div>
        <div className={c.stepText}>{props.text}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the egress allow-list — a distinct, deliberate surface
// ---------------------------------------------------------------------------

function EgressAllowListCard(props: {
  hosts: EgressAllowHost[];
  loading: boolean;
  providers: CustomModelProvider[];
}) {
  const act = useGuardedAction();
  const [host, setHost] = useState("");
  const [privateRanges, setPrivateRanges] = useState(false);
  const [plaintext, setPlaintext] = useState(false);
  const [note, setNote] = useState("");
  const [remove, setRemove] = useState<EgressAllowHost | null>(null);

  /** providers that would stop being reachable if this row went away */
  const dependants = (h: EgressAllowHost) =>
    props.providers.filter((p) => {
      try {
        return normalizeHost(new URL(p.baseUrl).hostname) === normalizeHost(h.host);
      } catch {
        return false;
      }
    });

  return (
    <Card title="Egress allow-list — the destinations this gateway may connect to at all">
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              host.trim(),
              () =>
                api.post("/v1/egress-allow-hosts", {
                  host: host.trim(),
                  allowPrivateRanges: privateRanges,
                  allowPlaintextHttp: plaintext,
                  ...(note.trim() ? { note: note.trim() } : {}),
                }),
              {
                title: "Egress destination granted",
                reason:
                  `'${host.trim()}' may now be connected to` +
                  (privateRanges ? ", WITH private-range access" : "") +
                  (plaintext ? ", WITH plaintext http" : "") +
                  ". The change is audited.",
              },
            )
            .then((ok) => {
              if (ok) {
                setHost("");
                setPrivateRanges(false);
                setPlaintext(false);
                setNote("");
              }
            });
        }}
      >
        <div className={a.formRow}>
          <Field label="Host — a bare hostname or IP literal, no scheme/port/path" grow>
            <Input
              required
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="e.g. models.internal.example.com  ·  127.0.0.1  ·  localhost"
              autoComplete="off"
              data-testid="allow-host-input"
            />
          </Field>
          <Field label="Note — why this destination is trusted (recommended)" grow>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. on-prem vLLM box, approved by security 2026-07-14 (TICKET-4412)"
              data-testid="allow-host-note"
            />
          </Field>
        </div>

        <div className={c.secBlock}>
          <div className={c.secTitle}>Security decisions — off unless you tick them</div>
          <OptIn
            id="allow-private-ranges"
            checked={privateRanges}
            onChange={setPrivateRanges}
            label="Allow private ranges"
            help="Lets THIS host resolve into an otherwise-blocked range: loopback, RFC1918, CGNAT, link-local. Link-local is where a cloud instance's own IAM credentials live, which is why it is blocked by default. Tick this only for a genuine on-prem endpoint."
          />
          <OptIn
            id="allow-plaintext-http"
            checked={plaintext}
            onChange={setPlaintext}
            label="Allow plaintext HTTP"
            help="The FIRST of the two flags plaintext http needs. The provider row must tick its own as well — one flag is a typo, two flags are a decision. Prompts and completions travel unencrypted to this host."
          />
        </div>

        <div className={v.row}>
          <Button type="submit" variant="primary" size="sm" disabled={act.busy} data-testid="add-allow-host">
            Grant this destination
          </Button>
          <span className={v.faint}>
            No wildcards on purpose — <code>*.example.com</code> is one dangling subdomain away from being a
            hole. Three hosts means three rows. Every write here is audited, and the audit reason names the
            opt-ins.
          </span>
        </div>
        <OutcomePanel outcome={act.outcome} testId="allow-host-outcome" />
      </form>

      <hr className={v.divider} />

      <Table<EgressAllowHost>
        columns={[
          {
            key: "host",
            header: "Host",
            sort: (h) => h.host,
            render: (h) => <span className={c.url}>{h.host}</span>,
          },
          {
            key: "private",
            header: "Private ranges",
            render: (h) =>
              h.allowPrivateRanges ? (
                <Badge tone="warn" title="This host may resolve into loopback / RFC1918 / CGNAT / link-local.">
                  allowed
                </Badge>
              ) : (
                <Badge title="Default-deny: a private or link-local address for this host is refused.">blocked</Badge>
              ),
          },
          {
            key: "plaintext",
            header: "Plaintext HTTP",
            render: (h) =>
              h.allowPlaintextHttp ? (
                <Badge tone="warn" title="Half of the two-flag rule. The provider must opt in too.">
                  allowed (host half)
                </Badge>
              ) : (
                <Badge title="https only for this host.">https only</Badge>
              ),
          },
          { key: "note", header: "Note", render: (h) => h.note ?? <span className={v.faint}>—</span> },
          { key: "added", header: "Added", sort: (h) => h.createdAt, render: (h) => ago(h.createdAt) },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (h) => (
              <Button size="sm" variant="danger" onClick={() => setRemove(h)}>
                remove
              </Button>
            ),
          },
        ]}
        rows={props.hosts}
        rowKey={(h) => h.id}
        loading={props.loading}
        empty={
          <EmptyState
            title="No destinations granted"
            body="An empty allow-list is the default-deny posture, not a problem: with no rows, no custom endpoint is reachable at all."
          />
        }
      />

      <ConfirmModal
        open={remove !== null}
        title={remove ? `Revoke egress to ${remove.host}?` : ""}
        danger
        confirmLabel="Revoke destination"
        body={
          remove ? (
            <div className={v.stack}>
              <div>
                The gateway will stop connecting to <strong>{remove.host}</strong>. The allow-list is
                re-read on every dispatch, so this takes effect immediately — not at the next restart.
              </div>
              {dependants(remove).length > 0 && (
                <div className={[c.panel, c.panelWarn].join(" ")}>
                  <div className={c.panelHead}>
                    {dependants(remove).length} provider(s) point at this host
                  </div>
                  <div className={c.panelReason}>
                    {dependants(remove)
                      .map((p) => p.name)
                      .join(", ")}{" "}
                    — their dispatches will start being refused with <code>egress_blocked</code>.
                  </div>
                </div>
              )}
            </div>
          ) : null
        }
        onCancel={() => setRemove(null)}
        onConfirm={() => {
          const h = remove;
          setRemove(null);
          if (h)
            void act.run(h.host, () => api.del(`/v1/egress-allow-hosts/${h.id}`), {
              title: "Egress destination revoked",
              reason: `'${h.host}' can no longer be connected to. The removal is audited.`,
            });
        }}
      />
    </Card>
  );
}

/** A security opt-in: an explicit checkbox with its own id/label pairing and a
 * sentence saying what ticking it actually permits. */
function OptIn(props: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  help: string;
}) {
  const helpId = `${props.id}-help`;
  return (
    <div className={c.optIn}>
      <input
        type="checkbox"
        id={props.id}
        checked={props.checked}
        aria-describedby={helpId}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className={c.optInText}>
        <label className={c.optInLabel} htmlFor={props.id}>
          {props.label}
        </label>
        <span className={c.optInHelp} id={helpId}>
          {props.help}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// registered providers
// ---------------------------------------------------------------------------

function ProvidersCard(props: {
  providers: CustomModelProvider[];
  loading: boolean;
  hosts: EgressAllowHost[];
}) {
  const act = useGuardedAction();
  const agents = useAgents();
  const [edit, setEdit] = useState<CustomModelProvider | null>(null);
  const [remove, setRemove] = useState<CustomModelProvider | null>(null);
  /** which provider the visible outcome belongs to, for the fix list */
  const [subject, setSubject] = useState<CustomModelProvider | null>(null);

  const boundAgents = (p: CustomModelProvider) =>
    (agents.data?.agents ?? []).filter((x) => x.customProviderId === p.id);

  const fixes = useMemo(
    () =>
      subject && act.outcome?.kind === "deny" && act.outcome.code === "egress_blocked"
        ? egressGaps(subject.baseUrl, props.hosts, subject.allowPlaintextHttp)
        : [],
    [subject, act.outcome, props.hosts],
  );

  const test = (p: CustomModelProvider) => {
    setSubject(p);
    void act.run(
      p.name,
      async () => {
        const r = await api.post<ConnectionTestResult>(`/v1/custom-model-providers/${p.id}/test`);
        return r;
      },
      {
        title: "Connection test passed",
        reason: `${p.name} answered ${p.wireProtocol} at ${p.baseUrl}. The pass is recorded, so this provider can now be enabled.`,
      },
    );
  };

  const setEnabled = (p: CustomModelProvider, enabled: boolean) => {
    setSubject(p);
    void act.run(
      p.name,
      () => api.post(`/v1/custom-model-providers/${p.id}/enabled`, { enabled }),
      {
        title: enabled ? "Provider enabled" : "Provider disabled",
        reason: enabled
          ? `${p.name} is now selectable when binding an agent, and its dispatches will go to ${p.baseUrl}.`
          : `${p.name} is off. Agents bound to it stop dispatching immediately.`,
      },
    );
  };

  return (
    <Card flush title="Registered endpoints">
      <Table<CustomModelProvider>
        columns={[
          { key: "name", header: "Name", sort: (p) => p.name, render: (p) => p.name },
          {
            key: "wire",
            header: "Wire protocol",
            sort: (p) => p.wireProtocol,
            render: (p) => <span className={v.mono}>{p.wireProtocol}</span>,
          },
          {
            key: "endpoint",
            header: "Endpoint",
            render: (p) => (
              <>
                <span className={c.url}>{p.baseUrl}</span>
                {p.baseUrl.startsWith("http://") && (
                  <span className={c.gateNote}>
                    plaintext · provider opt-in {p.allowPlaintextHttp ? "SET" : "NOT set"}
                  </span>
                )}
              </>
            ),
          },
          {
            key: "key",
            header: "Key",
            render: (p) =>
              p.hasApiKey ? (
                <Badge tone="info" title="A key is stored, encrypted. It is never returned by any endpoint — it can only be replaced.">
                  a key is set
                </Badge>
              ) : (
                <Badge title="No credential header is sent at all. Normal for a local Ollama / LocalAI / network-authenticated gateway.">
                  no key (unauthenticated endpoint)
                </Badge>
              ),
          },
          {
            key: "connection",
            header: "Connection",
            sort: (p) => connState(p).label,
            render: (p) => {
              const s = connState(p);
              return (
                <>
                  <Badge tone={s.tone} title={s.detail ?? undefined}>
                    {s.label}
                  </Badge>
                  {s.detail && (
                    <span className={c.gateNote} data-testid={`test-error-${p.name}`}>
                      {s.detail}
                    </span>
                  )}
                  {!s.gatePassed && (
                    <span className={c.gateNote} id={`gate-${p.id}`}>
                      Enable is gated until a connection test passes.
                    </span>
                  )}
                </>
              );
            },
          },
          {
            key: "status",
            header: "Status",
            sort: (p) => (p.enabled ? 0 : 1),
            render: (p) =>
              p.enabled ? (
                <Badge tone="ok">enabled</Badge>
              ) : (
                <Badge title="Registration never enables, and moving the endpoint disables again.">disabled</Badge>
              ),
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (p) => {
              const s = connState(p);
              return (
                <span className={c.actions}>
                  <Button size="sm" disabled={act.busy} onClick={() => test(p)} data-testid={`test-${p.name}`}>
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant={p.enabled ? "default" : "primary"}
                    disabled={act.busy}
                    // Not disabled when the gate is armed: the gateway owns
                    // that decision and answers with its own reason. The note
                    // in the Connection column says so BEFORE the click, so
                    // the 409 confirms a rule already stated rather than
                    // teaching it.
                    aria-describedby={!p.enabled && !s.gatePassed ? `gate-${p.id}` : undefined}
                    onClick={() => setEnabled(p, !p.enabled)}
                    data-testid={`${p.enabled ? "disable" : "enable"}-${p.name}`}
                  >
                    {p.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" onClick={() => setEdit(p)} data-testid={`edit-${p.name}`}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setRemove(p)}>
                    Remove
                  </Button>
                </span>
              );
            },
          },
        ]}
        rows={props.providers}
        rowKey={(p) => p.id}
        loading={props.loading}
        empty={
          <EmptyState
            title="No custom endpoints registered"
            body="Grant the destination above, then register the endpoint below. Registration stores it disabled."
          />
        }
      />
      <div style={{ padding: "var(--s2)" }}>
        <OutcomePanel outcome={act.outcome} fixes={fixes} testId="provider-outcome" />
      </div>

      {edit && (
        <EditProviderModal
          provider={edit}
          hosts={props.hosts}
          onClose={() => setEdit(null)}
          onSubject={setSubject}
        />
      )}

      <ConfirmModal
        open={remove !== null}
        title={remove ? `Remove ${remove.name}?` : ""}
        danger
        confirmLabel="Remove endpoint"
        body={
          remove ? (
            <div className={v.stack}>
              <div>
                The endpoint row and its stored key are deleted. Removal is refused while any agent still
                points at it — an endpoint an agent depends on must not vanish underneath it.
              </div>
              {boundAgents(remove).length > 0 && (
                <div className={[c.panel, c.panelWarn].join(" ")}>
                  <div className={c.panelHead}>{boundAgents(remove).length} agent(s) are bound to it</div>
                  <div className={c.panelReason}>
                    {boundAgents(remove)
                      .map((x) => x.name)
                      .join(", ")}{" "}
                    — the gateway will answer <code>custom_provider_in_use</code> until they are repointed.
                  </div>
                </div>
              )}
            </div>
          ) : null
        }
        onCancel={() => setRemove(null)}
        onConfirm={() => {
          const p = remove;
          setRemove(null);
          if (p) {
            setSubject(p);
            void act.run(p.name, () => api.del(`/v1/custom-model-providers/${p.id}`), {
              title: "Endpoint removed",
              reason: `${p.name} is gone. The removal is audited.`,
            });
          }
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

function RegisterProviderCard(props: { hosts: EgressAllowHost[] }) {
  const act = useGuardedAction();
  const [name, setName] = useState("");
  const [wireProtocol, setWireProtocol] = useState<CustomWireProtocol>("openai_chat");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [plaintext, setPlaintext] = useState(false);

  const gaps = useMemo(
    () => egressGaps(baseUrl, props.hosts, plaintext),
    [baseUrl, props.hosts, plaintext],
  );

  return (
    <Card title="Register an endpoint">
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              name.trim(),
              () =>
                api.post("/v1/custom-model-providers", {
                  name: name.trim(),
                  wireProtocol,
                  baseUrl: baseUrl.trim(),
                  // null/absent is a KEYLESS endpoint, and that is a real,
                  // supported configuration — not an unfinished form.
                  ...(apiKey ? { apiKey } : {}),
                  allowPlaintextHttp: plaintext,
                }),
              {
                title: "Endpoint registered — disabled",
                reason:
                  "Registration never enables. Run a connection test on the row above; only a passing test unlocks Enable.",
              },
            )
            .then((ok) => {
              if (ok) {
                setName("");
                setBaseUrl("");
                setApiKey("");
                setPlaintext(false);
              }
            });
        }}
      >
        <div className={a.formRow}>
          <Field label="Name">
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. on-prem-vllm"
              data-testid="provider-name"
            />
          </Field>
          <Field label="Wire protocol" grow>
            <Select
              value={wireProtocol}
              onChange={(e) => setWireProtocol(e.target.value as CustomWireProtocol)}
              data-testid="provider-wire"
            >
              {WIRE_PROTOCOLS.map((p) => (
                <option key={p.v} value={p.v}>
                  {p.l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className={a.formRow}>
          <Field label="Base URL" grow>
            <Input
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://models.internal.example.com/v1"
              autoComplete="off"
              data-testid="provider-base-url"
            />
          </Field>
          <Field label="API key — optional; blank means a keyless endpoint" grow>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="leave blank for an unauthenticated endpoint"
              autoComplete="off"
              data-testid="provider-api-key"
            />
          </Field>
        </div>

        <div className={c.secBlock}>
          <div className={c.secTitle}>Security decision — off unless you tick it</div>
          <OptIn
            id="provider-plaintext"
            checked={plaintext}
            onChange={setPlaintext}
            label="Allow plaintext HTTP (provider half)"
            help="The SECOND of the two flags. Plaintext http only works when the allow-list row for the host has ticked its own Allow plaintext HTTP as well as this one. Changing this flag later disables the provider and clears its connection test."
          />
        </div>

        <PreflightNote baseUrl={baseUrl} gaps={gaps} testId="register-preflight" />

        <div className={v.row}>
          <Button type="submit" variant="primary" disabled={act.busy} data-testid="register-provider">
            Register (stored disabled)
          </Button>
          <span className={v.faint}>
            A key, if you give one, is sent once and stored AES-256-GCM encrypted. No endpoint ever returns
            it — this page can only replace it, never reveal it. A keyless endpoint sends no credential
            header at all.
          </span>
        </div>
        <OutcomePanel outcome={act.outcome} fixes={act.outcome?.kind === "deny" ? gaps : []} testId="register-outcome" />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

/** Three-state key control. There is no fourth state where the current value
 * is shown, because the API has never returned it and never will. */
type KeyMode = "keep" | "replace" | "clear";

function EditProviderModal(props: {
  provider: CustomModelProvider;
  hosts: EgressAllowHost[];
  onClose: () => void;
  onSubject: (p: CustomModelProvider) => void;
}) {
  const p = props.provider;
  const act = useGuardedAction();
  const [name, setName] = useState(p.name);
  const [wireProtocol, setWireProtocol] = useState<CustomWireProtocol>(p.wireProtocol);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [plaintext, setPlaintext] = useState(p.allowPlaintextHttp);
  const [keyMode, setKeyMode] = useState<KeyMode>("keep");
  const [apiKey, setApiKey] = useState("");

  // exactly the condition the gateway calls "endpointMoved"
  const rearms = baseUrl.trim() !== p.baseUrl || plaintext !== p.allowPlaintextHttp;
  const gaps = useMemo(() => egressGaps(baseUrl, props.hosts, plaintext), [baseUrl, props.hosts, plaintext]);

  const submit = () => {
    props.onSubject(p);
    void act
      .run(
        p.name,
        () =>
          api.patch(`/v1/custom-model-providers/${p.id}`, {
            ...(name.trim() !== p.name ? { name: name.trim() } : {}),
            ...(wireProtocol !== p.wireProtocol ? { wireProtocol } : {}),
            ...(baseUrl.trim() !== p.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
            ...(plaintext !== p.allowPlaintextHttp ? { allowPlaintextHttp: plaintext } : {}),
            // null CLEARS the stored key (the endpoint becomes keyless);
            // omitting the field keeps whatever is there.
            ...(keyMode === "replace" ? { apiKey } : {}),
            ...(keyMode === "clear" ? { apiKey: null } : {}),
          }),
        {
          title: rearms ? "Endpoint moved — provider disabled, test cleared" : "Endpoint updated",
          reason: rearms
            ? `${p.name} now points at ${baseUrl.trim()}. Because the endpoint changed, the gate re-armed: it is disabled and untested again, and needs a fresh connection test before it can be enabled.`
            : `${p.name} updated.`,
        },
      )
      .then((ok) => ok && props.onClose());
  };

  return (
    <Modal
      open
      wide
      title={`Edit ${p.name}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={act.busy} data-testid="save-provider-edit">
            Save changes
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {rearms && (
          <div className={[c.panel, c.panelWarn].join(" ")} data-testid="rearm-warning">
            <div className={c.panelHead}>This change re-arms the gate</div>
            <div className={c.panelReason}>
              Moving the endpoint URL or the plaintext flag <strong>disables this provider and clears its
              connection test</strong>. Otherwise a test could be passed once against a safe endpoint and
              then edited around. You will need to test again before it can be enabled.
            </div>
          </div>
        )}
        <div className={a.formRow}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="edit-name" />
          </Field>
          <Field label="Wire protocol" grow>
            <Select value={wireProtocol} onChange={(e) => setWireProtocol(e.target.value as CustomWireProtocol)}>
              {WIRE_PROTOCOLS.map((w) => (
                <option key={w.v} value={w.v}>
                  {w.l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Base URL">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} data-testid="edit-base-url" />
        </Field>

        <div className={a.formRow}>
          <Field label={`API key — currently: ${p.hasApiKey ? "a key is set" : "no key (unauthenticated endpoint)"}`}>
            <Select value={keyMode} onChange={(e) => setKeyMode(e.target.value as KeyMode)}>
              <option value="keep">leave unchanged</option>
              <option value="replace">replace with a new key</option>
              <option value="clear">remove the key (make it keyless)</option>
            </Select>
          </Field>
          {keyMode === "replace" && (
            <Field label="New key" grow>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
            </Field>
          )}
        </div>
        <p className={v.faint}>
          The stored key is never returned by any endpoint, so it cannot be shown here — only replaced or
          removed. Removing it is legitimate: a local Ollama or LocalAI endpoint has no key, and a keyless
          provider sends no credential header at all.
        </p>

        <div className={c.secBlock}>
          <div className={c.secTitle}>Security decision</div>
          <OptIn
            id="edit-plaintext"
            checked={plaintext}
            onChange={setPlaintext}
            label="Allow plaintext HTTP (provider half)"
            help="Plaintext http needs this AND the allow-list row's own flag. Changing this re-arms the connection-test gate."
          />
        </div>

        <PreflightNote baseUrl={baseUrl} gaps={gaps} testId="edit-preflight" />
        <OutcomePanel outcome={act.outcome} fixes={act.outcome?.kind === "deny" ? gaps : []} testId="edit-outcome" />
      </div>
    </Modal>
  );
}
