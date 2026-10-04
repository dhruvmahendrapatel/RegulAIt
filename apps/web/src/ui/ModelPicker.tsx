/**
 * ADR-0172 — the one model picker. A button showing the chosen model's
 * provider logo and name opens a searchable popover of model tiles (logo,
 * name, model id, tier, readiness).
 *
 * ARIA: the trigger is a button (aria-haspopup="dialog", aria-expanded) named
 * by the visible label plus the current value. The popover is a small dialog
 * holding the editable-combobox pattern: a search input (role="combobox",
 * aria-controls the listbox, aria-activedescendant the active option) over a
 * listbox of options. Keyboard: ArrowDown/Enter/Space on the trigger opens;
 * typing filters; ArrowUp/ArrowDown/Home/End move; Enter picks; Escape closes.
 * Picking or Escape returns focus to the trigger; Tab or a click outside
 * closes without stealing focus back.
 *
 * The label is NOT a <label>: a <label for> on a button replaces its name
 * (see kit Field), so it is a plain span referenced by aria-labelledby, and
 * `getByLabel(label)` still finds the trigger.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, type Tone } from "./kit";
import { Logo } from "./logos/Logo";
import { providerLogoKey } from "./logos/providerLogo";
import k from "./kit.module.css";
import s from "./modelPicker.module.css";

export interface ModelPickerAgent {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  model: string | null;
  tier: number;
  logoKey: string | null;
  readinessLabel: string;
  readinessTone: Tone;
}

/** the tile body the picker and the /models grid share; its logo is decorative (the provider is in the text) */
export function ModelTileBody(props: { agent: ModelPickerAgent; size?: "sm" | "md" }) {
  const a = props.agent;
  const logo = props.size === "sm" ? 22 : 28;
  return (
    <span className={s.tileBody}>
      <span className={s.tileHead}>
        <span className={s.logoWrap} aria-hidden="true">
          <Logo name={a.logoKey} label={a.providerLabel} size={logo} />
        </span>
        <span className={s.tileText}>
          <span className={s.tileName}>{a.name}</span>
          <span className={s.tileModel}>{a.model ?? "no model id"}</span>
        </span>
      </span>
      <span className={s.tileBadges}>
        <span className={s.tileProvider}>{a.providerLabel}</span>
        <Badge>Tier {a.tier}</Badge>
        <Badge tone={a.readinessTone}>{a.readinessLabel}</Badge>
      </span>
    </span>
  );
}

function matches(a: ModelPickerAgent, q: string): boolean {
  if (!q) return true;
  return [a.name, a.model ?? "", a.provider, a.providerLabel].some((f) => f.toLowerCase().includes(q));
}

export function ModelPicker(props: {
  agents: readonly ModelPickerAgent[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  /** when set, the picker is unavailable and says why */
  disabledReason?: string;
  testId?: string;
}) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const valueId = `${uid}-value`;
  const listId = `${uid}-list`;
  const reasonId = `${uid}-reason`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = props.agents.find((a) => a.id === props.value) ?? null;
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => props.agents.filter((a) => matches(a, q)), [props.agents, q]);
  const disabled = Boolean(props.disabledReason);

  const openPicker = () => {
    if (disabled) return;
    setQuery("");
    const at = props.agents.findIndex((a) => a.id === props.value);
    setActive(at >= 0 ? at : 0);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (a: ModelPickerAgent | undefined) => {
    if (!a) return;
    props.onChange(a.id);
    close(true);
  };

  // focus the search box on open
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // keep the active option in range as the filter narrows, and in view
  useEffect(() => {
    if (!open) return;
    if (active > shown.length - 1) setActive(Math.max(0, shown.length - 1));
  }, [open, shown.length, active]);
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(optId(active));
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  // a click outside closes (focus stays where the click put it)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openPicker();
    }
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => (shown.length ? (i + 1) % shown.length : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0));
        break;
      case "Home":
        if (e.ctrlKey || !query) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (e.ctrlKey || !query) {
          e.preventDefault();
          setActive(Math.max(0, shown.length - 1));
        }
        break;
      case "Enter":
        e.preventDefault();
        pick(shown[active]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div className={`${k.field} ${s.root}`} ref={rootRef} data-testid={props.testId}>
      <span id={labelId} className={k.fieldLabel}>
        {props.label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className={s.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-describedby={disabled ? reasonId : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={onTriggerKey}
      >
        {selected ? (
          <>
            <span aria-hidden="true" className={s.logoWrap}>
              <Logo name={selected.logoKey} label={selected.providerLabel} size={20} />
            </span>
            <span id={valueId} className={s.triggerText}>
              <span className={s.triggerName}>{selected.name}</span>
              <span className={s.triggerMeta}>
                {selected.model ?? selected.providerLabel} · tier {selected.tier}
              </span>
            </span>
          </>
        ) : (
          <span id={valueId} className={s.triggerText}>
            <span className={s.triggerPlaceholder}>Choose a model</span>
          </span>
        )}
        <svg className={s.chevron} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {disabled && (
        <span id={reasonId} className={s.reason}>
          {props.disabledReason}
        </span>
      )}
      {open && (
        <div className={s.popover} role="dialog" aria-label="Choose a model">
          <input
            ref={searchRef}
            className={k.input}
            type="search"
            role="combobox"
            aria-label="Search models"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown.length ? optId(active) : undefined}
            placeholder="Search models and providers"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onSearchKey}
          />
          {shown.length === 0 ? (
            <p className={s.none} role="status">
              No models match “{query.trim()}”.
            </p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Models" className={s.list}>
              {shown.map((a, i) => (
                <li
                  key={a.id}
                  id={optId(i)}
                  role="option"
                  aria-selected={a.id === props.value}
                  data-active={i === active || undefined}
                  className={s.option}
                  // keep focus in the search box; the click picks
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(a)}
                >
                  <ModelTileBody agent={a} size="sm" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A provider name with its logo in front — for table cells and lists. The
 * logo is decorative (aria-hidden): the cell's accessible name stays exactly
 * the text it always had.
 */
export function ProviderMark(props: { provider: string; label: string; size?: number; children?: ReactNode }) {
  return (
    <span className={s.mark}>
      <span aria-hidden="true" className={s.logoWrap}>
        <Logo name={providerLogoKey(props.provider)} label={props.label} size={props.size ?? 18} />
      </span>
      {props.children ?? props.provider}
    </span>
  );
}

/**
 * Provider choice as tiles (logo + name): native radio buttons in a fieldset,
 * so arrows move between them and the group is named by its legend.
 */
export function ProviderTiles(props: {
  legend: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  testId?: string;
}) {
  const name = useId();
  return (
    <fieldset className={`${k.fieldset} ${s.providerSet}`} data-testid={props.testId}>
      <legend className={k.fieldLabel}>{props.legend}</legend>
      <div className={s.providerTiles}>
        {props.options.map((o) => (
          <label key={o.value} className={s.providerTile} data-checked={o.value === props.value || undefined}>
            <input
              type="radio"
              className={s.providerRadio}
              name={name}
              value={o.value}
              checked={o.value === props.value}
              onChange={() => props.onChange(o.value)}
            />
            <span aria-hidden="true" className={s.logoWrap}>
              <Logo name={providerLogoKey(o.value)} label={o.label} size={20} />
            </span>
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
