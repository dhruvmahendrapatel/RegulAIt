/**
 * P3 long-page split (#453 c6527514889): a long page keeps a short preview of each growing record list, and the full
 * list moves to its own page under the parent's path with the shared list control.
 *
 * `ListPreview` reads the list contract for its first rows and an exact count, plus one exact count per "needs
 * attention" filter, so the heading says "27 identities · 2 suspended" and a problem is never hidden behind the link.
 * At most five rows show. `SubpageTrail` is the full page's breadcrumb back to its parent.
 */
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { api } from "../api/client";
import { Card, Table, type Column } from "./kit";
import { normalisePage, pageUrl, type Filters, type ListSort } from "./listState";
import d from "./ListPreview.module.css";

export const PREVIEW_ROWS = 5;

export interface PreviewAttention {
  /** what the count is of, lower case: "suspended" in "27 identities · 2 suspended" */
  label: string;
  filters: Filters;
}

const n = (x: number) => x.toLocaleString("en-GB");

/** "27 identities · 2 suspended" (an attention count shows only when something needs it) */
export function previewHeading(total: number | null, noun: string, attention: Array<{ label: string; count: number | null }>): string {
  if (total === null) return "";
  return [`${n(total)} ${noun}`, ...attention.filter((a) => (a.count ?? 0) > 0).map((a) => `${n(a.count!)} ${a.label}`)].join(" · ");
}

export function ListPreview<T>(props: {
  title: string;
  /** plural, lower case */
  noun: string;
  endpoint: string;
  legacyKey: string;
  queryKey: readonly unknown[];
  sort: ListSort;
  filters?: Filters;
  attention?: PreviewAttention[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  /** the full list's own page, e.g. `/admin/sso/link-requests` */
  viewAll: string;
  empty?: ReactNode;
  /** a fixed sentence in place of the read's own error */
  errorMessage?: string;
  info?: ReactNode;
  /** a standing warning the full list carried, kept on the overview above the rows */
  note?: ReactNode;
  /** each time the first rows arrive (the page may name things from them) */
  onRows?: (rows: T[]) => void;
}) {
  const filters = props.filters ?? {};
  const read = (f: Filters) => () =>
    api.get<unknown>(pageUrl(props.endpoint, { limit: 10, sort: props.sort, filters: f, count: "exact" })).then((b) => normalisePage<T>(b, props.legacyKey));
  const attention = props.attention ?? [];
  const [main, ...counts] = useQueries({
    queries: [
      { queryKey: [...props.queryKey, "preview", filters], queryFn: read(filters) },
      ...attention.map((a) => ({ queryKey: [...props.queryKey, "preview-count", { ...filters, ...a.filters }], queryFn: read({ ...filters, ...a.filters }) })),
    ],
  });
  const firstRows = main!.data?.items;
  const onRows = props.onRows;
  useEffect(() => {
    if (firstRows) onRows?.(firstRows);
  }, [firstRows]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = main!.data ? (main!.data.total ?? main!.data.items.length) : null;
  const heading = previewHeading(
    total,
    props.noun,
    attention.map((a, i) => ({ label: a.label, count: counts[i]?.data?.total ?? null })),
  );
  return (
    <Card
      title={heading ? `${props.title} · ${heading}` : props.title}
      info={props.info}
      actions={
        <Link to={props.viewAll} aria-label={`View all ${props.noun}`}>
          View all →
        </Link>
      }
    >
      <div className={d.preview} data-preview={props.endpoint}>
        {props.note}
        <Table<T>
          columns={props.columns}
          rows={main!.data?.items.slice(0, PREVIEW_ROWS)}
          rowKey={props.rowKey}
          loading={main!.isLoading}
          error={main!.error && props.errorMessage ? new Error(props.errorMessage) : main!.error}
          onRetry={() => void main!.refetch()}
          empty={props.empty}
        />
      </div>
    </Card>
  );
}

/** the breadcrumb of a list's own page: a link back to the page it came from, then where you are */
export function SubpageTrail(props: { parent: string; parentTo: string; current: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className={d.trail}>
        <li>
          <Link to={props.parentTo}>{props.parent}</Link>
        </li>
        <li aria-current="page">{props.current}</li>
      </ol>
    </nav>
  );
}
