/** Super-admin only: the admin allow list and the access/audit log (ANALYSIS 2, PLAN 4). */
import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { admins, auditLogs } from "../../db/schema";
import { superAdminOnly } from "../auth/middleware";
import { fail, getDb, isUniqueViolation, type AppEnv } from "../env";
import { auditInsert } from "./audit";

const ROLES = ["admin", "super_admin"] as const;
const STATUSES = ["active", "suspended"] as const;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

export const adminRoutes = new Hono<AppEnv>()
  .use(superAdminOnly)
  .get("/", async (c) => {
    const items = await getDb(c.env).select().from(admins).orderBy(admins.id);
    return c.json({ items });
  })

  .post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = body?.role ?? "admin";
    if (!EMAIL.test(email) || email.length > 254) return fail(c, 400, "invalid", "이메일 주소를 확인해 주세요.");
    if (!ROLES.includes(role as (typeof ROLES)[number])) return fail(c, 400, "invalid", "역할이 올바르지 않습니다.");
    const db = getDb(c.env);
    try {
      const [[row]] = await db.batch([
        db
          .insert(admins)
          .values({ email, role: role as (typeof ROLES)[number], invitedBy: c.get("admin").id })
          .returning(),
        auditInsert(db, c, "admin.create", { type: "admin", id: email }, { role }),
      ]);
      return c.json(row, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return fail(c, 409, "duplicate", "이미 허용 목록에 있는 이메일입니다.");
      throw e;
    }
  })

  .patch("/:id{[0-9]+}", async (c) => {
    const id = Number(c.req.param("id"));
    // Changing your own account could lock everyone out (no active super admin left).
    if (id === c.get("admin").id) return fail(c, 400, "self", "자기 계정의 역할·상태는 바꿀 수 없습니다.");
    const body = (await c.req.json().catch(() => null)) as { status?: unknown; role?: unknown } | null;
    const set: Partial<typeof admins.$inferInsert> = {};
    if (body?.status !== undefined) {
      if (!STATUSES.includes(body.status as (typeof STATUSES)[number])) return fail(c, 400, "invalid", "상태가 올바르지 않습니다.");
      set.status = body.status as (typeof STATUSES)[number];
    }
    if (body?.role !== undefined) {
      if (!ROLES.includes(body.role as (typeof ROLES)[number])) return fail(c, 400, "invalid", "역할이 올바르지 않습니다.");
      set.role = body.role as (typeof ROLES)[number];
    }
    if (!Object.keys(set).length) return fail(c, 400, "invalid", "바꿀 값을 입력해 주세요.");
    const db = getDb(c.env);
    const [rows] = await db.batch([
      db.update(admins).set(set).where(eq(admins.id, id)).returning(),
      auditInsert(db, c, "admin.update", { type: "admin", id: String(id) }, set),
    ]);
    if (!rows.length) return fail(c, 404, "not_found", "관리자를 찾을 수 없습니다.");
    return c.json(rows[0]);
  });

const PAGE = 50;

export const auditLogRoutes = new Hono<AppEnv>().use(superAdminOnly).get("/", async (c) => {
  const q = c.req.query();
  const where: SQL[] = [];
  if (q.adminId && /^\d+$/.test(q.adminId)) where.push(eq(auditLogs.adminId, Number(q.adminId)));
  if (q.action) where.push(eq(auditLogs.action, q.action));
  if (q.from && /^\d+$/.test(q.from)) where.push(gte(auditLogs.createdAt, Number(q.from)));
  if (q.to && /^\d+$/.test(q.to)) where.push(lt(auditLogs.createdAt, Number(q.to)));
  const page = Math.max(1, Number(q.page) || 1);
  const db = getDb(c.env);
  const cond = where.length ? and(...where) : undefined;
  const [items, [{ total }]] = await db.batch([
    db.select().from(auditLogs).where(cond).orderBy(desc(auditLogs.id)).limit(PAGE).offset((page - 1) * PAGE),
    db.select({ total: count() }).from(auditLogs).where(cond),
  ]);
  return c.json({ items, total, page, pageSize: PAGE });
});
