import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { choices, questions, sourceFiles, subjects } from "../../db/schema";
import { validateQuestionInput, type QuestionInput, type QuestionStatus } from "../../shared/question";
import { fail, getDb, isUniqueViolation, rawBatch, type AppEnv, type Db } from "../env";
import { auditInsert, auditInsertIf } from "./audit";

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
    // The exam question picker asks for everything at once (?size=500).
    const size = Math.min(500, Math.max(1, Number.parseInt(q.size ?? String(PAGE_SIZE), 10) || PAGE_SIZE));
    const conds = [eq(questions.isLatest, true)];
    if (q.subject) conds.push(eq(questions.subjectId, Number(q.subject)));
    if (q.status && STATUSES.includes(q.status as QuestionStatus)) {
      conds.push(eq(questions.status, q.status as QuestionStatus));
    }
    const term = q.q?.trim();
    if (term) {
      // % and _ are LIKE wildcards; a search for "100%" must match the literal text.
      const inStem = sql`${questions.stem} like ${`%${term.replace(/[!%_]/g, "!$&")}%`} escape '!'`;
      conds.push(/^\d+$/.test(term) ? or(eq(questions.code, Number(term)), inStem)! : inStem);
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
          groupKey: questions.groupKey,
          stemPreview: sql<string>`substr(${questions.stem}, 1, 80)`,
          status: questions.status,
          updatedAt: questions.updatedAt,
          used: usedSql(sql.raw(`"questions"."id"`)).mapWith(Boolean),
        })
        .from(questions)
        .innerJoin(subjects, eq(subjects.id, questions.subjectId))
        .where(where)
        .orderBy(desc(questions.code))
        .limit(size)
        .offset((page - 1) * size),
      db.select({ total: count() }).from(questions).where(where),
    ]);
    return c.json({ items, total, page, pageSize: size });
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

  /**
   * Registers reviewed questions from one PDF in a single batch (all or nothing), as active.
   * Body: { sourceFileId, items: [{ sourceNo, ...QuestionInput }] }.
   */
  .post("/bulk", async (c) => {
    const db = getDb(c.env);
    const raw = (await c.req.json().catch(() => null)) as { sourceFileId?: unknown; items?: unknown } | null;
    const sourceFileId = Number(raw?.sourceFileId);
    const rawItems = Array.isArray(raw?.items) ? raw.items : [];
    if (!Number.isInteger(sourceFileId) || rawItems.length === 0 || rawItems.length > 200) {
      return fail(c, 400, "invalid", "등록할 문항(1~200개)과 원본 파일을 지정해 주세요.");
    }
    const source = await db.select({ id: sourceFiles.id }).from(sourceFiles).where(eq(sourceFiles.id, sourceFileId)).get();
    if (!source) return fail(c, 404, "not_found", "원본 파일을 찾을 수 없습니다.");

    const errors: string[] = [];
    const items = rawItems.map((it, i) => {
      const sourceNo = Number((it as { sourceNo?: unknown })?.sourceNo);
      const v = validateQuestionInput(it);
      const label = Number.isInteger(sourceNo) && sourceNo > 0 ? `${sourceNo}번` : `${i + 1}번째`;
      if (!v.ok) errors.push(...v.errors.map((e) => `${label}: ${e}`));
      return { sourceNo: Number.isInteger(sourceNo) && sourceNo > 0 ? sourceNo : null, input: v.ok ? v.value : null };
    });
    if (errors.length) return fail(c, 400, "invalid", errors.join("\n"));
    const inputs = items.map((i) => i.input!);

    const subjectIds = [...new Set(inputs.map((i) => i.subjectId))];
    const found = await db.select({ id: subjects.id }).from(subjects).where(inArray(subjects.id, subjectIds));
    if (found.length !== subjectIds.length) return fail(c, 400, "invalid", "존재하지 않는 과목이 있습니다.");
    // Group keys are per paper on the review screen ("6-7"); make them unique across papers.
    const groupSubject = new Map<string, number>();
    for (const q of inputs) {
      if (!q.groupKey) continue;
      q.groupKey = `s${sourceFileId}:${q.groupKey}`.slice(0, 50);
      if ((groupSubject.get(q.groupKey) ?? q.subjectId) !== q.subjectId) {
        return fail(c, 400, "invalid", "묶음 문항은 모두 같은 과목이어야 합니다.");
      }
      groupSubject.set(q.groupKey, q.subjectId);
    }

    const adminId = c.get("admin").id;
    const stmts = items.flatMap(({ sourceNo }, i) => [
      db.insert(questions).values({
        ...questionFields(inputs[i]),
        code: sql`(select coalesce(max(code), 0) + 1 from questions)`,
        version: 1,
        isLatest: true,
        status: "active",
        sourceFileId,
        sourceNo,
        createdBy: adminId,
      }),
      db.insert(choices).values(choiceRows(inputs[i], lastQuestionId)),
    ]);
    const res = await db.batch([
      stmts[0],
      ...stmts.slice(1),
      db.update(sourceFiles).set({ status: "done" }).where(eq(sourceFiles.id, sourceFileId)),
      auditInsert(db, c, "question.import", { type: "source_file", id: String(sourceFileId) }, { count: items.length }),
      db
        .select({ id: questions.id, code: questions.code, sourceNo: questions.sourceNo })
        .from(questions)
        .where(eq(questions.sourceFileId, sourceFileId))
        .orderBy(desc(questions.id))
        .limit(items.length),
    ]);
    const created = (res.at(-1) as { id: number; code: number; sourceNo: number | null }[]).reverse();
    return c.json({ created }, 201);
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
    const f =questionFields(input);
    const now = Date.now();
    const adminId = c.get("admin").id;

    // Rule 8, decided inside the batch (one transaction): an attempt that starts after we read
    // `cur` still forces a new version. Exactly one of the two paths below writes anything.
    const used = usedSql(id);
    const unused = sql`not ${used}`;
    const insertChoices = (questionId: SQL, when: SQL) =>
      sql`insert into choices (question_id, ord, body, image_key, is_correct)
        select ${questionId}, column1, column2, column3, column4
        from (values ${sql.join(
          input.choices.map((ch, ord) => sql`(${ord}, ${ch.body}, ${ch.imageKey ?? null}, ${ch.isCorrect ? 1 : 0})`),
          sql`, `,
        )})
        where ${when}`;

    try {
      const res = await rawBatch(c.env, [
        // A. not used yet: edit in place
        db.update(questions).set({ ...f, updatedAt: now }).where(and(eq(questions.id, id), unused)),
        db.delete(choices).where(and(eq(choices.questionId, id), unused)),
        insertChoices(sql`${id}`, unused),
        auditInsertIf(c, unused, "question.update", { type: "question", id: String(id) }, { code: cur.code, version: cur.version }),
        // B. used: retire this row and add version + 1 (copied from the row as it is now)
        db.update(questions).set({ isLatest: false }).where(and(eq(questions.id, id), used)),
        sql`insert into questions (code, version, is_latest, subject_id, source_file_id, source_no, stem, stem_image_key,
            explanation, fixed_choices, group_key, status, created_by, created_at, updated_at)
          select code, version + 1, 1, ${f.subjectId}, source_file_id, source_no, ${f.stem}, ${f.stemImageKey},
            ${f.explanation}, ${f.fixedChoices ? 1 : 0}, ${f.groupKey}, status, ${adminId}, ${now}, ${now}
          from questions where id = ${id} and ${used}`,
        insertChoices(lastQuestionId, used),
        auditInsertIf(c, used, "question.version", { type: "question", id: sql`(select cast(max(id) as text) from questions)` }, {
          code: cur.code,
          fromId: id,
          fromVersion: cur.version,
        }),
        db
          .select({ id: questions.id, code: questions.code, version: questions.version })
          .from(questions)
          .where(and(eq(questions.code, cur.code), eq(questions.isLatest, true))),
      ]);
      const latest = res.at(-1)!.results[0] as { id: number; code: number; version: number };
      return c.json({ ...latest, newVersion: latest.id !== id });
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
