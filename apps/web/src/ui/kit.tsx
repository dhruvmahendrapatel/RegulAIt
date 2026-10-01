/**
 * The owned component kit. Small on purpose: Button, Input, Select, Textarea,
 * Card, Table (sort + empty + loading), Badge, StatusDot, Modal, Tabs,
 * Skeleton, EmptyState, ErrorState, CodeBlock, IdChip, Meter.
 * Toast lives in ./toast.tsx (it carries a provider).
 */
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import s from "./kit.module.css";

// ---- Button ---------------------------------------------------------------

type ButtonVariant = "default" | "primary" | "danger" | "ghost";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
}
const variantClass: Record<ButtonVariant, string> = {
  default: s.btn!,
  primary: s.btnPrimary!,
  danger: s.btnDanger!,
  ghost: s.btnGhost!,
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", className, type, ...rest },
  ref,
) {
  const cls = [variantClass[variant], size === "sm" ? s.btnSm : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <button ref={ref} type={type ?? "button"} className={cls} {...rest} />;
});

// ---- fields ---------------------------------------------------------------

/**
 * A labelled form control.
 *
 * ASSOCIATION IS EXPLICIT (htmlFor/id), NOT BY WRAPPING, and the difference is
 * not cosmetic. When a `<label>` CONTAINS its control, the control's accessible
 * name is computed from the label element's text content — which, for a
 * `<select>`, swallows the options. Every select on the admin surface was
 * announcing itself as "Detect byhostnameweb appSDK packageAPI key prefix"
 * instead of "Detect by": the whole option list read out as the field's name,
 * on every select in the product.
 *
 * It surfaced as a test that could not find a control by its own label, which
 * is the same tell as the two label defects before it — if `getByLabel` cannot
 * name it, neither can a screen reader.
 *
 * The wrapping form is kept as a FALLBACK for the handful of fields whose
 * children are not a single element (a row of two inputs, a control plus a
 * hint). Those keep exactly the behaviour they had rather than silently losing
 * their association.
 */
export function Field(props: { label: string; children: ReactNode; error?: string | null; grow?: boolean }) {
  const auto = useId();
  // A SPACER IS NOT A LABEL. `<Field label="&nbsp;">` is used to keep a submit
  // button aligned with the inputs beside it — and rendering that as a real
  // <label> wrapping the button gave the button the accessible name
  // "\u00a0Add signature": a non-breaking space glued to the front of every
  // such control in the product, which is enough to make it unfindable by its
  // own name. A spacer renders as an aria-hidden span and never as a <label>.
  const spacer = props.label.trim().replace(/\u00a0/g, "") === "";
  if (spacer) {
    return (
      <div className={s.field} style={props.grow ? { flex: 1 } : undefined}>
        <span className={s.fieldLabel} aria-hidden>
          {props.label}
        </span>
        {props.children}
        {props.error ? <span className={s.fieldError}>{props.error}</span> : null}
      </div>
    );
  }

  const only = Children.count(props.children) === 1 ? Children.only(props.children) : null;
  // ONLY controls that actually take a label. A <label htmlFor> pointing at a
  // <button> does not describe it — it REPLACES its accessible name, so
  // `<Field label="&nbsp;"><Button>Add signature</Button></Field>` turned the
  // submit button into one named " ". That regression was introduced by the
  // first draft of this very fix and caught by a spec that could no longer
  // find the button, which is the same signal as before: a control a test
  // cannot name is a control a screen reader cannot name either.
  const labelable = only !== null && isValidElement(only) &&
    (only.type === Input || only.type === Select || only.type === Textarea);
  const single = labelable && isValidElement<{ id?: string }>(only) ? only : null;

  if (single) {
    const id = single.props.id ?? auto;
    return (
      <div className={s.field} style={props.grow ? { flex: 1 } : undefined}>
        <label className={s.fieldLabel} htmlFor={id}>
          {props.label}
        </label>
        {single.props.id ? single : cloneElement(single, { id })}
        {props.error ? <span className={s.fieldError}>{props.error}</span> : null}
      </div>
    );
  }

  return (
    <label className={s.field} style={props.grow ? { flex: 1 } : undefined}>
      <span className={s.fieldLabel}>{props.label}</span>
      {props.children}
      {props.error ? <span className={s.fieldError}>{props.error}</span> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={[s.input, className ?? ""].join(" ")} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={[s.select, className ?? ""].join(" ")} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={[s.textarea, className ?? ""].join(" ")} {...rest} />;
  },
);

// ---- Card -----------------------------------------------------------------

/**
 * An inline "why does this exist" affordance.
 *
 * ── WHY THIS COMPONENT EXISTS ──────────────────────────────────────────────
 * This product has a great deal to explain — most fields encode a governance
 * decision with a real consequence — and the explanations had been written as
 * PROSE ON THE PAGE: sixty-word page subtitles, parenthetical asides inside
 * field labels, paragraphs between form rows. There are ~185 strings over 110
 * characters across the views.
 *
 * That prose is good and should not be deleted; it is in the wrong place. Read
 * once it is essential and read every day after that it is noise, and noise is
 * what teaches people to skim past the sentence that mattered. Moving it behind
 * a deliberate affordance keeps the answer one keystroke away for whoever wants
 * it and off the screen of whoever already knows.
 *
 * ── IT IS A DISCLOSURE, NOT A TOOLTIP, AND THE DIFFERENCE IS THE POINT ─────
 * A hover tooltip is unreachable by touch, hostile to a screen reader, and
 * vanishes the moment you move toward it — which makes it the wrong container
 * for anything longer than a few words. This opens on CLICK, stays open, and is
 * dismissed by Escape or a click outside. It can therefore hold a real
 * paragraph, and a keyboard or touch user gets exactly what a mouse user gets.
 *
 * `aria-expanded` and `aria-controls` tie the trigger to the panel, and the
 * panel is `role="note"` rather than `role="tooltip"` because it is standing
 * explanatory content, not a transient label for the control.
 */
export function InfoButton(props: {
  /** what this explains — announced to a screen reader, e.g. "compliance tags" */
  label: string;
  children: ReactNode;
  /** nudges the panel left when the trigger sits near the right edge */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        // Return focus to the trigger: closing must not dump a keyboard user
        // back at the top of the document.
        wrap.current?.querySelector("button")?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span className={s.infoWrap} ref={wrap}>
      <button
        type="button"
        className={s.infoBtn}
        aria-label={open ? `Hide help for ${props.label}` : `What is ${props.label}?`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {/* A drawn glyph, not the character "i": a text "i" inherits the
            surrounding font and optical size and reads as a typo at 12px. */}
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" strokeWidth="1.5" />
          <circle cx="8" cy="4.6" r="0.95" stroke="none" />
          <path d="M8 7.1v4.6" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <span id={panelId} role="note" className={`${s.infoPanel} ${props.align === "end" ? s.infoPanelEnd : ""}`}>
          {props.children}
        </span>
      )}
    </span>
  );
}

/**
 * A closed-vocabulary tag picker.
 *
 * ── WHY THIS REPLACED A TEXT BOX ───────────────────────────────────────────
 * Compliance tags were a comma-separated `<Input>`. That looks like a small UI
 * choice and is not: these tags are what the pillar-3 cascade keys on, so a
 * typo does not produce a validation error — it produces a use case that
 * silently inherits NO compliance consequences. The failure is invisible at the
 * moment it happens and expensive later.
 *
 * The vocabulary is a real object (`compliance_profiles.tag`) and the page
 * already loads it, so asking a human to retype it from memory was never
 * necessary. Choosing from the list makes the wrong answer unrepresentable.
 *
 * ── FREE ENTRY IS STILL ALLOWED, AND MARKED ────────────────────────────────
 * A tag with no profile is legitimate — you can tag ahead of writing the
 * profile — so this does not forbid one. It marks it: an unknown tag is shown
 * as `unbound`, with the plain consequence spelled out, rather than looking
 * identical to a tag that actually enforces something. Refusing it outright
 * would be the wrong trade; letting it pass unremarked is what the text box
 * already did.
 */
export function TagPicker(props: {
  value: string[];
  onChange: (next: string[]) => void;
  /** the known vocabulary — tags that resolve to a compliance profile */
  known: string[];
  id?: string;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const add = (raw: string) => {
    const t = raw.trim().replace(/,+$/, "");
    if (!t || props.value.includes(t)) return setDraft("");
    props.onChange([...props.value, t]);
    setDraft("");
  };
  const unbound = (t: string) => !props.known.includes(t);

  return (
    <div className={s.tagPicker}>
      {props.value.length > 0 && (
        <ul className={s.tagList}>
          {props.value.map((t) => (
            <li key={t} className={`${s.tagChip} ${unbound(t) ? s.tagChipUnbound : ""}`}>
              <span>{t}</span>
              {unbound(t) && <em className={s.tagUnboundMark}>unbound</em>}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => props.onChange(props.value.filter((x) => x !== t))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={s.tagInputRow}>
        <input
          id={props.id}
          className={s.input}
          list={listId}
          value={draft}
          placeholder={props.known.length ? "start typing, or pick a known tag" : "no profiles defined yet"}
          onChange={(e) => {
            // A datalist click fires change with the full value and no key
            // event, so committing on a trailing comma alone would never catch
            // it. Committing when the value matches the vocabulary exactly is
            // what makes picking from the list feel like picking, not typing.
            const v = e.target.value;
            if (v.endsWith(",")) return add(v);
            if (props.known.includes(v)) return add(v);
            setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Enter adds a tag; it must not submit the form around it.
              e.preventDefault();
              add(draft);
            }
            if (e.key === "Backspace" && draft === "" && props.value.length) {
              props.onChange(props.value.slice(0, -1));
            }
          }}
          onBlur={() => add(draft)}
        />
        <datalist id={listId}>
          {props.known.filter((t) => !props.value.includes(t)).map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      {props.value.some(unbound) && (
        <p className={s.tagWarn}>
          No compliance profile carries {props.value.filter(unbound).map((t) => `“${t}”`).join(", ")} yet, so
          it enforces nothing until one does. That is allowed — tagging ahead of the profile is normal — but it
          is not the same as being governed.
        </p>
      )}
    </div>
  );
}

export function Card(props: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section
      className={[props.flush ? s.cardFlush : s.card, props.className ?? ""].join(" ")}
      style={props.style}
    >
      {props.title != null && (
        <div className={s.cardTitle} style={props.flush ? { padding: "var(--s2) var(--s2) 0" } : undefined}>
          <span style={{ flex: 1 }}>{props.title}</span>
          {props.actions}
        </div>
      )}
      {props.children}
    </section>
  );
}

// ---- Badge / status -------------------------------------------------------

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "primary";
const badgeTone: Record<Tone, string> = {
  neutral: s.badge!,
  ok: `${s.badge} ${s.badgeOk}`,
  warn: `${s.badge} ${s.badgeWarn}`,
  danger: `${s.badge} ${s.badgeDanger}`,
  info: `${s.badge} ${s.badgeInfo}`,
  primary: `${s.badge} ${s.badgePrimary}`,
};
export function Badge(props: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={badgeTone[props.tone ?? "neutral"]} title={props.title}>
      {props.children}
    </span>
  );
}

const dotTone: Record<Tone, string> = {
  neutral: s.dot!,
  ok: `${s.dot} ${s.dotOk}`,
  warn: `${s.dot} ${s.dotWarn}`,
  danger: `${s.dot} ${s.dotDanger}`,
  info: `${s.dot} ${s.dotInfo}`,
  primary: `${s.dot} ${s.dotPrimary}`,
};
export function StatusDot(props: { tone?: Tone; pulse?: boolean; title?: string }) {
  return (
    <span
      className={[dotTone[props.tone ?? "neutral"], props.pulse ? s.dotPulse : ""].join(" ")}
      title={props.title}
      aria-hidden
    />
  );
}

/** the one status→tone mapping every view shares (parity with the legacy map) */
export function statusTone(status: string): Tone {
  switch (status) {
    case "completed":
    case "done":
    case "approved":
    case "passed":
      return "ok";
    case "running":
    case "in_progress":
    case "awaiting_execution":
      return "info";
    case "blocked_on_approval":
    case "blocked_on_artifact":
    // ADR-0079: plan-only is a normal, expected resting state, not a failure —
    // same tone as the other "waiting on a human" statuses.
    case "blocked_on_plan":
    case "awaiting_trigger":
    case "in_review":
    case "pending":
    case "blocked_on_deploy":
      return "warn";
    case "blocked":
    case "blocked_on_check":
    case "failed":
    case "rolled_back":
    case "aborted":
    case "denied":
    case "superseded":
      return "danger";
    default:
      return "neutral";
  }
}
export function StatusBadge(props: { status: string }) {
  return <Badge tone={statusTone(props.status)}>{props.status.replaceAll("_", " ")}</Badge>;
}

/**
 * The one severity vocabulary. The brand ships a four-step severity scale
 * (critical / high / medium / low) as tokens — 16% tint fill, deep-step text —
 * and this is the single component that renders it. Before this existed, two
 * pages mapped the same word to different colours (red-team said high=danger,
 * shadow-AI said high=warn); a severity word must mean one colour everywhere.
 * Unknown classes fall back to a neutral Badge so a new vocabulary word shows
 * up unstyled rather than silently mis-coloured.
 */
const sevClass: Record<string, string> = {
  critical: s.sevCritical!,
  high: s.sevHigh!,
  medium: s.sevMedium!,
  low: s.sevLow!,
};
export function SeverityBadge(props: { severity: string; title?: string }) {
  const cls = sevClass[props.severity];
  if (!cls) return <Badge title={props.title}>{props.severity}</Badge>;
  return (
    <span className={`${s.badge} ${cls}`} title={props.title}>
      {props.severity}
    </span>
  );
}

// ---- Table ----------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  align?: "left" | "right";
  width?: string;
}

export function Table<T>(props: {
  columns: Array<Column<T>>;
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowLabel?: (row: T) => string;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const sorted = useMemo(() => {
    const rows = props.rows ?? [];
    if (!sortKey) return rows;
    const col = props.columns.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const sortFn = col.sort;
    return [...rows].sort((a, b) => {
      const av = sortFn(a);
      const bv = sortFn(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
    });
  }, [props.rows, props.columns, sortKey, sortDir]);

  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            {props.columns.map((c) => {
              const sortable = Boolean(c.sort);
              const active = sortKey === c.key;
              return (
                <th
                  key={c.key}
                  style={{ textAlign: c.align ?? "left", width: c.width }}
                  className={sortable ? s.thSortable : undefined}
                  aria-sort={active ? (sortDir === 1 ? "ascending" : "descending") : undefined}
                  onClick={
                    sortable
                      ? () => {
                          if (active) setSortDir((d) => (d === 1 ? -1 : 1));
                          else {
                            setSortKey(c.key);
                            setSortDir(1);
                          }
                        }
                      : undefined
                  }
                >
                  {c.header}
                  {active && <span className={s.sortArrow}>{sortDir === 1 ? "▲" : "▼"}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {props.loading
            ? [0, 1, 2].map((i) => (
                <tr key={`sk-${i}`}>
                  {props.columns.map((c) => (
                    <td key={c.key}>
                      <Skeleton width={`${55 + ((i * 17) % 35)}%`} />
                    </td>
                  ))}
                </tr>
              ))
            : sorted.map((row) => {
                const clickable = Boolean(props.onRowClick);
                return (
                  <tr
                    key={props.rowKey(row)}
                    className={clickable ? s.rowClickable : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    role={clickable ? "link" : undefined}
                    aria-label={clickable ? props.rowLabel?.(row) : undefined}
                    onClick={clickable ? () => props.onRowClick!(row) : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter") props.onRowClick!(row);
                          }
                        : undefined
                    }
                  >
                    {props.columns.map((c) => (
                      <td key={c.key} style={{ textAlign: c.align ?? "left" }}>
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
          {!props.loading && sorted.length === 0 && (
            <tr>
              <td colSpan={props.columns.length}>{props.empty ?? <EmptyState title="Nothing here yet" />}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---- Modal ----------------------------------------------------------------

export function Modal(props: {
  open: boolean;
  title: string;
  className?: string;
  children?: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  /** roomier dialog — for side-by-side content, not for more prose */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    // focus the dialog so keyboard users land inside it
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);
  if (!props.open) return null;
  return (
    <div className={s.scrim} onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        className={[s.modal, props.wide ? s.modalWide : "", props.className ?? ""].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        ref={ref}
      >
        <div className={s.modalTitle}>{props.title}</div>
        {props.children != null && <div className={s.modalBody}>{props.children}</div>}
        {props.actions != null && <div className={s.modalActions}>{props.actions}</div>}
      </div>
    </div>
  );
}

/** the owned confirm() — no native dialogs anywhere in the product */
export function ConfirmModal(props: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={props.open}
      title={props.title}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant={props.danger ? "danger" : "primary"} onClick={props.onConfirm}>
            {props.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {props.body}
    </Modal>
  );
}

// ---- Tabs -----------------------------------------------------------------

export function Tabs(props: {
  tabs: Array<{ id: string; label: ReactNode }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className={s.tabs} role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === props.active}
          className={t.id === props.active ? s.tabActive : s.tab}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---- Skeleton / Empty / Error ---------------------------------------------

export function Skeleton(props: { width?: string; height?: string; style?: React.CSSProperties }) {
  return (
    <span
      className={s.skeleton}
      style={{
        display: "inline-block",
        width: props.width ?? "100%",
        height: props.height ?? "12px",
        ...props.style,
      }}
      aria-hidden
    />
  );
}

export function SkeletonBlock(props: { lines?: number }) {
  const lines = props.lines ?? 3;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s1)" }} aria-label="Loading" role="status">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={`${88 - ((i * 23) % 40)}%`} />
      ))}
    </div>
  );
}

export function EmptyState(props: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={s.empty}>
      {props.icon ?? (
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden>
          <rect x="5" y="8" width="26" height="20" rx="3" stroke="currentColor" strokeWidth="1.6" opacity="0.5" />
          <path d="M5 14h26" stroke="currentColor" strokeWidth="1.6" opacity="0.5" />
          <circle cx="9.5" cy="11" r="1" fill="currentColor" opacity="0.5" />
        </svg>
      )}
      <div className={s.emptyTitle}>{props.title}</div>
      {props.body != null && <div className={s.emptyBody}>{props.body}</div>}
      {props.action}
    </div>
  );
}

export function ErrorState(props: { message: string; onRetry?: () => void; access?: boolean }) {
  return (
    <div className={s.empty} role="alert">
      <StatusDot tone="danger" />
      <div className={s.emptyTitle}>
        {props.access ? "You don't have access to this view" : "Couldn't load this view"}
      </div>
      <div className={s.emptyBody}>{props.message}</div>
      {props.onRetry && (
        <Button size="sm" onClick={props.onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ---- CodeBlock ------------------------------------------------------------

export function CodeBlock(props: { children: string; maxHeight?: string }) {
  return (
    <pre className={s.code} style={props.maxHeight ? { maxHeight: props.maxHeight } : undefined}>
      {props.children}
    </pre>
  );
}

// ---- IdChip ---------------------------------------------------------------

export function IdChip(props: { id: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!props.id) return null;
  const id = props.id;
  return (
    <button
      className={s.idChip}
      title={`${id} — click to copy`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 900);
        } catch {
          /* clipboard unavailable — the tooltip still shows the full id */
        }
      }}
    >
      {copied ? "copied" : id.slice(0, 8) + "…"}
    </button>
  );
}

// ---- Meter (budget gauge) -------------------------------------------------

export function Meter(props: {
  value: number;
  max: number;
  warn?: boolean;
  over?: boolean;
  markPct?: number;
  label?: string;
}) {
  const pct = props.max > 0 ? Math.min(100, (props.value / props.max) * 100) : 0;
  const fill = [
    s.meterFill,
    props.over ? s.meterFillOver : props.warn ? s.meterFillWarn : "",
  ].join(" ");
  return (
    <div
      className={s.meterTrack}
      role="meter"
      aria-valuenow={props.value}
      aria-valuemin={0}
      aria-valuemax={props.max}
      aria-label={props.label ?? "budget"}
    >
      <div className={fill} style={{ width: `${pct}%` }} />
      {props.markPct != null && props.markPct < 100 && (
        <span className={s.meterMark} style={{ left: `${props.markPct}%` }} title={`${props.markPct}% alert threshold`} />
      )}
    </div>
  );
}

// ---- BarList (ranked horizontal bars) -------------------------------------

export interface BarItem {
  /** stable react key; falls back to the row index */
  key?: string;
  /** plain text, or a <Link> when the row should navigate somewhere */
  label: ReactNode;
  /** tooltip / a11y text when `label` is not a plain string */
  title?: string;
  value: number;
}

/**
 * The ranked-bar readout every cost/savings breakdown uses (showback by
 * member, by agent, by project, savings by technique…). Top-N, sorted by the
 * caller, one shared visual so no two breakdowns look different.
 */
export function BarList(props: {
  items: BarItem[];
  /** value formatter — pass fmtUsd for money, toLocaleString for counts */
  format: (v: number) => string;
  limit?: number;
  empty?: ReactNode;
}) {
  const items = props.items.filter((i) => Number.isFinite(i.value)).slice(0, props.limit ?? 10);
  if (items.length === 0) {
    return (
      <>
        {props.empty ?? (
          <EmptyState title="No data yet" body="Metered activity appears here as it happens." />
        )}
      </>
    );
  }
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  return (
    <div className={s.barList}>
      {items.map((i, idx) => (
        <div key={i.key ?? idx} className={s.barRow}>
          <span
            className={s.barLabel}
            title={i.title ?? (typeof i.label === "string" ? i.label : undefined)}
          >
            {i.label}
          </span>
          <div className={s.barTrack}>
            <div className={s.barFill} style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }} />
          </div>
          <span className={s.barValue}>{props.format(i.value)}</span>
        </div>
      ))}
    </div>
  );
}
