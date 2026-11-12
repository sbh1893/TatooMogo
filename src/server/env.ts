import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { Admin } from "../db/schema";

export type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  ENVIRONMENT: string;
  ADMIN_DEV_EMAIL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: { admin: Admin };
};

export type Ctx = Context<AppEnv>;

export const getDb = (env: Bindings) => drizzle(env.DB);
export type Db = ReturnType<typeof getDb>;

export function fail(c: Context, status: 400 | 401 | 403 | 404 | 409 | 500, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

export const isUniqueViolation = (e: unknown) =>
  String((e as { cause?: unknown })?.cause ?? e).includes("UNIQUE constraint failed");
