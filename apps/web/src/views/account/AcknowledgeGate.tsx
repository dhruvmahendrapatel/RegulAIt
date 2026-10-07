/**
 * ADR-0182 (ADR-0175 batch D4) A14 — THE ACKNOWLEDGEMENT INTERSTITIAL. OWNER: A14 (D4).
 *
 * Mounted by the app shell (AppShell.tsx, P0's) around every signed-in page. When an AI policy or training applies
 * to the person (GET /v1/me/ai-literacy) and they have not acknowledged its current version, this asks them to,
 * before the page behind it. The gateway enforces the same rule on governed calls (`ai-literacy-not-current`), so
 * this screen is the explanation and the way through, not the control: "Not now" lets a person reach the rest of
 * the product for this browser session (a banner stays on every page), and their governed calls stay refused
 * until they acknowledge while the organisation's gate is set to enforce.
 *
 * The Account page is never interrupted: it carries the same list (`LiteracyDocumentList`), so the way through is
 * always reachable. Nothing applies, a bootstrap identity, a break-glass admin, or the gate off: the page renders
 * unchanged. Copy follows Article 4 as amended by Regulation (EU) 2026/1744 ("support the development of AI
 * literacy"); it never claims to guarantee any level of literacy.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import { fmtAt, plural } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { Badge, Button, Card, EmptyState, type Tone } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import v from "../views.module.css";

export type LiteracyState = "current" | "missing" | "expired" | "superseded";

export interface MyLiteracyDocument {
  documentId: string;
  key: string;
  version: number;
  kind: "acceptable_use" | "training";
  title: string;
  state: LiteracyState;
  acknowledgedAt: string | null;
  expiresAt: string | null;
  method: "acknowledged" | "training_completed" | "admin_recorded" | null;
  acknowledgedVersion: number | null;
  url: string | null;
  attachmentId: string | null;
  contentDigest: string;
  validityDays: number;
  editorial: boolean;
  expiresSoon: boolean;
}

export interface MyLiteracy {
  required: boolean;
  current: boolean;
  documents: MyLiteracyDocument[];
  gateMode: "off" | "warn" | "enforce";
  exempt: "bootstrap" | "break_glass" | null;
  noticeDays: number;
}

export const MY_LITERACY_KEY = ["me", "ai-literacy"] as const;

/** a response of the wrong shape (an older gateway, a proxy page) is treated as "nothing to ask", never a crash */
function asMyLiteracy(x: unknown): MyLiteracy | null {
  const d = x as Partial<MyLiteracy> | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.documents) || typeof d.required !== "boolean") return null;
  return d as MyLiteracy;
}

export function useMyLiteracy(enabled: boolean) {
  return useQuery({
    queryKey: MY_LITERACY_KEY,
    queryFn: async () => asMyLiteracy(await api.get<unknown>("/v1/me/ai-literacy")),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export const STATE_TEXT: Record<LiteracyState, { label: string; tone: Tone }> = {
  current: { label: "acknowledged", tone: "ok" },
  missing: { label: "not yet acknowledged", tone: "warn" },
  expired: { label: "acknowledgement expired", tone: "warn" },
  superseded: { label: "new version to acknowledge", tone: "warn" },
};

/**
 * D4A-04: a policy link is opened only when it is an `https:` address (mirrors `aiPolicyHref` in @regulait/shared,
 * which the gateway's schema enforces on write). Anything else — `javascript:`, `data:`, plain `http:` — is shown as
 * text, never as a link a person is asked to open.
 */
export function policyHref(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export const KIND_TEXT: Record<string, string> = {
  acceptable_use: "Acceptable-use policy",
  training: "Training",
};

/** the list of applicable documents with the self-acknowledgement action; used here and on the Account page */
export function LiteracyDocumentList(props: { data: MyLiteracy }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const acknowledge = async (d: MyLiteracyDocument) => {
    setBusy(d.documentId);
    setError(null);
    try {
      await api.post(`/v1/ai-policies/${d.documentId}/acknowledge`, { version: d.version, digest: d.contentDigest });
      toast(`Acknowledged “${d.title}” (version ${d.version}). Recorded in the audit trail.`, "success");
      await qc.invalidateQueries({ queryKey: MY_LITERACY_KEY });
    } catch (err) {
      setError(
        err instanceof ApiError && err.payload.error === "ai_policy_version_mismatch"
          ? "A newer version was published while this page was open. It has been reloaded; read it and acknowledge again."
          : err instanceof ApiError && err.payload.detail
            ? err.payload.detail
            : err instanceof Error
              ? err.message
              : String(err),
      );
      await qc.invalidateQueries({ queryKey: MY_LITERACY_KEY });
    } finally {
      setBusy(null);
    }
  };

  if (props.data.documents.length === 0) {
    return <EmptyState title="Nothing to acknowledge" body="No AI policy or training applies to you right now." />;
  }
  return (
    <div className={v.stack}>
      {error && (
        <div className={v.errLine} role="alert">
          {error}
        </div>
      )}
      {props.data.documents.map((d) => {
        const st = STATE_TEXT[d.state];
        const needs = d.state !== "current" || d.expiresSoon;
        const checkId = `lit-confirm-${d.documentId}`;
        return (
          <div key={d.documentId} className={v.listRow} style={{ flexWrap: "wrap", gap: "var(--s1)", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <div className={v.rowTight}>
                <strong>{d.title}</strong>
                <Badge>{KIND_TEXT[d.kind] ?? d.kind}</Badge>
                <Badge tone={st.tone}>{st.label}</Badge>
                {d.expiresSoon && <Badge tone="info">expires soon</Badge>}
              </div>
              <div className={v.faint}>
                Version {d.version}
                {d.editorial ? " (an editorial change: your earlier acknowledgement still counts)" : ""}
                {d.expiresAt ? ` · ${d.state === "expired" ? "expired" : "valid until"} ${fmtAt(d.expiresAt)}` : ""}
                {d.method && d.method !== "acknowledged" ? " · completion recorded by an admin" : ""}
              </div>
              {policyHref(d.url) ? (
                <a href={policyHref(d.url)!} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
                  Open “{d.title}” (opens in a new tab)
                </a>
              ) : d.url ? (
                <span className={v.faint} data-testid="policy-link-unsafe">
                  Link not shown (not an https address): <span className={v.mono}>{d.url}</span>
                </span>
              ) : (
                <span className={v.faint}>Attached document {d.attachmentId}</span>
              )}
            </div>
            {needs && (
              <div className={v.rowTight} style={{ alignItems: "center" }}>
                <input
                  id={checkId}
                  type="checkbox"
                  checked={!!confirmed[d.documentId]}
                  onChange={(e) => setConfirmed({ ...confirmed, [d.documentId]: e.target.checked })}
                />
                <label htmlFor={checkId}>I have read version {d.version}</label>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy !== null || !confirmed[d.documentId]}
                  onClick={() => void acknowledge(d)}
                >
                  {busy === d.documentId ? "Recording…" : d.state === "current" ? "Acknowledge again" : "Acknowledge"}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const DISMISS_KEY = "regulait.literacy.notNow";

function dismissedFor(data: MyLiteracy): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === pendingSignature(data);
  } catch {
    return false;
  }
}
function pendingSignature(data: MyLiteracy): string {
  return data.documents
    .filter((d) => d.state !== "current")
    .map((d) => `${d.documentId}@${d.version}`)
    .join(",");
}

export default function AcknowledgeGate(props: { children: ReactNode }) {
  const { auth } = useSession();
  const location = useLocation();
  const enabled = !!auth?.userId;
  const q = useMyLiteracy(enabled);
  const [, rerender] = useState(0);
  const data = enabled ? (q.data ?? null) : null;
  const gate = useRef<HTMLDivElement>(null);
  const wasVisible = useRef(false);
  const onAccount = location.pathname.startsWith("/account");
  const visible = !!data && !data.exempt && data.gateMode !== "off" && data.required && !data.current && !onAccount && !dismissedFor(data);
  useEffect(() => {
    const main = document.getElementById("rgMain");
    const active = document.activeElement;
    // Announce replaced page content without interrupting sidebar input.
    if (visible && (active === document.body || (active && main?.contains(active)))) gate.current?.focus();
    if (!visible && wasVisible.current && active === document.body) {
      (main?.querySelector<HTMLElement>("h1") ?? main)?.focus();
    }
    wasVisible.current = visible;
  }, [visible]);
  if (!data || data.exempt || data.gateMode === "off") return <>{props.children}</>;

  const pending = data.required && !data.current;
  const soon = data.documents.filter((d) => d.state === "current" && d.expiresSoon);
  const enforce = data.gateMode === "enforce";

  if (visible) {
    return (
      <div ref={gate} tabIndex={-1} role="region" aria-label="AI policy acknowledgement">
        <Card title="Before you continue: AI policies to acknowledge">
          <div className={v.stack}>
            <p className={v.hint}>
              Your organisation asks everyone who uses AI systems through regulAIt to read and acknowledge its AI
              policies and trainings. This is one of the measures it takes to support the development of AI literacy
              (Regulation (EU) 2024/1689, Article 4, as amended). It records that you read the current version; it is
              not a test.
              {enforce
                ? " Until you acknowledge, your AI tool calls through regulAIt are refused."
                : " Your organisation records the gap but does not refuse your calls."}
            </p>
            <LiteracyDocumentList data={data} />
            <div className={v.row}>
              <span className={v.faint}>
                You can also do this later from <Link to="/account?section=ai-policies" style={{ textDecoration: "underline" }}>Account</Link>.
              </span>
              <span className={v.grow} />
              <Button
                variant="ghost"
                onClick={() => {
                  try {
                    sessionStorage.setItem(DISMISS_KEY, pendingSignature(data));
                  } catch {
                    /* storage unavailable: the interstitial simply shows again */
                  }
                  rerender((n) => n + 1);
                }}
              >
                Not now
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <>
      {pending && !onAccount && (
        <div className={v.errLine} role="status" style={{ marginBottom: "var(--s2)" }}>
          {plural(data.documents.filter((d) => d.state !== "current").length, "AI policy", "AI policies")} to
          acknowledge{enforce ? "; until then your AI tool calls through regulAIt are refused" : ""}.{" "}
          <Link to="/account?section=ai-policies" style={{ textDecoration: "underline" }}>Acknowledge now</Link>
        </div>
      )}
      {!pending && soon.length > 0 && !onAccount && (
        <div className={v.hint} role="status" style={{ marginBottom: "var(--s2)" }}>
          Your acknowledgement of {soon.map((d) => `“${d.title}”`).join(", ")} expires within {data.noticeDays} days.{" "}
          <Link to="/account?section=ai-policies" style={{ textDecoration: "underline" }}>Acknowledge again</Link>
        </div>
      )}
      {props.children}
    </>
  );
}
