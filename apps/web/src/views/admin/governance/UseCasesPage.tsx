/**
 * The AI registry (ADR-0168 item 2; ADR-0080 for the use-case object).
 *
 * One place to see every registered AI use case and where it stands: headline
 * counts, filters, a table, and a right-hand preview a row opens without
 * leaving the list. There is ONE way in — "Register AI use case" opens the
 * intake wizard (ADR-0168 item 1); this page creates nothing itself.
 *
 * Status is decided, never edited: approval, conditions and send-back happen
 * at the review, and this page only shows the result.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, Input, Select, Table, type TableProps } from "../../../ui/kit";
import { DataList, type DataColumn } from "../../../ui/DataList";
import { RegistryIcon, RegistryState } from "./RegistryPresentation";
import { UseCasePreviewDrawer } from "./UseCasePreviewDrawer";
import { RetireUseCaseDialog } from "./RetireUseCase";
import {
  NO_FILTERS,
  fmtDay,
  isFiltered,
  rowStatus,
  tierLabel,
  tierTone,
  validity,
  type RegistryFilters,
  type StatusFilter,
  type TierFilter,
  type UseCaseRow,
} from "./registryModel";
import r from "./registry.module.css";
import v from "../../views.module.css";

const ViewContext = createContext({ view: "list" as "list" | "grid", filtersOpen: false });
const CARD_QUERY = "(max-width: 1100px)";
function subscribeCards(callback: () => void) {
  const query = window.matchMedia(CARD_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
const narrowCards = () => window.matchMedia(CARD_QUERY).matches;

const INTAKE = "/admin/governance/intake";

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "in_review", label: "In review" },
  { value: "proposed", label: "Proposed" },
  { value: "under_review", label: "Under review" },
  { value: "needs_info", label: "Needs information" },
  { value: "recertification", label: "Re-review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "retired", label: "Retired" },
];

const LIFECYCLE_STAGES: Array<{ value: StatusFilter; label: string }> = [
  { value: "proposed", label: "Proposed" },
  { value: "under_review", label: "Under review" },
  ...STATUS_OPTIONS.filter(({ value }) => value === "needs_info" || value === "approved" || value === "rejected" || value === "retired"),
];

interface RegistrySummary {
  headline: { total: number; underReview: number; approved: number; highTier: number };
  statusCounts: Record<string, number>;
  owners: Array<{ id: string; name: string }>;
}

/** ADR-0226: the registry's columns; the ids and sortable ones match the gateway's USE_CASES_LIST */
const USE_CASE_COLUMNS: Array<DataColumn<UseCaseRow>> = [
  {
    key: "name",
    header: "Use-case name",
    main: true,
    sortable: true,
    render: (row) => (
      <span className={r.nameCell}>
        <span className={r.nameText}>{row.name}</span>
        {row.description ? <span className={r.nameSub}>{row.description}</span> : null}
      </span>
    ),
  },
  {
    key: "tier",
    header: "Risk tier",
    main: true,
    sortable: true,
    required: "The risk tier is always shown",
    render: (row) => (row.euAiActTier ? <span className={r.statusPill} data-tone={row.euAiActTier === "high" ? "danger" : tierTone(row.euAiActTier)}>{tierLabel(row.euAiActTier)}</span> : <span className={`${v.faint} ${r.nowrap}`}>Not screened</span>),
  },
  { key: "status", header: "Lifecycle", main: true, sortable: true, required: "Status is always shown", render: (row) => <span className={r.statusPill} data-tone={rowStatus(row).tone}>{rowStatus(row).label}</span> },
  { key: "owner", header: "Owner", main: true, sortable: true, render: (row) => (
    <span className={r.owner}><span aria-hidden="true" className={r.ownerAvatar}>{row.ownerName?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?"}</span>{row.ownerName ?? "Unnamed"}</span>
  ) },
  { key: "created", header: "Created", sortable: true, render: (row) => <span className={r.nowrap}>{fmtDay(row.createdAt)}</span> },
  {
    key: "validUntil",
    header: "Valid until",
    sortable: true,
    render: (row) => {
      const until = validity(row.approvedUntil);
      return <span className={`${r.nowrap} ${until.expired ? r.expired : ""}`}>{until.text}</span>;
    },
  },
  {
    key: "conditions",
    header: "Open conditions",
    sortable: true,
    align: "right",
    render: (row) => (row.openConditions ? <Badge tone="warn">{row.openConditions}</Badge> : <span className={v.faint}>{row.openConditions === 0 ? "0" : "—"}</span>),
  },
  { key: "sensitivity", header: "Data sensitivity", sortable: true, render: (row) => row.dataSensitivity },
  { key: "decided", header: "Decided", sortable: true, render: (row) => (row.decidedAt ? fmtDay(row.decidedAt) : "—") },
];

export default function UseCasesPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"list" | "grid">("list");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [moreMetrics, setMoreMetrics] = useState(false);
  const [exportTarget, setExportTarget] = useState<HTMLDivElement | null>(null);
  const [filters, setFilters] = useState<RegistryFilters>(NO_FILTERS);
  // the search runs on the server, a moment after typing stops
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQ(filters.search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [filters.search]);
  const serverFilters = useMemo(
    () => ({
      q: q || undefined,
      status: filters.status === "all" ? undefined : filters.status,
      tier: filters.tier === "all" ? undefined : filters.tier,
      owner: filters.owner || undefined,
    }),
    [q, filters.status, filters.tier, filters.owner],
  );
  // Counts and owner choices cover every use case the existing endpoint makes visible.
  const [summary, setSummary] = useState<RegistrySummary | null>(null);
  const [rows, setRows] = useState<UseCaseRow[]>([]);
  const onRows = useCallback((pageRows: UseCaseRow[], raw: Record<string, unknown>) => {
    setRows(pageRows);
    setSummary(raw.summary ? raw.summary as RegistrySummary : null);
  }, []);
  const counts = summary?.headline ?? { total: 0, underReview: 0, approved: 0, highTier: 0 };
  const owners = summary?.owners ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  // G11: the row's Retire opens the drawer's own retire form in a dialog
  const [retiring, setRetiring] = useState<UseCaseRow | null>(null);
  // the row that opened the preview gets focus back when it closes
  const opener = useRef<HTMLElement | null>(null);
  const set = (patch: Partial<RegistryFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const statusCount = (value: StatusFilter) => summary?.statusCounts[value] ?? 0;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "use-cases"] });
  const tile = (label: string, value: number, tone: string, pressed: boolean | undefined, apply: Partial<RegistryFilters>) => (
    <button type="button" className={r.tile} data-tone={tone} aria-pressed={pressed} onClick={() => setFilters(pressed ? NO_FILTERS : { ...NO_FILTERS, ...apply })}>
      <RegistryIcon name={tone} />
      <span className={r.tileCopy}><span className={r.tileLabel}>{label}</span>{" "}<span className={r.tileValue}>{summary ? value : "—"}</span></span>
    </button>
  );
  const closePreview = () => {
    setOpenId(null);
    opener.current?.focus();
  };
  const empty = summary && summary.headline.total === 0;

  return (
    <>
      <div className={r.workspace}>
        <header className={r.heading}>
          <div><h1 tabIndex={-1}>AI Use-Cases</h1><p>Registry of AI use-cases, their risk, compliance, ownership and lifecycle status.</p></div>
          <div className={r.headerActions}><RegisterSplitButton /><div className={r.exportSlot} ref={setExportTarget} /></div>
        </header>
        <div className={r.tiles} role="group" aria-label="Headline counts" data-more={moreMetrics}>
          {tile("Total use cases", counts.total, "total", undefined, {})}
          {tile("Approved", counts.approved, "approved", filters.status === "approved" && filters.tier === "all", { status: "approved" })}
          {tile("In review", counts.underReview, "review", filters.status === "in_review" && filters.tier === "all", { status: "in_review" })}
          {tile("High or prohibited", counts.highTier, "risk", filters.tier === "high_or_prohibited" && filters.status === "all", { tier: "high_or_prohibited" })}
          {tile("Needs information", statusCount("needs_info"), "pending", filters.status === "needs_info" && filters.tier === "all", { status: "needs_info" })}
        </div>
        <button type="button" className={r.moreMetrics} aria-expanded={moreMetrics} onClick={() => setMoreMetrics(!moreMetrics)}>{moreMetrics ? "Fewer metrics" : "More metrics"}</button>
        <section aria-label="Use-case registry" className={r.results}>
          {empty ? (
            <RegistryState kind="empty" title="No AI use cases found">
              <p>Register your first use case to get started.</p>
              <Link to={INTAKE} className={r.primary}>Add use case</Link>
            </RegistryState>
          ) : (
            <div className={r.toolbar} role="search" aria-label="Filter use cases">
              <Input
                className={r.search}
                type="search"
                aria-label="Search use cases"
                placeholder="Search by name, purpose or owner"
                value={filters.search}
                onChange={(e) => set({ search: e.target.value })}
              />
              <button className={r.filterToggle} type="button" aria-controls="registry-filters" aria-expanded={filtersOpen} aria-label="Show registry filters" onClick={() => setFiltersOpen(!filtersOpen)}><RegistryIcon name="filter" /></button>
              <div id="registry-filters" className={r.filters} data-open={filtersOpen}>
              <Select className={r.chipSelect} aria-label="Status" value={filters.status} onChange={(e) => set({ status: e.target.value as StatusFilter })}>
                {STATUS_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{summary ? `${label} (${statusCount(value)})` : label}</option>
                ))}
              </Select>
              <Select className={r.chipSelect} aria-label="Tier" value={filters.tier} onChange={(e) => set({ tier: e.target.value as TierFilter })}>
                <option value="all">All tiers</option>
                <option value="high_or_prohibited">High or prohibited</option>
                <option value="prohibited">Prohibited</option>
                <option value="high">High</option>
                <option value="limited">Limited</option>
                <option value="minimal">Minimal</option>
                <option value="unscreened">Not screened</option>
              </Select>
              <select className={r.unavailableArea} aria-label="Business area unavailable" disabled><option>Business area: —</option></select>
              <Select className={r.chipSelect} aria-label="Owner" value={filters.owner} onChange={(e) => set({ owner: e.target.value })}>
                <option value="">All owners</option>
                {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
              <Button variant="ghost" size="sm" className={r.clear} disabled={!isFiltered(filters)} onClick={() => setFilters(NO_FILTERS)}>Clear all</Button>
              <div className={r.viewModes} role="group" aria-label="Registry view">
                <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><RegistryIcon name="list" /></button>
                <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><RegistryIcon name="grid" /></button>
              </div>
              </div>
            </div>
          )}
          <div className={r.registryList} hidden={Boolean(empty)}>
            <ViewContext.Provider value={{ view, filtersOpen }}>
            <DataList<UseCaseRow>
              listId="use-cases"
              noun="use cases"
              endpoint="/v1/use-cases"
              exportPath="/v1/use-cases/export.xlsx"
              exportTarget={empty ? null : exportTarget}
              footerControls
              queryKey={["admin", "use-cases", "list"]}
              legacyKey="useCases"
              filters={serverFilters}
              defaultSort={{ key: "created", dir: "desc" }}
              rowKey={(row) => row.id}
              rowLabel={(row) => `${row.name}, ${rowStatus(row).label} — open preview`}
              onRowClick={(row) => {
                opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                setOpenId(openId === row.id ? null : row.id);
              }}
              onRows={onRows}
              table={RegistryResults}
              empty={<RegistryState kind="empty" title="No use cases match these filters"><p>Try adjusting your filters or add a new use case.</p><Button size="sm" onClick={() => setFilters(NO_FILTERS)}>Clear all</Button></RegistryState>}
              columns={[
                ...USE_CASE_COLUMNS,
                {
                  key: "actions",
                  header: "",
                  srHeader: "Actions",
                  align: "right",
                  action: true,
                  render: (row) => <RegistryRowMenu row={row} onPreview={(trigger) => { opener.current = trigger; setOpenId(row.id); }} onRetire={() => setRetiring(row)} />,
                },
              ]}
            />
            </ViewContext.Provider>
          </div>
        </section>
        {summary && !empty && (
          <details className={r.lifecycle} aria-label="Lifecycle overview">
            <summary>Lifecycle overview</summary>
            <Card>
              <div className={r.analyticsRows}>
                {LIFECYCLE_STAGES.map(({ value, label }) => {
                  const count = statusCount(value);
                  return (
                    <div key={value} className={r.analyticsRow}>
                      <span>{label}</span>
                      <span className={r.analyticsTrack} aria-hidden="true">
                        <span className={r.analyticsFill} style={{ width: `${(count / counts.total) * 100}%` }} />
                      </span>
                      <strong>{count}</strong>
                    </div>
                  );
                })}
              </div>
            </Card>
          </details>
        )}
      </div>
      {retiring && <RetireUseCaseDialog id={retiring.id} name={retiring.name} onClose={() => setRetiring(null)} onRetired={refresh} />}
      {openId && <UseCasePreviewDrawer id={openId} row={rows.find((row) => row.id === openId)} onClose={closePreview} onChanged={refresh} />}
    </>
  );
}

/**
 * The page's one primary action, split: the main half registers an AI use case
 * (the intake wizard — the only way in), the menu also offers registering an
 * agent on the existing agent registration.
 */
function RegisterSplitButton() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    wrap.current?.querySelector<HTMLAnchorElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const onMenuKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLAnchorElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLAnchorElement);
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <div className={r.split} ref={wrap}>
      <Link to={INTAKE} className={`${r.primary} ${r.splitMain}`} aria-label="Add use case">
        <RegistryIcon name="plus" /><span>Add use case</span>
      </Link>
      <button
        ref={toggle}
        type="button"
        className={`${r.primary} ${r.splitToggle}`}
        aria-label="More ways to register"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={r.chevron} aria-hidden />
      </button>
      {open && (
        <ul className={r.menu} role="menu" aria-label="Register" onKeyDown={onMenuKey}>
          <li role="none">
            <Link role="menuitem" to={INTAKE} className={r.menuItem} onClick={() => setOpen(false)}>
              Register AI use case
              <span className={r.menuHint}>Describe, screen and send for review</span>
            </Link>
          </li>
          <li role="none">
            <Link role="menuitem" to="/admin/agents" className={r.menuItem} onClick={() => setOpen(false)}>
              Register an agent
              <span className={r.menuHint}>Add an agent to the agent catalog</span>
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}

function RegistryResults(props: TableProps<UseCaseRow>) {
  const compact = useSyncExternalStore(subscribeCards, narrowCards, () => false);
  const { view, filtersOpen } = useContext(ViewContext);
  const grid = view === "grid";
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const rows = props.rows ?? [];
  const selectedCount = rows.filter((row) => selected.has(row.id)).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;
  useEffect(() => {
    if (props.rows) setSelected((current) => new Set(props.rows!.filter((row) => current.has(row.id)).map((row) => row.id)));
  }, [props.rows]);
  const select = (id: string, checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  });
  const checkbox = (row: UseCaseRow) => <input type="checkbox" aria-label={`Select ${row.name}`} checked={selected.has(row.id)} onClick={(event) => event.stopPropagation()} onChange={(event) => select(row.id, event.target.checked)} />;
  if (props.loading) return <RegistryState kind="loading" title="Loading AI use-cases…"><p>Fetching the latest data from the registry.</p></RegistryState>;
  if (props.error && !rows.length) {
    const denied = (props.error as { status?: number }).status === 403;
    return <RegistryState kind={denied ? "denied" : "error"} title={denied ? "You don't have access to AI use-cases" : "Unable to load AI use-cases"}>
      <p>{denied ? "Contact your administrator for access to this page." : "We couldn't retrieve the use-case registry. Please try again."}</p>
      {!denied && <Button size="sm" onClick={props.onRetry}>Retry</Button>}
    </RegistryState>;
  }
  if (!rows.length) return <>{props.empty}</>;
  const sort = props.sort;
  const columns = props.columns;
  const sortColumns = columns.filter((column) => column.sort);
  return <>
    {props.error && <p className={r.stale} role="alert">Showing the last loaded results. <Button size="sm" onClick={props.onRetry}>Retry</Button></p>}
    {selectedCount > 0 && <p className={r.selection} role="status">{selectedCount} selected <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button></p>}
    {compact || grid ? <>
      {sort && (!compact || filtersOpen) && <div className={r.cardSort}>
        <Select aria-label="Sort use cases by" value={sort.key ?? ""} onChange={(event) => sort.by(event.target.value)}>
          {!sortColumns.some(({ key }) => key === sort.key) && <option value={sort.key ?? ""}>Current sort</option>}
          {sortColumns.map(({ key, header }) => <option key={key} value={key}>{header}</option>)}
        </Select>
        <Button size="sm" aria-label={sort.dir === 1 ? "Sort descending" : "Sort ascending"} onClick={() => sort.key && sort.by(sort.key)}>{sort.dir === 1 ? "↑" : "↓"}</Button>
      </div>}
      <ul className={r.recordGrid} data-view={grid ? "grid" : "list"} aria-label="Use cases">
        {rows.map((row) => <li key={props.rowKey(row)} className={r.recordCard}>
          {checkbox(row)}
          <button type="button" className={r.recordOpen} aria-label={props.rowLabel?.(row)} onClick={() => props.onRowClick?.(row)}>
            <span className={r.recordId}>{row.id.slice(0, 8)}</span>
            <strong>{row.name}</strong>
            <span className={r.recordMeta}>{columns.filter(({ key }) => ["tier", "status", "owner"].includes(key)).map((column) => <span key={column.key}>{column.render(row)}</span>)}</span>
          </button>
          {columns.find(({ key }) => key === "actions")?.render(row)}
        </li>)}
      </ul>
    </> : <Table {...props} error={undefined} columns={[
      { key: "selection", header: <input type="checkbox" aria-label="Select all use cases on this page" checked={allSelected} ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }} onChange={(event) => setSelected(new Set(event.target.checked ? rows.map(({ id }) => id) : []))} />, width: "2.75rem", render: checkbox },
      { key: "id", header: "ID", render: (row) => <code title={row.id} className={r.recordId}>{row.id.slice(0, 8)}</code> },
      ...columns.flatMap((column) => column.key === "name" ? [
        { ...column, width: "27%" },
        { key: "business-area", header: "Business area", render: () => <span title="The registry does not supply a business area">—</span> },
      ] : column.key === "actions" ? [
        { key: "next-action", header: "Next action", render: () => <span title="The registry does not supply a next action">—</span> },
        { key: "updated", header: "Updated", render: (row: UseCaseRow) => row.updatedAt ? fmtDay(row.updatedAt) : "—" },
        column,
      ] : [column]),
    ]} />}
  </>;
}

function RegistryRowMenu(props: { row: UseCaseRow; onPreview: (trigger: HTMLElement) => void; onRetire: () => void }) {
  const [open, setOpen] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (details.current?.open && !details.current.contains(event.target as Node)) details.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  const close = () => { if (details.current) details.current.open = false; };
  return <details ref={details} className={r.rowMenu} onToggle={(event) => setOpen(event.currentTarget.open)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (event.key === "Escape" && details.current?.open) {
      event.stopPropagation();
      close();
      summary.current?.focus();
    }
  }}>
    <summary ref={summary} aria-label={`Actions for ${props.row.name}`}><RegistryIcon name="more" /></summary>
    <div>
      <button type="button" onClick={() => { close(); if (summary.current) props.onPreview(summary.current); }}>Open preview</button>
      {props.row.status !== "retired" && <button type="button" aria-label={`Retire ${props.row.name}`} onClick={() => { close(); summary.current?.focus(); props.onRetire(); }}>Retire</button>}
    </div>
  </details>;
}
