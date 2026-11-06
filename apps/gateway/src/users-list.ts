/**
 * ADR-0226 — the admin users table under the shared list contract
 * (list-contract.ts): its sortable columns, export columns, filters and
 * default sort. The route stays admin-only through the default gate
 * (route-classes.ts), and so does its Excel export.
 *
 * Never a credential: the row says only whether a password is set and whether
 * one-time-password and TOTP flags are on, exactly as `GET /v1/users` always has.
 */
import { z } from "zod";
import { and, eq, isNotNull, isNull, or, sql, users, type Db, type SQL } from "@regulait/db";
import type { ListReader, ListSpec } from "./list-contract.js";

export interface UserListRow {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  createdAt: Date;
  totpEnabled: boolean;
  hasPassword: boolean;
  mustChangePassword: boolean;
}

export const usersFilterQuery = z
  .object({
    /** matches name, email or username, case-insensitively */
    q: z.string().trim().max(200).optional(),
    role: z.enum(["admin", "member"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict();
export type UsersFilters = z.infer<typeof usersFilterQuery>;

/** `%`, `_` and `\` in a search are literal, never wildcards */
export function likeLiteral(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function usersWhere(f: UsersFilters): SQL | undefined {
  const conds: SQL[] = [];
  if (f.q) {
    const pattern = likeLiteral(f.q);
    conds.push(
      or(
        sql`${users.email} ilike ${pattern}`,
        sql`${users.displayName} ilike ${pattern}`,
        sql`coalesce(${users.username}, '') ilike ${pattern}`,
      )!,
    );
  }
  if (f.role) conds.push(eq(users.isAdmin, f.role === "admin"));
  if (f.status === "active") conds.push(isNull(users.disabledAt));
  if (f.status === "disabled") conds.push(isNotNull(users.disabledAt));
  return conds.length ? and(...conds) : undefined;
}

export const usersReader = (db: Db): ListReader<UserListRow> => ({
  fetch: (q) =>
    db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
        disabledAt: users.disabledAt,
        createdAt: users.createdAt,
        totpEnabled: users.totpEnabled,
        hasPassword: sql<boolean>`${users.passwordHash} is not null`,
        mustChangePassword: users.mustChangePassword,
        _cursorAt: q.cursorAt,
      })
      .from(users)
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset),
  countable: (where) => db.select({ one: sql`1` }).from(users).where(where),
  idOf: (r) => r.id,
});

const signIn = (u: UserListRow) => (u.hasPassword ? (u.mustChangePassword ? "one-time pw" : "password") : "no password");

export const USERS_LIST: ListSpec<UserListRow> = {
  id: "users",
  sorts: {
    name: { expr: sql`lower(coalesce(nullif(${users.displayName}, ''), ${users.email}))` },
    email: { expr: sql`lower(${users.email})` },
    role: { expr: users.isAdmin },
    mfa: { expr: users.totpEnabled },
    status: { expr: sql`(${users.disabledAt} is not null)` },
    created: { expr: users.createdAt, keysetAt: users.createdAt },
    username: { expr: sql`lower(${users.username})` },
  },
  columns: {
    name: { label: "Name", value: (u) => u.displayName || null },
    email: { label: "Email", value: (u) => u.email },
    role: { label: "Role", value: (u) => (u.isAdmin ? "admin" : "member") },
    signIn: { label: "Sign-in", value: signIn },
    mfa: { label: "MFA", value: (u) => (u.totpEnabled ? "TOTP" : "none") },
    status: { label: "Status", value: (u) => (u.disabledAt ? "disabled" : "active") },
    created: { label: "Created", value: (u) => u.createdAt },
    username: { label: "Username", value: (u) => u.username },
    id: { label: "User id", value: (u) => u.id },
  },
  filters: ["q", "role", "status"],
  defaultSort: { col: "created", dir: "asc" },
  idCol: users.id,
};
