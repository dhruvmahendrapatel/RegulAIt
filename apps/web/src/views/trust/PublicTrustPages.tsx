/**
 * ADR-0225 (P13 d) — the two PUBLIC pages, outside the app shell (no chrome, no app session):
 *   /trust   the trust centre: what the organisation published, read-only. 404 from the gateway while the pages
 *            are off, shown as "not available" with no detail.
 *   /audit   the auditor portal. The sign-in link carries its single-use token in the URL FRAGMENT
 *            (`/ui/audit#rgal_…`), which a browser never sends to a server, so it cannot reach an access log or a
 *            Referer. The page posts it once, the gateway answers with an HttpOnly session cookie, and the fragment is
 *            cleared from the address bar. No token is ever kept in local or session storage.
 * Everything rendered is text from JSON; nothing is rendered as HTML.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../api/client";
import { fmtAt } from "../../api/format";
import { Badge, Button, Card, EmptyState, ErrorState, SkeletonBlock } from "../../ui/kit";
import v from "../views.module.css";
import t from "./trust.module.css";
import { FIELD_LABELS, KIND_LABELS, fieldsFor, tokenFromHash, type PublicItem, type PublicTrustCenter } from "./trustModel";

function Item(props: { item: PublicItem }) {
  return (
    <Card title={props.item.title}>
      <div className={v.stack}>
        <div className={v.row}>
          <Badge tone="neutral">{KIND_LABELS[props.item.kind]}</Badge>
          <span className={v.faint}>Published {fmtAt(props.item.publishedAt)}</span>
        </div>
        <dl className={t.fields}>
          {fieldsFor(props.item.kind).map((f) => (
            <div key={f} className={t.fieldRow}>
              <dt>{FIELD_LABELS[f]}</dt>
              <dd>{props.item.content[f] ?? ""}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

function Shell(props: { children: React.ReactNode }) {
  return (
    <main className={t.public}>
      <div className={t.panel}>{props.children}</div>
    </main>
  );
}

/** shown if the gateway's own footnote is missing (it always sends one) */
const DISCLAIMER =
  "These pages are published by the organisation. They are not a certification and do not state compliance with any standard or law.";

const unavailable = (e: unknown) => e instanceof ApiError && e.status === 404;

export function TrustCenterPage() {
  const q = useQuery({ queryKey: ["public", "trust-center"], queryFn: () => api.get<PublicTrustCenter>("/v1/trust-center"), retry: false });
  if (q.isLoading) {
    return (
      <Shell>
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      </Shell>
    );
  }
  if (q.error || !q.data) {
    return (
      <Shell>
        {unavailable(q.error) ? (
          <EmptyState title="This page is not available" body="The organisation has not published a trust centre." />
        ) : (
          <ErrorState title="The trust centre could not be loaded" message="Try again in a moment." onRetry={() => void q.refetch()} />
        )}
      </Shell>
    );
  }
  const d = q.data;
  const items = Array.isArray(d.items) ? d.items : [];
  const cards = items.filter((i) => i.kind === "ai_card");
  const controls = items.filter((i) => i.kind !== "ai_card");
  return (
    <Shell>
      <header className={t.section}>
        <h1>{d.displayName || "Trust centre"}</h1>
        {d.intro && <p className={t.prose}>{d.intro}</p>}
        {d.contactEmail && (
          <p className={v.faint}>
            Questions: <a href={`mailto:${d.contactEmail}`}>{d.contactEmail}</a>
          </p>
        )}
      </header>
      {items.length === 0 && <EmptyState title="Nothing published yet" body="The organisation has not published any items." />}
      {cards.length > 0 && (
        <section className={t.section} aria-labelledby="trust-cards">
          <h2 id="trust-cards">AI systems</h2>
          {cards.map((i) => (
            <Item key={i.slug} item={i} />
          ))}
        </section>
      )}
      {controls.length > 0 && (
        <section className={t.section} aria-labelledby="trust-controls">
          <h2 id="trust-controls">Controls and evidence</h2>
          {controls.map((i) => (
            <Item key={i.slug} item={i} />
          ))}
        </section>
      )}
      <p className={v.faint}>{d.disclaimer || DISCLAIMER}</p>
    </Shell>
  );
}

interface PortalSession {
  organisation: string | null;
  auditorName: string;
  accessEndsAt: string;
  sessionEndsAt: string;
  items: Array<{ slug: string; kind: PublicItem["kind"]; title: string; publishedAt: string }>;
  disclaimer: string;
}

function refusal(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "This page is not available.";
    if (typeof e.payload.detail === "string") return e.payload.detail;
  }
  return "Something went wrong. Try again in a moment.";
}

export function AuditorPortalPage() {
  const qc = useQueryClient();
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(() => tokenFromHash(window.location.hash) !== null);
  const started = useRef(false);
  const [open, setOpen] = useState<string | null>(null);

  // redeem the fragment's single-use token once, then clear it from the address bar
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = tokenFromHash(window.location.hash);
    if (!token) return;
    window.history.replaceState(null, "", window.location.pathname);
    api
      .post("/v1/auditor/session", { token })
      .then(() => qc.invalidateQueries({ queryKey: ["public", "auditor"] }))
      .catch((e: unknown) => setRedeemError(refusal(e)))
      .finally(() => setRedeeming(false));
  }, [qc]);

  const session = useQuery({
    queryKey: ["public", "auditor", "session"],
    queryFn: () => api.get<PortalSession>("/v1/auditor/session"),
    enabled: !redeeming,
    retry: false,
  });
  const item = useQuery({
    queryKey: ["public", "auditor", "item", open],
    queryFn: () => api.get<PublicItem>(`/v1/auditor/items/${encodeURIComponent(open!)}`),
    enabled: open !== null,
    retry: false,
  });
  const signOut = () =>
    void api
      .del("/v1/auditor/session")
      .catch(() => undefined)
      .finally(() => {
        setOpen(null);
        void qc.invalidateQueries({ queryKey: ["public", "auditor"] });
      });

  if (redeeming || session.isLoading) {
    return (
      <Shell>
        <Card>
          <SkeletonBlock lines={5} />
        </Card>
      </Shell>
    );
  }
  if (session.error || !session.data) {
    // signed out, or the link was refused: a fact to state, not a failure; anything else is an error with a retry
    const expected = session.error instanceof ApiError && [401, 404].includes(session.error.status);
    return (
      <Shell>
        {expected || redeemError ? (
          <EmptyState title="Auditor access" body={redeemError ?? refusal(session.error)} />
        ) : (
          <ErrorState title="Auditor access could not be loaded" message={refusal(session.error)} onRetry={() => void session.refetch()} />
        )}
      </Shell>
    );
  }
  const s = { ...session.data, items: Array.isArray(session.data.items) ? session.data.items : [] };
  return (
    <Shell>
      <header className={t.section}>
        <h1>{s.organisation ? `${s.organisation}: auditor access` : "Auditor access"}</h1>
        <div className={v.row}>
          <span>Signed in as {s.auditorName}.</span>
          <span className={v.faint}>
            This session ends {fmtAt(s.sessionEndsAt)}; your access ends {fmtAt(s.accessEndsAt)}.
          </span>
          <span className={v.grow} />
          <Button size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
        <p className={v.faint}>Read-only. Each item you open is recorded by the organisation.</p>
      </header>
      <Card title="Items shared with you" count={s.items.length}>
        {s.items.length === 0 ? (
          <EmptyState title="Nothing to show" body="No shared item is published at the moment." />
        ) : (
          <ul className={t.list}>
            {s.items.map((i) => (
              <li key={i.slug} className={v.row}>
                <Button size="sm" variant={open === i.slug ? "primary" : undefined} aria-pressed={open === i.slug} onClick={() => setOpen(i.slug)}>
                  Open
                </Button>
                <span>{i.title}</span>
                <span className={v.faint}>{KIND_LABELS[i.kind]}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open !== null &&
        (item.isLoading ? (
          <Card>
            <SkeletonBlock lines={4} />
          </Card>
        ) : item.data ? (
          <Item item={item.data} />
        ) : (
          <p role="alert" className={v.errLine}>
            {refusal(item.error)}
          </p>
        ))}
      <p className={v.faint}>{s.disclaimer || DISCLAIMER}</p>
    </Shell>
  );
}
