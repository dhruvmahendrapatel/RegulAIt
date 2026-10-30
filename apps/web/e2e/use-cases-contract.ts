/**
 * ADR-0219 — the AI registry's list contract as a mocked gateway answers it (`GET /v1/use-cases` with any of sort,
 * dir, cursor, offset or count): the server-side filters (search, status chip, tier, owner), the sort, the page and
 * the `summary` (headline and chip counts, owner choices) across every row. Shared by the registry mock specs.
 */
type Row = Record<string, unknown> & {
  id: string;
  name: string;
  description?: string;
  status: string;
  euAiActTier?: string | null;
  ownerUserId?: string;
  ownerName?: string | null;
  recertification?: boolean;
  createdAt?: string;
};

const IN_REVIEW = ["proposed", "under_review", "needs_info"];

function matches(r: Row, q: URLSearchParams): boolean {
  const status = q.get("status");
  if (status === "recertification" && !(r.recertification && r.status === "under_review")) return false;
  if (status === "in_review" && !IN_REVIEW.includes(r.status)) return false;
  if (status && !["all", "in_review", "recertification"].includes(status) && r.status !== status) return false;
  const tier = q.get("tier");
  const t = r.euAiActTier ?? null;
  if (tier === "unscreened" && t !== null) return false;
  if (tier === "high_or_prohibited" && !(t === "high" || t === "prohibited")) return false;
  if (tier && !["all", "unscreened", "high_or_prohibited"].includes(tier) && t !== tier) return false;
  const owner = q.get("owner");
  if (owner && r.ownerUserId !== owner) return false;
  const text = q.get("q")?.toLowerCase();
  if (text && ![r.name, r.description ?? "", r.ownerName ?? ""].some((s) => s.toLowerCase().includes(text))) return false;
  return true;
}

export function useCasesContract(rows: Row[], q: URLSearchParams) {
  const sort = q.get("sort") ?? "created";
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const field = ({ name: "name", status: "status", owner: "ownerName", created: "createdAt", validUntil: "approvedUntil" } as Record<string, string>)[sort] ?? "createdAt";
  const shown = rows.filter((r) => matches(r, q)).sort((a, b) => {
    const x = (a[field] ?? null) as string | null;
    const y = (b[field] ?? null) as string | null;
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * dir;
  });
  const limit = Number(q.get("limit") ?? 10);
  const start = Number(q.get("offset") ?? 0);
  const statusCounts: Record<string, number> = { all: rows.length, in_review: 0, recertification: 0 };
  for (const r of rows) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    if (IN_REVIEW.includes(r.status)) statusCounts.in_review! += 1;
    if (r.recertification && r.status === "under_review") statusCounts.recertification! += 1;
  }
  const owners = [...new Map(rows.map((r) => [r.ownerUserId ?? "", r.ownerName ?? "Unnamed owner"])).entries()].map(([id, name]) => ({ id, name }));
  return {
    items: shown.slice(start, start + limit),
    nextCursor: null,
    nextOffset: start + limit < shown.length ? start + limit : null,
    total: q.get("count") ? shown.length : null,
    totalIsEstimate: false,
    summary: {
      headline: {
        total: rows.length,
        underReview: rows.filter((r) => IN_REVIEW.includes(r.status)).length,
        approved: rows.filter((r) => r.status === "approved").length,
        highTier: rows.filter((r) => r.euAiActTier === "high" || r.euAiActTier === "prohibited").length,
      },
      statusCounts,
      owners,
    },
  };
}

/** a list request under the contract (the old callers send none of these) */
export const isContractRead = (q: URLSearchParams) => ["sort", "dir", "cursor", "offset", "count"].some((k) => q.has(k));
