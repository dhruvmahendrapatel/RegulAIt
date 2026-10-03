/**
 * The AI registry (ADR-0168 item 2; ADR-0080 for the use-case object).
 *
 * One place to see every registered AI use case and where it stands: headline
 * counts, filter chips, a table, and a right-hand preview a row opens without
 * leaving the list. There is ONE way in — "Register AI use case" opens the
 * intake wizard (ADR-0168 item 1); this page creates nothing itself.
 *
 * Status is decided, never edited: approval, conditions and send-back happen
 * at the review, and this page only shows the result.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Input, Select, Table } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import { UseCasePreviewDrawer } from "./UseCasePreviewDrawer";
import {
  NO_FILTERS,
  applyFilters,
  fmtDay,
  headline,
  isFiltered,
  statusLabel,
  statusTone,
  tierLabel,
  tierTone,
  validity,
  type RegistryFilters,
  type StatusFilter,
  type TierFilter,
  type UseCaseRow,
} from "./registryModel";
import r from "./registry.module.css";
import k from "../../../ui/kit.module.css";
import v from "../../views.module.css";

const INTAKE = "/admin/governance/intake";

const STATUS_CHIPS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "in_review", label: "In review" },
  { value: "needs_info", label: "Needs information" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "retired", label: "Retired" },
];

export default function UseCasesPage() {
  const list = useQuery({
    queryKey: ["admin", "use-cases"],
    queryFn: () => api.get<{ useCases?: UseCaseRow[] }>("/v1/use-cases"),
  });
  const rows = useMemo(() => list.data?.useCases ?? [], [list.data]);
  const [filters, setFilters] = useState<RegistryFilters>(NO_FILTERS);
  const shown = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const counts = useMemo(() => headline(rows), [rows]);
  const owners = useMemo(
    () => [...new Map(rows.map((row) => [row.ownerUserId, row.ownerName ?? "Unnamed owner"])).entries()].sort((a, b) => a[1].localeCompare(b[1])),
    [rows],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  // the row that opened the preview gets focus back when it closes
  const opener = useRef<HTMLElement | null>(null);
  const set = (patch: Partial<RegistryFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const statusCount = (value: StatusFilter) => applyFilters(rows, { ...NO_FILTERS, status: value }).length;
  const tile = (label: string, value: number, pressed: boolean, apply: Partial<RegistryFilters>) => (
    <button type="button" className={r.tile} aria-pressed={pressed} onClick={() => setFilters(pressed ? NO_FILTERS : { ...NO_FILTERS, ...apply })}>
      <span className={r.tileLabel}>{label}</span>{" "}
      <span className={r.tileValue}>{value}</span>
    </button>
  );
  const closePreview = () => {
    setOpenId(null);
    opener.current?.focus();
  };

  return (
    <>
      <PageHeader title="AI registry" sub="Every AI use case in your organization, and where it stands." actions={<RegisterSplitButton />} />
      <div className={v.stack}>
        <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          <div className={r.tiles} role="group" aria-label="Headline counts">
            {tile("Use cases", counts.total, false, {})}
            {tile("Under review", counts.underReview, filters.status === "in_review" && filters.tier === "all", { status: "in_review" })}
            {tile("Approved", counts.approved, filters.status === "approved" && filters.tier === "all", { status: "approved" })}
            {tile("High tier", counts.highTier, filters.tier === "high_or_prohibited" && filters.status === "all", { tier: "high_or_prohibited" })}
          </div>
          <Card>
            {rows.length === 0 ? (
              <EmptyState
                title="No AI use cases yet"
                body="Register the first one — the registration checks for duplicates, screens it and sends it for review."
                action={<Link to={INTAKE} className={k.btn} style={{ textDecoration: "none" }}>Register the first use case</Link>}
              />
            ) : (
              <>
                <div className={r.toolbar} role="search" aria-label="Filter use cases">
                  <Input
                    className={r.search}
                    type="search"
                    aria-label="Search use cases"
                    placeholder="Search by name, purpose or owner"
                    value={filters.search}
                    onChange={(e) => set({ search: e.target.value })}
                  />
                  <div className={r.chips} role="group" aria-label="Status">
                    {STATUS_CHIPS.map((chip) => (
                      <button key={chip.value} type="button" className={r.chip} aria-pressed={filters.status === chip.value} onClick={() => set({ status: chip.value })}>
                        {chip.label} <span className={r.chipCount}>{statusCount(chip.value)}</span>
                      </button>
                    ))}
                  </div>
                  <Select className={r.chipSelect} aria-label="Tier" value={filters.tier} onChange={(e) => set({ tier: e.target.value as TierFilter })}>
                    <option value="all">All tiers</option>
                    <option value="high_or_prohibited">High or prohibited</option>
                    <option value="prohibited">Prohibited</option>
                    <option value="high">High</option>
                    <option value="limited">Limited</option>
                    <option value="minimal">Minimal</option>
                    <option value="unscreened">Not screened</option>
                  </Select>
                  <Select className={r.chipSelect} aria-label="Owner" value={filters.owner} onChange={(e) => set({ owner: e.target.value })}>
                    <option value="">All owners</option>
                    {owners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </Select>
                  {isFiltered(filters) && (
                    <Button variant="ghost" size="sm" className={r.clear} onClick={() => setFilters(NO_FILTERS)}>Clear all</Button>
                  )}
                </div>
                <Table
                  rows={shown}
                  rowKey={(row) => row.id}
                  rowLabel={(row) => `${row.name}, ${statusLabel(row.status)} — open preview`}
                  onRowClick={(row) => {
                    opener.current = document.activeElement instanceof HTMLElement && document.activeElement.tagName === "TR" ? document.activeElement : null;
                    setOpenId(openId === row.id ? null : row.id);
                  }}
                  empty={<EmptyState title="No use cases match these filters" action={<Button size="sm" onClick={() => setFilters(NO_FILTERS)}>Clear all</Button>} />}
                  columns={[
                    {
                      key: "name",
                      header: "Name",
                      sort: (row) => row.name.toLowerCase(),
                      render: (row) => (
                        <span className={r.nameCell}>
                          <span className={r.nameText}>{row.name}</span>
                          {row.description ? <span className={r.nameSub}>{row.description}</span> : null}
                        </span>
                      ),
                    },
                    {
                      key: "status",
                      header: "Status",
                      sort: (row) => statusLabel(row.status),
                      render: (row) => <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>,
                    },
                    {
                      key: "tier",
                      header: "Tier",
                      sort: (row) => ({ prohibited: 0, high: 1, limited: 2, minimal: 3 } as const)[row.euAiActTier ?? "minimal"] + (row.euAiActTier ? 0 : 4),
                      render: (row) => (row.euAiActTier ? <Badge tone={tierTone(row.euAiActTier)}>{tierLabel(row.euAiActTier)}</Badge> : <span className={`${v.faint} ${r.nowrap}`}>Not screened</span>),
                    },
                    { key: "owner", header: "Owner", sort: (row) => row.ownerName ?? "", render: (row) => <span className={r.nowrap}>{row.ownerName ?? "Unnamed"}</span> },
                    { key: "created", header: "Created", sort: (row) => row.createdAt, render: (row) => <span className={r.nowrap}>{fmtDay(row.createdAt)}</span> },
                    {
                      key: "validUntil",
                      header: "Valid until",
                      sort: (row) => row.approvedUntil ?? "",
                      render: (row) => {
                        const until = validity(row.approvedUntil);
                        return <span className={`${r.nowrap} ${until.expired ? r.expired : ""}`}>{until.text}</span>;
                      },
                    },
                    {
                      key: "conditions",
                      header: "Open conditions",
                      align: "right",
                      sort: (row) => row.openConditions ?? -1,
                      render: (row) => (row.openConditions ? <Badge tone="warn">{row.openConditions}</Badge> : <span className={v.faint}>{row.openConditions === 0 ? "0" : "—"}</span>),
                    },
                  ]}
                />
              </>
            )}
          </Card>
        </QueryGate>
      </div>
      {openId && <UseCasePreviewDrawer id={openId} row={rows.find((row) => row.id === openId)} onClose={closePreview} onChanged={() => list.refetch()} />}
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
      <Link to={INTAKE} className={`${k.btnPrimary} ${r.splitMain}`}>
        Register AI use case
      </Link>
      <button
        ref={toggle}
        type="button"
        className={`${k.btnPrimary} ${r.splitToggle}`}
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
