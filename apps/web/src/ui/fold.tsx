/**
 * F6/F20/F21/F25 (owner-approved on #453, 2026-10-21): a Table whose narrow layout folds columns into another
 * column's cell (Column.fold). Its own module, so only the screens with a folding table load it and the entry bundle
 * stays inside its size-limit ceiling (#477 H1).
 */
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { InfoButton, Table, type Column, type TableProps } from "./kit";
import s from "./kit.module.css";
import v from "../views/views.module.css";

export type FoldStep = "lg" | "md" | "sm";

/** the column each column renders in at this step: its own key, or the key of the column that hosts it (exported for its test) */
export function foldHosts<T>(columns: Array<Column<T>>, step: FoldStep): Map<string, string> {
  const next = (c: Column<T>) => (step === "lg" ? undefined : (step === "sm" && c.fold?.sm) || c.fold?.md);
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const hosts = new Map<string, string>();
  for (const c of columns) {
    // a chain is followed to its end; a loop (or a key that names no column) leaves the column where it is
    const seen = new Set([c.key]);
    let at = c;
    let to;
    while ((to = next(at)) && byKey.has(to) && !seen.has(to)) {
      seen.add(to);
      at = byKey.get(to)!;
    }
    hosts.set(c.key, to && seen.has(to) ? c.key : at.key);
  }
  return hosts;
}

const nameOf = <T,>(c: Column<T>) => (typeof c.header === "string" ? c.header : c.infoLabel ?? c.key);
const isEmpty = (value: ReactNode) => value == null || value === false || value === "";
const info = <T,>(c: Column<T>) => c.info != null && <InfoButton label={c.infoLabel ?? nameOf(c)}>{c.info}</InfoButton>;

/** the table's own width, so a page narrowed by the drawer folds its table on a wide window */
function useFoldStep(wrap: React.RefObject<HTMLDivElement | null>): FoldStep {
  const [step, setStep] = useState<FoldStep>("lg");
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // a collapsed card measures 0 px and folds to sm; it re-measures when it opens
    const check = () => setStep(el.clientWidth < 600 ? "sm" : el.clientWidth < 1000 ? "md" : "lg");
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrap]);
  return step;
}

// a folded name that sorts reads as header text, like the host header it sits in
const SORT = { padding: "unset", border: "none", background: "none", font: "inherit", color: "inherit", cursor: "pointer" };

export function FoldTable<T>(props: TableProps<T>) {
  const wrap = useRef<HTMLDivElement>(null);
  const step = useFoldStep(wrap);
  const columns = useMemo(() => {
    const hosts = foldHosts(props.columns, step);
    const folded = new Map<string, Array<Column<T>>>();
    for (const c of props.columns) {
      const host = hosts.get(c.key)!;
      if (host !== c.key) folded.set(host, [...(folded.get(host) ?? []), c]);
    }
    return props.columns.map((c): Column<T> => {
      const into = folded.get(c.key);
      if (hosts.get(c.key) !== c.key) return { ...c, hidden: true };
      if (!into) return c;
      return {
        ...c,
        sortKeys: [c.key, ...into.map((f) => f.key)],
        // the folded columns' names and (i), once, in this header; a sortable one is its own sort button, so its sort
        // stays reachable (#477 M1)
        head: (sort) => (
          <span style={{ whiteSpace: "normal" }}>
            {into.map((f) => (
              <Fragment key={f.key}>
                {" "}
                <span style={{ whiteSpace: "nowrap" }}>
                  ·{" "}
                  {f.sort ? (
                    <button
                      type="button"
                      style={SORT}
                      onClick={(e) => {
                        e.stopPropagation();
                        sort.by(f.key);
                      }}
                    >
                      {f.header}
                    </button>
                  ) : (
                    f.header
                  )}
                  {info(f)}
                  {sort.key === f.key && <span className={s.sortArrow}>{sort.dir === 1 ? "▲" : "▼"}</span>}
                </span>
              </Fragment>
            ))}
          </span>
        ),
        render: (row) => (
          <>
            {c.render(row)}
            {into.map((f) => {
              const value = f.render(row);
              return isEmpty(value) ? null : (
                // inline, as the entry CSS has no headroom (size-limit); the label is a .fieldLabel
                <div key={f.key} data-fold={f.key} style={{ display: "flex", flexWrap: "wrap", gap: "0 var(--s1)", marginTop: "var(--s0)" }}>
                  <span className={s.fieldLabel} style={{ minWidth: "4rem" }}>
                    {nameOf(f)}
                  </span>
                  {/* a long code wraps rather than widening the narrow table it was folded to fit */}
                  <span style={{ overflowWrap: "anywhere" }}>{value}</span>
                </div>
              );
            })}
          </>
        ),
      };
    });
  }, [props.columns, step]);
  return (
    <div ref={wrap} data-fold-step={step}>
      <Table {...props} columns={columns} />
    </div>
  );
}

/** A list read with `?limit=N` says so once it is full, so a full page never reads as the whole history (A15).
 * Here, beside FoldTable, rather than in adminKit: adminKit ships in the entry bundle, this module is lazy. */
export function NewestNote(props: { shown: number; limit: number; noun: string }) {
  return props.shown >= props.limit ? (
    <p className={v.faint} data-testid="newest-note">Showing the newest {props.limit} {props.noun}; older ones are not listed here.</p>
  ) : null;
}
