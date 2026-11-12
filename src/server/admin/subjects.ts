import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { subjects } from "../../db/schema";
import { fail, getDb, isUniqueViolation, type AppEnv } from "../env";
import { auditInsert } from "./audit";

function parse(raw: unknown, partial: boolean) {
  const o = (raw ?? {}) as { name?: unknown; sortOrder?: unknown };
  const out: { name?: string; sortOrder?: number } = {};
  if (o.name !== undefined || !partial) {
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name || name.length > 50) return null;
    out.name = name;
  }
  if (o.sortOrder !== undefined || !partial) {
    const n = Number(o.sortOrder);
    if (!Number.isInteger(n)) return null;
    out.sortOrder = n;
  }
  return out;
}

export const subjectRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await getDb(c.env).select().from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.id));
    return c.json({ items: rows });
  })
  .post("/", async (c) => {
    const v = parse(await c.req.json().catch(() => null), false);
    if (!v) return fail(c, 400, "invalid", "과목 이름(50자 이하)과 표시 순서(정수)를 입력해 주세요.");
    const db = getDb(c.env);
    try {
      const [[row]] = await db.batch([
        db.insert(subjects).values({ name: v.name!, sortOrder: v.sortOrder! }).returning(),
        auditInsert(db, c, "subject.create", null, v),
      ]);
      return c.json(row, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return fail(c, 409, "duplicate", "같은 이름의 과목이 있습니다.");
      throw e;
    }
  })
  .patch("/:id{[0-9]+}", async (c) => {
    const v = parse(await c.req.json().catch(() => null), true);
    if (!v || Object.keys(v).length === 0) return fail(c, 400, "invalid", "바꿀 값을 입력해 주세요.");
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    try {
      const [rows] = await db.batch([
        db.update(subjects).set(v).where(eq(subjects.id, id)).returning(),
        auditInsert(db, c, "subject.update", { type: "subject", id: String(id) }, v),
      ]);
      if (!rows[0]) return fail(c, 404, "not_found", "과목을 찾을 수 없습니다.");
      return c.json(rows[0]);
    } catch (e) {
      if (isUniqueViolation(e)) return fail(c, 409, "duplicate", "같은 이름의 과목이 있습니다.");
      throw e;
    }
  });
