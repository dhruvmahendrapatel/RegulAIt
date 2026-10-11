/** Types for disposable-db.mjs (imported by the real-stack Playwright specs). */
export interface DisposableDatabase {
  host: string;
  port: number;
  user: string | null;
  password: string | null;
  database: string;
}
export function disposableDatabase(url: string | undefined, namePattern: RegExp): DisposableDatabase;
export function psqlInvocation(
  target: DisposableDatabase,
  query: string,
  env: Record<string, string | undefined>,
): { args: string[]; env: Record<string, string> };
