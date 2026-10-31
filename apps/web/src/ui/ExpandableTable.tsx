/**
 * I-2: a kit Table whose rows expand in place. Its own module, like FoldTable (ui/fold.tsx), so only the screens with
 * an expanding table load it and the entry bundle stays inside its size-limit ceiling (#453, 2026-10-31). It renders
 * the kit Table's markup and classes (sort, loading, stale, error and empty states) and adds the expansion:
 *
 * - a first column whose button carries `aria-expanded` and `aria-controls`;
 * - `render(row)` in a full-width row under it, as a region named after `label(row)`;
 * - opening from the button moves focus into that region, so a screen reader reads the detail; Esc inside it closes
 *   the row and returns focus to the button;
 * - a mouse click anywhere on the row (not on a control) toggles it too.
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, EmptyState, ErrorState, InfoButton, Skeleton, StatusDot, type TableProps } from "./kit";
import s from "./kit.module.css";
import x from "./expandableTable.module.css";

export type ExpandableTableProps<T> = TableProps<T> & {
  expand: { open: (row: T) => boolean; toggle: (row: T) => void; label: (row: T) => string; render: (row: T) => ReactNode };
};

export function ExpandableTable<T>(props: ExpandableTableProps<T>) {
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
  const by = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };
  const shown = props.columns.filter((c) => !c.hidden);
  const ex = props.expand;
  const exId = useId();
  const detailId = (row: T) => `${exId}-x-${props.rowKey(row).replace(/[^\w-]/g, "_")}`;
  // the row opened from its button: its region takes focus once rendered
  const focusOpened = useRef<string | null>(null);
  useEffect(() => {
    if (focusOpened.current == null) return;
    document.getElementById(focusOpened.current)?.focus();
    focusOpened.current = null;
  });
  const cols = shown.length + 1;

  return (
    <div className={s.tableWrap}>
      {/* aria-busy while the skeleton rows stand in for data, so the wait is announced like SkeletonBlock's */}
      <table className={`${s.table} ${x.table}`} aria-busy={props.loading || undefined}>
        <thead>
          <tr>
            <th aria-label="Details" className={x.thToggle} />
            {shown.map((c) => {
              const sortable = Boolean(c.sort);
              const active = sortKey === c.key;
              return (
                <th
                  key={c.key}
                  style={{ textAlign: c.align ?? "left", width: c.width }}
                  className={sortable ? s.thSortable : undefined}
                  aria-label={c.header === "" ? c.srHeader : undefined}
                  aria-sort={sortKey != null && (c.sortKeys ?? [c.key]).includes(sortKey) ? (sortDir === 1 ? "ascending" : "descending") : undefined}
                  onClick={sortable ? () => by(c.key) : undefined}
                >
                  {sortable ? <button type="button" className={s.thSortBtn}>{c.header}</button> : c.header}
                  {c.info != null && (
                    <InfoButton label={c.infoLabel ?? (typeof c.header === "string" ? c.header : c.key)}>{c.info}</InfoButton>
                  )}
                  {active && <span className={s.sortArrow}>{sortDir === 1 ? "▲" : "▼"}</span>}
                  {c.head?.({ key: sortKey, dir: sortDir, by })}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {props.loading
            ? [0, 1, 2].map((i) => (
                <tr key={`sk-${i}`}>
                  <td />
                  {shown.map((c) => (
                    <td key={c.key}>
                      <Skeleton width={`${55 + ((i * 17) % 35)}%`} />
                    </td>
                  ))}
                </tr>
              ))
            : sorted.map((row) => {
                const clickable = Boolean(props.onRowClick);
                const open = ex.open(row);
                const did = detailId(row);
                return (
                  <Fragment key={props.rowKey(row)}>
                    <tr
                      className={clickable ? s.rowClickable : x.rowExpandable}
                      tabIndex={clickable ? 0 : undefined}
                      role={clickable ? "link" : undefined}
                      aria-label={clickable ? props.rowLabel?.(row) : undefined}
                      onClick={
                        clickable
                          ? () => props.onRowClick!(row)
                          : (e) => {
                              if (!(e.target as HTMLElement).closest("button,a,input,select,textarea,label")) ex.toggle(row);
                            }
                      }
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.target === e.currentTarget && e.key === "Enter") {
                                e.preventDefault();
                                props.onRowClick!(row);
                              }
                            }
                          : undefined
                      }
                    >
                      <td>
                        <button
                          type="button"
                          id={`${did}-b`}
                          className={x.rowToggle}
                          aria-expanded={open}
                          aria-controls={did}
                          aria-label={`Details: ${ex.label(row)}`}
                          onClick={() => {
                            if (!open) focusOpened.current = `${did}-r`;
                            ex.toggle(row);
                          }}
                        >
                          <span aria-hidden>{open ? "▾" : "▸"}</span>
                        </button>
                      </td>
                      {shown.map((c) => (
                        <td key={c.key} style={{ textAlign: c.align ?? "left" }}>
                          {c.render(row)}
                        </td>
                      ))}
                    </tr>
                    {/* always in the DOM, so the button's aria-controls never dangles; empty and hidden while closed */}
                    <tr id={did} className={x.rowExpanded} hidden={!open}>
                      <td colSpan={cols}>
                        {open && (
                          <div
                            id={`${did}-r`}
                            role="region"
                            aria-label={`Details: ${ex.label(row)}`}
                            tabIndex={-1}
                            className={x.rowDetail}
                            onKeyDown={(e) => {
                              if (e.key !== "Escape") return;
                              e.stopPropagation();
                              ex.toggle(row);
                              document.getElementById(`${did}-b`)?.focus();
                            }}
                          >
                            {ex.render(row)}
                          </div>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
          {!props.loading && sorted.length > 0 && props.error != null && (
            // rows from the last good fetch stay on screen, but a failed refetch is never silent (as in the kit Table)
            <tr>
              <td colSpan={cols} className={s.tableStale} role="alert">
                <StatusDot tone="danger" />
                <span>
                  Couldn't refresh this list — {props.error instanceof Error ? props.error.message : String(props.error)}.
                  Showing the last loaded rows.
                </span>
                {props.onRetry && (
                  <Button size="sm" onClick={props.onRetry}>
                    Retry
                  </Button>
                )}
              </td>
            </tr>
          )}
          {!props.loading && sorted.length === 0 && props.error != null && (
            <tr>
              <td colSpan={cols}>
                <ErrorState
                  title="Couldn't load this list"
                  message={props.error instanceof Error ? props.error.message : String(props.error)}
                  access={(props.error as { status?: number }).status === 403}
                  onRetry={props.onRetry}
                />
              </td>
            </tr>
          )}
          {!props.loading && sorted.length === 0 && props.error == null && (
            <tr>
              <td colSpan={cols}>{props.empty ?? <EmptyState title="Nothing here yet" />}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
