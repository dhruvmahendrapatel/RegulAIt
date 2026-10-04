/**
 * ADR-0173 §4 — the command palette (Ctrl/⌘-K, or the search button in the
 * top bar): one search over the pages a person may open and the things they
 * may open — their builder agents, recent agent threads, models, projects and
 * (for admins) use cases.
 *
 * ENTITLEMENT. Pages come from the suites the navigation renders, filtered the
 * same way (an admin-only suite is absent for a non-admin). Entities come from
 * list endpoints the person already reads, each entitlement-scoped by the
 * gateway; nothing new is asked of it, and a list the person may not read
 * simply contributes nothing.
 *
 * ARIA. A modal dialog holding the editable-combobox pattern: the input is a
 * combobox controlling a listbox (aria-activedescendant follows the active
 * option), results are grouped (role="group", named by their heading).
 * Keyboard: ArrowUp/ArrowDown move (wrapping), Home/End with Ctrl jump, Enter
 * opens, Escape closes; Tab stays inside the dialog (a focus trap of its two
 * controls). Closing returns focus to whatever opened it.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BuilderAgentSummary, BuilderThreadSummary, MyAgentsResponse, Project } from "../api/types";
import {
  KIND_LABELS,
  pageItems,
  pushRecent,
  readRecent,
  searchPalette,
  type PaletteItem,
} from "./commandPaletteModel";
import s from "./commandPalette.module.css";

const quiet = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null; // a list this person may not read contributes nothing
  }
};

/** the entity lists, fetched only while the palette is open */
function useEntityItems(open: boolean, userId: string | null, isAdmin: boolean): { items: PaletteItem[]; loading: boolean } {
  const agentsQ = useQuery({
    queryKey: ["palette", "builder-agents"],
    enabled: open && Boolean(userId),
    queryFn: () => quiet(api.get<{ agents: BuilderAgentSummary[] }>("/v1/builder/agents")),
    staleTime: 30_000,
  });
  const threadsQ = useQuery({
    queryKey: ["palette", "builder-threads"],
    enabled: open && Boolean(userId),
    queryFn: () => quiet(api.get<{ threads: BuilderThreadSummary[] }>("/v1/builder/threads?status=all")),
    staleTime: 30_000,
  });
  const modelsQ = useQuery({
    queryKey: ["palette", "models", userId],
    enabled: open && Boolean(userId),
    queryFn: () => quiet(api.get<MyAgentsResponse>(`/v1/users/${userId}/agents`)),
    staleTime: 30_000,
  });
  const projectsQ = useQuery({
    queryKey: ["palette", "projects"],
    enabled: open,
    queryFn: () => quiet(api.get<{ projects: Project[] }>("/v1/projects")),
    staleTime: 30_000,
  });
  // a use case has a page only in the admin console, so only an admin can open one
  const useCasesQ = useQuery({
    queryKey: ["palette", "use-cases"],
    enabled: open && isAdmin,
    queryFn: () => quiet(api.get<{ useCases?: Array<{ id: string; name: string; status: string }> }>("/v1/use-cases")),
    staleTime: 30_000,
  });

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    for (const t of [...(threadsQ.data?.threads ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10)) {
      out.push({
        key: `thread:${t.id}`,
        kind: "thread",
        label: t.title,
        sub: t.agentName,
        to: `/builder?agent=${encodeURIComponent(t.agentId)}&thread=${encodeURIComponent(t.id)}`,
      });
    }
    for (const a of agentsQ.data?.agents ?? []) {
      out.push({ key: `builder_agent:${a.id}`, kind: "builder_agent", label: a.name, sub: a.ownerName ?? undefined, to: `/builder/agents/${a.id}` });
    }
    for (const m of modelsQ.data?.agents ?? []) {
      if (m.revoked) continue;
      out.push({ key: `model:${m.agentId}`, kind: "model", label: m.name, sub: m.model ?? m.provider, to: `/models?model=${encodeURIComponent(m.agentId)}` });
    }
    for (const p of projectsQ.data?.projects ?? []) {
      out.push({ key: `project:${p.id}`, kind: "project", label: p.name, to: `/projects/${p.id}` });
    }
    if (isAdmin) {
      for (const u of useCasesQ.data?.useCases ?? []) {
        out.push({ key: `use_case:${u.id}`, kind: "use_case", label: u.name, sub: u.status.replace(/_/g, " "), to: `/admin/governance/use-cases/${u.id}` });
      }
    }
    return out;
  }, [threadsQ.data, agentsQ.data, modelsQ.data, projectsQ.data, useCasesQ.data, isAdmin]);

  const loading = [agentsQ, threadsQ, modelsQ, projectsQ, useCasesQ].some((q) => q.isFetching && !q.data);
  return { items, loading };
}

export function CommandPalette(props: { open: boolean; onClose: () => void; isAdmin: boolean; userId: string | null }) {
  if (!props.open) return null;
  return <PaletteDialog {...props} />;
}

function PaletteDialog(props: { onClose: () => void; isAdmin: boolean; userId: string | null }) {
  const navigate = useNavigate();
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (key: string) => `${uid}-opt-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>(readRecent);

  const pages = useMemo(() => pageItems(props.isAdmin), [props.isAdmin]);
  const entities = useEntityItems(true, props.userId, props.isAdmin);
  const groups = useMemo(
    () => searchPalette([...pages, ...entities.items], query, { recentKeys: recent }),
    [pages, entities.items, query, recent],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    inputRef.current?.focus();
    const back = returnTo.current;
    return () => {
      // closing returns focus to whatever opened the palette
      if (back && document.contains(back)) back.focus();
    };
  }, []);
  useEffect(() => {
    if (active > flat.length - 1) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);
  useEffect(() => {
    const item = flat[active];
    if (item) document.getElementById(optId(item.key))?.scrollIntoView?.({ block: "nearest" });
  }, [active, flat]);

  const open = (item: PaletteItem | undefined) => {
    if (!item) return;
    // written NOW, not in a state updater: closing unmounts this dialog in the
    // same batch, and an updater queued on an unmounting component never runs
    setRecent(pushRecent(recent, item.key));
    props.onClose();
    navigate(item.to);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
        break;
      case "Home":
        if (e.ctrlKey) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (e.ctrlKey) {
          e.preventDefault();
          setActive(Math.max(0, flat.length - 1));
        }
        break;
      case "Enter":
        e.preventDefault();
        open(flat[active]);
        break;
    }
  };

  // Escape anywhere in the dialog closes it; Tab cycles inside it (focus trap)
  const onDialogKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [],
    );
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const activeItem = flat[active];
  let index = -1;

  return (
    <div className={s.scrim} onMouseDown={(e) => e.target === e.currentTarget && props.onClose()} data-testid="command-palette">
      <div
        ref={dialogRef}
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Search pages and your work"
        onKeyDown={onDialogKey}
      >
        <div className={s.searchRow}>
          <svg className={s.searchIcon} width="18" height="18" viewBox="0 0 24 24" aria-hidden focusable="false">
            <path d="M5 10.5a5.5 5.5 0 1 0 11 0 5.5 5.5 0 1 0-11 0M14.5 14.5l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className={s.input}
            type="text"
            role="combobox"
            aria-label="Search pages, agents, models and projects"
            aria-autocomplete="list"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeItem ? optId(activeItem.key) : undefined}
            placeholder="Search pages, agents, models, projects…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className={s.close} onClick={props.onClose} aria-label="Close search">
            Esc
          </button>
        </div>
        <p className={flat.length === 0 ? s.none : s.srOnly} role="status">
          {flat.length === 0
            ? entities.loading
              ? "Searching…"
              : query.trim()
                ? `Nothing you can open matches “${query.trim()}”.`
                : "Type to search."
            : `${flat.length} result${flat.length === 1 ? "" : "s"}`}
        </p>
        <div id={listId} role="listbox" aria-label="Results" className={s.results} hidden={flat.length === 0}>
          {groups.map((g) => {
              const headId = `${uid}-group-${g.kind}`;
              return (
                <div key={g.kind} role="group" aria-labelledby={headId} className={s.group}>
                  <div id={headId} className={s.groupHead} role="presentation">
                    {g.kind === "recent" ? "Recent" : KIND_LABELS[g.kind]}
                  </div>
                  {g.items.map((item) => {
                    index += 1;
                    const i = index;
                    return (
                      <div
                        key={item.key}
                        id={optId(item.key)}
                        role="option"
                        aria-selected={i === active}
                        className={s.option}
                        data-active={i === active || undefined}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => setActive(i)}
                        onClick={() => open(item)}
                      >
                        <span className={s.optLabel}>{item.label}</span>
                        {item.sub && <span className={s.optSub}>{item.sub}</span>}
                        {g.kind === "recent" && <span className={s.optKind}>{KIND_LABELS[item.kind]}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
        </div>
        <div className={s.foot} aria-hidden>
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
