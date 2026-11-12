import { and, asc, count, desc, eq, like, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { choices, questions, subjects } from "../../db/schema";
import { validateQuestionInput, type QuestionInput, type QuestionStatus } from "../../shared/question";
import { fail, getDb, isUniqueViolation, type AppEnv, type Db } from "../env";
import { auditInsert } from "./audit";

const PAGE_SIZE = 20;
const STATUSES: QuestionStatus[] = ["review", "active", "disabled"];

// In a D1 batch (one transaction, single writer) the row just inserted has the highest id.
const lastQuestionId = sql`(select max(id) from questions)`;

/**
 * Rule 8: a question is "used" once any attempt exists on an exam that contains it.
 * Used questions are never edited in place; a new version row is created instead.
 */
// Takes the outer question id; pass a fully qualified column (attempts also has an "id").
const usedSql = (questionId: unknown) =>
  sql<number>`exists(select 1 from exam_questions eq join attempts a on a.exam_id = eq.exam_id where eq.question_id = ${questionId})`;

export async function hasAttempts(db: Db, questionId: number) {
  const row = await db.get<{ used: number }>(sql`select ${usedSql(questionId)} as used`);
  return row?.used === 1;
}

const choiceRows = (input: QuestionInput, questionId: number | typeof lastQuestionId) =>
  input.choices.map((c, ord) => ({
    questionId,
    ord,
    body: c.body,
    imageKey: c.imageKey ?? null,
    isCorrect: c.isCorrect,
  }));

const questionFields = (input: QuestionInput) => ({
  subjectId: input.subjectId,
  stem: input.stem,
  stemImageKey: input.stemImageKey ?? null,
  explanation: input.explanation,
  fixedChoices: input.fixedChoices,
  groupKey: input.groupKey ?? null,
});

async function readInput(c: { req: { json: () => Promise<unknown> } }, db: Db) {
  const parsed = validateQuestionInput(await c.req.json().catch(() => null));
  if (!parsed.ok) return parsed;
  const subject = await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, parsed.value.subjectId)).get();
  if (!subject) return { ok: false as const, errors: ["존재하지 않는 과목입니다."] };
  return parsed;
}

export const questionRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = getDb(c.env);
    const q = c.req.query();
    const page = Math.max(1, Number.parseInt(q.page ?? "1", 10) || 1);
    const conds = [eq(questions.isLatest, true)];
    if (q.subject) conds.push(eq(questions.subjectId, Number(q.subject)));
    if (q.status && STATUSES.includes(q.status as QuestionStatus)) {
      conds.push(eq(questions.status, q.status as QuestionStatus));
    }
    const term = q.q?.trim();
    if (term) {
      const asCode = /^\d+$/.test(term) ? eq(questions.code, Number(term)) : undefined;
      conds.push(asCode ? or(asCode, like(questions.stem, `%${term}%`))! : like(questions.stem, `%${term}%`));
    }
    const where = and(...conds);
    const [items, [{ total }]] = await db.batch([
      db
        .select({
          id: questions.id,
          code: questions.code,
          version: questions.version,
          subjectId: questions.subjectId,
          subjectName: subjects.name,
          stemPreview: sql<string>`substr(${questions.stem}, 1, 80)`,
          status: questions.status,
          updatedAt: questions.updatedAt,
          used: usedSql(sql.raw(`"questions"."id"`)).mapWith(Boolean),
        })
        .from(questions)
        .innerJoin(subjects, eq(subjects.id, questions.subjectId))
        .where(where)
        .orderBy(desc(questions.code))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE),
      db.select({ total: count() }).from(questions).where(where),
    ]);
    return c.json({ items, total, page, pageSize: PAGE_SIZE });
  })

  .get("/:id{[0-9]+}", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const [question, choiceList, versions] = await db.batch([
      db
        .select({ q: questions, used: usedSql(sql.raw(`"questions"."id"`)).mapWith(Boolean) })
        .from(questions)
        .where(eq(questions.id, id)),
      db.select().from(choices).where(eq(choices.questionId, id)).orderBy(asc(choices.ord)),
      db
        .select({ id: questions.id, version: questions.version, status: questions.status, createdAt: questions.createdAt })
        .from(questions)
        .where(sql`${questions.code} = (select code from questions where id = ${id})`)
        .orderBy(desc(questions.version)),
    ]);
    if (!question[0]) return fail(c, 404, "not_found", "문항을 찾을 수 없습니다.");
    return c.json({ ...question[0].q, used: question[0].used, choices: choiceList, versions });
  })

  .post("/", async (c) => {
    const db = getDb(c.env);
    const parsed = await readInput(c, db);
    if (!parsed.ok) return fail(c, 400, "invalid", parsed.errors.join("\n"));
    const input = parsed.value;
    const admin = c.get("admin");
    const [[created]] = await db.batch([
      db
        .insert(questions)
        .values({
          ...questionFields(input),
          code: sql`(select coalesce(max(code), 0) + 1 from questions)`,
          version: 1,
          isLatest: true,
          status: "active",
          createdBy: admin.id,
        })
        .returning({ id: questions.id, code: questions.code, version: questions.version }),
      db.insert(choices).values(choiceRows(input, lastQuestionId)),
      auditInsert(db, c, "question.create", { type: "question", id: sql`(select cast(max(id) as text) from questions)` }),
    ]);
    return c.json({ ...created, newVersion: false }, 201);
  })

  .put("/:id{[0-9]+}", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const cur = await db.select().from(questions).where(eq(questions.id, id)).get();
    if (!cur) return fail(c, 404, "not_found", "문항을 찾을 수 없습니다.");
    if (!cur.isLatest) return fail(c, 409, "not_latest", "최신 버전만 수정할 수 있습니다.");
    const parsed = await readInput(c, db);
    if (!parsed.ok) return fail(c, 400, "invalid", parsed.errors.join("\n"));
    const input = parsed.value;
    const now = Date.now();

    if (!(await hasAttempts(db, id))) {
      // ponytail: tiny race if an exam's first attempt starts between this check and the batch;
      // add a conditional update (WHERE NOT used) if that ever shows up in practice.
      await db.batch([
        db.update(questions).set({ ...questionFields(input), updatedAt: now }).where(eq(questions.id, id)),
        db.delete(choices).where(eq(choices.questionId, id)),
        db.insert(choices).values(choiceRows(input, id)),
        auditInsert(db, c, "question.update", { type: "question", id: String(id) }, { code: cur.code, version: cur.version }),
      ]);
      return c.json({ id, code: cur.code, version: cur.version, newVersion: false });
    }

    try {
      const [, [created]] = await db.batch([
        db.update(questions).set({ isLatest: false }).where(eq(questions.id, id)),
        db
          .insert(questions)
          .values({
            ...questionFields(input),
            code: cur.code,
            version: cur.version + 1,
            isLatest: true,
            status: cur.status,
            sourceFileId: cur.sourceFileId,
            sourceNo: cur.sourceNo,
            createdBy: c.get("admin").id,
          })
          .returning({ id: questions.id, code: questions.code, version: questions.version }),
        db.insert(choices).values(choiceRows(input, lastQuestionId)),
        auditInsert(db, c, "question.version", { type: "question", id: sql`(select cast(max(id) as text) from questions)` }, {
          code: cur.code,
          fromId: id,
          fromVersion: cur.version,
        }),
      ]);
      return c.json({ ...created, newVersion: true });
    } catch (e) {
      if (isUniqueViolation(e)) return fail(c, 409, "conflict", "다른 관리자가 먼저 수정했습니다. 새로고침 후 다시 시도해 주세요.");
      throw e;
    }
  })

  .post("/:id{[0-9]+}/:action{disable|enable}", async (c) => {
    const db = getDb(c.env);
    const id = Number(c.req.param("id"));
    const action = c.req.param("action") as "disable" | "enable";
    const cur = await db.select().from(questions).where(eq(questions.id, id)).get();
    if (!cur) return fail(c, 404, "not_found", "문항을 찾을 수 없습니다.");
    if (!cur.isLatest) return fail(c, 409, "not_latest", "최신 버전만 바꿀 수 있습니다.");
    const status = action === "disable" ? "disabled" : "active";
    await db.batch([
      db.update(questions).set({ status, updatedAt: Date.now() }).where(eq(questions.id, id)),
      auditInsert(db, c, `question.${action}`, { type: "question", id: String(id) }, { code: cur.code, from: cur.status }),
    ]);
    return c.json({ id, status });
  });
