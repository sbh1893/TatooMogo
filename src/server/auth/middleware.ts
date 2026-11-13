import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { admins, type Admin } from "../../db/schema";
import { auditInsert } from "../admin/audit";
import { fail, getDb, type AppEnv, type Bindings } from "../env";
import { accessKeys, normalizeTeamDomain, verifyAccessJwt } from "./access";

/** Swappable in tests so a locally signed JWT can be verified without fetching real certs. */
export const authDeps = { keys: accessKeys };

/** The local bypass is only honoured when ENVIRONMENT is exactly "development". */
export const devBypassEmail = (env: Bindings) =>
  env.ENVIRONMENT === "development" && env.ADMIN_DEV_EMAIL
    ? env.ADMIN_DEV_EMAIL.trim().toLowerCase()
    : null;

async function resolveEmail(env: Bindings, jwt: string | undefined): Promise<string | null> {
  if (jwt) {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      console.error("ACCESS_TEAM_DOMAIN / ACCESS_AUD not configured");
      return null;
    }
    const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
    try {
      return await verifyAccessJwt(jwt, { teamDomain, aud: env.ACCESS_AUD, keys: authDeps.keys(teamDomain) });
    } catch {
      return null;
    }
  }
  return devBypassEmail(env);
}

const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const startOfKstDay = (t: number) => Math.floor((t + KST) / DAY) * DAY - KST;

/** For routes mounted under requireAdmin(): the admin row is already loaded, only the role is checked. */
export const superAdminOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("admin").role !== "super_admin") return fail(c, 403, "forbidden", "최고관리자만 사용할 수 있습니다.");
  await next();
});

/** Runs on every /api/admin request: who are you, are you still allowed, is your role enough. */
export const requireAdmin = (role: Admin["role"] = "admin") =>
  createMiddleware<AppEnv>(async (c, next) => {
    const email = await resolveEmail(c.env, c.req.header("Cf-Access-Jwt-Assertion"));
    if (!email) return fail(c, 401, "unauthorized", "로그인이 필요합니다.");

    const db = getDb(c.env);
    const admin = await db.select().from(admins).where(eq(admins.email, email)).get();
    if (!admin || admin.status !== "active") {
      return fail(c, 403, "forbidden", "관리자 권한이 없는 계정입니다.");
    }
    if (role === "super_admin" && admin.role !== "super_admin") {
      return fail(c, 403, "forbidden", "최고관리자만 사용할 수 있습니다.");
    }
    c.set("admin", admin);

    // Access handles the actual login, so the first request of each KST day is recorded as one.
    const now = Date.now();
    if (!admin.lastLoginAt || admin.lastLoginAt < startOfKstDay(now)) {
      await db.batch([
        db.update(admins).set({ lastLoginAt: now }).where(eq(admins.id, admin.id)),
        auditInsert(db, c, "login", null, undefined, admin),
      ]);
    }
    await next();
  });
