import type { Context } from "hono";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { Admin } from "../db/schema";

export type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  ENVIRONMENT: string;
  ADMIN_DEV_EMAIL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  SENTRY_DSN?: string;
  /** Workers Rate Limiting bindings (wrangler.jsonc "ratelimits"). Missing = no limit. */
  RL_API?: RateLimit;
  RL_ENTRY?: RateLimit;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: { admin: Admin };
};

export type Ctx = Context<AppEnv>;

export const getDb = (env: Bindings) => drizzle(env.DB);
export type Db = ReturnType<typeof getDb>;

const dialect = new SQLiteAsyncDialect();
type Built = SQL | { toSQL(): { sql: string; params: unknown[] } };

/**
 * D1 batch (one transaction) over drizzle builders and raw `sql` fragments alike.
 * drizzle's own db.batch() can't take raw INSERT ... SELECT ... WHERE statements,
 * which conditional writes need. Returns raw D1 results (column names as in SQL).
 */
export function rawBatch(env: Bindings, items: Built[]) {
  return env.DB.batch(
    items.map((i) => {
      const q = is(i, SQL) ? dialect.sqlToQuery(i) : i.toSQL();
      return env.DB.prepare(q.sql).bind(...q.params);
    }),
  );
}

export function fail(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 500, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

export const isUniqueViolation = (e: unknown) =>
  String((e as { cause?: unknown })?.cause ?? e).includes("UNIQUE constraint failed");
