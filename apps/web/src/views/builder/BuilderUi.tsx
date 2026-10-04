/**
 * ADR-0172 — the agent builder's shared pieces: avatar, logo strip, radio
 * cards, segmented control, switch, collapsible section, drawer, copy button,
 * code tabs, the message list and composer, the template hero art, and the
 * New agent dialog that the Chat, Agents and Template pages all open.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BuilderMessage, BuilderPendingStep, BuilderTemplate, BuilderTool, BuilderToolStep, BuilderToolStepStatus } from "../../api/types";
import { fmtUsd, fmtDur } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { Badge, Button, Field, Input, Modal, Select, Tabs, Textarea } from "../../ui/kit";
import { ModelPicker } from "../../ui/ModelPicker";
import { Logo, hasLogo } from "../../ui/logos/Logo";
import { providerLogoKey } from "../../ui/logos/providerLogo";
import { useToast } from "../../ui/toast";
import { bk, builderApi, chatRefusal, useMyModelTiles, useMyProjects, type ChatResponse } from "./builderApi";
import { agentInitials, importMessage, parseBundleText, safeAgentColor } from "./builderLogic";
import s from "./builder.module.css";

// ---- glyphs (inline, decorative) -------------------------------------------

const glyph = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
export const Icon = {
  plus: (n = 16) => glyph(<path d="M12 5v14M5 12h14" />, n),
  send: (n = 16) => glyph(<path d="M12 19V5M5 12l7-7 7 7" />, n),
  close: (n = 16) => glyph(<path d="M6 6l12 12M18 6L6 18" />, n),
  chevron: (n = 14) => glyph(<path d="M9 6l6 6-6 6" />, n),
  trash: (n = 15) => glyph(<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />, n),
  users: (n = 16) => glyph(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20c.8-3.3 3.2-5 6-5s5.2 1.7 6 5M16 5.5a3 3 0 010 5.6M18 15c1.6.6 2.7 2.2 3 5" /></>, n),
  user: (n = 16) => glyph(<><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5" /></>, n),
  monitor: (n = 16) => glyph(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>, n),
  chat: (n = 16) => glyph(<path d="M4 5h16v11H9l-5 4z" />, n),
  lock: (n = 14) => glyph(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>, n),
  globe: (n = 16) => glyph(<><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" /></>, n),
  link: (n = 16) => glyph(<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />, n),
  book: (n = 16) => glyph(<path d="M5 4h10a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h10" />, n),
  spark: (n = 16) => glyph(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />, n),
  brain: (n = 16) => glyph(<path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 1V5a3 3 0 00-3-1zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-6 1" />, n),
  clock: (n = 16) => glyph(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>, n),
  tree: (n = 16) => glyph(<><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-4h12v4" /></>, n),
  sliders: (n = 16) => glyph(<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />, n),
  code: (n = 16) => glyph(<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />, n),
  mail: (n = 16) => glyph(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5L12 13l8.5-6.5" /></>, n),
  check: (n = 16) => glyph(<><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.4 2.4 4.6-4.9" /></>, n),
  upload: (n = 16) => glyph(<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" />, n),
  download: (n = 16) => glyph(<path d="M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" />, n),
  grid: (n = 16) => glyph(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>, n),
  list: (n = 16) => glyph(<path d="M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0" />, n),
  shield: (n = 16) => glyph(<path d="M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6z" />, n),
  inbox: (n = 16) => glyph(<path d="M4 13l2.5-8h11L20 13v6H4zM4 13h4.5l1 2h5l1-2H20" />, n),
};

// ---- identity ---------------------------------------------------------------

export function AgentAvatar(props: { name: string; color: string | null | undefined; size?: number }) {
  const size = props.size ?? 36;
  return (
    <span
      className={s.avatar}
      aria-hidden
      style={{ width: size, height: size, background: safeAgentColor(props.color, props.name), fontSize: Math.max(10, Math.round(size * 0.36)), borderRadius: Math.round(size * 0.28) }}
    >
      {agentInitials(props.name)}
    </span>
  );
}

/** the logo key for anything the builder shows: a provider kind, a logo key itself, or null */
export function logoKeyFor(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const p = provider.toLowerCase();
  return providerLogoKey(p) ?? (hasLogo(p) ? p : null);
}

/** an MCP server's mark: the vendored MCP logo is a wide wordmark, so a square glyph stands in */
export function McpGlyph(props: { label: string; size?: number }) {
  const size = props.size ?? 20;
  return (
    <span role="img" aria-label={props.label} className={s.logoChipSm} style={{ width: size + 4, height: size + 4 }}>
      {Icon.code(Math.round(size * 0.7))}
    </span>
  );
}

export function ToolLogo(props: { tool: Pick<BuilderTool, "kind" | "provider" | "name">; size?: number }) {
  const key = logoKeyFor(props.tool.provider);
  const label = props.tool.provider ?? props.tool.name;
  if (!key && props.tool.kind === "mcp_tool") return <McpGlyph label={label} size={props.size ?? 20} />;
  return <Logo name={key} label={label} size={props.size ?? 20} />;
}

export function ModelChip(props: { model: { name: string; provider: string; model?: string | null } | null }) {
  if (!props.model) return <span className={s.modelChip}>Workspace default model</span>;
  return (
    <span className={s.modelChip}>
      <Logo name={providerLogoKey(props.model.provider)} label={props.model.provider} size={16} />
      {props.model.name}
    </span>
  );
}

export function LogoStrip(props: { keys: string[]; size?: number; small?: boolean; labels?: Record<string, string> }) {
  return (
    <div className={s.logoStrip}>
      {props.keys.map((k) => (
        <span key={k} className={props.small ? s.logoChipSm : s.logoChip}>
          <Logo name={hasLogo(k) ? k : null} label={props.labels?.[k] ?? k} size={props.size ?? (props.small ? 14 : 18)} />
        </span>
      ))}
    </div>
  );
}

// ---- inputs -----------------------------------------------------------------

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  sub?: string;
  badge?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}
export function ChoiceCards<T extends string>(props: {
  legend: string;
  hint?: string;
  options: ChoiceOption<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className={s.choiceGroup}>
      <legend className={s.choiceLegend}>{props.legend}</legend>
      {props.hint && <p className={s.choiceHint}>{props.hint}</p>}
      {props.options.map((o) => {
        const off = props.disabled || o.disabled;
        return (
          <label key={o.value} className={off ? s.choiceDisabled : s.choice}>
            {o.icon && <span className={s.choiceIcon}>{o.icon}</span>}
            <span className={s.choiceText}>
              <span className={s.choiceTitle}>
                {o.title}
                {o.badge}
              </span>
              {o.sub && <span className={s.choiceSub}>{o.sub}</span>}
            </span>
            <input type="radio" name={name} value={o.value} checked={props.value === o.value} disabled={off} onChange={() => props.onChange(o.value)} />
          </label>
        );
      })}
    </fieldset>
  );
}

export function Segmented<T extends string>(props: {
  label: string;
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={props.label} className={s.segmented}>
      {props.options.map((o) => (
        <label key={o.value} className={s.segment}>
          <input type="radio" name={name} value={o.value} checked={props.value === o.value} disabled={props.disabled} onChange={() => props.onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={s.switch}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    />
  );
}

export function Disclosure(props: { label: string; open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button type="button" className={s.disclosure} aria-expanded={props.open} aria-controls={props.controls} onClick={props.onToggle}>
      <span className={props.open ? s.chevOpen : s.chev}>{Icon.chevron(12)}</span>
      {props.label}
    </button>
  );
}

/** a collapsible configure-panel section: a real button with aria-expanded over a region */
export function Section(props: { title: string; icon?: ReactNode; count?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const id = useId();
  return (
    <div className={s.section}>
      <h2 style={{ margin: 0, fontSize: "inherit" }}>
        <button type="button" className={s.sectionHead} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {props.icon && <span className={s.sectionIcon}>{props.icon}</span>}
          {props.title}
          {props.count != null && <span className={s.sectionCount}>{props.count}</span>}
          <span className={open ? s.chevOpen : s.chev} style={props.count == null ? { marginLeft: "auto" } : undefined}>
            {Icon.chevron(12)}
          </span>
        </button>
      </h2>
      {open && (
        <div id={id} role="region" aria-label={props.title} className={s.sectionBody}>
          {props.children}
        </div>
      )}
    </div>
  );
}

// ---- drawer -----------------------------------------------------------------

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * A right-hand drawer: a modal dialog that slides in from the edge. Focus moves
 * in on open, Tab stays inside, Escape closes, and focus returns to whatever
 * opened it.
 */
export function Drawer(props: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    if (!props.open) return;
    const opener = document.activeElement as HTMLElement | null;
    // land on the first field of the body, not the close button
    const first = ref.current?.querySelector<HTMLElement>(`[data-drawer-body] :is(${FOCUSABLE})`) ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => opener?.focus?.();
  }, [props.open]);
  if (!props.open) return null;
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose.current();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };
  return (
    <div className={s.drawerScrim} onMouseDown={(e) => e.target === e.currentTarget && onClose.current()}>
      <div ref={ref} className={s.drawer} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKey}>
        <div className={s.drawerHead}>
          <h2 id={titleId} className={s.drawerTitle}>
            {props.title}
          </h2>
          <button type="button" className={s.iconBtn} aria-label="Close" onClick={() => onClose.current()}>
            {Icon.close()}
          </button>
        </div>
        <div className={s.drawerBody} data-drawer-body="">
          {props.children}
        </div>
        {props.footer && <div className={s.drawerFoot}>{props.footer}</div>}
      </div>
    </div>
  );
}

// ---- code -------------------------------------------------------------------

export function CopyButton(props: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      className={props.className}
      aria-label={props.label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard unavailable — the text is selectable */
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

export function CodeTabs(props: { snippets: Array<{ id: string; label: string; code: string }> }) {
  const [tab, setTab] = useState(props.snippets[0]?.id ?? "");
  const active = props.snippets.find((x) => x.id === tab) ?? props.snippets[0];
  return (
    <div className={s.codeWrap}>
      <Tabs tabs={props.snippets.map((x) => ({ id: x.id, label: x.label }))} active={tab} onChange={setTab} />
      {active && (
        <div className={s.codeWrap} role="tabpanel" aria-label={`${active.label} snippet`} style={{ marginTop: 12 }}>
          <pre className={s.mono} tabIndex={0} style={{ background: "var(--rg-code-bg)", color: "var(--rg-code-ink)", padding: "14px 16px", borderRadius: 10, overflowX: "auto", margin: 0, lineHeight: 1.6 }}>
            {active.code}
          </pre>
          <CopyButton text={active.code} label={`Copy ${active.label} snippet`} className={s.copyBtn} />
        </div>
      )}
    </div>
  );
}

// ---- conversation -----------------------------------------------------------

// ---- ADR-0173: tool steps and the two pauses ---------------------------------

const STEP_STATUS: Record<BuilderToolStepStatus, { label: string; tone: "neutral" | "ok" | "warn" | "danger" | "primary" }> = {
  pending_confirmation: { label: "Needs your OK", tone: "warn" },
  pending_approval: { label: "Waiting for approval", tone: "warn" },
  running: { label: "Running", tone: "primary" },
  done: { label: "Done", tone: "ok" },
  denied: { label: "Denied", tone: "danger" },
  refused: { label: "Refused", tone: "danger" },
  error: { label: "Failed", tone: "danger" },
};

/** a redacted argument preview, readable */
export function argumentsText(args: unknown): string {
  if (args == null) return "Not shown — the arguments themselves were refused by policy.";
  if (typeof args === "object" && !Array.isArray(args) && Object.keys(args as object).length === 0) return "{} (no arguments)";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function StepLogo(props: { step: BuilderToolStep }) {
  const { step } = props;
  if (step.kind === "unknown") return <McpGlyph label="Unknown tool" size={16} />;
  return <ToolLogo tool={{ kind: step.kind, provider: step.provider, name: step.displayName }} size={16} />;
}

/** one tool call as a collapsible row: logo, name, status, cost; open for the
 * (redacted) arguments, the result preview and why it ended the way it did */
export function ToolStepRow(props: { step: BuilderToolStep }) {
  const { step } = props;
  const [open, setOpen] = useState(false);
  const id = useId();
  const st = STEP_STATUS[step.status];
  return (
    <li className={s.step}>
      <button type="button" className={s.stepHead} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className={open ? s.chevOpen : s.chev}>{Icon.chevron(12)}</span>
        <StepLogo step={step} />
        <span className={s.stepName}>{step.displayName}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        {step.costUsd != null && <span className={s.stepCost}>{fmtUsd(step.costUsd)}</span>}
      </button>
      {open && (
        <div id={id} className={s.stepBody}>
          <p className={s.stepLabel}>Arguments</p>
          <pre className={s.stepPre}>{argumentsText(step.arguments)}</pre>
          {step.status === "done" || step.resultWithheld || step.resultPreview ? (
            <>
              <p className={s.stepLabel}>Result</p>
              {step.resultWithheld ? (
                <p className={s.small} style={{ margin: 0 }}>Withheld by your organisation's data policy — the agent was given the policy's marker, not the content.</p>
              ) : (
                <pre className={s.stepPre}>{step.resultPreview ?? "(empty)"}</pre>
              )}
            </>
          ) : null}
          {step.outcomeDetail && (
            <p className={s.small} style={{ margin: 0 }}>
              {step.outcomeDetail}
            </p>
          )}
          <span className={s.small}>
            {step.kind === "connector" ? "Connector" : step.kind === "mcp_tool" ? "MCP tool" : "Not in this agent's toolbox"}
            {step.latencyMs != null ? ` · ${fmtDur(step.latencyMs)}` : ""}
            {step.requiresConfirmation ? " · asks first" : ""}
          </span>
        </div>
      )}
    </li>
  );
}

export function ToolSteps(props: { steps: BuilderToolStep[] }) {
  if (!props.steps.length) return null;
  return (
    <ul className={s.steps} aria-label="Tool calls">
      {props.steps.map((st) => (
        <ToolStepRow key={st.id} step={st} />
      ))}
    </ul>
  );
}

/** the thread owner answers an "Ask first" pause; the response is the whole thread */
export function useConfirmStep(threadId: string | null | undefined) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (v: { stepId: string; decision: "approve" | "deny" }) => builderApi.confirmStep(threadId!, v.stepId, v.decision),
    onSuccess: (res: ChatResponse) => {
      queryClient.setQueryData(bk.thread(res.thread.id), res);
      void queryClient.invalidateQueries({ queryKey: ["builder", "threads"] });
    },
    onError: (e) => {
      toast(chatRefusal(e).message, "error");
      if (threadId) void queryClient.invalidateQueries({ queryKey: bk.thread(threadId) });
      void queryClient.invalidateQueries({ queryKey: ["builder", "threads"] });
    },
  });
}

/**
 * The two pauses, never conflated. "Ask first" is a CONFIRMATION: the person
 * the agent runs as sees the exact (redacted) call and approves or denies it.
 * An organisation approval waits in the approvals queue for a named approver;
 * the conversation continues by itself once they decide.
 */
export function PauseCard(props: { waiting: BuilderPendingStep; threadId: string; agentName: string }) {
  const { waiting } = props;
  const confirm = useConfirmStep(props.threadId);
  const titleId = useId();
  if (waiting.status === "pending_approval") {
    return (
      <div className={s.pauseCard} role="status" aria-labelledby={titleId}>
        <p id={titleId} className={s.pauseTitle}>
          Waiting for approval by {waiting.approverName ?? "an approver"}
        </p>
        <span>
          {props.agentName} asked to use <strong>{waiting.displayName}</strong>, and your organisation requires an approval for this call. The conversation continues on its own
          once it is decided.
        </span>
      </div>
    );
  }
  return (
    <div className={s.pauseCard} role="group" aria-labelledby={titleId}>
      <p id={titleId} className={s.pauseTitle}>
        Allow {waiting.displayName}?
      </p>
      <span>
        {props.agentName} asks before using this tool. It will run as you, with exactly these arguments:
      </span>
      <pre className={s.stepPre}>{argumentsText(waiting.step?.arguments ?? {})}</pre>
      <div className={s.pauseActions}>
        <Button variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate({ stepId: waiting.stepId, decision: "approve" })}>
          Approve
        </Button>
        <Button disabled={confirm.isPending} onClick={() => confirm.mutate({ stepId: waiting.stepId, decision: "deny" })}>
          Deny
        </Button>
        {confirm.isPending && (
          <span role="status" className={s.small} style={{ alignSelf: "center" }}>
            Working…
          </span>
        )}
      </div>
    </div>
  );
}

export function MessageList(props: {
  messages: BuilderMessage[];
  agentName: string;
  agentColor: string | null | undefined;
  pending?: string | null;
  /** ADR-0173: the tool step the thread waits on, and the thread it belongs to */
  waiting?: BuilderPendingStep | null;
  threadId?: string | null;
}) {
  return (
    <div className={s.messages} aria-live="polite">
      {props.messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id} className={s.msgUser}>
            <span className={s.srOnly}>You: </span>
            {m.content}
          </div>
        ) : m.role === "system" ? (
          <div key={m.id} className={s.msgSystem}>
            {m.content}
          </div>
        ) : (
          <div key={m.id} className={s.msgAgent}>
            <AgentAvatar name={props.agentName} color={props.agentColor} size={28} />
            <div style={{ minWidth: 0, flex: 1 }}>
              {m.content ? (
                <div className={s.msgAgentBody}>
                  <span className={s.srOnly}>{props.agentName}: </span>
                  {m.content}
                </div>
              ) : (
                <span className={s.srOnly}>{props.agentName} used tools:</span>
              )}
              <ToolSteps steps={m.steps ?? []} />
              {(m.model || m.costUsd != null || m.latencyMs != null) && (
                <div className={s.msgMeta}>
                  {m.model && <span>{m.model}</span>}
                  {m.costUsd != null && <span>{fmtUsd(m.costUsd)}</span>}
                  {m.latencyMs != null && <span>{fmtDur(m.latencyMs)}</span>}
                </div>
              )}
            </div>
          </div>
        ),
      )}
      {props.waiting && props.threadId && (
        <PauseCard
          waiting={{
            ...props.waiting,
            // the step (with its exact arguments) from the response, else from the thread
            step: props.waiting.step ?? props.messages.flatMap((m) => m.steps ?? []).find((st) => st.id === props.waiting!.stepId),
          }}
          threadId={props.threadId}
          agentName={props.agentName}
        />
      )}
      {props.pending && (
        <>
          <div className={s.msgUser}>
            <span className={s.srOnly}>You: </span>
            {props.pending}
          </div>
          <div className={s.msgSystem} role="status">
            {props.agentName} is thinking…
          </div>
        </>
      )}
    </div>
  );
}

/** the message box: Enter sends, Shift+Enter breaks a line */
export function Composer(props: {
  label: string;
  placeholder: string;
  onSend: (text: string) => void;
  busy?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || props.busy || props.disabled) return;
    props.onSend(t);
    setText("");
  };
  return (
    <div className={s.composer}>
      <textarea
        className={s.composerInput}
        aria-label={props.label}
        placeholder={props.placeholder}
        value={text}
        maxLength={8000}
        rows={2}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className={s.composerBar}>
        {props.leading}
        <Button variant="primary" className={s.sendBtn} aria-label="Send" disabled={!text.trim() || props.busy || props.disabled} onClick={send}>
          {Icon.send()}
        </Button>
      </div>
    </div>
  );
}

// ---- template art -------------------------------------------------------------

const HERO_HUES: Record<string, [string, string]> = {
  intake: ["#22d3ee", "#6366f1"],
  risk: ["#f59e0b", "#ef4444"],
  policy: ["#34d399", "#0ea5e9"],
  evidence: ["#a78bfa", "#22d3ee"],
  incident: ["#fb7185", "#f59e0b"],
  reporting: ["#38bdf8", "#34d399"],
};
export function heroHues(category: string): [string, string] {
  const key = category.toLowerCase();
  for (const [k, v] of Object.entries(HERO_HUES)) if (key.includes(k)) return v;
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Object.values(HERO_HUES)[h % 6]!;
}

/**
 * The template card illustration: abstract floating panels and a connecting
 * path on a deep field — drawn here from shapes, no imagery. Decorative.
 */
export function HeroArt(props: { template: Pick<BuilderTemplate, "id" | "category" | "skills" | "integrations"> }) {
  const [a, b] = heroHues(props.template.category);
  const gid = `g-${props.template.id}`;
  const rows = Math.max(2, Math.min(4, props.template.skills.length + 1));
  return (
    <div className={s.hero} aria-hidden>
      <svg viewBox="0 0 320 160" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id={`${gid}-r`} cx="80%" cy="10%" r="90%">
            <stop offset="0" stopColor={a} stopOpacity="0.55" />
            <stop offset="1" stopColor="#0d1326" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${gid}-l`} x1="0" x2="1">
            <stop offset="0" stopColor={a} />
            <stop offset="1" stopColor={b} />
          </linearGradient>
        </defs>
        <rect width="320" height="160" fill="#0d1326" />
        <rect width="320" height="160" fill={`url(#${gid}-r)`} />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <path key={i} d={`M${-20 + i * 46} 170 C ${60 + i * 30} 110, ${120 + i * 20} 130, ${340} ${40 + i * 6}`} stroke="#ffffff" strokeOpacity="0.05" fill="none" />
        ))}
        <path d="M70 62 C 120 62, 130 104, 190 104 S 250 70, 262 70" stroke={`url(#${gid}-l)`} strokeWidth="1.5" strokeDasharray="3 4" fill="none" />
        <g>
          <rect x="22" y="28" width="104" height={22 + rows * 11} rx="8" fill="#182039" stroke="#ffffff" strokeOpacity="0.12" />
          <circle cx="36" cy="40" r="5" fill={a} />
          <rect x="47" y="37" width="52" height="6" rx="3" fill="#ffffff" fillOpacity="0.7" />
          {Array.from({ length: rows }).map((_, i) => (
            <g key={i}>
              <circle cx="36" cy={58 + i * 11} r="2.4" fill={b} fillOpacity="0.9" />
              <rect x="44" y={56 + i * 11} width={66 - (i % 2) * 18} height="4" rx="2" fill="#ffffff" fillOpacity="0.28" />
            </g>
          ))}
        </g>
        <g>
          <rect x="196" y="22" width="102" height="44" rx="8" fill="#182039" stroke="#ffffff" strokeOpacity="0.12" />
          <rect x="208" y="34" width="40" height="5" rx="2.5" fill="#ffffff" fillOpacity="0.6" />
          <rect x="208" y="46" width="22" height="9" rx="4.5" fill={a} fillOpacity="0.9" />
          <rect x="234" y="46" width="52" height="4" rx="2" fill="#ffffff" fillOpacity="0.25" />
        </g>
        <g>
          <rect x="150" y="96" width="120" height="44" rx="8" fill="#182039" stroke="#ffffff" strokeOpacity="0.12" />
          <rect x="162" y="108" width="14" height="14" rx="4" fill={b} fillOpacity="0.9" />
          <rect x="182" y="109" width="56" height="5" rx="2.5" fill="#ffffff" fillOpacity="0.6" />
          <rect x="182" y="119" width="72" height="4" rx="2" fill="#ffffff" fillOpacity="0.25" />
          <rect x="182" y="127" width="40" height="4" rx="2" fill="#ffffff" fillOpacity="0.25" />
        </g>
        <circle cx="262" cy="70" r="3" fill={b} />
      </svg>
    </div>
  );
}

// ---- the project an agent bills to (owner rule: required) ----------------------

/**
 * "Bill to project": every agent bills its spend to a project the creator is a
 * member of. Preselects the only project when there is just one; with none,
 * says how to get one instead of offering an empty list.
 */
export function ProjectSelect(props: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const projects = useMyProjects();
  const list = projects.data?.projects ?? [];
  const { value, onChange } = props;
  useEffect(() => {
    if (!value && list.length === 1) onChange(list[0]!.id);
  }, [value, list, onChange]);
  if (projects.isSuccess && list.length === 0) {
    return (
      <div className={s.note} role="note">
        <span>
          <strong>No project to bill to.</strong> Every agent bills its spend to a project you&apos;re a member of. Ask a project owner or an admin to add you to one.
        </span>
      </div>
    );
  }
  return (
    <Field label="Bill to project">
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={props.disabled || projects.isLoading} required>
        <option value="" disabled>
          {projects.isLoading ? "Loading projects…" : "Choose a project"}
        </option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

// ---- new agent ------------------------------------------------------------------

/**
 * The New agent dialog: name, description, and Advanced (connection format,
 * computer use, model). With a templateId the template seeds everything else.
 */
export function NewAgentDialog(props: { open: boolean; onClose: () => void; templateId?: string; templateName?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { auth } = useSession();
  const models = useMyModelTiles(props.open ? (auth?.userId ?? null) : null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [format, setFormat] = useState<"shared" | "per_user">("shared");
  const [computer, setComputer] = useState<"yes" | "no">("no");
  const [modelId, setModelId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const advId = useId();

  useEffect(() => {
    if (props.open) {
      setName(props.templateName ?? "");
      setDescription("");
      setAdvanced(false);
      setFormat("shared");
      setComputer("no");
      setModelId("");
      setProjectId("");
      setError(null);
    }
  }, [props.open, props.templateName]);

  const create = useMutation({
    mutationFn: () =>
      builderApi.createAgent({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(modelId ? { modelAgentId: modelId } : {}),
        connectionFormat: format,
        computerUse: computer === "yes",
        projectId,
        ...(props.templateId ? { templateId: props.templateId } : {}),
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: bk.agents });
      toast(`Created ${res.agent.name}`, "success");
      props.onClose();
      navigate(`/builder/agents/${res.agent.id}?setup=1`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const onClose = props.onClose;
  const close = useCallback(() => {
    if (!create.isPending) onClose();
  }, [create.isPending, onClose]);
  const nameErr = name.length > 80 ? "Use 80 characters or fewer" : null;
  const canCreate = name.trim().length > 0 && !nameErr && description.length <= 500 && !!projectId && !create.isPending;

  return (
    <Modal
      open={props.open}
      title={props.templateId ? `New agent from ${props.templateName ?? "template"}` : "New agent"}
      onClose={close}
      actions={
        <>
          <Button onClick={close} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canCreate} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create agent"}
          </Button>
        </>
      }
    >
      <form
        style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--rg-ink)" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate) create.mutate();
        }}
      >
        <Field label="Name your agent" error={nameErr}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Intake reviewer" maxLength={120} autoFocus />
        </Field>
        <Field label="Describe what it should do" error={description.length > 500 ? "Use 500 characters or fewer" : null}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Read new AI intake requests, flag missing details and suggest a risk tier."
            rows={3}
          />
        </Field>
        <ProjectSelect value={projectId} onChange={setProjectId} disabled={create.isPending} />
        <div>
          <Disclosure label="Advanced" open={advanced} onToggle={() => setAdvanced((a) => !a)} controls={advId} />
        </div>
        {advanced && (
          <div id={advId} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <ChoiceCards
              legend="Connection format"
              hint="Whose accounts the agent uses for its connections. This can't be changed later."
              value={format}
              onChange={setFormat}
              options={[
                { value: "shared", title: "Shared", sub: "Everyone uses one set of connected accounts.", icon: Icon.users(), badge: <span className={s.byline}>Recommended</span> },
                { value: "per_user", title: "Per person", sub: "Each person connects their own accounts.", icon: Icon.user() },
              ]}
            />
            <ChoiceCards
              legend="Should it use a computer?"
              hint="A computer lets an agent run programs and work with files. It's recorded now and isn't available in this workspace yet."
              value={computer}
              onChange={setComputer}
              options={[
                { value: "yes", title: "Yes", sub: "Give it a computer when one is available.", icon: Icon.monitor() },
                { value: "no", title: "No", sub: "Chat and tools only.", icon: Icon.chat(), badge: <span className={s.byline}>Default</span> },
              ]}
            />
            <ModelPicker
              label="Model"
              agents={models.tiles}
              value={modelId || models.defaultAgentId || ""}
              onChange={setModelId}
              placeholder="Your default model"
              testId="new-agent-model"
            />
          </div>
        )}
        {error && (
          <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: "var(--text-sm)" }}>
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

// ---- import -------------------------------------------------------------------

/** "Import": pick an exported .json bundle, check it, send it, open the new agent */
export function useImportBundle() {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ bundle: Parameters<typeof builderApi.importAgent>[0]; name: string } | null>(null);
  const [projectId, setProjectId] = useState("");
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseBundleText(await file.text());
    if (inputRef.current) inputRef.current.value = "";
    if (!parsed.ok) {
      toast(parsed.error, "error");
      return;
    }
    // owner rule: the importer chooses the project (never the bundle)
    setProjectId("");
    setPending({ bundle: parsed.bundle, name: parsed.bundle.agent.name });
  };
  const send = async () => {
    if (!pending || !projectId) return;
    setBusy(true);
    try {
      const res = await builderApi.importAgent(pending.bundle, projectId);
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: bk.agents });
      toast(importMessage(res.agent.name, res.dropped ?? []),
        res.dropped?.length ? "info" : "success",
      );
      navigate(`/builder/agents/${res.agent.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept=".json,application/json"
      className={s.srOnly}
      tabIndex={-1}
      aria-label="Agent export file"
      onChange={(e) => void onFile(e.target.files?.[0])}
    />
  );
  const dialog = (
    <Modal
      open={!!pending}
      title={`Import ${pending?.name ?? "agent"}`}
      onClose={() => !busy && setPending(null)}
      actions={
        <>
          <Button onClick={() => setPending(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!projectId || busy} onClick={() => void send()}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, color: "var(--rg-ink)" }}>
        <p className={s.small} style={{ margin: 0 }}>
          Tools and models are checked again for you; anything you can&apos;t use is left out.
        </p>
        <ProjectSelect value={projectId} onChange={setProjectId} disabled={busy} />
      </div>
    </Modal>
  );
  return { input, dialog, open: () => inputRef.current?.click(), busy };
}
